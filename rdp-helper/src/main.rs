//! portunia-rdp : client RDP sans fenêtre, piloté par Portunia.
//!
//! Entrée standard, une ligne JSON par message :
//!   1re ligne : la configuration { host, port, username, domain, password, width, height }
//!   ensuite   : { "type": "key", "code": "KeyA", "down": true } | { "type": "pointer", x, y, buttons }
//!               | { "type": "close" }
//! Sortie standard, une ligne JSON par message :
//!   { "type": "connected" } | { "type": "resize", width, height } | { "type": "closed", "reason": … }
//!   | { "type": "pixels", "bytes": n } suivi de n octets bruts : « P », x, y, largeur, hauteur
//!     (u16 petit-boutien), puis les pixels RGBA (voir `pixels`). Pas de base64 : une image
//!     plein écran 1080p fait 8 Mo, et 11 Mo de texte de plus à décoder dans la page.
//!
//! Relecture (Gate) : 1re ligne { "replay": "fichier" }, voir `replay`.

mod files;
mod replay;
mod scancodes;

use std::{io::Write, time::Duration};

use anyhow::Result;
use ironrdp_client::{
    config::{ConfigBuilder, Destination, TransportKind},
    rdp::{RdpClient, RdpInputEvent, RdpOutputEvent},
};
use ironrdp_pdu::rdp::client_info::PerformanceFlags;
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
    /// N'accepter que NLA (CredSSP) : le serveur ne peut pas imposer le TLS simple.
    #[serde(default, rename = "nlaOnly")]
    nla_only: bool,
    /// Passage RDCleanPath d'une Gate (mode enregistré).
    #[serde(default)]
    rdcleanpath: Option<RdCleanPath>,
    /// « fast » : sans fond d'écran, thèmes ni lissage (liaison lente) ; « best » : tous les
    /// effets ; sinon équilibré (options par défaut d'IronRDP).
    #[serde(default)]
    quality: String,
    /// Son du serveur joué sur ce poste.
    #[serde(default)]
    sound: bool,
    /// Passerelle Bureau à distance (RD Gateway) : « hôte:port », compte et mot de passe.
    #[serde(default)]
    gateway: Option<Gateway>,
    /// Profondeur de couleur (16, 24 ou 32 bits) ; 0 : celle d'IronRDP.
    #[serde(default, rename = "colorDepth")]
    color_depth: u32,
    /// Taille fixe du bureau : l'onglet ne la change pas en se redimensionnant.
    /// Copie de fichiers par le presse-papiers (faux : jamais, par exemple si la Gate ne la permet pas).
    #[serde(default = "yes")]
    files: bool,
    #[serde(default, rename = "fixedSize")]
    fixed_size: bool,
}

#[derive(Deserialize)]
struct Gateway {
    host: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
}

#[derive(Deserialize)]
struct RdCleanPath {
    url: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Input {
    Key { code: String, down: bool },
    Pointer { x: u16, y: u16, buttons: u8 },
    Resize { width: u16, height: u16 },
    /// Fichiers de ce poste à mettre au presse-papiers de la session.
    SendFiles { paths: Vec<String> },
    /// Enregistre dans ce dossier les fichiers copiés sur le serveur.
    FetchFiles { dir: String },
    Close,
    #[serde(other)]
    Other,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Output {
    Connected,
    Resize { width: u16, height: u16 },
    Closed { reason: Option<String> },
    /// Relecture chargée : durée et nombre de messages.
    Ready { duration: f64, frames: usize },
    /// Relecture : image à jour pour ce temps.
    Position { t: f64 },
    /// Copie de fichiers possible dans cette session (négociée avec le serveur et la Gate).
    Files { allowed: bool },
    /// Le presse-papiers du serveur contient (ou plus) des fichiers.
    RemoteFiles { available: bool },
    /// Fichiers mis au presse-papiers de la session.
    FilesOffered { count: usize },
    /// Le serveur a lu un fichier offert en entier.
    FileSent { name: String },
    FileProgress { name: String, done: u64, total: u64 },
    /// Récupération terminée.
    FilesSaved { dir: String, count: usize },
    /// `code` : not_allowed, nothing_to_send, no_remote_files, busy, name_refused, write, refused, size, no_list.
    FileError { code: &'static str, name: Option<String> },
}

fn yes() -> bool {
    true
}

pub(crate) fn emit(message: &Output) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, message);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// Zone d'image : annonce JSON puis le paquet binaire, d'un seul tenant.
fn emit_pixels(packet: &[u8]) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{{\"type\":\"pixels\",\"bytes\":{}}}", packet.len());
    let _ = out.write_all(packet);
    let _ = out.flush();
}

/// Paquet d'une zone : « P », x, y, largeur, hauteur (u16 petit-boutien), puis les pixels RGBA.
fn pixels(x: usize, y: usize, w: usize, h: usize, fill: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut packet = Vec::with_capacity(9 + w * h * 4);
    packet.push(b'P');
    for v in [x, y, w, h] {
        packet.extend_from_slice(&(v as u16).to_le_bytes());
    }
    fill(&mut packet);
    packet
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
    let first = first.trim_start_matches('\u{feff}');
    if let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(first) {
        if let Some(path) = o.get("replay").and_then(|v| v.as_str()) {
            return replay::run(path, lines).await;
        }
    }
    let s: Settings = serde_json::from_str(first)?;

    let mut builder = ConfigBuilder::new()
        .with_destination(Destination::from_parts(s.host.clone(), s.port))
        .with_username(s.username.clone())
        .with_password(s.password.clone())
        .with_desktop_width(s.width.max(640))
        .with_desktop_height(s.height.max(480))
        .with_server_pointer(true)
        .with_pointer_software_rendering(false)
        .with_client_name("Portunia")
        // Identité du client annoncée au serveur (valeurs habituelles d'un client Windows).
        .with_client_build(0)
        .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS);
    if !s.domain.is_empty() {
        builder = builder.with_domain(s.domain.clone());
    }
    if s.nla_only {
        builder = builder.with_tls(false);
    }
    builder = builder.with_performance_flags(performance(&s.quality)).with_sound(s.sound);
    if matches!(s.color_depth, 16 | 24 | 32) {
        builder = builder.with_color_depth(s.color_depth);
    }
    if let Some(rdcp) = &s.rdcleanpath {
        let url = rdcp.url.parse().map_err(|e| anyhow::anyhow!("adresse du passage invalide : {e}"))?;
        builder = builder.with_transport(TransportKind::RDCleanPath { url }).with_rdcleanpath_token(rdcp.token.clone());
    } else if let Some(gw) = s.gateway.as_ref().filter(|g| !g.host.trim().is_empty()) {
        // Port 443 par défaut, comme mstsc.
        let host = gw.host.trim();
        let endpoint = if host.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) { host.to_string() } else { format!("{host}:443") };
        builder = builder
            .with_transport(TransportKind::Gateway { endpoint })
            .with_gateway_username(if gw.username.is_empty() { s.username.clone() } else { gw.username.clone() })
            .with_gateway_password(if gw.password.is_empty() { s.password.clone() } else { gw.password.clone() });
    }
    let fixed = s.fixed_size;
    let config = builder.build()?;

    let (out_tx, mut out_rx) = mpsc::channel(16);
    let client = RdpClient::new(config, out_tx);
    let input = client.input_sender();
    // Copie de fichiers : le presse-papiers de Windows enveloppé (voir `files`).
    let shared = files::shared(s.files, input.clone());
    let wrapped = shared.clone();
    let client = client.with_cliprdr_wrapper(Box::new(move |inner| Box::new(files::Factory { inner, files: wrapped })));
    // La boucle d'IronRDP n'est pas « Send » : elle tourne sur son propre fil.
    std::thread::spawn(move || {
        match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            // Le presse-papiers partagé passe par une fenêtre Windows invisible créée
            // sur ce fil : il faut traiter ses messages pendant que la session tourne.
            Ok(runtime) => runtime.block_on(async {
                tokio::select! {
                    _ = client.run() => {}
                    _ = pump_windows_messages() => {}
                }
            }),
            Err(e) => emit(&Output::Closed { reason: Some(format!("{e}")) }),
        }
    });

    // Saisie venant de Portunia.
    let keys = input.clone();
    tokio::spawn(async move {
        let mut last_buttons = 0u8;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Input>(&line) else { continue };
            let events: smallvec::SmallVec<[FastPathInputEvent; 2]> = match event {
                // Taille fixe : le bureau garde sa taille, l'onglet le met à l'échelle.
                Input::Resize { .. } if fixed => continue,
                Input::Resize { width, height } => {
                    // L'onglet a changé de taille : le bureau distant s'adapte (ou la session se reconnecte à la nouvelle taille).
                    let _ = keys.send(RdpInputEvent::Resize { width: width.max(640), height: height.max(480), scale_factor: 100, physical_size: None });
                    continue;
                }
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
                Input::SendFiles { paths } => {
                    shared.lock().unwrap_or_else(|e| e.into_inner()).offer(paths);
                    continue;
                }
                Input::FetchFiles { dir } => {
                    shared.lock().unwrap_or_else(|e| e.into_inner()).fetch(dir);
                    continue;
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
        // Portunia fermé : on ferme la session.
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

/// Options d'affichage annoncées au serveur selon la qualité choisie. Elles réduisent ce que
/// Windows dessine (fond d'écran, animations), sans changer le décodage de l'image : les
/// enregistrements de la Gate se relisent de la même façon.
fn performance(quality: &str) -> PerformanceFlags {
    match quality {
        "fast" => {
            PerformanceFlags::DISABLE_WALLPAPER
                | PerformanceFlags::DISABLE_FULLWINDOWDRAG
                | PerformanceFlags::DISABLE_MENUANIMATIONS
                | PerformanceFlags::DISABLE_THEMING
                | PerformanceFlags::DISABLE_CURSOR_SHADOW
        }
        "best" => PerformanceFlags::ENABLE_FONT_SMOOTHING | PerformanceFlags::ENABLE_DESKTOP_COMPOSITION,
        _ => PerformanceFlags::default(),
    }
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
    if lower.contains("client advertised") {
        format!("Le serveur refuse NLA. S'il s'agit d'un serveur de confiance qui ne le propose pas (xrdp, ancien Windows), cochez « Accepter les serveurs sans NLA » dans la session. ({raw})")
    } else if lower.contains("logon") || lower.contains("credential") || lower.contains("credssp") || lower.contains("0xc000006d") || lower.contains("authentication") {
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
    for (x, y, tw, th) in merge_runs(changed) {
        emit_pixels(&pixels(x, y, tw, th, |out| {
            for row in y..y + th {
                for &px in &current[row * w + x..row * w + x + tw] {
                    // 0x00RRGGBB → R, G, B, A
                    out.extend_from_slice(&[(px >> 16) as u8, (px >> 8) as u8, px as u8, 255]);
                }
            }
        }));
    }
}

/// Carrés voisins d'une même rangée réunis en une seule zone : moins de messages.
fn merge_runs(tiles: Vec<(usize, usize, usize, usize)>) -> Vec<(usize, usize, usize, usize)> {
    let mut out: Vec<(usize, usize, usize, usize)> = Vec::with_capacity(tiles.len());
    for (x, y, w, h) in tiles {
        match out.last_mut() {
            Some(last) if last.1 == y && last.0 + last.2 == x && last.3 == h => last.2 += w,
            _ => out.push((x, y, w, h)),
        }
    }
    out
}

/// Version RGBA (image d'IronRDP) : compare à l'image précédente (vide : tout envoyer).
pub(crate) fn send_rgba_changes(previous: &[u8], current: &[u8], width: u16, height: u16) {
    let (w, h) = (width as usize, height as usize);
    if current.len() < w * h * 4 {
        return;
    }
    let mut changed = Vec::new();
    for ty in (0..h).step_by(TILE) {
        for tx in (0..w).step_by(TILE) {
            let tw = TILE.min(w - tx);
            let th = TILE.min(h - ty);
            let differs = previous.len() != current.len()
                || (ty..ty + th).any(|y| {
                    let row = (y * w + tx) * 4;
                    previous[row..row + tw * 4] != current[row..row + tw * 4]
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
    for (x, y, tw, th) in merge_runs(changed) {
        emit_pixels(&pixels(x, y, tw, th, |out| {
            for row in y..y + th {
                let start = (row * w + x) * 4;
                for px in current[start..start + tw * 4].chunks_exact(4) {
                    out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
            }
        }));
    }
}

/// Traite les messages Windows du fil courant (presse-papiers), sans bloquer.
#[cfg(windows)]
async fn pump_windows_messages() {
    use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE};
    loop {
        let mut msg = MSG::default();
        // SAFETY : appels Win32 classiques sur le fil qui possède la fenêtre.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[cfg(not(windows))]
async fn pump_windows_messages() {
    std::future::pending::<()>().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paquet_de_pixels() {
        let p = pixels(3, 64, 2, 1, |out| out.extend_from_slice(&[1, 2, 3, 255, 4, 5, 6, 255]));
        assert_eq!(&p[..9], &[b'P', 3, 0, 64, 0, 2, 0, 1, 0]);
        assert_eq!(p.len(), 9 + 2 * 4);
    }

    #[test]
    fn carres_voisins_reunis() {
        let tiles = vec![(0, 0, 64, 64), (64, 0, 64, 64), (192, 0, 64, 64), (0, 64, 64, 64), (64, 64, 32, 64)];
        assert_eq!(merge_runs(tiles), vec![(0, 0, 128, 64), (192, 0, 64, 64), (0, 64, 96, 64)]);
    }
}
