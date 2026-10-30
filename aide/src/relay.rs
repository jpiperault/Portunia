//! Liaison avec le dépanneur par le relais du bastion : place et code, échange de clés,
//! accord de la personne, puis session RDP dans le canal chiffré de bout en bout.

use anyhow::{anyhow, bail, Result};
use assist_proto::{Code, Handshake, Kind, Role};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

/// Ce que la fenêtre montre à la personne aidée.
pub trait Ui: Send {
    /// Code à dicter au dépanneur.
    fn code(&mut self, code: &str);
    /// Le dépanneur `who` demande l'accès : `Some(contrôle autorisé)` si elle accepte, `None` sinon.
    fn consent(&mut self, who: &str) -> Option<bool>;
    /// Session en cours (bandeau « Arrêter »).
    fn connected(&mut self, who: &str, control: bool);
    /// Fin de la session, avec la raison.
    fn ended(&mut self, reason: &str);
}

/// Essais de code faux avant de changer de place (contre les tentatives au hasard).
const TRIES: u32 = 3;

/// Une assistance : se met en attente sur le relais, puis sert l'écran au dépanneur.
pub async fn run(url: &str, preset: Option<Code>, ui: &mut dyn Ui, serve: impl Fn(bool) -> crate::Server, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    let mut failures = 0;
    loop {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| anyhow!("{} {e}", crate::t("Assistance server unreachable:", "Serveur d'assistance injoignable :")))?;
        // Place donnée par le relais.
        let place = loop {
            let m = tokio::select! { m = ws.next() => m, _ = stop.changed() => return Ok(()) };
            match m {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t)?;
                    match v["type"].as_str() {
                        Some("place") => break v["place"].as_str().unwrap_or_default().to_string(),
                        Some("erreur") => bail!("{}", v["message"].as_str().unwrap_or("?")),
                        _ => {}
                    }
                }
                Some(Ok(_)) => {}
                _ => bail!(crate::t("The assistance server closed the connection", "Le serveur d'assistance a fermé la connexion")),
            }
        };
        let code = match &preset {
            Some(c) => Code { nameplate: place.clone(), secret: c.secret.clone() },
            None => Code::new(&place),
        };
        ui.code(&code.display());
        // Attente du dépanneur.
        let who = loop {
            let m = tokio::select! { m = ws.next() => m, _ = stop.changed() => return Ok(()) };
            match m {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t)?;
                    if v["type"] == "relie" {
                        break v["depanneur"].as_str().unwrap_or("?").to_string();
                    }
                }
                Some(Ok(_)) => {}
                _ => bail!(crate::t("The assistance server closed the connection", "Le serveur d'assistance a fermé la connexion")),
            }
        };
        // Échange de clés : le dépanneur doit avoir le même code.
        let (hs, mine) = Handshake::start(Role::Agent, &code);
        ws.send(Message::Binary(mine.into())).await?;
        let peer = next_binary(&mut ws).await?;
        let (pending, confirm) = hs.finish(&peer)?;
        ws.send(Message::Binary(confirm.into())).await?;
        let peer_confirm = next_binary(&mut ws).await?;
        let (mut sealer, mut opener) = match pending.confirm(&peer_confirm) {
            Ok(c) => c,
            Err(_) => {
                failures += 1;
                let _ = ws.close(None).await;
                if failures >= TRIES {
                    bail!(crate::t("Wrong code three times: open Portunia Assist again for a new code", "Code faux trois fois : rouvrez Portunia Assist pour un nouveau code"));
                }
                // Mauvais code : nouvelle place, nouveau code.
                continue;
            }
        };
        // Accord de la personne.
        let Some(control) = ui.consent(&who) else {
            let msg = sealer.seal(Kind::Control, json!({ "type": "refus" }).to_string().as_bytes());
            ws.send(Message::Binary(msg.into())).await?;
            let _ = ws.close(None).await;
            ui.ended(crate::t("You declined.", "Vous avez refusé."));
            return Ok(());
        };
        let msg = sealer.seal(Kind::Control, json!({ "type": "accord", "controle": control }).to_string().as_bytes());
        ws.send(Message::Binary(msg.into())).await?;
        ui.connected(&who, control);

        // Session RDP dans le canal chiffré : le serveur RDP lit et écrit dans un tuyau en mémoire.
        let (local, remote) = tokio::io::duplex(256 * 1024);
        let mut server = serve(control);
        // Le serveur RDP d'IronRDP ne passe pas d'un fil à l'autre : tâche locale (voir main).
        let rdp = tokio::task::spawn_local(async move { server.run_connection(remote).await });
        let (mut rd, mut wr) = tokio::io::split(local);
        let (mut tx, mut rx) = ws.split();
        let mut buf = vec![0u8; 64 * 1024];
        let reason = loop {
            tokio::select! {
                n = rd.read(&mut buf) => match n {
                    Ok(0) | Err(_) => break crate::t("End of the session.", "Fin de la session."),
                    Ok(n) => {
                        let frame = sealer.seal(Kind::Data, &buf[..n]);
                        if tx.send(Message::Binary(frame.into())).await.is_err() { break crate::t("Connection lost.", "Connexion perdue."); }
                    }
                },
                m = rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => match opener.open(&b) {
                        Ok((Kind::Data, data)) => { if wr.write_all(&data).await.is_err() { break crate::t("End of the session.", "Fin de la session."); } }
                        Ok((Kind::Control, c)) => {
                            let v: Value = serde_json::from_slice(&c).unwrap_or(Value::Null);
                            if v["type"] == "fin" { break crate::t("Ended by the person helping you.", "Terminée par la personne qui vous aide."); }
                        }
                        Err(_) => break crate::t("Altered message: connection cut for safety.", "Message altéré : connexion coupée par sécurité."),
                    },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break crate::t("Connection lost.", "Connexion perdue."),
                    _ => {}
                },
                _ = stop.changed() => {
                    let fin = sealer.seal(Kind::Control, json!({ "type": "fin" }).to_string().as_bytes());
                    let _ = tx.send(Message::Binary(fin.into())).await;
                    break crate::t("You stopped it.", "Vous l'avez arrêtée.");
                }
            }
        };
        rdp.abort();
        let _ = tx.close().await;
        ui.ended(reason);
        return Ok(());
    }
}

async fn next_binary<S>(ws: &mut S) -> Result<Vec<u8>>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match ws.next().await {
            Some(Ok(Message::Binary(b))) => return Ok(b.to_vec()),
            Some(Ok(Message::Text(_))) | Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
            _ => bail!(crate::t("Connection lost while checking the code", "Connexion perdue pendant la vérification du code")),
        }
    }
}
