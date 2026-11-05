//! Bureau à distance (RDP), de deux façons :
//! - dans un onglet, grâce au moteur IronRDP du programme auxiliaire `portunia-rdp.exe` ;
//! - dans le client Bureau à distance de Windows (mstsc), pour ce qu'IronRDP ne gère pas encore.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
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
            version: "0.3.0".into(),
            description: t!("Windows desktop in a tab (IronRDP), or in the Windows Remote Desktop client.", "Bureau Windows dans un onglet (IronRDP), ou dans le client Bureau à distance de Windows.").into(),
            view: ViewKind::Screen,
            builtin: true,
            catalog: false,
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
                    choice(&[("tab", t!("In a tab", "Dans un onglet")), ("mstsc", if cfg!(target_os = "macos") { t!("Windows App", "Windows App") } else { t!("Windows client (mstsc)", "Client Windows (mstsc)") })]),
                )
                .default("tab"),
                Field::new("password", t!("Password", "Mot de passe"), FieldKind::Secret).show_if("client", "tab").hidden_by("credential"),
                Field::new(
                    "allowNoNla",
                    t!("Accept servers without NLA (xrdp, old systems): less secure", "Accepter les serveurs sans NLA (xrdp, anciens systèmes) : moins sûr"),
                    FieldKind::Bool,
                )
                .default(false)
                .show_if("client", "tab"),
                // Ce que Windows dessine : moins d'effets, moins de données sur une liaison lente.
                Field::new(
                    "quality",
                    t!("Quality", "Qualité"),
                    choice(&[
                        ("balanced", t!("Balanced", "Équilibrée")),
                        ("fast", t!("Fast (no wallpaper or themes, slow links)", "Rapide (sans fond d'écran ni thèmes, liaison lente)")),
                        ("best", t!("Best (all visual effects)", "Maximale (tous les effets visuels)")),
                    ]),
                )
                .default("balanced")
                .show_if("client", "tab"),
                Field::new(
                    "resolution",
                    t!("Resolution", "Résolution"),
                    choice(&[
                        ("auto", t!("Fit the tab or window", "Celle de l'onglet ou de la fenêtre")),
                        ("1280x720", "1280 × 720"),
                        ("1600x900", "1600 × 900"),
                        ("1920x1080", "1920 × 1080"),
                        ("2560x1440", "2560 × 1440"),
                    ]),
                )
                .default("auto"),
                Field::new(
                    "colorDepth",
                    t!("Colours", "Couleurs"),
                    choice(&[("0", t!("Automatic", "Automatique")), ("32", t!("32 bits", "32 bits")), ("24", t!("24 bits", "24 bits")), ("16", t!("16 bits (slow links)", "16 bits (liaison lente)"))]),
                )
                .default("0"),
                Field::new("sound", t!("Play the server's sound here", "Jouer le son du serveur ici"), FieldKind::Bool).default(true),
                // Passerelle Bureau à distance (RD Gateway) : serveurs atteints par HTTPS.
                Field::new("gateway", t!("Remote Desktop Gateway", "Passerelle Bureau à distance"), FieldKind::Text)
                    .placeholder(t!("Optional: rdg.company.com (port 443 by default)", "Facultatif : rdg.entreprise.fr (port 443 par défaut)")),
                Field::new("gatewayUser", t!("Gateway user", "Utilisateur de la passerelle"), FieldKind::Text)
                    .placeholder(t!("Empty = same credentials as the server", "Vide = mêmes identifiants que le serveur")),
                Field::new("gatewayPassword", t!("Gateway password", "Mot de passe de la passerelle"), FieldKind::Secret).show_if("client", "tab"),
                Field::new("fullscreen", t!("Full screen", "Plein écran"), FieldKind::Bool).default(false).show_if("client", "mstsc"),
                Field::new("multimon", t!("Use all screens", "Utiliser tous les écrans"), FieldKind::Bool)
                    .default(false)
                    .show_if("client", "mstsc"),
                Field::new("drives", t!("Share this computer's drives", "Partager les lecteurs de ce poste"), FieldKind::Bool)
                    .default(false)
                    .show_if("client", "mstsc"),
                Field::new("printers", t!("Share this computer's printers", "Partager les imprimantes de ce poste"), FieldKind::Bool)
                    .default(false)
                    .show_if("client", "mstsc"),
                Field::new("admin", t!("Administration session (console)", "Session d'administration (console)"), FieldKind::Bool)
                    .default(false)
                    .show_if("client", "mstsc"),
                Field::new("remoteApp", t!("RemoteApp: program only", "RemoteApp : programme seul"), FieldKind::Text)
                    .placeholder(t!("Optional: C:\\Program Files\\App\\app.exe or ||alias", "Facultatif : C:\\Program Files\\App\\app.exe ou ||alias"))
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
pub(crate) fn helper_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "portunia-rdp.exe" } else { "portunia-rdp" };
    let beside = std::env::current_exe().ok()?.parent()?.join(name);
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("rdp-helper").join("target");
    [beside, dev.join("release").join(name), dev.join("debug").join(name)]
        .into_iter()
        .find(|p| p.exists())
}

/// Message du moteur RDP : une ligne JSON, ou une zone d'image binaire annoncée par
/// `{"type":"pixels","bytes":n}` et suivie de ses n octets (voir `pixels_packet`).
pub(crate) enum EngineMessage {
    Json(Value),
    Pixels(Vec<u8>),
}

/// Lit la sortie du moteur jusqu'à sa fin, ou jusqu'à ce que `on` renvoie false.
pub(crate) fn read_engine(stdout: impl Read, mut on: impl FnMut(EngineMessage) -> bool) {
    let mut reader = BufReader::with_capacity(1 << 20, stdout);
    let mut line = String::new();
    loop {
        line.clear();
        if !matches!(reader.read_line(&mut line), Ok(n) if n > 0) {
            return;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim_end()) else { continue };
        let message = if message["type"] == "pixels" {
            let len = message["bytes"].as_u64().unwrap_or(0) as usize;
            // Au plus une image 8K en RGBA : au-delà, la sortie est incompréhensible.
            if len > 9 + 8192 * 8192 * 4 {
                return;
            }
            let mut packet = vec![0; len];
            if reader.read_exact(&mut packet).is_err() {
                return;
            }
            EngineMessage::Pixels(packet)
        } else {
            EngineMessage::Json(message)
        };
        if !on(message) {
            return;
        }
    }
}

/// Résolution choisie (« 1920x1080 »), ou rien pour suivre l'onglet ou la fenêtre.
fn fixed_resolution(ctx: &ConnectContext) -> Option<(u16, u16)> {
    let value = ctx.str("resolution")?;
    let (w, h) = value.split_once('x')?;
    Some((w.parse().ok().filter(|w| (640..=8192).contains(w))?, h.parse().ok().filter(|h| (480..=8192).contains(h))?))
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
    // Serveur derrière une Gate (rebond) : le moteur passe par un tunnel SSH local,
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

    // Pour une vue écran, l'interface transmet la taille de l'onglet en pixels ; une résolution
    // fixe la remplace, et l'onglet met alors l'image à l'échelle.
    let fixed = fixed_resolution(ctx);
    let (width, height) = fixed.unwrap_or((ctx.cols, ctx.rows));
    let mut settings = json!({
        "host": host, "port": port, "username": username, "domain": domain, "password": password,
        "width": width, "height": height, "fixedSize": fixed.is_some(),
    });
    settings["sound"] = json!(ctx.values.get("sound").and_then(Value::as_bool).unwrap_or(true));
    settings["colorDepth"] = json!(ctx.str("colorDepth").and_then(|d| d.parse::<u32>().ok()).unwrap_or(0));
    if let Some(gateway) = ctx.str("gateway").filter(|g| !g.trim().is_empty()) {
        settings["gateway"] = json!({
            "host": gateway.trim(),
            "username": ctx.str("gatewayUser").unwrap_or_default(),
            "password": ctx.raw("gatewayPassword").unwrap_or_default(),
        });
    }
    // NLA exigé par défaut : un faux serveur ne peut pas faire passer la connexion en TLS simple,
    // où le mot de passe serait envoyé au serveur lui-même.
    settings["nlaOnly"] = json!(!ctx.bool("allowNoNla"));
    settings["quality"] = json!(ctx.str("quality").unwrap_or_default());
    // Copie de fichiers par le presse-papiers ; une Gate dit si la règle la permet.
    settings["files"] = json!(ctx.values.get("files").and_then(Value::as_bool).unwrap_or(true));
    // Gate, mode enregistré : passage RDCleanPath avec un jeton à usage unique.
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
        read_engine(stdout, |message| {
            let message = match message {
                EngineMessage::Pixels(packet) => {
                    sink.screen_pixels(packet);
                    return true;
                }
                EngineMessage::Json(message) => message,
            };
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
                    return false;
                }
                _ => {
                    if let Ok(event) = serde_json::from_value::<ScreenEvent>(message) {
                        sink.screen(event);
                    }
                }
            }
            true
        });
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
            InputEvent::SendFiles { paths } => self.send(json!({ "type": "sendFiles", "paths": paths })),
            InputEvent::FetchFiles { dir } => self.send(json!({ "type": "fetchFiles", "dir": dir })),
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
    if let Some((w, h)) = fixed_resolution(ctx) {
        lines.extend([format!("desktopwidth:i:{w}"), format!("desktopheight:i:{h}"), "smart sizing:i:1".into()]);
    }
    if let Some(depth) = ctx.str("colorDepth").filter(|d| ["32", "24", "16"].contains(&d.as_str())) {
        lines.push(format!("session bpp:i:{depth}"));
    }
    // 0 : son joué sur ce poste ; 2 : pas de son.
    let sound = ctx.values.get("sound").and_then(Value::as_bool).unwrap_or(true);
    lines.push(format!("audiomode:i:{}", if sound { 0 } else { 2 }));
    if ctx.bool("drives") {
        lines.push("drivestoredirect:s:*".into());
    }
    lines.push(format!("redirectprinters:i:{}", ctx.bool("printers") as u8));
    if ctx.bool("admin") {
        lines.push("administrative session:i:1".into());
    }
    if let Some(gateway) = ctx.str("gateway").map(|g| g.trim().to_string()).filter(|g| !g.is_empty()) {
        single_line(&gateway, t!("The gateway", "La passerelle"))?;
        // 1 : toujours passer par la passerelle ; mêmes identifiants que le serveur si aucun n'est donné.
        lines.extend([format!("gatewayhostname:s:{gateway}"), "gatewayusagemethod:i:1".into(), "gatewayprofileusagemethod:i:1".into(), "gatewaycredentialssource:i:0".into()]);
        match ctx.str("gatewayUser").filter(|u| !u.trim().is_empty()) {
            Some(user) => {
                single_line(&user, t!("The gateway user", "L'utilisateur de la passerelle"))?;
                lines.extend(["promptcredentialonce:i:0".into(), format!("gatewayusername:s:{user}")]);
            }
            None => lines.push("promptcredentialonce:i:1".into()),
        }
    }
    // RemoteApp : la fenêtre du programme seule, au lieu du bureau entier.
    if let Some(program) = ctx.str("remoteApp").map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        single_line(&program, t!("The RemoteApp program", "Le programme RemoteApp"))?;
        let name = program.trim_start_matches("||").rsplit(['\\', '/']).next().unwrap_or(&program).trim_end_matches(".exe").to_string();
        lines.extend([
            "remoteapplicationmode:i:1".into(),
            format!("remoteapplicationprogram:s:{program}"),
            format!("remoteapplicationname:s:{name}"),
            "disableremoteappcapscheck:i:1".into(),
        ]);
    }

    // Fichier .rdp en UTF-16 avec BOM, comme ceux enregistrés par Windows.
    let dir = ctx.data_dir.join("rdp");
    fs::create_dir_all(&dir)?;
    prepare_rdp_dir(&dir)?;
    let safe_name: String = ctx
        .session_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let path = dir.join(rdp_file_name(&safe_name));
    let mut bytes = vec![0xFF, 0xFE];
    for unit in (lines.join("\r\n") + "\r\n").encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    write_rdp_file(&path, &bytes)?;
    launch_external_client(&path)?;
    Ok(Outcome::Detached(format!("Bureau à distance ouvert vers {host}")))
}

/// Windows : nom stable, dossier laissé tel quel (comportement d'origine).
#[cfg(windows)]
fn rdp_file_name(safe_name: &str) -> String {
    format!("{safe_name}.rdp")
}

/// Unix : nom unique par lancement, pour que le minuteur de suppression d'une connexion
/// n'efface pas le fichier d'une autre.
#[cfg(not(windows))]
fn rdp_file_name(safe_name: &str) -> String {
    format!("{safe_name}-{}.rdp", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

#[cfg(windows)]
fn prepare_rdp_dir(_dir: &Path) -> Result<()> {
    Ok(())
}

/// Dossier réservé à l'utilisateur (0700) ; purge les .rdp oubliés (arrêt de Portunia avant le minuteur).
#[cfg(not(windows))]
fn prepare_rdp_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    purge_stale_rdp(dir, RDP_FILE_LIFETIME);
    Ok(())
}

/// Supprime les `.rdp` du dossier plus vieux que `max_age`. Les erreurs sont ignorées : c'est du ménage.
#[cfg(not(windows))]
fn purge_stale_rdp(dir: &Path, max_age: std::time::Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = path.extension().is_some_and(|e| e == "rdp")
            && entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max_age);
        if stale {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
fn write_rdp_file(path: &Path, bytes: &[u8]) -> Result<()> {
    Ok(fs::write(path, bytes)?)
}

/// Fichier .rdp créé neuf, lisible par son seul propriétaire (0600) : un fichier ou un lien
/// symbolique déjà présent est écarté, jamais suivi ni réutilisé.
#[cfg(not(windows))]
fn write_rdp_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    std::io::Write::write_all(&mut file, bytes)?;
    Ok(())
}

#[cfg(windows)]
fn launch_external_client(path: &Path) -> Result<()> {
    Command::new("mstsc.exe")
        .arg(path)
        .spawn()
        .context(t!("Cannot start the Remote Desktop client (mstsc.exe)", "Impossible de lancer le client Bureau à distance (mstsc.exe)"))?;
    Ok(())
}

/// Identifiant de Windows App (ex-« Microsoft Remote Desktop ») et sa page de l'App Store.
#[cfg(not(windows))]
const WINDOWS_APP_BUNDLE: &str = "com.microsoft.rdc.macos";
#[cfg(not(windows))]
const WINDOWS_APP_STORE: &str = "https://apps.apple.com/app/windows-app/id1295203466";

/// Arguments de `open` pour ouvrir le fichier .rdp dans Windows App (le chemin reste un argument
/// distinct : jamais de chaîne shell).
#[cfg(not(windows))]
fn open_args(path: &Path) -> Vec<std::ffi::OsString> {
    vec!["-b".into(), WINDOWS_APP_BUNDLE.into(), path.as_os_str().to_owned()]
}

/// Délai avant de supprimer le .rdp temporaire : le temps que Windows App le lise.
#[cfg(not(windows))]
const RDP_FILE_LIFETIME: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(target_os = "macos")]
fn launch_external_client(path: &Path) -> Result<()> {
    let status = Command::new("open").args(open_args(path)).stdout(Stdio::null()).stderr(Stdio::null()).status();
    if !matches!(status, Ok(s) if s.success()) {
        let _ = fs::remove_file(path);
        bail!(t!(
            format!("Windows App is not installed. Install it from the App Store: {WINDOWS_APP_STORE}"),
            format!("Windows App n'est pas installée. Installez-la depuis l'App Store : {WINDOWS_APP_STORE}")
        ));
    }
    // Le fichier .rdp ne sert qu'à ouvrir la session : on ne le garde pas.
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        std::thread::sleep(RDP_FILE_LIFETIME);
        let _ = fs::remove_file(path);
    });
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn launch_external_client(path: &Path) -> Result<()> {
    let _ = fs::remove_file(path);
    bail!(t!("The external RDP client is only available on Windows and macOS", "Le client RDP externe n'est disponible que sous Windows et macOS"))
}

#[cfg(all(test, not(windows)))]
mod external_client_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn open_cible_windows_app_sans_chaine_shell() {
        let args = open_args(Path::new("/tmp/a b; rm -rf x.rdp"));
        assert_eq!(args, ["-b", "com.microsoft.rdc.macos", "/tmp/a b; rm -rf x.rdp"]);
    }

    #[test]
    fn le_fichier_rdp_est_prive_et_sans_mot_de_passe() {
        let dir = std::env::temp_dir().join(format!("portunia-rdp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.rdp");
        // Un fichier déjà présent avec des droits larges doit être resserré.
        fs::write(&path, "ancien").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_rdp_file(&path, b"full address:s:h:3389\r\n").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read(&path).unwrap(), b"full address:s:h:3389\r\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn le_nom_du_moteur_n_a_pas_d_extension_exe() {
        if let Some(path) = helper_path() {
            assert!(!path.to_string_lossy().ends_with(".exe"));
        }
    }

    #[test]
    fn un_lien_symbolique_n_est_pas_suivi() {
        let dir = std::env::temp_dir().join(format!("portunia-rdp-link-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("cible");
        fs::write(&target, "intact").unwrap();
        let path = dir.join("s.rdp");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        write_rdp_file(&path, b"neuf").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"intact");
        assert_eq!(fs::read(&path).unwrap(), b"neuf");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn les_noms_de_fichier_sont_uniques() {
        let (a, b) = (rdp_file_name("srv"), rdp_file_name("srv"));
        assert_ne!(a, b);
        assert!(a.starts_with("srv-") && a.ends_with(".rdp"));
    }

    #[test]
    fn le_dossier_est_prive_et_les_vieux_rdp_sont_purges() {
        let dir = std::env::temp_dir().join(format!("portunia-rdp-purge-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let old = dir.join("vieux.rdp");
        let fresh = dir.join("frais.rdp");
        let other = dir.join("autre.txt");
        for f in [&old, &fresh, &other] {
            fs::write(f, "x").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for f in [&old, &other] {
            fs::File::options().write(true).open(f).unwrap().set_modified(long_ago).unwrap();
        }
        prepare_rdp_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert!(!old.exists(), "le vieux .rdp doit être supprimé");
        assert!(fresh.exists(), "un .rdp récent est conservé (autre connexion en cours)");
        assert!(other.exists(), "seuls les .rdp sont purgés");
        fs::remove_dir_all(&dir).unwrap();
    }
}
