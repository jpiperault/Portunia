//! Extension Portunia Gate : Gates SSH ajoutés dans Portunia.
//!
//! L'API de la Gate (HTTPS, certificat vérifié par son empreinte) donne un jeton de
//! session après mot de passe et code ; pour chaque ouverture, Portunia demande un jeton
//! SSH à usage unique et se connecte avec « login%serveur » au port SSH de la Gate.
//! Le jeton de session reste dans le Gestionnaire d'identifiants Windows.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, bail, Result};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State};

use crate::commands::{err, full, start_connection, AppState, CmdResult, ConnectResponse};

const FILE: &str = "gates.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub id: String,
    pub name: String,
    /// Hôte de l'API (et du SSH) : « Gate.acme.local ».
    pub host: String,
    pub api_port: u16,
    pub ssh_port: u16,
    /// Empreinte SHA-256 du certificat de l'API, vérifiée à chaque appel.
    pub api_fingerprint: String,
    pub ssh_fingerprint: String,
    pub login: String,
    #[serde(default)]
    pub role: String,
    /// Fin de la session de la Gate (RFC 3339) ; vide = déconnecté.
    #[serde(default)]
    pub expires: String,
    #[serde(default)]
    pub remember_allowed: bool,
    /// La Gate laisse chaque compte relire ses propres sessions.
    #[serde(default)]
    pub own_replay: bool,
    /// Dernière liste connue des serveurs, affichée grisée hors connexion.
    #[serde(default)]
    pub servers: Vec<Value>,
    /// Noms d'hôte publiés par Cloudflare en TCP (Gate 0.41) : accès de l'extérieur par cloudflared.
    #[serde(default)]
    pub cloudflare: Option<CfHosts>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CfHosts {
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub ssh: String,
    #[serde(default)]
    pub rdp: String,
}

// ---------- Accès direct ou par Cloudflare ----------

#[derive(Clone, Copy, PartialEq)]
enum Svc {
    Api,
    Ssh,
    Rdp,
}

/// Décision retenue par Gate (passage par Cloudflare, moment) : revérifiée après 2 minutes.
static ROUTES: Mutex<Option<HashMap<String, (bool, std::time::Instant)>>> = Mutex::new(None);
const ROUTE_TTL: std::time::Duration = std::time::Duration::from_secs(120);

fn remember_route(id: &str, cloudflare: bool) {
    ROUTES.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.to_string(), (cloudflare, std::time::Instant::now()));
}

/// Faut-il passer par Cloudflare ? Seulement si la Gate publie son API en TCP et que son adresse
/// directe ne répond pas (essai de 3 s).
async fn via_cloudflare(b: &Gate) -> bool {
    if b.cloudflare.as_ref().is_none_or(|c| c.api.is_empty()) {
        return false;
    }
    let known = ROUTES.lock().unwrap().as_ref().and_then(|m| m.get(&b.id).copied());
    if let Some((cf, at)) = known {
        if at.elapsed() < ROUTE_TTL {
            return cf;
        }
    }
    let direct = tokio::time::timeout(std::time::Duration::from_secs(3), tokio::net::TcpStream::connect((b.host.as_str(), b.api_port))).await.is_ok_and(|r| r.is_ok());
    remember_route(&b.id, !direct);
    !direct
}

/// Où joindre un service de la Gate : son adresse, ou le port local de cloudflared (port 0 pour
/// le RDP natif en direct : l'adresse vient alors de la Gate).
async fn reach(data_dir: &Path, b: &Gate, svc: Svc) -> Result<(String, u16)> {
    let direct = match svc {
        Svc::Api => (b.host.clone(), b.api_port),
        Svc::Ssh => (b.host.clone(), b.ssh_port),
        Svc::Rdp => (b.host.clone(), 0),
    };
    if !via_cloudflare(b).await {
        return Ok(direct);
    }
    let cf = b.cloudflare.clone().unwrap_or_default();
    let (host, what) = match svc {
        Svc::Api => (cf.api, "API"),
        Svc::Ssh => (cf.ssh, "SSH"),
        Svc::Rdp => (cf.rdp, "RDP"),
    };
    if host.is_empty() {
        bail!(
            "{}",
            t!(
                format!("Gate unreachable directly, and its {what} is not published through Cloudflare"),
                format!("Gate injoignable directement, et son {what} n'est pas publié par Cloudflare")
            )
        );
    }
    let port = crate::cloudflared::forward(data_dir, &host).await?;
    Ok(("127.0.0.1".to_string(), port))
}

/// Adresse de l'API (directe ou par cloudflared), en erreur lisible.
async fn api_at(data_dir: &Path, b: &Gate) -> CmdResult<(String, u16)> {
    reach(data_dir, b, Svc::Api).await.map_err(full)
}

impl Gate {
    fn secret_id(&self) -> String {
        format!("gate-{}", self.id)
    }
    fn connected(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.expires).is_ok_and(|e| e > chrono::Utc::now())
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

fn load(data_dir: &Path) -> Vec<Gate> {
    crate::vault::load_json(&path(data_dir)).0
}

fn save(data_dir: &Path, list: &[Gate]) -> Result<()> {
    crate::vault::write(&path(data_dir), &serde_json::to_string_pretty(list)?)
}

fn find(data_dir: &Path, id: &str) -> Result<Gate> {
    load(data_dir).into_iter().find(|b| b.id == id).ok_or_else(|| anyhow!(t!("Unknown Gate", "Gate inconnu")))
}

fn update(data_dir: &Path, gate: &Gate) -> Result<()> {
    let mut list = load(data_dir);
    match list.iter_mut().find(|b| b.id == gate.id) {
        Some(b) => *b = gate.clone(),
        None => list.push(gate.clone()),
    }
    save(data_dir, &list)
}

/// « hôte », « hôte:port » ou « https://hôte:port » → (hôte, port de l'API).
fn split_address(address: &str) -> Result<(String, u16)> {
    let a = address.trim().trim_start_matches("https://").trim_end_matches('/');
    if a.is_empty() {
        bail!(t!("Give the Gate's address", "Indiquez l'adresse de la Gate"));
    }
    match a.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') || h.starts_with('[') => {
            Ok((h.trim_matches(['[', ']']).to_string(), p.parse().map_err(|_| anyhow!("{}", t!(format!("Invalid port: {p}"), format!("Port invalide : {p}"))))?))
        }
        _ => Ok((a.trim_matches(['[', ']']).to_string(), 8443)),
    }
}

// ---------- HTTPS avec certificat épinglé ----------

/// Accepte le certificat si son empreinte est celle attendue ; sans empreinte attendue
/// (premier contact), accepte et note l'empreinte vue, qui est montrée à l'utilisateur.
#[derive(Debug)]
struct Pinned {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

pub fn fingerprint(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    digest.as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end.as_ref());
        *self.seen.lock().unwrap() = Some(fp.clone());
        match &self.expected {
            Some(expected) if expected != &fp => Err(rustls::Error::General(format!("empreinte du certificat différente ({fp})"))),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub(crate) fn client(expected: Option<&str>) -> Result<(reqwest::Client, Arc<Mutex<Option<String>>>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let seen = Arc::new(Mutex::new(None));
    let verifier = Pinned { expected: expected.map(str::to_owned), seen: seen.clone(), provider: provider.clone() };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let http = reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Portunia/", env!("CARGO_PKG_VERSION")))
        // Messages de la Gate dans la langue de l'interface.
        .default_headers(reqwest::header::HeaderMap::from_iter([(
            reqwest::header::ACCEPT_LANGUAGE,
            reqwest::header::HeaderValue::from_static(crate::lang::code()),
        )]))
        .build()?;
    Ok((http, seen))
}

/// Relais local vers l'API de la Gate, en TLS avec le certificat épinglé : le moteur RDP s'y
/// connecte en clair sur 127.0.0.1 (passage RDCleanPath de la Gate). Une seule connexion.
async fn pinned_forwarder(host: &str, port: u16, fingerprint: &str) -> Result<u16> {
    let mut tls = pinned_tls(host, port, fingerprint).await?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let local = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        if let Ok(Ok((mut socket, _))) = tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept()).await {
            let _ = socket.set_nodelay(true);
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut tls).await;
        }
    });
    Ok(local)
}

/// Relais local de longue durée vers l'API de la Gate (interfaces web) : la fenêtre web ouvre
/// plusieurs connexions, chacune part en TLS épinglé. Fermé après `lifetime`.
async fn pinned_listener(host: String, port: u16, fingerprint: String, lifetime: std::time::Duration) -> Result<u16> {
    // Vérifie tout de suite que la Gate répond avec le bon certificat.
    drop(pinned_tls(&host, port, &fingerprint).await?);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let local = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        let end = tokio::time::sleep(lifetime);
        tokio::pin!(end);
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { continue };
                    let (host, fingerprint) = (host.clone(), fingerprint.clone());
                    tauri::async_runtime::spawn(async move {
                        if let Ok(mut tls) = pinned_tls(&host, port, &fingerprint).await {
                            let _ = socket.set_nodelay(true);
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut tls).await;
                        }
                    });
                }
                _ = &mut end => break,
            }
        }
    });
    Ok(local)
}

/// Configuration TLS qui n'accepte que le certificat de cette empreinte (Gate, Proxmox).
pub(crate) fn pinned_config(fingerprint: &str) -> Result<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Pinned { expected: Some(fingerprint.to_string()), seen: Arc::default(), provider: provider.clone() };
    Ok(ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()?.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth())
}

/// Connexion TLS à l'API de la Gate, certificat vérifié par son empreinte.
async fn pinned_tls(host: &str, port: u16, fingerprint: &str) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Pinned { expected: Some(fingerprint.to_string()), seen: Arc::default(), provider: provider.clone() };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).map_err(|_| anyhow!(t!("Invalid Gate address", "Adresse de la Gate invalide")))?;
    let tcp = tokio::net::TcpStream::connect((host, port)).await.map_err(|e| anyhow!("{}", t!(format!("Gate unreachable ({host}:{port}): {e}"), format!("Gate injoignable ({host}:{port}) : {e}"))))?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|e| anyhow!("{}", t!(format!("Gate {host}:{port}: {e}"), format!("Gate {host}:{port} : {e}"))))?;
    Ok(tls)
}

/// Appel de l'API. Erreur « SESSION_EXPIREE » si le jeton n'est plus valable.
async fn call(host: &str, port: u16, fingerprint: &str, token: Option<&str>, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
    let (http, _) = client(Some(fingerprint))?;
    let mut req = http.request(method, format!("https://{host}:{port}/api/v1{path}"));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| anyhow!("{}", t!(format!("Gate unreachable ({host}:{port}): {}", root_cause(&e)), format!("Gate injoignable ({host}:{port}) : {}", root_cause(&e)))))?;
    let status = resp.status();
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::UNAUTHORIZED && token.is_some() {
        bail!("SESSION_EXPIREE");
    }
    if !status.is_success() {
        bail!("{}", value.get("erreur").and_then(Value::as_str).unwrap_or(status.as_str()));
    }
    Ok(value)
}

pub(crate) fn root_cause(e: &dyn std::error::Error) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

fn token(b: &Gate) -> Result<String> {
    crate::secrets::get(&b.secret_id(), "jeton")?.ok_or_else(|| anyhow!("SESSION_EXPIREE"))
}

/// Appel authentifié ; sur session expirée, la Gate est marqué déconnecté.
async fn authed(data_dir: &Path, b: &mut Gate, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
    let t = token(b)?;
    let (host, port) = reach(data_dir, b, Svc::Api).await?;
    match call(&host, port, &b.api_fingerprint, Some(&t), method, path, body).await {
        Err(e) if e.to_string() == "SESSION_EXPIREE" => {
            b.expires.clear();
            let _ = crate::secrets::delete(&b.secret_id(), "jeton");
            let _ = update(data_dir, b);
            Err(e)
        }
        other => other,
    }
}

// ---------- Commandes ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateView {
    #[serde(flatten)]
    gate: Gate,
    connected: bool,
    password_saved: bool,
}

fn view(b: Gate) -> GateView {
    let password_saved = crate::secrets::get(&b.secret_id(), "mot_de_passe").ok().flatten().is_some();
    GateView { connected: b.connected(), password_saved, gate: b }
}

#[tauri::command]
pub fn gate_list(state: State<'_, AppState>) -> CmdResult<Vec<GateView>> {
    state.unlocked()?;
    Ok(load(&state.data_dir).into_iter().map(view).collect())
}

/// Premier contact : empreinte du certificat et informations publiques de la Gate.
#[tauri::command]
pub async fn gate_probe(state: State<'_, AppState>, address: String) -> CmdResult<Value> {
    let (host, port) = split_address(&address).map_err(full)?;
    let (http, seen) = client(None).map_err(full)?;
    let direct = http.get(format!("https://{host}:{port}/api/v1/gate")).send().await;
    // Adresse injoignable : peut-être l'API publiée par Cloudflare en TCP (de l'extérieur).
    let mut cloudflare = false;
    let resp = match direct {
        Ok(r) => r,
        Err(e) if host.contains('.') && host.parse::<std::net::IpAddr>().is_err() && !e.is_status() => {
            let local = crate::cloudflared::forward(&state.data_dir, &host).await.map_err(|c| format!("Gate injoignable ({host}:{port}) : {} ; Cloudflare : {c}", root_cause(&e)))?;
            cloudflare = true;
            http.get(format!("https://127.0.0.1:{local}/api/v1/gate")).send().await.map_err(|e| format!("Gate injoignable ({host}, Cloudflare) : {}", root_cause(&e)))?
        }
        Err(e) => return Err(format!("Gate injoignable ({host}:{port}) : {}", root_cause(&e))),
    };
    let info: Value = resp.json().await.map_err(|_| t!("This server does not answer like a Gate", "Ce serveur ne répond pas comme une Gate").to_string())?;
    if info.get("empreinte_ssh").is_none() {
        return Err(t!("This server does not answer like a Gate", "Ce serveur ne répond pas comme une Gate").into());
    }
    let fp = seen.lock().unwrap().clone().unwrap_or_default();
    Ok(json!({ "host": host, "apiPort": port, "fingerprint": fp, "info": info, "cloudflare": cloudflare }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// Gate déjà ajouté (reconnexion) ; sinon ajout.
    id: Option<String>,
    host: String,
    api_port: u16,
    fingerprint: String,
    login: String,
    password: Option<String>,
    code: Option<String>,
    new_password: Option<String>,
    remember: bool,
    /// Premier contact passé par Cloudflare : `host` est le nom d'hôte de l'API publié en TCP.
    #[serde(default)]
    cloudflare: bool,
}

/// Connexion (ou reconnexion) : renvoie l'état donné par la Gate (« code_requis »,
/// « changer_mot_de_passe », « enrolement » avec le secret à scanner) ou la Gate connecté.
#[tauri::command]
pub async fn gate_login(state: State<'_, AppState>, request: LoginRequest) -> CmdResult<Value> {
    state.unlocked()?;
    let data_dir = state.data_dir.clone();
    let existing = request.id.as_deref().and_then(|id| find(&data_dir, id).ok());
    // Mot de passe mémorisé : utilisé si aucun n'est tapé.
    let password = match request.password.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => existing
            .as_ref()
            .and_then(|b| crate::secrets::get(&b.secret_id(), "mot_de_passe").ok().flatten())
            .ok_or("MOT_DE_PASSE_REQUIS")?,
    };
    let body = json!({
        "login": request.login,
        "mot_de_passe": password,
        "code": request.code,
        "nouveau_mot_de_passe": request.new_password,
        "client": format!("Portunia {} · {}", env!("CARGO_PKG_VERSION"), std::env::var("COMPUTERNAME").unwrap_or_default()),
    });
    // Reconnexion : même passage que les autres appels ; premier contact par Cloudflare : son relais.
    let (host, port) = match &existing {
        Some(b) if b.host == request.host && b.api_port == request.api_port => api_at(&data_dir, b).await?,
        _ if request.cloudflare => ("127.0.0.1".to_string(), crate::cloudflared::forward(&data_dir, &request.host).await.map_err(full)?),
        _ => (request.host.clone(), request.api_port),
    };
    let answer = call(&host, port, &request.fingerprint, None, reqwest::Method::POST, "/connexion", Some(body)).await.map_err(full)?;
    if answer.get("etat").and_then(Value::as_str) != Some("ok") {
        return Ok(answer);
    }
    let info = &answer["gate"];
    let mut b = existing.unwrap_or_else(|| Gate { id: uuid::Uuid::new_v4().to_string(), ..Default::default() });
    b.name = info["nom"].as_str().unwrap_or("Portunia Gate").to_string();
    b.host = request.host.clone();
    b.api_port = request.api_port;
    b.api_fingerprint = request.fingerprint.clone();
    b.ssh_port = info["port_ssh"].as_u64().unwrap_or(2222) as u16;
    b.ssh_fingerprint = info["empreinte_ssh"].as_str().unwrap_or_default().to_string();
    b.login = request.login.clone();
    b.role = answer["compte"]["role"].as_str().unwrap_or("user").to_string();
    b.expires = answer["expire"].as_str().unwrap_or_default().to_string();
    b.remember_allowed = info["memo_mot_de_passe"].as_bool().unwrap_or(false);
    b.own_replay = info["relecture_propres"].as_bool().unwrap_or(false);
    b.cloudflare = serde_json::from_value::<CfHosts>(info["cloudflare"].clone()).ok();
    if request.cloudflare && b.cloudflare.as_ref().is_none_or(|c| c.api.is_empty()) {
        b.cloudflare = Some(CfHosts { api: request.host.clone(), ..b.cloudflare.clone().unwrap_or_default() });
    }
    if request.cloudflare {
        remember_route(&b.id, true);
    }
    crate::secrets::set(&b.secret_id(), "jeton", answer["jeton"].as_str().unwrap_or_default()).map_err(full)?;
    // Mot de passe gardé seulement si l'utilisateur le demande et que la Gate l'autorise.
    let final_password = request.new_password.filter(|p| !p.is_empty()).unwrap_or(password);
    if request.remember && b.remember_allowed {
        crate::secrets::set(&b.secret_id(), "mot_de_passe", &final_password).map_err(full)?;
    } else {
        let _ = crate::secrets::delete(&b.secret_id(), "mot_de_passe");
    }
    // L'empreinte SSH de la Gate vient de l'API vérifiée : pas de question à la première session.
    if !b.ssh_fingerprint.is_empty() {
        crate::connectors::ssh::remember_host(&data_dir, &format!("{}:{}", b.host, b.ssh_port), &b.ssh_fingerprint);
    }
    if let Ok(list) = call(&host, port, &b.api_fingerprint, answer["jeton"].as_str(), reqwest::Method::GET, "/serveurs", None).await {
        b.servers = list["serveurs"].as_array().cloned().unwrap_or_default();
    }
    update(&data_dir, &b).map_err(full)?;
    Ok(json!({ "etat": "ok", "gate": view(b) }))
}

#[tauri::command]
pub async fn gate_logout(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.unlocked()?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    if let (Ok(t), Ok((host, port))) = (token(&b), reach(&state.data_dir, &b, Svc::Api).await) {
        let _ = call(&host, port, &b.api_fingerprint, Some(&t), reqwest::Method::DELETE, "/connexion", None).await;
    }
    let _ = crate::secrets::delete(&b.secret_id(), "jeton");
    b.expires.clear();
    update(&state.data_dir, &b).map_err(full)
}

#[tauri::command]
pub async fn gate_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.unlocked()?;
    let _ = gate_logout(state.clone(), id.clone()).await;
    let b = find(&state.data_dir, &id).map_err(full)?;
    let _ = crate::secrets::delete(&b.secret_id(), "mot_de_passe");
    let mut list = load(&state.data_dir);
    list.retain(|x| x.id != id);
    save(&state.data_dir, &list).map_err(full)
}

/// Serveurs autorisés maintenant (et mise à jour de la liste gardée).
#[tauri::command]
pub async fn gate_servers(state: State<'_, AppState>, id: String) -> CmdResult<GateView> {
    state.unlocked()?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    let list = authed(&state.data_dir, &mut b, reqwest::Method::GET, "/serveurs", None).await.map_err(full)?;
    b.servers = list["serveurs"].as_array().cloned().unwrap_or_default();
    update(&state.data_dir, &b).map_err(full)?;
    Ok(view(b))
}

/// Appel d'administration (/admin/…) ou d'audit (/audit/…), réservé par la Gate aux rôles autorisés.
#[tauri::command]
pub async fn gate_admin(state: State<'_, AppState>, id: String, method: String, path: String, body: Option<Value>) -> CmdResult<Value> {
    state.unlocked()?;
    if !(path.starts_with("/admin/") || path.starts_with("/audit/")) || path.contains("..") {
        return Err(t!("Invalid administration path", "Chemin d'administration invalide").into());
    }
    // État de la Gate : pour tout administrateur de la Gate (offre gratuite) ; mise à jour
    // lancée ou annulée depuis Portunia : Pro ; le reste de l'administration : Équipes.
    let route = path.split('?').next().unwrap_or_default();
    let feature = if route == "/admin/etat" || (route == "/admin/mise-a-jour" && method == "GET") {
        None
    } else if route == "/admin/mise-a-jour" {
        Some(crate::license::Feature::GateUpdate)
    } else {
        Some(crate::license::Feature::GateAdmin)
    };
    if let Some(f) = feature {
        state.license.lock().unwrap().require(f).map_err(full)?;
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(err)?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    authed(&state.data_dir, &mut b, method, &path, body).await.map_err(full)
}

/// Export de l'audit (enregistrement, transcription), écrit dans le fichier choisi par l'utilisateur.
#[tauri::command]
pub fn gate_export(state: State<'_, AppState>, dest: String, content: String) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
    std::fs::write(&dest, content).map_err(|e| format!("Écriture impossible : {e}"))
}

/// Export binaire d'une relecture (vidéo) : octets bruts dans le corps de la requête, chemin
/// de destination en hexadécimal (UTF-8) dans l'en-tête « x-dest » (en-têtes ASCII seulement).
#[tauri::command]
pub fn gate_export_bytes(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
    let hex = request.headers().get("x-dest").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let bytes: Option<Vec<u8>> = (hex.len() % 2 == 0).then(|| (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()).flatten();
    let dest = bytes.and_then(|b| String::from_utf8(b).ok()).filter(|d| !d.is_empty()).ok_or_else(|| t!("Destination missing", "Destination manquante").to_string())?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(t!("Expected binary content", "Contenu binaire attendu").into());
    };
    std::fs::write(&dest, data).map_err(|e| format!("{} {e}", t!("Cannot write:", "Écriture impossible :")))
}

/// Export CSV du journal, écrit dans le fichier choisi.
#[tauri::command]
pub async fn gate_journal_csv(state: State<'_, AppState>, id: String, query: String, dest: String) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
    let b = find(&state.data_dir, &id).map_err(full)?;
    let t = token(&b).map_err(full)?;
    let (http, _) = client(Some(&b.api_fingerprint)).map_err(full)?;
    let (host, port) = api_at(&state.data_dir, &b).await?;
    let resp = http
        .get(format!("https://{host}:{port}/api/v1/admin/journal.csv?limite=5000&q={}", urlencode(&query)))
        .bearer_auth(t)
        .send()
        .await
        .map_err(|e| root_cause(&e))?;
    if !resp.status().is_success() {
        return Err(format!("Export refusé ({})", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(err)?;
    std::fs::write(&dest, bytes).map_err(|e| format!("Écriture impossible : {e}"))
}

pub(crate) fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Ouvre une session sur un serveur de la Gate. `extra` : identifiants tapés dans le
/// terminal (serveurs en mode rebond, comme pour la connexion rapide).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gate_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    server: String,
    extra: HashMap<String, Value>,
    cols: u16,
    rows: u16,
    on_event: Channel,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    let data_dir = state.data_dir.clone();
    let mut b = find(&data_dir, &id).map_err(full)?;
    let path = format!("/serveurs/{}/ticket", urlencode(&server));
    let t = authed(&data_dir, &mut b, reqwest::Method::POST, &path, None).await.map_err(full)?;
    let ticket = t["ticket"].as_str().ok_or(t!("The Gate gave no token", "La Gate n'a pas donné de jeton"))?.to_string();
    let ssh_user = t["utilisateur_ssh"].as_str().unwrap_or_default().to_string();
    // Interface web et Bureau à distance enregistré passent par l'API ; le reste par le SSH.
    let by_api = matches!(t["protocole"].as_str(), Some("http" | "https")) || (t["protocole"].as_str() == Some("rdp") && t["mode"].as_str() != Some("rebond"));
    let (ssh_host, ssh_port) = if by_api { (b.host.clone(), b.ssh_port) } else { reach(&data_dir, &b, Svc::Ssh).await.map_err(full)? };
    let (api_host, api_port) = if by_api { api_at(&data_dir, &b).await? } else { (b.host.clone(), b.api_port) };
    let gate_values: serde_json::Map<String, Value> = [
        ("host".to_string(), json!(ssh_host)),
        ("port".to_string(), json!(ssh_port)),
        // Relais local : la clé SSH reste vérifiée sous le nom réel de la Gate.
        ("hostKeyAlias".to_string(), json!(format!("{}:{}", b.host, b.ssh_port))),
        ("username".to_string(), json!(ssh_user)),
        ("auth".to_string(), json!("password")),
        ("password".to_string(), json!(ticket)),
    ]
    .into_iter()
    .collect();
    let mut values: HashMap<String, Value> = HashMap::new();
    let name = format!("{server} · {}", b.name);
    // Interface web : fenêtre web sur un relais local vers la Gate, qui relaie vers le serveur
    // et note les pages ouvertes. Le jeton ouvre une session web de 8 heures.
    if matches!(t["protocole"].as_str(), Some("http" | "https")) {
        let local = pinned_listener(api_host.clone(), api_port, b.api_fingerprint.clone(), std::time::Duration::from_secs(8 * 3600)).await.map_err(full)?;
        values.insert("url".into(), json!(format!("http://127.0.0.1:{local}/web/entree?jeton={}", urlencode(&ticket))));
        return start_connection(&app, &state, "web", name, values, cols, rows, on_event).await;
    }
    let vault = t["mode"].as_str() == Some("coffre");
    if t["protocole"].as_str() == Some("rdp") && (t["mode"].as_str() == Some("enregistre") || vault) {
        // Bureau à distance enregistré : passage RDCleanPath de la Gate (qui relaie et enregistre) ;
        // l'authentification Windows (NLA) reste entre le moteur RDP et le serveur. Coffre : la
        // Gate ouvre la session Windows elle-même, le moteur s'authentifie auprès d'elle avec le jeton.
        let local = pinned_forwarder(&api_host, api_port, &b.api_fingerprint).await.map_err(full)?;
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        values.insert("client".into(), json!("tab"));
        // Copie de fichiers : seulement si la règle de la Gate la permet (Gate 0.28 et suivantes).
        values.insert("files".into(), json!(t["fichiers"].as_bool().unwrap_or(false)));
        values.insert("rdcleanpathUrl".into(), json!(format!("ws://127.0.0.1:{local}/api/v1/rdp")));
        values.insert("rdcleanpathToken".into(), json!(ticket));
        if vault {
            values.insert("username".into(), json!("portunia"));
            values.insert("password".into(), json!(ticket));
        } else {
            values.extend(extra.into_iter().filter(|(k, _)| ["username", "password"].contains(&k.as_str())));
        }
        return start_connection(&app, &state, "rdp", name, values, cols, rows, on_event).await;
    }
    if t["protocole"].as_str() == Some("rdp") {
        // Bureau à distance en rebond : tunnel par la Gate, identifiants Windows de bout en bout.
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        values.insert("client".into(), json!("tab"));
        // Copie de fichiers : seulement si la règle de la Gate la permet (Gate 0.28 et suivantes).
        values.insert("files".into(), json!(t["fichiers"].as_bool().unwrap_or(false)));
        values.insert("jumpHost".into(), Value::Object(gate_values));
        values.extend(extra.into_iter().filter(|(k, _)| ["username", "password"].contains(&k.as_str())));
        return start_connection(&app, &state, "rdp", name, values, cols, rows, on_event).await;
    }
    if t["mode"].as_str() == Some("rebond") {
        // De bout en bout : la Gate relaie, l'authentification va au serveur.
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        if let Some(account) = t["compte"].as_str() {
            values.insert("username".into(), json!(account));
        }
        values.insert("auth".into(), json!("auto"));
        values.insert("jumpHost".into(), Value::Object(gate_values));
    } else {
        values.extend(gate_values);
    }
    values.extend(extra.into_iter().filter(|(k, _)| ["username", "password", "auth"].contains(&k.as_str())));
    start_connection(&app, &state, "ssh", name, values, cols, rows, on_event).await
}

/// Accès à une sortie web de la Gate (0.48) : où joindre son SSH (direct ou par cloudflared),
/// sous quel nom, avec quel jeton à usage unique, et l'empreinte attendue du serveur SSH.
pub(crate) struct EgressRoute {
    pub gate_name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub ticket: String,
    pub fingerprint: String,
}

pub(crate) async fn egress_route(data_dir: &Path, id: &str, server: &str) -> Result<EgressRoute> {
    let mut b = find(data_dir, id)?;
    if b.ssh_fingerprint.is_empty() {
        bail!(t!("Sign in to this Gate again: its SSH fingerprint is unknown", "Reconnectez-vous à cette Gate : l'empreinte de son SSH est inconnue"));
    }
    let path = format!("/serveurs/{}/ticket", urlencode(server));
    let t = authed(data_dir, &mut b, reqwest::Method::POST, &path, None).await?;
    if t["protocole"].as_str() != Some("sortie") {
        bail!(t!(format!("{server} is not a web egress"), format!("{server} n'est pas une sortie web")));
    }
    let ticket = t["ticket"].as_str().ok_or_else(|| anyhow!(t!("The Gate gave no token", "La Gate n'a pas donné de jeton")))?.to_string();
    let (host, port) = reach(data_dir, &b, Svc::Ssh).await?;
    Ok(EgressRoute {
        gate_name: b.name.clone(),
        host,
        port,
        user: t["utilisateur_ssh"].as_str().unwrap_or_default().to_string(),
        ticket,
        fingerprint: b.ssh_fingerprint.clone(),
    })
}

/// Entrée RDP native de la Gate (0.31) : fichier .rdp à usage unique, ouvert dans le client RDP
/// du système (mstsc, Windows App). Mode enregistré : les identifiants Windows donnés ici sont
/// confiés à la Gate, qui les garde en mémoire le temps du jeton et ouvre la session avec.
/// Renvoie l'adresse appelée.
#[tauri::command]
pub async fn gate_native_rdp(state: State<'_, AppState>, id: String, server: String, account: Option<String>, password: Option<String>) -> CmdResult<String> {
    state.unlocked()?;
    let data_dir = state.data_dir.clone();
    let mut b = find(&data_dir, &id).map_err(full)?;
    let path = format!("/serveurs/{}/rdp-natif", urlencode(&server));
    let body = json!({ "compte": account, "mot_de_passe": password });
    let t = authed(&data_dir, &mut b, reqwest::Method::POST, &path, Some(body)).await.map_err(full)?;
    let token = t["jeton"].as_str().ok_or(t!("The Gate gave no token", "La Gate n'a pas donné de jeton"))?;
    let port = t["port"].as_u64().unwrap_or(3390);
    // Adresse réglée sur la Gate (« hôte » ou « hôte:port »), sinon celle que Portunia connaît.
    let relayed = reach(&data_dir, &b, Svc::Rdp).await.map_err(full)?;
    let address = match t["adresse"].as_str().map(str::trim).filter(|a| !a.is_empty()) {
        // De l'extérieur, par Cloudflare : le relais local de cloudflared.
        _ if relayed.1 != 0 => format!("127.0.0.1:{}", relayed.1),
        Some(a) if a.rsplit_once(':').is_some_and(|(h, p)| !h.ends_with(':') && p.parse::<u16>().is_ok() && (!h.contains(':') || h.ends_with(']'))) => a.to_string(),
        Some(a) => format!("{a}:{port}"),
        None if b.host.contains(':') => format!("[{}]:{port}", b.host),
        None => format!("{}:{port}", b.host),
    };
    // Rebond : authentification Windows de bout en bout (NLA) ; sinon TLS simple avec la Gate,
    // qui ouvre elle-même la session Windows.
    let jump = t["mode"].as_str() == Some("rebond");
    let lines = vec![
        format!("full address:s:{address}"),
        format!("loadbalanceinfo:s:{token}"),
        "screen mode id:i:1".to_string(),
        "prompt for credentials:i:0".to_string(),
        "authentication level:i:2".to_string(),
        format!("enablecredsspsupport:i:{}", jump as u8),
        "redirectclipboard:i:1".to_string(),
        "audiomode:i:0".to_string(),
    ];
    crate::connectors::rdp::open_rdp_lines(&data_dir, &format!("{server}-{}", b.name), &lines).map_err(full)?;
    Ok(address)
}

/// Code QR (SVG) d'enrôlement du code TOTP, dessiné aux couleurs de l'interface par le CSS.
#[tauri::command]
pub fn qr_svg(text: String) -> CmdResult<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(err)?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(200, 200).quiet_zone(true).build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dossier_en_zip() {
        let dir = std::env::temp_dir().join(format!("portunia-zip-{}", std::process::id())).join("Rapports");
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("a.txt"), b"bonjour").unwrap();
        std::fs::write(dir.join("logs").join("b.log"), vec![7u8; 100_000]).unwrap();
        let zip = zip_folder(&dir).unwrap();
        assert_eq!(zip.file_name().unwrap(), "Rapports.zip");
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().unwrap().to_string()).collect();
        names.sort();
        assert_eq!(names, ["Rapports/", "Rapports/a.txt", "Rapports/logs/", "Rapports/logs/b.log"]);
        let mut content = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("Rapports/a.txt").unwrap(), &mut content).unwrap();
        assert_eq!(content, "bonjour");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        let _ = std::fs::remove_dir_all(zip.parent().unwrap());
    }

    #[test]
    fn adresses() {
        assert_eq!(split_address("gate.acme.local").unwrap(), ("gate.acme.local".into(), 8443));
        assert_eq!(split_address("https://10.0.0.5:9443/").unwrap(), ("10.0.0.5".into(), 9443));
        assert!(split_address("").is_err());
        assert!(split_address("hote:abc").is_err());
    }
}

// ---------- Relecture des sessions Bureau à distance ----------

/// Relecture en cours : moteur RDP en mode relecture et son fichier temporaire.
struct RdpReplay {
    stdin: std::process::ChildStdin,
    child: std::process::Child,
    file: PathBuf,
    /// Gate et session relues ; images déjà reçues (session suivie en direct).
    gate: String,
    session: String,
    frames: usize,
}

/// Nombre d'images complètes d'un flux (temps f64, longueur u32, message) et leurs octets.
fn whole_frames(bytes: &[u8]) -> (usize, usize) {
    let (mut count, mut at) = (0, 0);
    while at + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[at + 8], bytes[at + 9], bytes[at + 10], bytes[at + 11]]) as usize;
        if at + 12 + len > bytes.len() {
            break;
        }
        at += 12 + len;
        count += 1;
    }
    (count, at)
}

/// Télécharge l'image d'une session depuis la Gate, à partir de l'image `from`.
async fn rdp_stream(data_dir: &Path, b: &Gate, session: &str, from: usize) -> CmdResult<Vec<u8>> {
    let t = token(b).map_err(full)?;
    let (http, _) = client(Some(&b.api_fingerprint)).map_err(full)?;
    let (host, port) = api_at(data_dir, b).await?;
    let resp = http
        .get(format!("https://{host}:{port}/api/v1/audit/sessions/{session}/flux?depuis={from}"))
        .bearer_auth(t)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| root_cause(&e))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("SESSION_EXPIREE".into());
    }
    if !resp.status().is_success() {
        let value: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(value.get("erreur").and_then(Value::as_str).unwrap_or("?").to_string());
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(err)
}

impl Drop for RdpReplay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_file(&self.file);
    }
}

fn replays() -> &'static Mutex<HashMap<String, RdpReplay>> {
    static REPLAYS: std::sync::OnceLock<Mutex<HashMap<String, RdpReplay>>> = std::sync::OnceLock::new();
    REPLAYS.get_or_init(Mutex::default)
}

/// Ouvre la relecture d'une session Bureau à distance : télécharge son image depuis la Gate
/// (signature contrôlée par la Gate) et la confie au moteur RDP. Ses messages (images,
/// position) arrivent par `on_event` ; renvoie l'identifiant de la relecture.
#[tauri::command]
pub async fn gate_rdp_replay(state: State<'_, AppState>, id: String, session: String, on_event: Channel) -> CmdResult<String> {
    use std::io::Write;
    use tauri::ipc::InvokeResponseBody;
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
    if !session.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(t!("Session not found", "Session introuvable").into());
    }
    let b = find(&state.data_dir, &id).map_err(full)?;
    let bytes = rdp_stream(&state.data_dir, &b, &session, 0).await?;
    // Session en cours : la dernière image peut être incomplète ; elle viendra avec les suivantes.
    let (frames, whole) = whole_frames(&bytes);
    let bytes = &bytes[..whole];
    let replay_id = uuid::Uuid::new_v4().to_string();
    let file = std::env::temp_dir().join(format!("portunia-relecture-{replay_id}.flux"));
    std::fs::write(&file, &bytes).map_err(err)?;

    let helper = crate::connectors::rdp::helper_path()
        .ok_or_else(|| t!("RDP engine not found (portunia-rdp.exe). Reinstall Portunia.", "Moteur RDP introuvable (portunia-rdp.exe). Réinstallez Portunia.").to_string())?;
    let mut command = std::process::Command::new(helper);
    command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| format!("{}: {e}", t!("Cannot start the RDP engine", "Impossible de lancer le moteur RDP")))?;
    let mut stdin = child.stdin.take().ok_or("stdin")?;
    let stdout = child.stdout.take().ok_or("stdout")?;
    writeln!(stdin, "{}", json!({ "replay": file.display().to_string() })).map_err(err)?;
    stdin.flush().map_err(err)?;
    std::thread::Builder::new()
        .name("rdp-relecture".into())
        .spawn(move || {
            // Images en binaire (ArrayBuffer dans la page), le reste en JSON.
            let mut open = true;
            crate::connectors::rdp::read_engine(stdout, |message| {
                let body = match message {
                    crate::connectors::rdp::EngineMessage::Pixels(packet) => InvokeResponseBody::Raw(packet),
                    crate::connectors::rdp::EngineMessage::Json(value) => InvokeResponseBody::Json(value.to_string()),
                };
                open = on_event.send(body).is_ok();
                open
            });
            if !open {
                return;
            }
            // Moteur arrêté sans message (plantage) : le lecteur l'affiche au lieu d'attendre.
            let closed = json!({ "type": "closed", "reason": t!("The RDP engine stopped", "Le moteur RDP s'est arrêté") });
            let _ = on_event.send(InvokeResponseBody::Json(closed.to_string()));
        })
        .map_err(err)?;
    replays().lock().unwrap().insert(replay_id.clone(), RdpReplay { stdin, child, file, gate: id, session, frames });
    Ok(replay_id)
}

/// Session suivie en direct : ajoute les nouvelles images au fichier de la relecture et les
/// confie au moteur. Renvoie le nombre d'images ajoutées.
#[tauri::command]
pub async fn gate_rdp_replay_more(state: State<'_, AppState>, replay: String) -> CmdResult<usize> {
    use std::io::Write;
    state.unlocked()?;
    let (gate, session, from) = {
        let all = replays().lock().unwrap();
        let r = all.get(&replay).ok_or_else(|| t!("Session closed", "Session fermée").to_string())?;
        (r.gate.clone(), r.session.clone(), r.frames)
    };
    let b = find(&state.data_dir, &gate).map_err(full)?;
    let bytes = rdp_stream(&state.data_dir, &b, &session, from).await?;
    let (added, whole) = whole_frames(&bytes);
    if added == 0 {
        return Ok(0);
    }
    let mut all = replays().lock().unwrap();
    let r = all.get_mut(&replay).ok_or_else(|| t!("Session closed", "Session fermée").to_string())?;
    // Une autre demande a pu passer entre-temps : on n'ajoute que si rien n'a bougé.
    if r.frames != from {
        return Ok(0);
    }
    std::fs::OpenOptions::new().append(true).open(&r.file).and_then(|mut f| f.write_all(&bytes[..whole])).map_err(err)?;
    r.frames += added;
    writeln!(r.stdin, "{}", json!({ "type": "more" })).map_err(err)?;
    r.stdin.flush().map_err(err)?;
    Ok(added)
}

/// Amène la relecture à ce temps (secondes) : le moteur envoie les zones changées.
#[tauri::command]
pub fn gate_rdp_replay_seek(replay: String, t: f64) -> CmdResult<()> {
    use std::io::Write;
    let mut all = replays().lock().unwrap();
    let r = all.get_mut(&replay).ok_or_else(|| t!("Session closed", "Session fermée").to_string())?;
    writeln!(r.stdin, "{}", json!({ "type": "seek", "t": t })).map_err(err)?;
    r.stdin.flush().map_err(err)
}

/// Lecteur détaché : la relecture d'une session dans sa propre fenêtre (relecture.html), qui
/// n'a que les droits nécessaires (capabilities/relecture.json).
#[tauri::command]
pub fn gate_replay_window(app: AppHandle, state: State<'_, AppState>, id: String, session: String, reveal: bool, title: String) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
    let safe = |v: &str| !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !safe(&id) || !safe(&session) {
        return Err(t!("Session not found", "Session introuvable").into());
    }
    let label = format!("relecture-{}", uuid::Uuid::new_v4().simple());
    let url = format!("relecture.html?gate={id}&session={session}{}", if reveal { "&reveler=1" } else { "" });
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title(format!("{} — Portunia", title.chars().take(120).collect::<String>()))
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 420.0)
        .build()
        .map_err(err)?;
    Ok(())
}

/// Ferme la relecture (moteur arrêté, fichier temporaire effacé).
#[tauri::command]
pub fn gate_rdp_replay_close(replay: String) {
    replays().lock().unwrap().remove(&replay);
}

// ---------- Assistance à distance (Portunia Assist) ----------

/// Le relais d'assistance de la Gate : actif, autorisé pour ce compte, adresse à donner.
#[tauri::command]
pub async fn gate_assist_status(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    state.unlocked()?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    authed(&state.data_dir, &mut b, reqwest::Method::GET, "/assistance", None).await.map_err(full)
}

/// Assistances en cours : messages de l'onglet (discussion, demande de contrôle) vers le pont.
fn assists() -> &'static Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<Value>>> {
    static A: std::sync::OnceLock<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<Value>>>> = std::sync::OnceLock::new();
    A.get_or_init(Default::default)
}

/// Fonctions de Portunia annoncées au programme de la personne aidée.
const ASSIST_FEATURES: [&str; 6] = ["liaison", "discussion", "pause", "controle", "reprise", "fichiers"];

/// Fichiers reçus pendant les assistances (« assistance:numéro » → fichier), pour Ouvrir et
/// Enregistrer, même après la fin de la session.
fn assist_files() -> &'static Mutex<HashMap<String, std::path::PathBuf>> {
    static F: std::sync::OnceLock<Mutex<HashMap<String, std::path::PathBuf>>> = std::sync::OnceLock::new();
    F.get_or_init(Default::default)
}

/// Dossier de travail des assistances (fichiers reçus, dossiers mis en .zip).
fn assist_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("portunia-assistance")
}

/// Met un dossier en .zip (pour l'envoyer à la personne aidée) ; les liens sont ignorés.
fn zip_folder(dir: &std::path::Path) -> Result<std::path::PathBuf> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "dossier".into());
    let out_dir = assist_dir().join("envois").join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&out_dir)?;
    let target = out_dir.join(format!("{}.zip", assist_proto::transfer::safe_name(&name)));
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&target)?);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    let mut stack = vec![(dir.to_path_buf(), name.clone())];
    while let Some((path, inside)) = stack.pop() {
        zip.add_directory(format!("{inside}/"), opts)?;
        for entry in std::fs::read_dir(&path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let child = format!("{inside}/{}", entry.file_name().to_string_lossy());
            if kind.is_dir() {
                stack.push((entry.path(), child));
            } else if kind.is_file() {
                zip.start_file(child, opts)?;
                let mut f = std::fs::File::open(entry.path())?;
                std::io::copy(&mut f, &mut zip)?;
            }
        }
    }
    zip.finish()?.flush()?;
    Ok(target)
}

/// Fichiers ou dossiers déposés dans l'onglet d'assistance : proposés à la personne aidée
/// (un dossier part en .zip). Elle accepte chacun sur son écran.
#[tauri::command]
pub async fn gate_assist_offer(assist: String, paths: Vec<String>) -> CmdResult<()> {
    let ended = || t!("Assistance ended", "Assistance terminée").to_string();
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        let path = if path.is_dir() { tauri::async_runtime::spawn_blocking(move || zip_folder(&path)).await.map_err(err)?.map_err(full)? } else { path };
        let tx = assists().lock().unwrap().get(&assist).cloned().ok_or_else(ended)?;
        tx.send(json!({ "type": "fichier_envoyer", "chemin": path })).map_err(|_| ended())?;
    }
    Ok(())
}

/// Fichier reçu de la personne aidée : l'ouvrir (`dest` absent) ou l'enregistrer à `dest`.
#[tauri::command]
pub fn gate_assist_file(app: AppHandle, assist: String, id: u32, dest: Option<String>) -> CmdResult<()> {
    let src = assist_files().lock().unwrap().get(&format!("{assist}:{id}")).cloned().ok_or_else(|| t!("File no longer available", "Fichier plus disponible").to_string())?;
    match dest {
        Some(d) => {
            std::fs::copy(&src, &d).map_err(err)?;
        }
        None => {
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_path(src.to_string_lossy(), None::<&str>).map_err(err)?;
        }
    }
    Ok(())
}

/// Message de l'onglet vers la personne aidée : `{type: "message", texte}`, `{type: "demande_controle"}`
/// ou `{type: "fichier_annuler", id}`.
#[tauri::command]
pub fn gate_assist_send(assist: String, message: Value) -> CmdResult<()> {
    let allowed = matches!(message["type"].as_str(), Some("message" | "demande_controle" | "fichier_annuler"));
    if !allowed {
        return Err(t!("Unknown message", "Message inconnu").into());
    }
    let tx = assists().lock().unwrap().get(&assist).cloned().ok_or_else(|| t!("Assistance ended", "Assistance terminée").to_string())?;
    tx.send(message).map_err(|_| t!("Assistance ended", "Assistance terminée").to_string())
}

type AssistWs = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

/// WebSocket du relais d'assistance de la Gate (place, et jeton de reprise après une coupure).
async fn assist_socket(host: &str, port: u16, fingerprint: &str, jeton: &str, place: &str, resume: Option<&str>) -> Result<AssistWs, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let tls = pinned_tls(host, port, fingerprint).await.map_err(full)?;
    let url = match resume {
        Some(r) => format!("wss://{host}:{port}/api/v1/assistance/{place}?reprise={r}"),
        None => format!("wss://{host}:{port}/api/v1/assistance/{place}"),
    };
    let mut request = url.into_client_request().map_err(err)?;
    let h = request.headers_mut();
    h.insert("authorization", format!("Bearer {jeton}").parse().map_err(err)?);
    h.insert("accept-language", crate::lang::code().parse().map_err(err)?);
    let (ws, _) = tokio_tungstenite::client_async(request, tls).await.map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(r) if r.status() == 401 => "SESSION_EXPIREE".to_string(),
        tokio_tungstenite::tungstenite::Error::Http(r) => {
            let body = r.body().as_deref().map(String::from_utf8_lossy).unwrap_or_default();
            serde_json::from_str::<Value>(&body).ok().and_then(|v| v["erreur"].as_str().map(String::from)).unwrap_or_else(|| r.status().to_string())
        }
        e => e.to_string(),
    })?;
    Ok(ws)
}

/// Reprise après une coupure : même place, puis chacun renvoie ce que l'autre n'a pas reçu.
async fn assist_resume(host: &str, port: u16, fingerprint: &str, jeton: &str, place: &str, token: &str, link: &mut assist_proto::Link) -> Option<AssistWs> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while std::time::Instant::now() < until {
        let attempt = async {
            let mut ws = assist_socket(host, port, fingerprint, jeton, place, Some(token)).await.ok()?;
            loop {
                match ws.next().await? {
                    Ok(Message::Text(t)) => {
                        let v: Value = serde_json::from_str(&t).ok()?;
                        match v["type"].as_str() {
                            Some("repris") => break,
                            Some("erreur") => return None,
                            _ => {}
                        }
                    }
                    Ok(_) => {}
                    Err(_) => return None,
                }
            }
            ws.send(Message::Text(json!({ "type": "reprise", "recu": link.opened() }).to_string().into())).await.ok()?;
            let n = loop {
                if let Ok(Message::Text(t)) = ws.next().await? {
                    let v: Value = serde_json::from_str(&t).ok()?;
                    if v["type"] == "reprise" {
                        break v["recu"].as_u64().unwrap_or(0);
                    }
                }
            };
            for f in link.resend_from(n)? {
                ws.send(Message::Binary(f.into())).await.ok()?;
            }
            Some(ws)
        };
        if let Some(ws) = attempt.await {
            return Some(ws);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    None
}

/// Rejoint la personne aidée par le relais de la Gate, avec le code qu'elle a lu : échange de
/// clés authentifié par le code (le relais ne peut ni lire ni se faire passer pour l'un des deux),
/// attente de son accord, puis Bureau à distance dans le canal chiffré, dans un onglet.
/// `on_assist` reçoit ce qui se passe à côté de l'image (contrôle, pause, messages, reconnexion).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gate_assist(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    code: String,
    assist: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel,
    on_assist: Channel<Value>,
) -> CmdResult<ConnectResponse> {
    use assist_proto::{
        transfer::{self, Outgoing, Transfers},
        Code, Handshake, Kind, Link, Role,
    };
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message;

    state.unlocked()?;
    // Offre gratuite : 100 Mo par fichier dans l'assistance ; Pro et Équipes : sans limite.
    let files_limit = if state.license.lock().unwrap().allows(crate::license::Feature::AssistLargeFiles) { None } else { Some(transfer::FREE_LIMIT) };
    let code = Code::parse(&code).map_err(|_| t!("Invalid code: 9 digits expected", "Code invalide : 9 chiffres attendus").to_string())?;
    let b = find(&state.data_dir, &id).map_err(full)?;
    let jeton = token(&b).map_err(full)?;
    let (host, port) = api_at(&state.data_dir, &b).await?;
    let mut ws = assist_socket(&host, port, &b.api_fingerprint, &jeton, &code.nameplate, None).await?;
    let fail = |m: &str| m.to_string();
    // Relais : la place existe-t-elle encore ? (et jeton de reprise, Gate 0.43 et suivantes)
    let resume_token = loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                match v["type"].as_str() {
                    Some("relie") => break v["reprise"].as_str().map(String::from),
                    Some("erreur") => return Err(v["message"].as_str().unwrap_or("?").to_string()),
                    _ => {}
                }
            }
            Some(Ok(_)) => {}
            _ => return Err(fail(t!("The relay closed the connection", "Le relais a fermé la connexion"))),
        }
    };
    async fn binary<S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin>(ws: &mut S) -> Option<Vec<u8>> {
        loop {
            match ws.next().await? {
                Ok(Message::Binary(b)) => return Some(b.to_vec()),
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }
    let gone = || t!("The person closed Portunia Assistance", "La personne a fermé Portunia Assistance").to_string();
    // Échange de clés, puis confirmation : prouve que les deux ont le même code.
    let (hs, mine) = Handshake::start(Role::Helper, &code);
    ws.send(Message::Binary(mine.into())).await.map_err(err)?;
    let peer = binary(&mut ws).await.ok_or_else(gone)?;
    let (pending, confirm) = hs.finish(&peer).map_err(err)?;
    ws.send(Message::Binary(confirm.into())).await.map_err(err)?;
    let peer_confirm = binary(&mut ws).await.ok_or_else(|| t!("Wrong code: check the 9 digits with the person", "Code faux : vérifiez les 9 chiffres avec la personne").to_string())?;
    let (sealer, opener) = pending
        .confirm(&peer_confirm)
        .map_err(|_| t!("Wrong code: check the 9 digits with the person", "Code faux : vérifiez les 9 chiffres avec la personne").to_string())?;
    let mut link = Link::new(sealer, opener);
    // Accord de la personne (elle voit le nom du compte qui se connecte).
    let (control, features) = loop {
        let frame = binary(&mut ws).await.ok_or_else(gone)?;
        let (kind, payload) = link.open(&frame).map_err(err)?;
        if kind != Kind::Control {
            continue;
        }
        let v: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        match v["type"].as_str() {
            Some("accord") => {
                let features: Vec<String> = v["fonctions"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                break (v["controle"].as_bool().unwrap_or(false), features);
            }
            Some("refus") => return Err(t!("The person declined", "La personne a refusé").into()),
            _ => {}
        }
    };
    // Programme récent : il saura lire nos accusés et nos messages.
    if !features.is_empty() {
        let f = link.seal(Kind::Control, json!({ "type": "fonctions", "liste": ASSIST_FEATURES, "fichiers_max": files_limit }).to_string().as_bytes());
        ws.send(Message::Binary(f.into())).await.map_err(err)?;
    }
    let notify = move |v: Value| {
        let _ = on_assist.send(v);
    };
    notify(json!({ "type": "debut", "controle": control, "fonctions": features }));
    let (to_peer, mut from_tab) = tokio::sync::mpsc::unbounded_channel::<Value>();
    if let Some(a) = &assist {
        assists().lock().unwrap().insert(a.clone(), to_peer);
    }
    // Le moteur RDP se connecte en local ; ce pont chiffre et déchiffre vers la personne aidée.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(err)?;
    let local_port = listener.local_addr().map_err(err)?.port();
    let place = code.nameplate.clone();
    let fingerprint = b.api_fingerprint.clone();
    let (rhost, rjeton) = (host.clone(), jeton.clone());
    let resumable = features.iter().any(|f| f == "reprise");
    let files_ok = features.iter().any(|f| f == "fichiers");
    let assist_id = assist.clone();
    let assist_key = assist.clone().unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    // Fichiers envoyés par la personne : acceptés d'office (elle les a choisis), rangés à part.
    let mut files = Transfers::new(Role::Helper, assist_dir().join(&assist_key), files_limit, true);
    tauri::async_runtime::spawn(async move {
        let Ok(Ok((socket, _))) = tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept()).await else { return };
        let _ = socket.set_nodelay(true);
        let (mut rd, mut wr) = socket.into_split();
        let (mut tx, mut rx) = ws.split();
        let mut buf = vec![0u8; 64 * 1024];
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
        let mut last_quality = std::time::Instant::now();
        let mut out: Vec<Vec<u8>> = Vec::new();
        let mut paused = false;
        let mut noted: Vec<u32> = Vec::new();
        let reason: String = 'session: loop {
            let lost = 'net: loop {
                // Messages préparés au tour précédent (fichiers), dans l'ordre du chiffrement.
                for f in out.drain(..) {
                    if tx.send(Message::Binary(f.into())).await.is_err() { break 'net true; }
                }
                let changes = files.take_changes();
                if !changes.is_empty() {
                    for c in &changes {
                        if !c.state.finished() || noted.contains(&c.id) {
                            continue;
                        }
                        noted.push(c.id);
                        if c.incoming && c.state == transfer::State::Done {
                            if let Some(p) = &c.path {
                                assist_files().lock().unwrap().insert(format!("{assist_key}:{}", c.id), p.clone());
                            }
                        }
                        // Journal de la Gate (0.44 et suivantes) : sens, taille, issue ; ni nom ni contenu.
                        let note = json!({ "type": "journal", "evenement": "fichier", "sens": if c.incoming { "recu" } else { "envoye" }, "taille": c.size, "etat": c.state.id() });
                        let _ = tx.send(Message::Text(note.to_string().into())).await;
                    }
                    notify(json!({ "type": "fichiers", "liste": files.all().iter().map(|f| f.to_json()).collect::<Vec<_>>(), "max": files.limit() }));
                }
                tokio::select! {
                    biased;
                    n = rd.read(&mut buf) => match n {
                        Ok(0) | Err(_) => {
                            // Onglet fermé : on prévient la personne aidée.
                            let fin = link.seal(Kind::Control, json!({ "type": "fin" }).to_string().as_bytes());
                            let _ = tx.send(Message::Binary(fin.into())).await;
                            let _ = tx.close().await;
                            break 'session String::new();
                        }
                        Ok(n) => {
                            let frame = link.seal(Kind::Data, &buf[..n]);
                            if tx.send(Message::Binary(frame.into())).await.is_err() { break true; }
                        }
                    },
                    m = rx.next() => match m {
                        Some(Ok(Message::Binary(b))) => match link.open(&b) {
                            Ok((Kind::Data, data)) => {
                                if wr.write_all(&data).await.is_err() { break 'session String::new(); }
                                if let Some(ack) = link.take_ack() {
                                    if tx.send(Message::Binary(ack.into())).await.is_err() { break true; }
                                }
                            }
                            Ok((Kind::File, data)) => {
                                if let Some(r) = files.on_data(&data) {
                                    out.push(link.seal(Kind::Control, r.to_string().as_bytes()));
                                }
                                if let Some(ack) = link.take_ack() {
                                    out.push(ack);
                                }
                            }
                            Ok((Kind::Control, c)) => {
                                let v: Value = serde_json::from_slice(&c).unwrap_or(Value::Null);
                                match v["type"].as_str() {
                                    Some("recu") => link.acked(v["n"].as_u64().unwrap_or(0)),
                                    Some("fin") => break 'session t!("The person stopped the assistance.", "La personne a arrêté l'assistance.").to_string(),
                                    Some("message") => notify(json!({ "type": "message", "texte": v["texte"].as_str().unwrap_or_default().chars().take(4000).collect::<String>() })),
                                    Some(t) if t.starts_with("fichier_") && files_ok => {
                                        if let Some(r) = files.on_control(&v) {
                                            out.push(link.seal(Kind::Control, r.to_string().as_bytes()));
                                        }
                                    }
                                    Some("pause") => {
                                        paused = v["actif"].as_bool().unwrap_or(false);
                                        notify(json!({ "type": "pause", "actif": paused }));
                                    }
                                    Some("controle") => notify(json!({ "type": "controle", "actif": v["actif"].as_bool().unwrap_or(false) })),
                                    _ => {}
                                }
                            }
                            Err(_) => break 'session t!("Altered message: connection cut for safety.", "Message altéré : connexion coupée par sécurité.").to_string(),
                        },
                        Some(Ok(Message::Close(_))) => break 'session t!("The relay closed the connection.", "Le relais a fermé la connexion.").to_string(),
                        None | Some(Err(_)) => break true,
                        _ => {}
                    },
                    m = from_tab.recv() => if let Some(v) = m {
                        match v["type"].as_str() {
                            Some("fichier_envoyer") => {
                                if let Some(p) = v["chemin"].as_str().filter(|_| files_ok) {
                                    if let Ok(o) = files.offer(std::path::Path::new(p)) {
                                        out.push(link.seal(Kind::Control, o.to_string().as_bytes()));
                                    }
                                }
                            }
                            Some("fichier_annuler") => {
                                if let Some(r) = v["id"].as_u64().and_then(|i| files.cancel(i as u32)) {
                                    out.push(link.seal(Kind::Control, r.to_string().as_bytes()));
                                }
                            }
                            _ => {
                                let f = link.seal(Kind::Control, v.to_string().as_bytes());
                                if tx.send(Message::Binary(f.into())).await.is_err() { break true; }
                            }
                        }
                    },
                    _ = tick.tick() => {
                        if let Some(ack) = link.take_ack() {
                            if tx.send(Message::Binary(ack.into())).await.is_err() { break true; }
                        }
                        if last_quality.elapsed() >= std::time::Duration::from_secs(1) {
                            last_quality = std::time::Instant::now();
                            if let Some(rtt) = link.rtt() { notify(json!({ "type": "qualite", "ms": rtt.as_millis() as u64 })); }
                        }
                    }
                    // Fichier : seulement dans la place que l'image laisse libre, et pas pendant la pause.
                    _ = std::future::ready(()), if files.sending() && !paused && link.flow && link.in_flight() + 64 * 1024 <= link.window() / 2 => {
                        match files.next() {
                            Some(Outgoing::Data(d)) => out.push(link.seal(Kind::File, &d)),
                            Some(Outgoing::Control(c)) => out.push(link.seal(Kind::Control, c.to_string().as_bytes())),
                            None => {}
                        }
                    }
                }
            };
            debug_assert!(lost);
            // Ce qui n'est pas parti est gardé par la liaison et renvoyé à la reprise.
            out.clear();
            // Coupure : reprise si la Gate et le programme la savent faire.
            let Some(token) = resume_token.as_deref().filter(|_| resumable && link.flow) else {
                break t!("Connection lost.", "Connexion perdue.").to_string();
            };
            notify(json!({ "type": "reconnexion", "actif": true }));
            match assist_resume(&rhost, port, &fingerprint, &rjeton, &place, token, &mut link).await {
                Some(ws) => {
                    (tx, rx) = ws.split();
                    notify(json!({ "type": "reconnexion", "actif": false }));
                }
                None => break t!("Connection lost.", "Connexion perdue.").to_string(),
            }
        };
        files.close();
        notify(json!({ "type": "fichiers", "liste": files.all().iter().map(|f| f.to_json()).collect::<Vec<_>>(), "max": files.limit() }));
        notify(json!({ "type": "fin", "raison": reason }));
        if let Some(a) = &assist_id {
            assists().lock().unwrap().remove(a);
        }
    });
    let mut values: HashMap<String, Value> = HashMap::new();
    values.insert("host".into(), json!("127.0.0.1"));
    values.insert("port".into(), json!(local_port));
    values.insert("client".into(), json!("tab"));
    // Assistance : pont local chiffré de bout en bout, sans mot de passe ; le programme de la
    // personne aidée ne propose pas NLA.
    values.insert("allowNoNla".into(), json!(true));
    // Le pointeur de la personne aidée est dessiné dans l'image (on la voit bouger la souris).
    values.insert("remotePointer".into(), json!(true));
    let name = if control {
        t!(format!("Assistance · {}", code.display()), format!("Assistance · {}", code.display()))
    } else {
        t!(format!("Assistance (view only) · {}", code.display()), format!("Assistance (vue seule) · {}", code.display()))
    };
    let result = start_connection(&app, &state, "rdp", name, values, cols, rows, on_event).await;
    if result.is_err() {
        if let Some(a) = &assist {
            assists().lock().unwrap().remove(a);
        }
    }
    result
}
