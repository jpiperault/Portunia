//! Essai : le côté dépanneur, comme Portunia (bastion de test au certificat auto-signé).
//!
//!   cargo run --example depanneur -- wss://127.0.0.1:18444 JETON "483 216 907" 13391
//! puis connecter un client RDP à 127.0.0.1:13391.

use std::sync::Arc;

use assist_proto::{Code, Handshake, Kind, Role};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

/// Bastion de test : certificat accepté sans vérification (Portunia, lui, vérifie l'empreinte).
#[derive(Debug)]
struct AnyCert;
impl ServerCertVerifier for AnyCert {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

async fn binary<S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin>(ws: &mut S) -> Option<Vec<u8>> {
    loop {
        match ws.next().await? {
            Ok(Message::Binary(b)) => return Some(b.to_vec()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (base, token, code, port) = (&args[1], &args[2], Code::parse(&args[3]).expect("code"), args[4].parse::<u16>().unwrap());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCert))
        .with_no_client_auth();
    let mut req = format!("{base}/api/v1/assistance/{}", code.nameplate).into_client_request().unwrap();
    req.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(config));
    let (mut ws, _) = match tokio_tungstenite::connect_async_tls_with_config(req, None, false, Some(connector)).await {
        Ok(w) => w,
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => {
            println!("REFUS {} {}", r.status(), String::from_utf8_lossy(r.body().as_deref().unwrap_or_default()));
            return;
        }
        Err(e) => panic!("{e}"),
    };
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                println!("relais : {v}");
                if v["type"] == "relie" {
                    break;
                }
                if v["type"] == "erreur" {
                    return;
                }
            }
            Some(Ok(_)) => {}
            _ => {
                println!("relais fermé");
                return;
            }
        }
    }
    let (hs, mine) = Handshake::start(Role::Helper, &code);
    ws.send(Message::Binary(mine.into())).await.unwrap();
    let peer = binary(&mut ws).await.expect("échange");
    let (pending, confirm) = hs.finish(&peer).unwrap();
    ws.send(Message::Binary(confirm.into())).await.unwrap();
    let Some(peer_confirm) = binary(&mut ws).await else {
        println!("CODE FAUX (la personne a coupé)");
        return;
    };
    let Ok((mut sealer, mut opener)) = pending.confirm(&peer_confirm) else {
        println!("CODE FAUX");
        return;
    };
    let accord = loop {
        let f = binary(&mut ws).await.expect("accord");
        let (k, p) = opener.open(&f).unwrap();
        if k == Kind::Control {
            break serde_json::from_slice::<Value>(&p).unwrap();
        }
    };
    println!("ACCORD {accord}");
    if accord["type"] != "accord" {
        return;
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("PRET 127.0.0.1:{port}");
    let (socket, _) = listener.accept().await.unwrap();
    let (mut rd, mut wr) = socket.into_split();
    let (mut tx, mut rx) = ws.split();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut up, mut down) = (0usize, 0usize);
    loop {
        tokio::select! {
            n = rd.read(&mut buf) => match n {
                Ok(0) | Err(_) => {
                    let fin = sealer.seal(Kind::Control, json!({ "type": "fin" }).to_string().as_bytes());
                    let _ = tx.send(Message::Binary(fin.into())).await;
                    break;
                }
                Ok(n) => { up += n; tx.send(Message::Binary(sealer.seal(Kind::Data, &buf[..n]).into())).await.unwrap(); }
            },
            m = rx.next() => match m {
                Some(Ok(Message::Binary(b))) => match opener.open(&b) {
                    Ok((Kind::Data, d)) => { down += d.len(); if wr.write_all(&d).await.is_err() { break; } }
                    Ok(_) => {}
                    Err(e) => { println!("ALTÉRÉ {e}"); break; }
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    println!("FIN : {up} octets envoyés, {down} reçus");
}
