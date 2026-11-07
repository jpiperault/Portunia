//! Essai local de la liaison d'assistance, sans Gate :
//!
//!   cargo run --example essai_liaison -- relais 18555 [--coupure 8]
//!     relais WebSocket qui imite celui de la Gate (place, jetons de reprise, retour après une
//!     coupure) ; avec --coupure N, il coupe les deux côtés une fois, N secondes après la mise en
//!     relation, pour éprouver la reprise.
//!   cargo run --example essai_liaison -- depanneur ws://127.0.0.1:18555 "483 216 907" 13391 [--message TEXTE] [--demande-controle]
//!     côté dépanneur, comme Portunia : liaison avec accusés et reprise, puis serveur RDP local
//!     relayé sur le port donné (y connecter un client RDP).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use assist_proto::{Code, Handshake, Kind, Link, Role};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{
    tungstenite::{
        handshake::server::{Request, Response},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

type Server = WebSocketStream<tokio::net::TcpStream>;
type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

// ---------- Relais ----------

#[derive(Default)]
struct Relay {
    waiting: HashMap<String, tokio::sync::oneshot::Sender<(Server, String)>>,
    /// Sessions coupées : (jeton personne, jeton dépanneur) → côtés revenus.
    parked: Vec<(String, String, Option<Server>, Option<Server>)>,
    cut_done: bool,
}

async fn relay_main(port: u16, cut: Option<u64>) {
    let relay = Arc::new(Mutex::new(Relay::default()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("RELAIS ws://127.0.0.1:{port}");
    loop {
        let (tcp, _) = listener.accept().await.unwrap();
        let _ = tcp.set_nodelay(true);
        let relay = relay.clone();
        tokio::spawn(async move {
            let mut path = String::new();
            let ws = tokio_tungstenite::accept_hdr_async(tcp, |req: &Request, resp: Response| {
                path = req.uri().to_string();
                Ok(resp)
            })
            .await;
            let Ok(ws) = ws else { return };
            let resume = path.split_once("reprise=").map(|(_, t)| t.to_string());
            if let Some(token) = resume {
                rejoin(relay, ws, token, cut).await;
            } else if path.starts_with("/assistance/relais") {
                agent(relay, ws, cut).await;
            } else if let Some(place) = path.strip_prefix("/api/v1/assistance/") {
                helper(relay, ws, place.to_string()).await;
            }
        });
    }
}

async fn agent(relay: Arc<Mutex<Relay>>, mut ws: Server, cut: Option<u64>) {
    let place = format!("{:03}", rand_u32() % 1000);
    let (tx, rx) = tokio::sync::oneshot::channel();
    relay.lock().unwrap().waiting.insert(place.clone(), tx);
    ws.send(Message::Text(json!({ "type": "place", "place": place, "attente_s": 1800 }).to_string().into())).await.unwrap();
    let Ok((helper, helper_token)) = rx.await else { return };
    let agent_token = format!("{:032x}", rand_u32() as u128 * 7919);
    ws.send(Message::Text(json!({ "type": "relie", "depanneur": "Essai Dépanneur", "reprise": agent_token }).to_string().into())).await.unwrap();
    println!("RELAIS mise en relation (place {place})");
    pump(relay, ws, helper, agent_token, helper_token, cut).await;
}

async fn helper(relay: Arc<Mutex<Relay>>, mut ws: Server, place: String) {
    let Some(tx) = relay.lock().unwrap().waiting.remove(&place) else {
        let _ = ws.send(Message::Text(json!({ "type": "erreur", "message": "place inconnue" }).to_string().into())).await;
        return;
    };
    let token = format!("{:032x}", rand_u32() as u128 * 104729);
    ws.send(Message::Text(json!({ "type": "relie", "adresse": "127.0.0.1", "reprise": token }).to_string().into())).await.unwrap();
    let _ = tx.send((ws, token));
}

async fn rejoin(relay: Arc<Mutex<Relay>>, ws: Server, token: String, cut: Option<u64>) {
    let ready = {
        let mut r = relay.lock().unwrap();
        let Some(i) = r.parked.iter().position(|p| p.0 == token || p.1 == token) else { return };
        if r.parked[i].0 == token {
            r.parked[i].2 = Some(ws);
        } else {
            r.parked[i].3 = Some(ws);
        }
        if r.parked[i].2.is_some() && r.parked[i].3.is_some() {
            Some(r.parked.remove(i))
        } else {
            None
        }
    };
    if let Some((ta, th, Some(mut a), Some(mut h))) = ready {
        println!("RELAIS reprise");
        let _ = a.send(Message::Text(json!({ "type": "repris" }).to_string().into())).await;
        let _ = h.send(Message::Text(json!({ "type": "repris" }).to_string().into())).await;
        Box::pin(pump(relay, a, h, ta, th, cut)).await;
    }
}

async fn pump(relay: Arc<Mutex<Relay>>, mut a: Server, mut h: Server, ta: String, th: String, cut: Option<u64>) {
    let first_cut = cut.filter(|_| !relay.lock().unwrap().cut_done);
    let sleep = tokio::time::sleep(Duration::from_secs(first_cut.unwrap_or(1_000_000)));
    tokio::pin!(sleep);
    let mut bytes = 0usize;
    let lost = loop {
        tokio::select! {
            m = a.next() => match m {
                Some(Ok(m @ (Message::Binary(_) | Message::Text(_)))) => { bytes += m.len(); if h.send(m).await.is_err() { break true; } }
                Some(Ok(Message::Close(_))) => break false,
                None | Some(Err(_)) => break true,
                _ => {}
            },
            m = h.next() => match m {
                Some(Ok(m @ (Message::Binary(_) | Message::Text(_)))) => { bytes += m.len(); if a.send(m).await.is_err() { break true; } }
                Some(Ok(Message::Close(_))) => break false,
                None | Some(Err(_)) => break true,
                _ => {}
            },
            _ = &mut sleep => {
                relay.lock().unwrap().cut_done = true;
                println!("RELAIS coupure simulée ({bytes} octets relayés)");
                break true;
            }
        }
    };
    if lost {
        // Pas de fermeture propre : les deux voient la coupure et reviennent avec leur jeton.
        drop(a);
        drop(h);
        relay.lock().unwrap().parked.push((ta, th, None, None));
    } else {
        let _ = a.close(None).await;
        let _ = h.close(None).await;
        println!("RELAIS fin ({bytes} octets)");
    }
}

fn rand_u32() -> u32 {
    let n = Instant::now().elapsed().as_nanos() as u32 ^ std::process::id().rotate_left(7);
    n.wrapping_mul(2654435761) ^ (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos())
}

// ---------- Dépanneur ----------

async fn binary(ws: &mut Client) -> Option<Vec<u8>> {
    loop {
        match ws.next().await? {
            Ok(Message::Binary(b)) => return Some(b.to_vec()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn resume(base: &str, place: &str, token: &str, link: &mut Link) -> Option<Client> {
    let until = Instant::now() + Duration::from_secs(120);
    while Instant::now() < until {
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(format!("{base}/api/v1/assistance/{place}?reprise={token}")).await {
            let mut ok = false;
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    if serde_json::from_str::<Value>(&t).ok()?["type"] == "repris" {
                        ok = true;
                        break;
                    }
                }
            }
            if ok {
                ws.send(Message::Text(json!({ "type": "reprise", "recu": link.opened() }).to_string().into())).await.ok()?;
                let n = loop {
                    if let Some(Ok(Message::Text(t))) = ws.next().await {
                        let v: Value = serde_json::from_str(&t).ok()?;
                        if v["type"] == "reprise" {
                            break v["recu"].as_u64()?;
                        }
                    }
                };
                for f in link.resend_from(n)? {
                    ws.send(Message::Binary(f.into())).await.ok()?;
                }
                return Some(ws);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

async fn helper_main(base: String, code: Code, port: u16, message: Option<String>, ask: bool) {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{base}/api/v1/assistance/{}", code.nameplate)).await.unwrap();
    let token = loop {
        if let Some(Ok(Message::Text(t))) = ws.next().await {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == "relie" {
                break v["reprise"].as_str().unwrap().to_string();
            }
        }
    };
    let (hs, mine) = Handshake::start(Role::Helper, &code);
    ws.send(Message::Binary(mine.into())).await.unwrap();
    let peer = binary(&mut ws).await.unwrap();
    let (pending, confirm) = hs.finish(&peer).unwrap();
    ws.send(Message::Binary(confirm.into())).await.unwrap();
    let peer_confirm = binary(&mut ws).await.unwrap();
    let (s, o) = pending.confirm(&peer_confirm).expect("code");
    let mut link = Link::new(s, o);
    let accord = loop {
        let (k, p) = link.open(&binary(&mut ws).await.unwrap()).unwrap();
        if k == Kind::Control {
            break serde_json::from_slice::<Value>(&p).unwrap();
        }
    };
    println!("ACCORD {accord}");
    let f = link.seal(Kind::Control, json!({ "type": "fonctions", "liste": ["liaison", "discussion", "pause", "controle", "reprise"] }).to_string().as_bytes());
    ws.send(Message::Binary(f.into())).await.unwrap();
    if let Some(m) = message {
        let f = link.seal(Kind::Control, json!({ "type": "message", "texte": m }).to_string().as_bytes());
        ws.send(Message::Binary(f.into())).await.unwrap();
    }
    if ask {
        let f = link.seal(Kind::Control, json!({ "type": "demande_controle" }).to_string().as_bytes());
        ws.send(Message::Binary(f.into())).await.unwrap();
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("PRET 127.0.0.1:{port}");
    let (socket, _) = listener.accept().await.unwrap();
    let _ = socket.set_nodelay(true);
    let (mut rd, mut wr) = socket.into_split();
    let (mut tx, mut rx) = ws.split();
    let mut buf = vec![0u8; 64 * 1024];
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let (mut down, started) = (0usize, Instant::now());
    let mut last = Instant::now();
    'session: loop {
        let lost = loop {
            tokio::select! {
                n = rd.read(&mut buf) => match n {
                    Ok(0) | Err(_) => {
                        let fin = link.seal(Kind::Control, json!({ "type": "fin" }).to_string().as_bytes());
                        let _ = tx.send(Message::Binary(fin.into())).await;
                        let _ = tx.close().await;
                        break 'session;
                    }
                    Ok(n) => { let f = link.seal(Kind::Data, &buf[..n]); if tx.send(Message::Binary(f.into())).await.is_err() { break true; } }
                },
                m = rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => match link.open(&b) {
                        Ok((Kind::Data, d)) => {
                            down += d.len();
                            if wr.write_all(&d).await.is_err() { break 'session; }
                            if let Some(a) = link.take_ack() { if tx.send(Message::Binary(a.into())).await.is_err() { break true; } }
                        }
                        Ok((Kind::Control, c)) => {
                            let v: Value = serde_json::from_slice(&c).unwrap_or(Value::Null);
                            if v["type"] == "recu" { link.acked(v["n"].as_u64().unwrap_or(0)); } else { println!("CONTRÔLE {v}"); }
                            if v["type"] == "fin" { break 'session; }
                        }
                        Err(e) => { println!("ALTÉRÉ {e}"); break 'session; }
                    },
                    Some(Ok(Message::Close(_))) => break 'session,
                    None | Some(Err(_)) => break true,
                    _ => {}
                },
                _ = tick.tick() => {
                    if let Some(a) = link.take_ack() { if tx.send(Message::Binary(a.into())).await.is_err() { break true; } }
                    if last.elapsed() >= Duration::from_secs(2) {
                        last = Instant::now();
                        println!("DÉBIT {:.0} Ko/s reçus, aller-retour {:?}", down as f64 / 1024.0 / started.elapsed().as_secs_f64(), link.rtt());
                    }
                }
            }
        };
        assert!(lost);
        println!("COUPURE : reprise…");
        let t0 = Instant::now();
        match resume(&base, &code.nameplate, &token, &mut link).await {
            Some(ws) => {
                (tx, rx) = ws.split();
                println!("REPRISE en {:?}", t0.elapsed());
            }
            None => {
                println!("REPRISE IMPOSSIBLE");
                break;
            }
        }
    }
    println!("FIN : {down} octets reçus en {:?}", started.elapsed());
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let opt = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    match args.get(1).map(String::as_str) {
        Some("relais") => relay_main(args[2].parse().unwrap(), opt("--coupure").and_then(|v| v.parse().ok())).await,
        Some("depanneur") => {
            helper_main(args[2].clone(), Code::parse(&args[3]).expect("code"), args[4].parse().unwrap(), opt("--message"), args.iter().any(|a| a == "--demande-controle")).await
        }
        _ => eprintln!("relais PORT [--coupure N] | depanneur URL CODE PORT [--message T] [--demande-controle]"),
    }
}
