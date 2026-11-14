//! Extension « Navigation par la Gate » (Pro) : Edge, Chrome ou Brave, dans un profil à part,
//! dont tout le trafic passe par une sortie web de Portunia Gate (0.48).
//!
//! Portunia se connecte au SSH de la Gate sous « login%sortie » avec un jeton à usage unique,
//! ouvre un proxy SOCKS5 sur 127.0.0.1 (port tiré au hasard) et lance le navigateur réglé pour
//! s'en servir, sans résolution DNS sur le PC, sans HTTP/3 ni WebRTC hors du proxy. Chaque
//! connexion du navigateur devient un canal « direct-tcpip » : la Gate filtre le site, le
//! résout, refuse les réseaux internes et le note au journal.
//!
//! Tout s'arrête ensemble : navigateur fermé, bouton Arrêter, Portunia fermé ou coupure par
//! la Gate (le navigateur est alors fermé, et sans proxy il ne passe plus du tout).

use std::{
    collections::HashMap,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Result};
use russh::{
    client,
    keys::{HashAlg, PublicKey, PublicKeyOrCertificate},
    ChannelOpenFailure, Disconnect,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::Notify,
};

use crate::connector::BoxFuture;
use crate::connectors::forward::socks5_handshake;
use crate::extension::{args, reply, unknown, Emit, ExtManifest, Extension, Host};
use crate::license::Feature;

pub struct Browse;

/// Une navigation en cours, par Gate et sortie web.
struct Running {
    id: String,
    gate: String,
    server: String,
    gate_name: String,
    port: u16,
    browser: Browser,
    profile: PathBuf,
    started: chrono::DateTime<chrono::Utc>,
    stop: Arc<Notify>,
    stats: Arc<Stats>,
    /// Processus du navigateur : tué à la fin, même à la fermeture brusque de Portunia.
    child: Arc<Mutex<std::process::Child>>,
}

#[derive(Default)]
struct Stats {
    open: AtomicUsize,
    total: AtomicU64,
    refused: AtomicU64,
    bytes: AtomicU64,
}

static RUNNING: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);

fn key(gate: &str, server: &str) -> String {
    format!("{gate}/{server}")
}

// ---------- Navigateurs ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    pub id: &'static str,
    pub name: &'static str,
    pub path: PathBuf,
}

/// Navigateurs Chromium installés (le proxy et les réglages passent par la ligne de commande ;
/// Firefox demanderait de modifier son profil).
pub fn browsers() -> Vec<Browser> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let (pf, pf86, local) = (env("ProgramFiles"), env("ProgramFiles(x86)"), env("LOCALAPPDATA"));
        let list: [(&'static str, &'static str, Vec<Option<PathBuf>>); 3] = [
            ("chrome", "Google Chrome", vec![
                pf.clone().map(|p| p.join(r"Google\Chrome\Application\chrome.exe")),
                pf86.clone().map(|p| p.join(r"Google\Chrome\Application\chrome.exe")),
                local.clone().map(|p| p.join(r"Google\Chrome\Application\chrome.exe")),
            ]),
            ("edge", "Microsoft Edge", vec![
                pf86.clone().map(|p| p.join(r"Microsoft\Edge\Application\msedge.exe")),
                pf.clone().map(|p| p.join(r"Microsoft\Edge\Application\msedge.exe")),
            ]),
            ("brave", "Brave", vec![
                pf.clone().map(|p| p.join(r"BraveSoftware\Brave-Browser\Application\brave.exe")),
                local.clone().map(|p| p.join(r"BraveSoftware\Brave-Browser\Application\brave.exe")),
            ]),
        ];
        for (id, name, paths) in list {
            if let Some(path) = paths.into_iter().flatten().find(|p| p.is_file()) {
                out.push(Browser { id, name, path });
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for (id, name, path) in [
            ("chrome", "Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ("edge", "Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            ("brave", "Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            ("chromium", "Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ] {
            let path = PathBuf::from(path);
            if path.is_file() {
                out.push(Browser { id, name, path });
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        for (id, name, bins) in [
            ("chrome", "Google Chrome", &["google-chrome", "google-chrome-stable"][..]),
            ("edge", "Microsoft Edge", &["microsoft-edge", "microsoft-edge-stable"][..]),
            ("brave", "Brave", &["brave-browser", "brave"][..]),
            ("chromium", "Chromium", &["chromium", "chromium-browser"][..]),
        ] {
            if let Some(path) = bins.iter().flat_map(|b| dirs.iter().map(move |d| d.join(b))).find(|p| p.is_file()) {
                out.push(Browser { id, name, path });
            }
        }
    }
    out
}

/// Réglages du navigateur : profil à part, tout par le proxy, rien en direct.
pub fn browser_args(profile: &Path, port: u16, url: Option<&str>) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", profile.display()),
        format!("--proxy-server=socks5://127.0.0.1:{port}"),
        // Aucun nom résolu sur le PC : c'est la Gate qui résout (sinon fuite DNS).
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1".into(),
        // Même la boucle locale passe par le proxy (la Gate la refuse) : une page ne joint pas le PC.
        "--proxy-bypass-list=<-loopback>".into(),
        // HTTP/3 et WebRTC passent par UDP, que le proxy ne transmet pas.
        "--disable-quic".into(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--new-window".into(),
    ];
    if let Some(url) = url.filter(|u| !u.trim().is_empty()) {
        a.push(normalize_url(url));
    }
    a
}

/// Adresse tapée : « github.com » devient « https://github.com » ; seuls http et https sont permis.
fn normalize_url(url: &str) -> String {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        url.to_string()
    } else {
        format!("https://{}", url.trim_start_matches(|c: char| c == '/' || c == ':'))
    }
}

/// Dossier du profil : un par Gate (cookies et historique gardés d'une fois sur l'autre,
/// jamais mêlés à ceux du navigateur habituel).
fn profile_dir(data_dir: &Path, gate: &str) -> PathBuf {
    let safe: String = gate.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    data_dir.join("navigateur").join(safe)
}

fn launch(browser: &Browser, profile: &Path, port: u16, url: Option<&str>) -> Result<std::process::Child> {
    std::fs::create_dir_all(profile)?;
    let mut command = std::process::Command::new(&browser.path);
    command.args(browser_args(profile, port, url)).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    command.spawn().map_err(|e| anyhow!(t!(format!("Cannot start {}: {e}", browser.name), format!("Impossible de lancer {} : {e}", browser.name))))
}

// ---------- SSH de la Gate ----------

/// Vérifie la clé SSH de la Gate (empreinte donnée par son API, vérifiée par TLS) et garde la
/// raison d'une coupure.
struct GateSsh {
    fingerprint: String,
    reason: Arc<Mutex<Option<String>>>,
}

impl client::Handler for GateSsh {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let public = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        Ok(public.fingerprint(HashAlg::Sha256).to_string() == self.fingerprint)
    }

    async fn disconnected(&mut self, reason: client::DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        let text = match reason {
            client::DisconnectReason::ReceivedDisconnect(info) => info.message,
            client::DisconnectReason::Error(e) => e.to_string(),
        };
        self.reason.lock().unwrap().get_or_insert(text);
        Ok(())
    }
}

/// Réponse SOCKS5 à un refus de la Gate : 2 = interdit par les règles, 5 = refusé par le site.
fn socks_code(e: &russh::Error) -> u8 {
    match e {
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited) => 2,
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::ResourceShortage) => 1,
        _ => 5,
    }
}

/// Une connexion du navigateur : négociation SOCKS5, canal vers la Gate, puis relais.
async fn serve(handle: Arc<client::Handle<GateSsh>>, mut socket: TcpStream, stats: Arc<Stats>) -> Result<()> {
    let (host, port) = socks5_handshake(&mut socket).await?;
    let peer = socket.peer_addr()?.port();
    let channel = match handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", peer as u32).await {
        Ok(c) => c,
        Err(e) => {
            stats.refused.fetch_add(1, Ordering::Relaxed);
            let _ = socket.write_all(&[5, socks_code(&e), 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Ok(());
        }
    };
    socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    let _ = socket.set_nodelay(true);
    stats.total.fetch_add(1, Ordering::Relaxed);
    stats.open.fetch_add(1, Ordering::Relaxed);
    let mut stream = channel.into_stream();
    let copied = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
    stats.open.fetch_sub(1, Ordering::Relaxed);
    if let Ok((a, b)) = copied {
        stats.bytes.fetch_add(a + b, Ordering::Relaxed);
    }
    Ok(())
}

// ---------- Méthodes ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs {
    gate_id: String,
    server: String,
    #[serde(default)]
    url: Option<String>,
    /// chrome, edge, brave ou chromium ; absent : le premier trouvé.
    #[serde(default)]
    browser: Option<String>,
}

#[derive(Deserialize)]
struct StopArgs {
    id: String,
}

fn view(r: &Running) -> Value {
    json!({
        "id": r.id, "gateId": r.gate, "server": r.server, "gateName": r.gate_name, "port": r.port,
        "browser": r.browser.name, "started": r.started.to_rfc3339(),
        "open": r.stats.open.load(Ordering::Relaxed), "total": r.stats.total.load(Ordering::Relaxed),
        "refused": r.stats.refused.load(Ordering::Relaxed), "bytes": r.stats.bytes.load(Ordering::Relaxed),
    })
}

/// Connexion SSH à la sortie web de la Gate, authentifiée par le jeton à usage unique ; la clé
/// du serveur doit être celle que l'API a donnée. Rend aussi où lire la raison d'une coupure.
async fn connect_gate(host: &str, port: u16, user: &str, ticket: &str, fingerprint: &str) -> Result<(Arc<client::Handle<GateSsh>>, Arc<Mutex<Option<String>>>)> {
    let reason = Arc::new(Mutex::new(None));
    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(15)), keepalive_max: 3, ..Default::default() });
    let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host, port)))
        .await
        .map_err(|_| anyhow!(t!("Gate unreachable (timed out)", "Gate injoignable (délai dépassé)")))??;
    let _ = tcp.set_nodelay(true);
    let handler = GateSsh { fingerprint: fingerprint.to_string(), reason: reason.clone() };
    let mut handle = tokio::time::timeout(Duration::from_secs(15), client::connect_stream(config, tcp, handler))
        .await
        .map_err(|_| anyhow!(t!("The Gate does not answer over SSH", "La Gate ne répond pas en SSH")))?
        .map_err(|e| match e {
            russh::Error::UnknownKey => anyhow!(t!("The Gate's SSH key does not match the one its API gave: connection refused", "La clé SSH de la Gate ne correspond pas à celle donnée par son API : connexion refusée")),
            e => e.into(),
        })?;
    if !handle.authenticate_password(user, ticket).await?.success() {
        bail!(t!("The Gate refused the token", "La Gate a refusé le jeton"));
    }
    Ok((Arc::new(handle), reason))
}

/// Proxy SOCKS5 sur 127.0.0.1 (port tiré au hasard) : chaque connexion devient un canal vers la Gate.
async fn open_proxy(handle: Arc<client::Handle<GateSsh>>, stats: Arc<Stats>) -> Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let accept = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let (handle, stats) = (handle.clone(), stats.clone());
            tokio::spawn(async move {
                let _ = serve(handle, socket, stats).await;
            });
        }
    });
    Ok((port, accept))
}

async fn start(host: &dyn Host, a: StartArgs) -> Result<Value> {
    let data_dir = host.data_dir();
    // Déjà ouverte : une fenêtre de plus dans le même navigateur (même proxy).
    let existing = RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).get(&key(&a.gate_id, &a.server)).map(|r| (r.browser.clone(), r.profile.clone(), r.port, view(r)));
    if let Some((browser, profile, port, v)) = existing {
        launch(&browser, &profile, port, a.url.as_deref())?;
        return Ok(v);
    }
    let found = browsers();
    let browser = match a.browser.as_deref().filter(|b| !b.is_empty()) {
        Some(wanted) => found.iter().find(|b| b.id == wanted).cloned().ok_or_else(|| anyhow!(t!(format!("Browser « {wanted} » not found"), format!("Navigateur « {wanted} » introuvable"))))?,
        None => found.first().cloned().ok_or_else(|| anyhow!(t!("No Chrome, Edge or Brave found on this PC", "Aucun Chrome, Edge ni Brave trouvé sur ce PC")))?,
    };
    let emit = host.events()?;

    let route = crate::gate::egress_route(&data_dir, &a.gate_id, &a.server).await?;
    let (handle, reason) = connect_gate(&route.host, route.port, &route.user, &route.ticket, &route.fingerprint).await?;

    let stats = Arc::new(Stats::default());
    let (port, accept) = open_proxy(handle.clone(), stats.clone()).await?;
    let profile = profile_dir(&data_dir, &a.gate_id);
    let child = match launch(&browser, &profile, port, a.url.as_deref()) {
        Ok(c) => Arc::new(Mutex::new(c)),
        Err(e) => {
            accept.abort();
            let _ = handle.disconnect(Disconnect::ByApplication, "", "fr").await;
            return Err(e);
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(Notify::new());
    let running = Running {
        id: id.clone(),
        gate: a.gate_id.clone(),
        server: a.server.clone(),
        gate_name: route.gate_name.clone(),
        port,
        browser: browser.clone(),
        profile,
        started: chrono::Utc::now(),
        stop: stop.clone(),
        stats: stats.clone(),
        child: child.clone(),
    };
    let first = view(&running);
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).insert(key(&a.gate_id, &a.server), running);
    emit(json!({ "type": "started", "navigation": first }));

    let k = key(&a.gate_id, &a.server);
    host.spawn(Box::pin(watch(handle, child, stop, stats, reason, accept, emit, k, id.clone())));
    Ok(first)
}

/// Surveille la navigation jusqu'à sa fin et prévient l'interface.
#[allow(clippy::too_many_arguments)]
async fn watch(
    handle: Arc<client::Handle<GateSsh>>,
    child: Arc<Mutex<std::process::Child>>,
    stop: Arc<Notify>,
    stats: Arc<Stats>,
    reason: Arc<Mutex<Option<String>>>,
    accept: tokio::task::JoinHandle<()>,
    emit: Emit,
    k: String,
    id: String,
) {
    let started = Instant::now();
    let mut last = (usize::MAX, u64::MAX, u64::MAX);
    let why: String = loop {
        tokio::select! {
            _ = stop.notified() => {
                let _ = child.lock().unwrap().kill();
                break t!("Browsing stopped", "Navigation arrêtée").into();
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
        let exited = matches!(child.lock().unwrap().try_wait(), Ok(Some(_)));
        if exited {
            // Fermé aussitôt sans rien avoir ouvert : le profil était déjà ouvert par un autre
            // navigateur (qui n'utilise pas ce proxy), la fenêtre lui a été passée.
            if started.elapsed() < Duration::from_secs(5) && stats.total.load(Ordering::Relaxed) == 0 {
                break t!(
                    "The browser closed at once: a Portunia browser window for this Gate is probably still open. Close it, then try again.",
                    "Le navigateur s'est fermé aussitôt : une fenêtre de navigation Portunia pour cette Gate est sans doute encore ouverte. Fermez-la, puis recommencez."
                )
                .into();
            }
            break t!("Browser closed", "Navigateur fermé").into();
        }
        if handle.is_closed() {
            let _ = child.lock().unwrap().kill();
            let gate = reason.lock().unwrap().clone().filter(|r| !r.is_empty());
            break match gate {
                Some(r) => t!(format!("The Gate cut the browsing: {r}"), format!("La Gate a coupé la navigation : {r}")),
                None => t!("Connection to the Gate lost: browsing stopped", "Liaison avec la Gate perdue : navigation arrêtée").into(),
            };
        }
        let now = (stats.open.load(Ordering::Relaxed), stats.total.load(Ordering::Relaxed), stats.bytes.load(Ordering::Relaxed));
        if now != last {
            last = now;
            emit(json!({ "type": "stats", "id": id, "open": now.0, "total": now.1, "bytes": now.2, "refused": stats.refused.load(Ordering::Relaxed) }));
        }
    };
    accept.abort();
    let _ = child.lock().unwrap().wait();
    let _ = handle.disconnect(Disconnect::ByApplication, "", "fr").await;
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&k);
    emit(json!({ "type": "closed", "id": id, "reason": why }));
}

/// Arrête toutes les navigations (fermeture de Portunia).
pub fn stop_all() {
    for r in RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).values() {
        r.stop.notify_one();
        let _ = r.child.lock().unwrap().kill();
    }
}

impl Extension for Browse {
    fn manifest(&self) -> ExtManifest {
        ExtManifest {
            id: "browse",
            name: t!("Browsing through the Gate", "Navigation par la Gate").into(),
            feature: Some(Feature::GateBrowse),
            // Voir, arrêter et lister les navigateurs restent permis sans licence.
            free: &["stop", "list", "browsers"],
        }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, a: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "start" => start(host, args(a)?).await,
                "stop" => {
                    let StopArgs { id } = args(a)?;
                    let found = RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).values().find(|r| r.id == id).map(|r| r.stop.clone());
                    if let Some(stop) = &found {
                        stop.notify_one();
                    }
                    reply(found.is_some())
                }
                "list" => reply(RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).values().map(view).collect::<Vec<_>>()),
                "browsers" => reply(browsers()),
                _ => Err(unknown("browse", method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reglages_du_navigateur() {
        let a = browser_args(Path::new("/tmp/p"), 41234, Some("github.com"));
        assert!(a.contains(&"--proxy-server=socks5://127.0.0.1:41234".to_string()));
        assert!(a.iter().any(|x| x.starts_with("--host-resolver-rules=MAP * ~NOTFOUND")));
        assert!(a.contains(&"--disable-quic".to_string()));
        assert!(a.contains(&"--proxy-bypass-list=<-loopback>".to_string()));
        assert_eq!(a.last().unwrap(), "https://github.com");
        assert!(!browser_args(Path::new("/tmp/p"), 1, None).iter().any(|x| x.starts_with("https")));
    }

    #[test]
    fn adresses_tapees() {
        assert_eq!(normalize_url("example.org/x"), "https://example.org/x");
        assert_eq!(normalize_url("http://intranet"), "http://intranet");
        assert_eq!(normalize_url(" HTTPS://a.b "), "HTTPS://a.b");
        // Ni fichier local ni javascript : tout devient une adresse https.
        assert_eq!(normalize_url("javascript:alert(1)"), "https://javascript:alert(1)");
        assert_eq!(normalize_url("file:///etc/passwd"), "https://file:///etc/passwd");
    }

    #[test]
    fn profil_par_gate() {
        let p = profile_dir(Path::new("/d"), "../../x y");
        assert!(p.ends_with("______x_y"));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "navigateur");
    }

    #[test]
    fn codes_socks() {
        assert_eq!(socks_code(&russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited)), 2);
        assert_eq!(socks_code(&russh::Error::ChannelOpenFailure(ChannelOpenFailure::ConnectFailed)), 5);
    }

    /// Essai réel contre une Gate (banc) : jeton à usage unique obtenu juste avant.
    /// BANC_SSH=hôte:port BANC_USER=login%sortie BANC_TICKET=hj1_… BANC_FP=SHA256:… [BANC_OK=example.com]
    /// [BANC_REFUSE=192.168.1.1] [BANC_BROWSER=1] cargo test --lib sortie_reelle -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn sortie_reelle() {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let (host, port) = env("BANC_SSH").rsplit_once(':').map(|(h, p)| (h.to_string(), p.parse::<u16>().unwrap())).expect("BANC_SSH");
        let (handle, _) = connect_gate(&host, port, &env("BANC_USER"), &env("BANC_TICKET"), &env("BANC_FP")).await.expect("connexion à la Gate");
        let stats = Arc::new(Stats::default());
        let (proxy, _accept) = open_proxy(handle.clone(), stats.clone()).await.unwrap();
        // Requête HTTP brute à travers le proxy SOCKS5 : réponse du site, code SOCKS sinon.
        async fn through(proxy: u16, site: &str) -> Result<String, u8> {
            use tokio::io::AsyncReadExt;
            let mut s = TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();
            let mut req = vec![5, 1, 0, 5, 1, 0, 3, site.len() as u8];
            req.extend_from_slice(site.as_bytes());
            req.extend_from_slice(&80u16.to_be_bytes());
            s.write_all(&req).await.unwrap();
            let mut head = [0u8; 12];
            s.read_exact(&mut head).await.unwrap();
            if head[3] != 0 {
                return Err(head[3]);
            }
            s.write_all(format!("GET / HTTP/1.1
Host: {site}
Connection: close

").as_bytes()).await.unwrap();
            let mut out = String::new();
            let _ = tokio::time::timeout(Duration::from_secs(15), s.read_to_string(&mut out)).await;
            Ok(out)
        }
        let ok = std::env::var("BANC_OK").unwrap_or_else(|_| "example.com".into());
        let page = through(proxy, &ok).await.expect("site permis");
        println!("{ok} : {}", page.lines().next().unwrap_or_default());
        assert!(page.starts_with("HTTP/1.1"), "réponse HTTP attendue");
        let refuse = std::env::var("BANC_REFUSE").unwrap_or_else(|_| "192.168.1.1".into());
        assert_eq!(through(proxy, &refuse).await.err(), Some(2), "réseau interne refusé par la Gate");
        assert_eq!(through(proxy, "localhost").await.err(), Some(2), "boucle locale refusée");
        if env("BANC_BROWSER") == "1" {
            // Navigateur sans fenêtre, avec les réglages de Portunia : la page arrive par la Gate.
            let b = browsers().into_iter().next().expect("navigateur");
            let profile = std::env::temp_dir().join(format!("portunia-essai-navigation-{}", std::process::id()));
            let mut args = browser_args(&profile, proxy, None);
            args.retain(|a| a != "--new-window");
            args.extend(["--headless=new".into(), "--disable-gpu".into(), "--dump-dom".into(), format!("http://{ok}/")]);
            let out = tokio::task::spawn_blocking(move || std::process::Command::new(&b.path).args(&args).output()).await.unwrap().unwrap();
            let dom = String::from_utf8_lossy(&out.stdout);
            println!("{} : {} octets de page", b.name, dom.len());
            let _ = std::fs::remove_dir_all(&profile);
            assert!(dom.contains("<html"), "page reçue par le navigateur");
            assert!(stats.total.load(Ordering::Relaxed) >= 2);
        }
        let _ = handle.disconnect(Disconnect::ByApplication, "", "fr").await;
    }
}
