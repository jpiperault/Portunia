//! termoria-rdp : client RDP sans fenêtre, piloté par Termoria.
//!
//! Entrée standard, une ligne JSON par message :
//!   1re ligne : la configuration { host, port, username, domain, password, width, height }
//!   ensuite   : { "type": "key", "code": "KeyA", "down": true } | { "type": "pointer", x, y, buttons }
//!               | { "type": "close" }
//! Sortie standard, une ligne JSON par message :
//!   { "type": "connected" } | { "type": "resize", width, height }
//!   | { "type": "image", x, y, width, height, rgba } | { "type": "closed", "reason": … }

mod scancodes;

use std::{io::Write, time::Duration};

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ironrdp_client::{
    config::{ConfigBuilder, Destination},
    rdp::{RdpClient, RdpInputEvent, RdpOutputEvent},
};
use ironrdp_pdu::input::{
    fast_path::{FastPathInputEvent, KeyboardFlags},
    mouse::PointerFlags,
    MousePdu,
};
use serde::{Deserialize, Serialize};
use smallvec::smallvec;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::mpsc,
};

#[derive(Deserialize)]
struct Settings {
    host: String,
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    password: String,
    width: u16,
    height: u16,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Input {
    Key { code: String, down: bool },
    Pointer { x: u16, y: u16, buttons: u8 },
    Close,
    #[serde(other)]
    Other,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Output {
    Connected,
    Resize { width: u16, height: u16 },
    Image { x: u16, y: u16, width: u16, height: u16, rgba: String },
    Closed { reason: Option<String> },
}

fn emit(message: &Output) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, message);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        emit(&Output::Closed { reason: Some(format!("{e:#}")) });
    }
    // La lecture de l'entrée standard bloquerait l'arrêt normal : on quitte directement.
    std::process::exit(0);
}

async fn run() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let first = lines.next_line().await?.ok_or_else(|| anyhow::anyhow!("configuration manquante"))?;
    // Certains lanceurs ajoutent une marque d'ordre des octets (BOM) en tête.
    let s: Settings = serde_json::from_str(first.trim_start_matches('\u{feff}'))?;

    let mut builder = ConfigBuilder::new()
        .with_destination(Destination::from_parts(s.host.clone(), s.port))
        .with_username(s.username.clone())
        .with_password(s.password.clone())
        .with_desktop_width(s.width.max(640))
        .with_desktop_height(s.height.max(480))
        .with_server_pointer(true)
        .with_pointer_software_rendering(false)
        .with_client_name("Termoria")
        // Identité du client annoncée au serveur (valeurs habituelles d'un client Windows).
        .with_client_build(0)
        .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS);
    if !s.domain.is_empty() {
        builder = builder.with_domain(s.domain.clone());
    }
    let config = builder.build()?;

    let (out_tx, mut out_rx) = mpsc::channel(16);
    let client = RdpClient::new(config, out_tx);
    let input = client.input_sender();
    // La boucle d'IronRDP n'est pas « Send » : elle tourne sur son propre fil.
    std::thread::spawn(move || {
        match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime.block_on(client.run()),
            Err(e) => emit(&Output::Closed { reason: Some(format!("{e}")) }),
        }
    });

    // Saisie venant de Termoria.
    let keys = input.clone();
    tokio::spawn(async move {
        let mut last_buttons = 0u8;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Input>(&line) else { continue };
            let events: smallvec::SmallVec<[FastPathInputEvent; 2]> = match event {
                Input::Key { code, down } => match scancodes::lookup(&code) {
                    Some((scancode, extended)) => {
                        let mut flags = KeyboardFlags::empty();
                        if !down {
                            flags |= KeyboardFlags::RELEASE;
                        }
                        if extended {
                            flags |= KeyboardFlags::EXTENDED;
                        }
                        smallvec![FastPathInputEvent::KeyboardEvent(flags, scancode)]
                    }
                    None => continue,
                },
                Input::Pointer { x, y, buttons } => {
                    let mut out = smallvec::SmallVec::new();
                    // Molette : bits 8 (haut) et 16 (bas), comme en VNC.
                    if buttons & 24 != 0 {
                        let up = buttons & 8 != 0;
                        let mut flags = PointerFlags::VERTICAL_WHEEL;
                        if !up {
                            flags |= PointerFlags::WHEEL_NEGATIVE;
                        }
                        out.push(FastPathInputEvent::MouseEvent(MousePdu {
                            flags,
                            number_of_wheel_rotation_units: if up { 120 } else { -120 },
                            x_position: x,
                            y_position: y,
                        }));
                    } else {
                        let changed = buttons ^ last_buttons;
                        for (bit, flag) in [(1u8, PointerFlags::LEFT_BUTTON), (2, PointerFlags::MIDDLE_BUTTON_OR_WHEEL), (4, PointerFlags::RIGHT_BUTTON)] {
                            if changed & bit != 0 {
                                let mut flags = flag;
                                if buttons & bit != 0 {
                                    flags |= PointerFlags::DOWN;
                                }
                                out.push(FastPathInputEvent::MouseEvent(MousePdu { flags, number_of_wheel_rotation_units: 0, x_position: x, y_position: y }));
                            }
                        }
                        if changed == 0 {
                            out.push(FastPathInputEvent::MouseEvent(MousePdu {
                                flags: PointerFlags::MOVE,
                                number_of_wheel_rotation_units: 0,
                                x_position: x,
                                y_position: y,
                            }));
                        }
                        last_buttons = buttons & 7;
                    }
                    out
                }
                Input::Close => {
                    let _ = keys.send(RdpInputEvent::Close);
                    break;
                }
                Input::Other => continue,
            };
            if !events.is_empty() && keys.send(RdpInputEvent::FastPath(events)).is_err() {
                break;
            }
        }
        // Termoria fermé : on ferme la session.
        let _ = keys.send(RdpInputEvent::Close);
    });

    // Images venant du serveur : on n'envoie que les zones qui ont changé.
    let mut previous: Vec<u32> = Vec::new();
    let (mut width, mut height) = (0u16, 0u16);
    let mut connected = false;
    while let Some(mut event) = out_rx.recv().await {
        // Plusieurs images en attente : seule la plus récente compte.
        if matches!(event, RdpOutputEvent::Image { .. }) {
            while let Ok(next) = out_rx.try_recv() {
                if matches!(next, RdpOutputEvent::Image { .. }) {
                    event = next;
                } else {
                    handle_other(next);
                }
            }
        }
        match event {
            RdpOutputEvent::Image { buffer, width: w, height: h } => {
                if !connected {
                    connected = true;
                    emit(&Output::Connected);
                }
                let (w, h) = (w.get(), h.get());
                if (w, h) != (width, height) || previous.len() != buffer.len() {
                    width = w;
                    height = h;
                    previous = vec![u32::MAX; buffer.len()];
                    emit(&Output::Resize { width, height });
                }
                send_changes(&previous, &buffer, width, height);
                previous = buffer;
            }
            other => {
                if handle_other(other) {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    emit(&Output::Closed { reason: None });
    Ok(())
}

/// Renvoie true si la session est terminée.
fn handle_other(event: RdpOutputEvent) -> bool {
    match event {
        RdpOutputEvent::ConnectionFailure(e) => {
            emit(&Output::Closed { reason: Some(explain(&e.to_string())) });
            true
        }
        RdpOutputEvent::Terminated(result) => {
            let reason = match result {
                Ok(_) => None,
                Err(e) => Some(explain(&e.to_string())),
            };
            emit(&Output::Closed { reason });
            true
        }
        _ => false,
    }
}

/// Messages d'erreur plus parlants pour les cas courants.
fn explain(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("logon") || lower.contains("credential") || lower.contains("credssp") || lower.contains("0xc000006d") || lower.contains("authentication") {
        format!("Identifiant ou mot de passe refusé. Pour un compte de domaine, écrivez DOMAINE\\utilisateur. ({raw})")
    } else if lower.contains("connection refused") || lower.contains("10061") || lower.contains("tcp connect") {
        format!("Connexion impossible : serveur injoignable, Bureau à distance désactivé ou port fermé ({raw})")
    } else if lower.contains("tls") || lower.contains("certificate") {
        format!("Échec de la connexion sécurisée (TLS) avec le serveur ({raw})")
    } else {
        raw.to_string()
    }
}

const TILE: usize = 64;

/// Compare l'image à la précédente par carrés de 64 pixels et n'envoie que ceux qui ont changé.
fn send_changes(previous: &[u32], current: &[u32], width: u16, height: u16) {
    let (w, h) = (width as usize, height as usize);
    let mut changed = Vec::new();
    for ty in (0..h).step_by(TILE) {
        for tx in (0..w).step_by(TILE) {
            let tw = TILE.min(w - tx);
            let th = TILE.min(h - ty);
            let differs = (ty..ty + th).any(|y| {
                let row = y * w + tx;
                previous[row..row + tw] != current[row..row + tw]
            });
            if differs {
                changed.push((tx, ty, tw, th));
            }
        }
    }
    let total = w.div_ceil(TILE) * h.div_ceil(TILE);
    // Plus de la moitié de l'écran a changé : une seule image complète.
    if changed.len() * 2 > total {
        changed = vec![(0, 0, w, h)];
    }
    for (x, y, tw, th) in changed {
        let mut rgba = Vec::with_capacity(tw * th * 4);
        for row in y..y + th {
            for &px in &current[row * w + x..row * w + x + tw] {
                // 0x00RRGGBB → R, G, B, A
                rgba.extend_from_slice(&[(px >> 16) as u8, (px >> 8) as u8, px as u8, 255]);
            }
        }
        emit(&Output::Image { x: x as u16, y: y as u16, width: tw as u16, height: th as u16, rgba: B64.encode(&rgba) });
    }
}
