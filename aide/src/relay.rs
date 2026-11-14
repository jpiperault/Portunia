//! Liaison avec le dépanneur par le relais de la Gate : place et code, échange de clés,
//! accord de la personne, puis session RDP dans le canal chiffré de bout en bout.
//!
//! Pendant la session, des messages de contrôle (JSON chiffré) passent à côté du flux RDP :
//! accusés de réception (débit), pause, contrôle donné ou repris, discussion, fichiers, fin.
//! Les fichiers passent après l'image : seulement dans la place qu'elle laisse libre.
//! Avec une Gate et un Portunia récents, une coupure du réseau est reprise sans nouveau code.

use std::{
    path::PathBuf,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Result};
use assist_proto::{
    transfer::{self, Outgoing, Snapshot, Transfers},
    Code, Handshake, Kind, Link, Role,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc::UnboundedReceiver,
};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Fonctions de ce programme, annoncées au dépanneur avec l'accord.
const FEATURES: [&str; 8] = ["liaison", "discussion", "pause", "controle", "reprise", "fichiers", "ecrans", "infos"];

/// Écrans du PC pour le dépanneur, avec celui qui est montré.
fn screens_message() -> Value {
    let list: Vec<Value> = crate::display::screens()
        .iter()
        .map(|s| json!({ "nom": s.name, "largeur": s.width, "hauteur": s.height, "principal": s.primary }))
        .collect();
    json!({ "type": "ecrans", "liste": list, "actuel": crate::display::SCREEN.load(Ordering::Relaxed) })
}
/// Durée pendant laquelle une session coupée peut reprendre.
const RESUME_FOR: Duration = Duration::from_secs(120);

/// Ce que la personne demande depuis la fenêtre.
#[derive(Debug)]
pub enum Command {
    Stop,
    Pause(bool),
    /// Donner (après une demande) ou reprendre le contrôle.
    Control(bool),
    Message(String),
    /// Envoyer ces fichiers au dépanneur (choisis par la personne).
    SendFiles(Vec<PathBuf>),
    /// Accepter ou refuser un fichier proposé par le dépanneur.
    FileAnswer(u32, bool),
    FileCancel(u32),
    /// Envoyer (après accord de la personne) ou refuser les informations du PC.
    SendInfo(bool),
}

/// Ce qui arrive pendant la session.
#[derive(Debug, Clone)]
pub enum Event {
    /// Message du dépanneur.
    Message(String),
    /// Le dépanneur demande le contrôle.
    ControlRequested,
    Control(bool),
    Paused(bool),
    /// Réseau coupé, reprise en cours (true) ou reprise faite (false).
    Reconnecting(bool),
    /// Temps d'aller-retour mesuré.
    Quality(Duration),
    /// Fichiers de la session (tous, dans l'ordre), et taille maximale d'un fichier.
    Files(Vec<Snapshot>, Option<u64>),
    /// Le dépanneur demande les informations du PC : la liste, montrée avant l'accord.
    InfoRequested(Vec<(String, String)>),
    /// Le dépanneur montre un autre écran (le cadre suit).
    ScreenShown,
}

/// Bilan de fin, montré à la personne.
#[derive(Debug, Clone, Default)]
pub struct Summary {
    pub reason: String,
    pub who: String,
    pub duration: Duration,
    pub control: bool,
    pub messages: u32,
    pub files: Vec<Snapshot>,
}

/// Ce que la fenêtre montre à la personne aidée.
pub trait Ui: Send {
    /// Code à dicter au dépanneur, et combien de temps il reste valable.
    fn code(&mut self, code: &str, valid: Option<Duration>);
    /// Le dépanneur `who` demande l'accès : `Some(contrôle autorisé)` si elle accepte, `None` sinon.
    fn consent(&mut self, who: &str, server: &str) -> Option<bool>;
    /// Session en cours (barre de session).
    fn connected(&mut self, who: &str, control: bool);
    fn event(&mut self, event: Event);
    /// Nom et logo (PNG) de l'entreprise, réglés sur la Gate (édition Pro) : montrés à la place de Portunia.
    fn brand(&mut self, _name: &str, _logo: Option<Vec<u8>>) {}
    /// Fin de la session, avec son bilan.
    fn ended(&mut self, summary: &Summary);
    /// Fichiers proposés acceptés d'office (essai seulement).
    fn auto_accept_files(&self) -> bool {
        false
    }
}

/// Essais de code faux avant de changer de place (contre les tentatives au hasard).
const TRIES: u32 = 3;

/// Nom du serveur d'assistance, tiré de son adresse (wss://acces.exemple.fr/assistance/relais).
pub fn server_host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.rsplit_once('@').map_or(host, |(_, h)| h)
}

fn ended(reason: &str) -> Summary {
    Summary { reason: reason.into(), ..Default::default() }
}

/// Une assistance : se met en attente sur le relais, puis sert l'écran au dépanneur.
pub async fn run(url: &str, preset: Option<Code>, ui: &mut dyn Ui, serve: impl Fn() -> crate::Server, mut commands: UnboundedReceiver<Command>) -> Result<()> {
    let mut failures = 0;
    loop {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| anyhow!("{} {e}", crate::t("Assistance server unreachable:", "Serveur d'assistance injoignable :")))?;
        // Place donnée par le relais.
        let (place, valid) = loop {
            let m = tokio::select! { m = ws.next() => m, c = commands.recv() => { if matches!(c, Some(Command::Stop) | None) { return Ok(()) } continue } };
            match m {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t)?;
                    match v["type"].as_str() {
                        Some("place") => {
                            if let Some(b) = v.get("marque").filter(|b| b.is_object()) {
                                use base64::Engine;
                                let logo = b["logo"].as_str().filter(|l| !l.is_empty()).and_then(|l| base64::engine::general_purpose::STANDARD.decode(l).ok());
                                ui.brand(b["nom"].as_str().unwrap_or_default(), logo);
                            }
                            break (v["place"].as_str().unwrap_or_default().to_string(), v["attente_s"].as_u64().map(Duration::from_secs));
                        }
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
        ui.code(&code.display(), valid);
        // Attente du dépanneur.
        let (who, resume_token) = loop {
            let m = tokio::select! { m = ws.next() => m, c = commands.recv() => { if matches!(c, Some(Command::Stop) | None) { return Ok(()) } continue } };
            match m {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t)?;
                    if v["type"] == "relie" {
                        break (v["depanneur"].as_str().unwrap_or("?").to_string(), v["reprise"].as_str().map(String::from));
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
        let (sealer, opener) = match pending.confirm(&peer_confirm) {
            Ok(c) => c,
            Err(_) => {
                failures += 1;
                let _ = ws.close(None).await;
                if failures >= TRIES {
                    bail!(crate::t("Wrong code three times: open Portunia Assistance again for a new code", "Code faux trois fois : rouvrez Portunia Assistance pour un nouveau code"));
                }
                // Mauvais code : nouvelle place, nouveau code.
                continue;
            }
        };
        let mut link = Link::new(sealer, opener);
        // Accord de la personne. Le nom vient du relais : l'adresse du serveur, elle, ne peut pas
        // être choisie par un escroc qui n'a pas ce nom de domaine.
        let Some(control) = ui.consent(&who, server_host(url)) else {
            let msg = link.seal(Kind::Control, json!({ "type": "refus" }).to_string().as_bytes());
            ws.send(Message::Binary(msg.into())).await?;
            let _ = ws.close(None).await;
            ui.ended(&ended(crate::t("You declined.", "Vous avez refusé.")));
            return Ok(());
        };
        crate::input::CONTROL.store(control, Ordering::Relaxed);
        crate::display::PAUSED.store(false, Ordering::Relaxed);
        let msg = link.seal(Kind::Control, json!({ "type": "accord", "controle": control, "fonctions": FEATURES }).to_string().as_bytes());
        ws.send(Message::Binary(msg.into())).await?;
        ui.connected(&who, control);

        let mut summary = Summary { who: who.clone(), control, ..Default::default() };
        let started = Instant::now();
        summary.reason = session(url, ws, &mut link, resume_token, ui, &serve, &mut commands, &mut summary).await.to_string();
        crate::input::CONTROL.store(false, Ordering::Relaxed);
        crate::input::release_all();
        crate::display::PAUSED.store(false, Ordering::Relaxed);
        summary.duration = started.elapsed();
        ui.ended(&summary);
        return Ok(());
    }
}

/// Session RDP dans le canal chiffré : le serveur RDP lit et écrit dans un tuyau en mémoire, qui
/// survit aux coupures du réseau. Rend la raison de la fin.
#[allow(clippy::too_many_arguments)]
async fn session(
    url: &str,
    ws: Ws,
    link: &mut Link,
    resume_token: Option<String>,
    ui: &mut dyn Ui,
    serve: &impl Fn() -> crate::Server,
    commands: &mut UnboundedReceiver<Command>,
    summary: &mut Summary,
) -> &'static str {
    // Petit tuyau : quand le réseau est lent, l'image attend dans la capture (où seule la plus
    // récente compte) et non dans un tampon.
    let (local, remote) = tokio::io::duplex(64 * 1024);
    let mut server = serve();
    // Le serveur RDP d'IronRDP ne passe pas d'un fil à l'autre : tâche locale (voir main).
    let rdp = tokio::task::spawn_local(async move { server.run_connection(remote).await });
    let (mut rd, mut wr) = tokio::io::split(local);
    let (mut tx, mut rx) = ws.split();
    let mut buf = vec![0u8; 64 * 1024];
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut peer_features: Vec<String> = Vec::new();
    let mut last_quality = Instant::now();
    let send_control = |link: &mut Link, v: Value| link.seal(Kind::Control, v.to_string().as_bytes());
    // Fin de la session RDP de ce côté : le dépanneur est prévenu, le relais fermé proprement.
    let mut rdp_ended = false;
    // Fichiers : rangés dans Téléchargements, limite annoncée par Portunia (offre gratuite sinon).
    let mut files = Transfers::new(Role::Agent, crate::ui::downloads_dir().join("Portunia Assistance"), Some(transfer::FREE_LIMIT), ui.auto_accept_files());
    let mut waiting_files: Vec<PathBuf> = Vec::new();
    // Informations du PC lues pour le dépanneur, envoyées seulement après l'accord.
    let mut pending_info: Option<Vec<(String, String)>> = None;
    let mut files_ok = false;
    let mut out: Vec<Vec<u8>> = Vec::new();
    let reason = 'session: loop {
        // Une coupure : reprise si les deux côtés et la Gate la savent faire, sinon fin.
        let lost: bool = 'net: loop {
            // Messages préparés par le tour précédent (réponses sur les fichiers).
            for f in out.drain(..) {
                if tx.send(Message::Binary(f.into())).await.is_err() { break 'net true; }
            }
            let changes = files.take_changes();
            if !changes.is_empty() {
                ui.event(Event::Files(files.all(), files.limit()));
            }
            let paused = crate::display::PAUSED.load(Ordering::Relaxed);
            tokio::select! {
                biased;
                n = rd.read(&mut buf), if !link.congested() => match n {
                    Ok(0) | Err(_) => { rdp_ended = true; break 'session crate::t("End of the session.", "Fin de la session.") }
                    Ok(n) => {
                        let frame = link.seal(Kind::Data, &buf[..n]);
                        if tx.send(Message::Binary(frame.into())).await.is_err() { break true; }
                    }
                },
                m = rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => match link.open(&b) {
                        Ok((Kind::Data, data)) => {
                            if wr.write_all(&data).await.is_err() { rdp_ended = true; break 'session crate::t("End of the session.", "Fin de la session."); }
                            if let Some(ack) = link.take_ack() {
                                if tx.send(Message::Binary(ack.into())).await.is_err() { break true; }
                            }
                        }
                        Ok((Kind::File, data)) => {
                            if let Some(r) = files.on_data(&data) {
                                out.push(send_control(link, r));
                            }
                            if let Some(ack) = link.take_ack() {
                                out.push(ack);
                            }
                        }
                        Ok((Kind::Control, c)) => {
                            let v: Value = serde_json::from_slice(&c).unwrap_or(Value::Null);
                            match v["type"].as_str() {
                                Some("recu") => link.acked(v["n"].as_u64().unwrap_or(0)),
                                Some("fin") => break 'session crate::t("Ended by the person helping you.", "Terminée par la personne qui vous aide."),
                                Some("fonctions") => {
                                    peer_features = v["liste"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                                    files_ok = peer_features.iter().any(|f| f == "fichiers");
                                    // Taille maximale d'un fichier : null = sans limite (Pro, Équipes).
                                    files.set_limit(match v.get("fichiers_max") {
                                        Some(Value::Null) => None,
                                        Some(n) => Some(n.as_u64().unwrap_or(transfer::FREE_LIMIT)),
                                        None => Some(transfer::FREE_LIMIT),
                                    });
                                    if files_ok {
                                        ui.event(Event::Files(files.all(), files.limit()));
                                    }
                                    // Plusieurs écrans : la liste, pour passer de l'un à l'autre.
                                    if peer_features.iter().any(|f| f == "ecrans") {
                                        out.push(send_control(link, screens_message()));
                                    }
                                    for p in std::mem::take(&mut waiting_files).into_iter().filter(|_| files_ok) {
                                        if let Ok(o) = files.offer(&p) {
                                            out.push(send_control(link, o));
                                        }
                                    }
                                }
                                Some(t) if t.starts_with("fichier_") && files_ok => {
                                    if let Some(r) = files.on_control(&v) {
                                        out.push(send_control(link, r));
                                    }
                                }
                                Some("message") => {
                                    if let Some(t) = v["texte"].as_str() {
                                        summary.messages += 1;
                                        ui.event(Event::Message(t.chars().take(4000).collect()));
                                    }
                                }
                                Some("ecran") => {
                                    if crate::display::select(v["index"].as_u64().unwrap_or(0) as usize) {
                                        out.push(send_control(link, screens_message()));
                                        ui.event(Event::ScreenShown);
                                    }
                                }
                                Some("demande_infos") => {
                                    pending_info = Some(crate::sysinfo::collect());
                                    ui.event(Event::InfoRequested(pending_info.clone().unwrap_or_default()));
                                }
                                Some("demande_controle") => {
                                    if !crate::input::CONTROL.load(Ordering::Relaxed) {
                                        ui.event(Event::ControlRequested);
                                    }
                                }
                                _ => {}
                            }
                        }
                        Err(_) => break 'session crate::t("Altered message: connection cut for safety.", "Message altéré : connexion coupée par sécurité."),
                    },
                    Some(Ok(Message::Close(_))) => break 'session crate::t("Connection closed by the server.", "Connexion fermée par le serveur."),
                    None | Some(Err(_)) => break true,
                    _ => {}
                },
                c = commands.recv() => match c {
                    None | Some(Command::Stop) => {
                        let fin = send_control(link, json!({ "type": "fin" }));
                        let _ = tx.send(Message::Binary(fin.into())).await;
                        let _ = tx.close().await;
                        break 'session crate::t("You stopped it.", "Vous l'avez arrêtée.");
                    }
                    Some(Command::Pause(on)) => {
                        crate::display::PAUSED.store(on, Ordering::Relaxed);
                        if on { crate::input::release_all(); }
                        let f = send_control(link, json!({ "type": "pause", "actif": on }));
                        ui.event(Event::Paused(on));
                        if tx.send(Message::Binary(f.into())).await.is_err() { break true; }
                    }
                    Some(Command::Control(on)) => {
                        crate::input::CONTROL.store(on, Ordering::Relaxed);
                        if !on { crate::input::release_all(); }
                        summary.control |= on;
                        let f = send_control(link, json!({ "type": "controle", "actif": on }));
                        ui.event(Event::Control(on));
                        if tx.send(Message::Binary(f.into())).await.is_err() { break true; }
                    }
                    Some(Command::SendInfo(yes)) => {
                        let msg = match (yes, pending_info.take()) {
                            (true, Some(list)) => json!({ "type": "infos", "liste": list.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>() }),
                            _ => json!({ "type": "infos_refusees" }),
                        };
                        let f = send_control(link, msg);
                        if tx.send(Message::Binary(f.into())).await.is_err() { break true; }
                    }
                    Some(Command::Message(text)) => {
                        summary.messages += 1;
                        let f = send_control(link, json!({ "type": "message", "texte": text }));
                        if tx.send(Message::Binary(f.into())).await.is_err() { break true; }
                    }
                    Some(Command::SendFiles(paths)) => {
                        if !files_ok {
                            // Portunia n'a pas encore dit ce qu'il sait faire.
                            if peer_features.is_empty() { waiting_files.extend(paths); }
                        } else {
                            for p in paths {
                                if let Ok(o) = files.offer(&p) {
                                    out.push(send_control(link, o));
                                }
                            }
                        }
                    }
                    Some(Command::FileAnswer(id, yes)) => {
                        if let Some(r) = files.answer(id, yes) { out.push(send_control(link, r)); }
                    }
                    Some(Command::FileCancel(id)) => {
                        if let Some(r) = files.cancel(id) { out.push(send_control(link, r)); }
                    }
                },
                _ = tick.tick() => {
                    if let Some(ack) = link.take_ack() {
                        if tx.send(Message::Binary(ack.into())).await.is_err() { break true; }
                    }
                    if last_quality.elapsed() >= Duration::from_secs(1) {
                        last_quality = Instant::now();
                        if let Some(rtt) = link.rtt() { ui.event(Event::Quality(rtt)); }
                    }
                    for r in files.expire() {
                        out.push(send_control(link, r));
                    }
                }
                // Fichier : seulement dans la place que l'image laisse libre, et jamais en pause.
                _ = std::future::ready(()), if files.sending() && !paused && link.flow && link.in_flight() + 64 * 1024 <= link.window() / 2 => {
                    match files.next() {
                        Some(Outgoing::Data(d)) => out.push(link.seal(Kind::File, &d)),
                        Some(Outgoing::Control(c)) => out.push(send_control(link, c)),
                        None => {}
                    }
                }
            }
        };
        debug_assert!(lost);
        // Ce qui n'est pas parti est gardé par la liaison et renvoyé à la reprise.
        out.clear();
        // Reprise possible ?
        let resumable = link.flow && peer_features.iter().any(|f| f == "reprise");
        let Some(token) = resume_token.as_deref().filter(|_| resumable) else {
            break crate::t("Connection lost.", "Connexion perdue.");
        };
        ui.event(Event::Reconnecting(true));
        match resume(url, token, link, commands).await {
            Ok(Some(ws)) => {
                (tx, rx) = ws.split();
                ui.event(Event::Reconnecting(false));
            }
            Ok(None) => break crate::t("You stopped it.", "Vous l'avez arrêtée."),
            Err(_) => break crate::t("Connection lost.", "Connexion perdue."),
        }
    };
    files.close();
    summary.files = files.all();
    if rdp_ended {
        let fin = send_control(link, json!({ "type": "fin" }));
        let _ = tx.send(Message::Binary(fin.into())).await;
        let _ = tx.close().await;
    }
    rdp.abort();
    reason
}

/// Reprend la session après une coupure : même place sur le relais, puis chacun renvoie ce que
/// l'autre n'a pas reçu. `None` : la personne a arrêté pendant l'attente.
async fn resume(url: &str, token: &str, link: &mut Link, commands: &mut UnboundedReceiver<Command>) -> Result<Option<Ws>> {
    let until = Instant::now() + RESUME_FOR;
    let target = format!("{url}?reprise={token}");
    while Instant::now() < until {
        let attempt = async {
            let (mut ws, _) = tokio_tungstenite::connect_async(&target).await?;
            // Le relais remet en relation, puis chacun dit ce qu'il a reçu.
            loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t)?;
                        match v["type"].as_str() {
                            Some("repris") => break,
                            Some("erreur") => bail!("{}", v["message"].as_str().unwrap_or("?")),
                            _ => {}
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => bail!("relais fermé"),
                }
            }
            ws.send(Message::Text(json!({ "type": "reprise", "recu": link.opened() }).to_string().into())).await?;
            let n = loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t)?;
                        if v["type"] == "reprise" {
                            break v["recu"].as_u64().unwrap_or(0);
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => bail!("relais fermé"),
                }
            };
            let frames = link.resend_from(n).ok_or_else(|| anyhow!("reprise impossible"))?;
            for f in frames {
                ws.send(Message::Binary(f.into())).await?;
            }
            Ok::<_, anyhow::Error>(ws)
        };
        tokio::select! {
            r = attempt => match r {
                Ok(ws) => return Ok(Some(ws)),
                Err(e) if e.to_string().contains("reprise impossible") => return Err(e),
                Err(_) => tokio::time::sleep(Duration::from_secs(2)).await,
            },
            c = commands.recv() => if matches!(c, None | Some(Command::Stop)) { return Ok(None) },
        }
    }
    bail!("reprise trop longue")
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

#[cfg(test)]
mod tests_serveur {
    use super::server_host;

    #[test]
    fn adresse_du_serveur() {
        assert_eq!(server_host("wss://acces.exemple.fr/assistance/relais"), "acces.exemple.fr");
        assert_eq!(server_host("wss://x:y@pirate.fr:8443/a?b"), "pirate.fr:8443");
    }
}
