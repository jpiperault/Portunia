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
    match call(&b.host, b.api_port, &b.api_fingerprint, Some(&t), method, path, body).await {
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
pub async fn gate_probe(address: String) -> CmdResult<Value> {
    let (host, port) = split_address(&address).map_err(full)?;
    let (http, seen) = client(None).map_err(full)?;
    let resp = http
        .get(format!("https://{host}:{port}/api/v1/gate"))
        .send()
        .await
        .map_err(|e| format!("Gate injoignable ({host}:{port}) : {}", root_cause(&e)))?;
    let info: Value = resp.json().await.map_err(|_| t!("This server does not answer like a Gate", "Ce serveur ne répond pas comme une Gate").to_string())?;
    if info.get("empreinte_ssh").is_none() {
        return Err(t!("This server does not answer like a Gate", "Ce serveur ne répond pas comme une Gate").into());
    }
    let fp = seen.lock().unwrap().clone().unwrap_or_default();
    Ok(json!({ "host": host, "apiPort": port, "fingerprint": fp, "info": info }))
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
    let answer = call(&request.host, request.api_port, &request.fingerprint, None, reqwest::Method::POST, "/connexion", Some(body)).await.map_err(full)?;
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
    if let Ok(list) = call(&b.host, b.api_port, &b.api_fingerprint, answer["jeton"].as_str(), reqwest::Method::GET, "/serveurs", None).await {
        b.servers = list["serveurs"].as_array().cloned().unwrap_or_default();
    }
    update(&data_dir, &b).map_err(full)?;
    Ok(json!({ "etat": "ok", "gate": view(b) }))
}

#[tauri::command]
pub async fn gate_logout(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.unlocked()?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    if let Ok(t) = token(&b) {
        let _ = call(&b.host, b.api_port, &b.api_fingerprint, Some(&t), reqwest::Method::DELETE, "/connexion", None).await;
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
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
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

/// Export CSV du journal, écrit dans le fichier choisi.
#[tauri::command]
pub async fn gate_journal_csv(state: State<'_, AppState>, id: String, query: String, dest: String) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::GateAdmin).map_err(full)?;
    let b = find(&state.data_dir, &id).map_err(full)?;
    let t = token(&b).map_err(full)?;
    let (http, _) = client(Some(&b.api_fingerprint)).map_err(full)?;
    let resp = http
        .get(format!("https://{}:{}/api/v1/admin/journal.csv?limite=5000&q={}", b.host, b.api_port, urlencode(&query)))
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
    let gate_values: serde_json::Map<String, Value> = [
        ("host".to_string(), json!(b.host)),
        ("port".to_string(), json!(b.ssh_port)),
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
        let local = pinned_listener(b.host.clone(), b.api_port, b.api_fingerprint.clone(), std::time::Duration::from_secs(8 * 3600)).await.map_err(full)?;
        values.insert("url".into(), json!(format!("http://127.0.0.1:{local}/web/entree?jeton={}", urlencode(&ticket))));
        return start_connection(&app, &state, "web", name, values, cols, rows, on_event).await;
    }
    let vault = t["mode"].as_str() == Some("coffre");
    if t["protocole"].as_str() == Some("rdp") && (t["mode"].as_str() == Some("enregistre") || vault) {
        // Bureau à distance enregistré : passage RDCleanPath de la Gate (qui relaie et enregistre) ;
        // l'authentification Windows (NLA) reste entre le moteur RDP et le serveur. Coffre : la
        // Gate ouvre la session Windows elle-même, le moteur s'authentifie auprès d'elle avec le jeton.
        let local = pinned_forwarder(&b.host, b.api_port, &b.api_fingerprint).await.map_err(full)?;
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        values.insert("client".into(), json!("tab"));
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
    let t = token(&b).map_err(full)?;
    let (http, _) = client(Some(&b.api_fingerprint)).map_err(full)?;
    let resp = http
        .get(format!("https://{}:{}/api/v1/audit/sessions/{session}/flux", b.host, b.api_port))
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
    let bytes = resp.bytes().await.map_err(err)?;
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
    replays().lock().unwrap().insert(replay_id.clone(), RdpReplay { stdin, child, file });
    Ok(replay_id)
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

/// Rejoint la personne aidée par le relais de la Gate, avec le code qu'elle a lu : échange de
/// clés authentifié par le code (le relais ne peut ni lire ni se faire passer pour l'un des deux),
/// attente de son accord, puis Bureau à distance dans le canal chiffré, dans un onglet.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gate_assist(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    code: String,
    cols: u16,
    rows: u16,
    on_event: Channel,
) -> CmdResult<ConnectResponse> {
    use assist_proto::{Code, Handshake, Kind, Role};
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

    state.unlocked()?;
    let code = Code::parse(&code).map_err(|_| t!("Invalid code: 9 digits expected", "Code invalide : 9 chiffres attendus").to_string())?;
    let b = find(&state.data_dir, &id).map_err(full)?;
    let jeton = token(&b).map_err(full)?;
    let tls = pinned_tls(&b.host, b.api_port, &b.api_fingerprint).await.map_err(full)?;
    let mut request = format!("wss://{}:{}/api/v1/assistance/{}", b.host, b.api_port, code.nameplate).into_client_request().map_err(err)?;
    let h = request.headers_mut();
    h.insert("authorization", format!("Bearer {jeton}").parse().map_err(err)?);
    h.insert("accept-language", crate::lang::code().parse().map_err(err)?);
    let (mut ws, _) = tokio_tungstenite::client_async(request, tls).await.map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(r) if r.status() == 401 => "SESSION_EXPIREE".to_string(),
        tokio_tungstenite::tungstenite::Error::Http(r) => {
            let body = r.body().as_deref().map(String::from_utf8_lossy).unwrap_or_default();
            serde_json::from_str::<Value>(&body).ok().and_then(|v| v["erreur"].as_str().map(String::from)).unwrap_or_else(|| r.status().to_string())
        }
        e => e.to_string(),
    })?;
    let fail = |m: &str| m.to_string();
    // Relais : la place existe-t-elle encore ?
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                match v["type"].as_str() {
                    Some("relie") => break,
                    Some("erreur") => return Err(v["message"].as_str().unwrap_or("?").to_string()),
                    _ => {}
                }
            }
            Some(Ok(_)) => {}
            _ => return Err(fail(t!("The relay closed the connection", "Le relais a fermé la connexion"))),
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
    let gone = || t!("The person closed Portunia Assistance", "La personne a fermé Portunia Assistance").to_string();
    // Échange de clés, puis confirmation : prouve que les deux ont le même code.
    let (hs, mine) = Handshake::start(Role::Helper, &code);
    ws.send(Message::Binary(mine.into())).await.map_err(err)?;
    let peer = binary(&mut ws).await.ok_or_else(gone)?;
    let (pending, confirm) = hs.finish(&peer).map_err(err)?;
    ws.send(Message::Binary(confirm.into())).await.map_err(err)?;
    let peer_confirm = binary(&mut ws).await.ok_or_else(|| t!("Wrong code: check the 9 digits with the person", "Code faux : vérifiez les 9 chiffres avec la personne").to_string())?;
    let (mut sealer, mut opener) = pending
        .confirm(&peer_confirm)
        .map_err(|_| t!("Wrong code: check the 9 digits with the person", "Code faux : vérifiez les 9 chiffres avec la personne").to_string())?;
    // Accord de la personne (elle voit le nom du compte qui se connecte).
    let control = loop {
        let frame = binary(&mut ws).await.ok_or_else(gone)?;
        let (kind, payload) = opener.open(&frame).map_err(err)?;
        if kind != Kind::Control {
            continue;
        }
        let v: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        match v["type"].as_str() {
            Some("accord") => break v["controle"].as_bool().unwrap_or(false),
            Some("refus") => return Err(t!("The person declined", "La personne a refusé").into()),
            _ => {}
        }
    };
    // Le moteur RDP se connecte en local ; ce pont chiffre et déchiffre vers la personne aidée.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    tauri::async_runtime::spawn(async move {
        let Ok(Ok((socket, _))) = tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept()).await else { return };
        let _ = socket.set_nodelay(true);
        let (mut rd, mut wr) = socket.into_split();
        let (mut tx, mut rx) = ws.split();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            tokio::select! {
                n = rd.read(&mut buf) => match n {
                    Ok(0) | Err(_) => {
                        // Onglet fermé : on prévient la personne aidée.
                        let fin = sealer.seal(Kind::Control, json!({ "type": "fin" }).to_string().as_bytes());
                        let _ = tx.send(Message::Binary(fin.into())).await;
                        break;
                    }
                    Ok(n) => {
                        let frame = sealer.seal(Kind::Data, &buf[..n]);
                        if tx.send(Message::Binary(frame.into())).await.is_err() { break; }
                    }
                },
                m = rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => match opener.open(&b) {
                        Ok((Kind::Data, data)) => { if wr.write_all(&data).await.is_err() { break; } }
                        Ok((Kind::Control, _)) => {}
                        Err(_) => break,
                    },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
        let _ = tx.close().await;
    });
    let mut values: HashMap<String, Value> = HashMap::new();
    values.insert("host".into(), json!("127.0.0.1"));
    values.insert("port".into(), json!(port));
    values.insert("client".into(), json!("tab"));
    // Assistance : pont local chiffré de bout en bout, sans mot de passe ; le programme de la
    // personne aidée ne propose pas NLA.
    values.insert("allowNoNla".into(), json!(true));
    let name = if control {
        t!(format!("Assistance · {}", code.display()), format!("Assistance · {}", code.display()))
    } else {
        t!(format!("Assistance (view only) · {}", code.display()), format!("Assistance (vue seule) · {}", code.display()))
    };
    start_connection(&app, &state, "rdp", name, values, cols, rows, on_event).await
}
