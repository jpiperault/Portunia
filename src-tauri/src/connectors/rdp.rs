//! Bureau à distance (RDP), de deux façons :
//! - dans un onglet, grâce au moteur IronRDP du programme auxiliaire `portunia-rdp.exe` ;
//! - dans le client Bureau à distance de Windows (mstsc), pour ce qu'IronRDP ne gère pas encore.

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use super::single_line;
use crate::connector::*;

pub struct RdpConnector;

impl Connector for RdpConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "rdp".into(),
            name: t!("Remote Desktop (RDP)", "Bureau à distance (RDP)").into(),
            version: "0.2.0".into(),
            description: t!("Windows desktop in a tab (IronRDP), or in the Windows Remote Desktop client.", "Bureau Windows dans un onglet (IronRDP), ou dans le client Bureau à distance de Windows.").into(),
            view: ViewKind::Screen,
            builtin: true,
            file_browser: false,
            port_forwarding: false,
            fields: vec![
                Field::new("host", t!("Host", "Hôte"), FieldKind::Text).required(),
                Field::new("port", "Port", FieldKind::Number).default(3389),
                Field::new("credential", t!("Shared credentials", "Identifiants partagés"), FieldKind::Suggest { source: "credentials".into() })
                    .placeholder(t!("Empty = this session's own credentials", "Vide = identifiants propres à cette session")),
                Field::new("username", t!("User", "Utilisateur"), FieldKind::Text)
                    .placeholder(t!("DOMAIN\\user", "DOMAINE\\utilisateur"))
                    .hidden_by("credential"),
                Field::new(
                    "client",
                    t!("Display", "Affichage"),
                    choice(&[("tab", t!("In a tab", "Dans un onglet")), ("mstsc", t!("Windows client (mstsc)", "Client Windows (mstsc)"))]),
                )
                .default("tab"),
                Field::new("password", t!("Password", "Mot de passe"), FieldKind::Secret).show_if("client", "tab").hidden_by("credential"),
                Field::new("fullscreen", t!("Full screen", "Plein écran"), FieldKind::Bool).default(false).show_if("client", "mstsc"),
                Field::new("multimon", t!("Use all screens", "Utiliser tous les écrans"), FieldKind::Bool)
                    .default(false)
                    .show_if("client", "mstsc"),
                Field::new("mac", t!("MAC address (Wake-on-LAN)", "Adresse MAC (Wake-on-LAN)"), FieldKind::Text)
                    .placeholder(t!("Optional: AA:BB:CC:DD:EE:FF, to wake the machine up", "Facultatif : AA:BB:CC:DD:EE:FF, pour réveiller la machine")),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        if ctx.str("client").as_deref() == Some("mstsc") {
            return connect_mstsc(&ctx);
        }
        connect_embedded(&ctx)
    }
}

// ---------- Dans un onglet (IronRDP) ----------

/// Emplacement de `portunia-rdp.exe` : à côté de Portunia une fois installé,
/// sinon dans le dossier de compilation du programme auxiliaire (développement).
fn helper_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "portunia-rdp.exe" } else { "portunia-rdp" };
    let beside = std::env::current_exe().ok()?.parent()?.join(name);
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("rdp-helper").join("target");
    [beside, dev.join("release").join(name), dev.join("debug").join(name)]
        .into_iter()
        .find(|p| p.exists())
}

fn split_user(raw: &str) -> (String, String) {
    match raw.split_once('\\') {
        Some((domain, user)) => (domain.to_string(), user.to_string()),
        None => (String::new(), raw.to_string()),
    }
}

fn connect_embedded(ctx: &ConnectContext) -> Result<Outcome> {
    let host = ctx.require("host", t!("Host", "Hôte"))?;
    let port = ctx.port(3389)?;
    // Serveur derrière un bastion Heimdia (rebond) : le moteur passe par un tunnel SSH local,
    // l'authentification Windows reste de bout en bout.
    let (host, port) = match ctx.values.get("jumpHost") {
        Some(Value::Object(_)) => ("127.0.0.1".to_string(), super::ssh::local_tunnel(ctx, &host, port)?),
        _ => (host, port),
    };
    let (domain, username) = split_user(&ctx.str("username").unwrap_or_default());
    let password = ctx.raw("password").unwrap_or_default();
    let helper = helper_path().ok_or_else(|| {
        anyhow!(t!("RDP engine not found (portunia-rdp.exe). Reinstall Portunia, or choose the « Windows client » display.", "Moteur RDP introuvable (portunia-rdp.exe). Réinstallez Portunia, ou choisissez l'affichage « Client Windows »."))
    })?;

    let mut command = Command::new(&helper);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().context(t!("Cannot start the RDP engine", "Impossible de lancer le moteur RDP"))?;
    let mut stdin = child.stdin.take().context(t!("RDP engine: input unavailable", "Moteur RDP : entrée indisponible"))?;
    let stdout = child.stdout.take().context(t!("RDP engine: output unavailable", "Moteur RDP : sortie indisponible"))?;

    // Pour une vue écran, l'interface transmet la taille de l'onglet en pixels.
    let mut settings = json!({
        "host": host, "port": port, "username": username, "domain": domain, "password": password,
        "width": ctx.cols, "height": ctx.rows,
    });
    // Bastion Heimdia, mode enregistré : passage RDCleanPath avec un jeton à usage unique.
    if let (Some(url), Some(token)) = (ctx.str("rdcleanpathUrl"), ctx.raw("rdcleanpathToken")) {
        settings["rdcleanpath"] = json!({ "url": url, "token": token });
    }
    writeln!(stdin, "{settings}")?;
    stdin.flush()?;

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let sink = ctx.sink.clone();
    thread::Builder::new().name("rdp-out".into()).spawn(move || {
        let mut ready = Some(ready_tx);
        let mut ended = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            match message["type"].as_str() {
                Some("connected") => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Some("closed") => {
                    let reason = message["reason"].as_str().map(String::from);
                    match ready.take() {
                        Some(tx) => {
                            let _ = tx.send(Err(reason.unwrap_or_else(|| t!("The server closed the connection", "Le serveur a fermé la connexion").into())));
                        }
                        None => sink.closed(reason),
                    }
                    ended = true;
                    break;
                }
                _ => {
                    if let Ok(event) = serde_json::from_value::<ScreenEvent>(message) {
                        sink.screen(event);
                    }
                }
            }
        }
        if !ended {
            let reason = t!("The RDP engine stopped", "Le moteur RDP s'est arrêté").to_string();
            match ready.take() {
                Some(tx) => {
                    let _ = tx.send(Err(reason));
                }
                None => sink.closed(Some(reason)),
            }
        }
    })?;

    match ready_rx.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => {
            let _ = child.kill();
            bail!("{reason}");
        }
        Err(_) => {
            let _ = child.kill();
            bail!("{}", t!(format!("No answer from RDP server {host}:{port}"), format!("Pas de réponse du serveur RDP {host}:{port}")));
        }
    }

    Ok(Outcome::Terminal(Box::new(RdpSession {
        stdin: Mutex::new(stdin),
        child: Arc::new(Mutex::new(child)),
    })))
}

struct RdpSession {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
}

impl RdpSession {
    fn send(&self, message: Value) -> Result<()> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{message}").map_err(|_| anyhow!(t!("Session closed", "Session fermée")))?;
        stdin.flush().map_err(|_| anyhow!(t!("Session closed", "Session fermée")))
    }
}

impl TerminalConnection for RdpSession {
    fn write(&self, _data: &[u8]) -> Result<()> {
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }

    fn close(&self) {
        let _ = self.send(json!({ "type": "close" }));
        // Laisse au moteur le temps de se déconnecter proprement, puis l'arrête.
        let child = self.child.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            let _ = child.lock().unwrap().kill();
        });
    }

    fn input(&self, event: InputEvent) -> Result<()> {
        match event {
            InputEvent::Key { code: Some(code), down, .. } => {
                self.send(json!({ "type": "key", "code": code, "down": down }))
            }
            InputEvent::Key { .. } => Ok(()),
            InputEvent::Pointer { x, y, buttons } => {
                self.send(json!({ "type": "pointer", "x": x, "y": y, "buttons": buttons }))
            }
            InputEvent::Resize { width, height } => {
                self.send(json!({ "type": "resize", "width": width, "height": height }))
            }
            // Le presse-papiers RDP est synchronisé directement par le moteur (presse-papiers Windows).
            InputEvent::Clipboard { .. } => Ok(()),
        }
    }
}

impl Drop for RdpSession {
    fn drop(&mut self) {
        let child = self.child.clone();
        // Après un `close`, on laisse le temps de se déconnecter proprement.
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(3));
            let _ = child.lock().unwrap().kill();
        });
    }
}

// ---------- Client Windows (mstsc) ----------

fn connect_mstsc(ctx: &ConnectContext) -> Result<Outcome> {
    let host = ctx.require("host", t!("Host", "Hôte"))?;
    let port = ctx.port(3389)?;
    let username = ctx.str("username").unwrap_or_default();
    single_line(&host, t!("The host", "L'hôte"))?;
    single_line(&username, "L'utilisateur")?;

    let mut lines = vec![
        format!("full address:s:{host}:{port}"),
        format!("screen mode id:i:{}", if ctx.bool("fullscreen") { 2 } else { 1 }),
        format!("use multimon:i:{}", ctx.bool("multimon") as u8),
        "prompt for credentials:i:0".into(),
        "authentication level:i:2".into(),
    ];
    if !username.is_empty() {
        lines.push(format!("username:s:{username}"));
    }

    // Fichier .rdp en UTF-16 avec BOM, comme ceux enregistrés par Windows.
    let dir = ctx.data_dir.join("rdp");
    fs::create_dir_all(&dir)?;
    let safe_name: String = ctx
        .session_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let path = dir.join(format!("{safe_name}.rdp"));
    let mut bytes = vec![0xFF, 0xFE];
    for unit in (lines.join("\r\n") + "\r\n").encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    fs::write(&path, bytes)?;

    Command::new("mstsc.exe")
        .arg(&path)
        .spawn()
        .context(t!("Cannot start the Remote Desktop client (mstsc.exe)", "Impossible de lancer le client Bureau à distance (mstsc.exe)"))?;
    Ok(Outcome::Detached(format!("Bureau à distance ouvert vers {host}")))
}
