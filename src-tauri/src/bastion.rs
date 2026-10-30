//! Extension Heimdia : bastions SSH ajoutés dans Portunia.
//!
//! L'API du bastion (HTTPS, certificat vérifié par son empreinte) donne un jeton de
//! session après mot de passe et code ; pour chaque ouverture, Portunia demande un jeton
//! SSH à usage unique et se connecte avec « login%serveur » au port SSH du bastion.
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

const FILE: &str = "bastions.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bastion {
    pub id: String,
    pub name: String,
    /// Hôte de l'API (et du SSH) : « bastion.acme.local ».
    pub host: String,
    pub api_port: u16,
    pub ssh_port: u16,
    /// Empreinte SHA-256 du certificat de l'API, vérifiée à chaque appel.
    pub api_fingerprint: String,
    pub ssh_fingerprint: String,
    pub login: String,
    #[serde(default)]
    pub role: String,
    /// Fin de la session du bastion (RFC 3339) ; vide = déconnecté.
    #[serde(default)]
    pub expires: String,
    #[serde(default)]
    pub remember_allowed: bool,
    /// Le bastion laisse chaque compte relire ses propres sessions.
    #[serde(default)]
    pub own_replay: bool,
    /// Dernière liste connue des serveurs, affichée grisée hors connexion.
    #[serde(default)]
    pub servers: Vec<Value>,
}

impl Bastion {
    fn secret_id(&self) -> String {
        format!("heimdia-{}", self.id)
    }
    fn connected(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.expires).is_ok_and(|e| e > chrono::Utc::now())
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

fn load(data_dir: &Path) -> Vec<Bastion> {
    crate::vault::load_json(&path(data_dir)).0
}

fn save(data_dir: &Path, list: &[Bastion]) -> Result<()> {
    crate::vault::write(&path(data_dir), &serde_json::to_string_pretty(list)?)
}

fn find(data_dir: &Path, id: &str) -> Result<Bastion> {
    load(data_dir).into_iter().find(|b| b.id == id).ok_or_else(|| anyhow!(t!("Unknown bastion", "Bastion inconnu")))
}

fn update(data_dir: &Path, bastion: &Bastion) -> Result<()> {
    let mut list = load(data_dir);
    match list.iter_mut().find(|b| b.id == bastion.id) {
        Some(b) => *b = bastion.clone(),
        None => list.push(bastion.clone()),
    }
    save(data_dir, &list)
}

/// « hôte », « hôte:port » ou « https://hôte:port » → (hôte, port de l'API).
fn split_address(address: &str) -> Result<(String, u16)> {
    let a = address.trim().trim_start_matches("https://").trim_end_matches('/');
    if a.is_empty() {
        bail!(t!("Give the bastion's address", "Indiquez l'adresse du bastion"));
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

fn client(expected: Option<&str>) -> Result<(reqwest::Client, Arc<Mutex<Option<String>>>)> {
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
        // Messages du bastion dans la langue de l'interface.
        .default_headers(reqwest::header::HeaderMap::from_iter([(
            reqwest::header::ACCEPT_LANGUAGE,
            reqwest::header::HeaderValue::from_static(crate::lang::code()),
        )]))
        .build()?;
    Ok((http, seen))
}

/// Relais local vers l'API du bastion, en TLS avec le certificat épinglé : le moteur RDP s'y
/// connecte en clair sur 127.0.0.1 (passage RDCleanPath du bastion). Une seule connexion.
async fn pinned_forwarder(host: &str, port: u16, fingerprint: &str) -> Result<u16> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Pinned { expected: Some(fingerprint.to_string()), seen: Arc::default(), provider: provider.clone() };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).map_err(|_| anyhow!(t!("Invalid bastion address", "Adresse du bastion invalide")))?;
    let tcp = tokio::net::TcpStream::connect((host, port)).await.map_err(|e| anyhow!("{}", t!(format!("Bastion unreachable ({host}:{port}): {e}"), format!("Bastion injoignable ({host}:{port}) : {e}"))))?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|e| anyhow!("{}", t!(format!("Bastion {host}:{port}: {e}"), format!("Bastion {host}:{port} : {e}"))))?;
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
    let resp = req.send().await.map_err(|e| anyhow!("{}", t!(format!("Bastion unreachable ({host}:{port}): {}", root_cause(&e)), format!("Bastion injoignable ({host}:{port}) : {}", root_cause(&e)))))?;
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

fn root_cause(e: &dyn std::error::Error) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

fn token(b: &Bastion) -> Result<String> {
    crate::secrets::get(&b.secret_id(), "jeton")?.ok_or_else(|| anyhow!("SESSION_EXPIREE"))
}

/// Appel authentifié ; sur session expirée, le bastion est marqué déconnecté.
async fn authed(data_dir: &Path, b: &mut Bastion, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
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
pub struct BastionView {
    #[serde(flatten)]
    bastion: Bastion,
    connected: bool,
    password_saved: bool,
}

fn view(b: Bastion) -> BastionView {
    let password_saved = crate::secrets::get(&b.secret_id(), "mot_de_passe").ok().flatten().is_some();
    BastionView { connected: b.connected(), password_saved, bastion: b }
}

#[tauri::command]
pub fn bastion_list(state: State<'_, AppState>) -> CmdResult<Vec<BastionView>> {
    state.unlocked()?;
    Ok(load(&state.data_dir).into_iter().map(view).collect())
}

/// Premier contact : empreinte du certificat et informations publiques du bastion.
#[tauri::command]
pub async fn bastion_probe(address: String) -> CmdResult<Value> {
    let (host, port) = split_address(&address).map_err(full)?;
    let (http, seen) = client(None).map_err(full)?;
    let resp = http
        .get(format!("https://{host}:{port}/api/v1/bastion"))
        .send()
        .await
        .map_err(|e| format!("Bastion injoignable ({host}:{port}) : {}", root_cause(&e)))?;
    let info: Value = resp.json().await.map_err(|_| t!("This server does not answer like a Heimdia bastion", "Ce serveur ne répond pas comme un bastion Heimdia").to_string())?;
    if info.get("empreinte_ssh").is_none() {
        return Err(t!("This server does not answer like a Heimdia bastion", "Ce serveur ne répond pas comme un bastion Heimdia").into());
    }
    let fp = seen.lock().unwrap().clone().unwrap_or_default();
    Ok(json!({ "host": host, "apiPort": port, "fingerprint": fp, "info": info }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// Bastion déjà ajouté (reconnexion) ; sinon ajout.
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

/// Connexion (ou reconnexion) : renvoie l'état donné par le bastion (« code_requis »,
/// « changer_mot_de_passe », « enrolement » avec le secret à scanner) ou le bastion connecté.
#[tauri::command]
pub async fn bastion_login(state: State<'_, AppState>, request: LoginRequest) -> CmdResult<Value> {
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
    let info = &answer["bastion"];
    let mut b = existing.unwrap_or_else(|| Bastion { id: uuid::Uuid::new_v4().to_string(), ..Default::default() });
    b.name = info["nom"].as_str().unwrap_or("Heimdia").to_string();
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
    // Mot de passe gardé seulement si l'utilisateur le demande et que le bastion l'autorise.
    let final_password = request.new_password.filter(|p| !p.is_empty()).unwrap_or(password);
    if request.remember && b.remember_allowed {
        crate::secrets::set(&b.secret_id(), "mot_de_passe", &final_password).map_err(full)?;
    } else {
        let _ = crate::secrets::delete(&b.secret_id(), "mot_de_passe");
    }
    // L'empreinte SSH du bastion vient de l'API vérifiée : pas de question à la première session.
    if !b.ssh_fingerprint.is_empty() {
        crate::connectors::ssh::remember_host(&data_dir, &format!("{}:{}", b.host, b.ssh_port), &b.ssh_fingerprint);
    }
    if let Ok(list) = call(&b.host, b.api_port, &b.api_fingerprint, answer["jeton"].as_str(), reqwest::Method::GET, "/serveurs", None).await {
        b.servers = list["serveurs"].as_array().cloned().unwrap_or_default();
    }
    update(&data_dir, &b).map_err(full)?;
    Ok(json!({ "etat": "ok", "bastion": view(b) }))
}

#[tauri::command]
pub async fn bastion_logout(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    if let Ok(t) = token(&b) {
        let _ = call(&b.host, b.api_port, &b.api_fingerprint, Some(&t), reqwest::Method::DELETE, "/connexion", None).await;
    }
    let _ = crate::secrets::delete(&b.secret_id(), "jeton");
    b.expires.clear();
    update(&state.data_dir, &b).map_err(full)
}

#[tauri::command]
pub async fn bastion_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let _ = bastion_logout(state.clone(), id.clone()).await;
    let b = find(&state.data_dir, &id).map_err(full)?;
    let _ = crate::secrets::delete(&b.secret_id(), "mot_de_passe");
    let mut list = load(&state.data_dir);
    list.retain(|x| x.id != id);
    save(&state.data_dir, &list).map_err(full)
}

/// Serveurs autorisés maintenant (et mise à jour de la liste gardée).
#[tauri::command]
pub async fn bastion_servers(state: State<'_, AppState>, id: String) -> CmdResult<BastionView> {
    state.unlocked()?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    let list = authed(&state.data_dir, &mut b, reqwest::Method::GET, "/serveurs", None).await.map_err(full)?;
    b.servers = list["serveurs"].as_array().cloned().unwrap_or_default();
    update(&state.data_dir, &b).map_err(full)?;
    Ok(view(b))
}

/// Appel d'administration (/admin/…) ou d'audit (/audit/…), réservé par le bastion aux rôles autorisés.
#[tauri::command]
pub async fn bastion_admin(state: State<'_, AppState>, id: String, method: String, path: String, body: Option<Value>) -> CmdResult<Value> {
    state.unlocked()?;
    if !(path.starts_with("/admin/") || path.starts_with("/audit/")) || path.contains("..") {
        return Err(t!("Invalid administration path", "Chemin d'administration invalide").into());
    }
    state.license.lock().unwrap().require(crate::license::Feature::BastionAdmin).map_err(full)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(err)?;
    let mut b = find(&state.data_dir, &id).map_err(full)?;
    authed(&state.data_dir, &mut b, method, &path, body).await.map_err(full)
}

/// Export de l'audit (enregistrement, transcription), écrit dans le fichier choisi par l'utilisateur.
#[tauri::command]
pub fn bastion_export(state: State<'_, AppState>, dest: String, content: String) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::BastionAdmin).map_err(full)?;
    std::fs::write(&dest, content).map_err(|e| format!("Écriture impossible : {e}"))
}

/// Export CSV du journal, écrit dans le fichier choisi.
#[tauri::command]
pub async fn bastion_journal_csv(state: State<'_, AppState>, id: String, query: String, dest: String) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::BastionAdmin).map_err(full)?;
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

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Ouvre une session sur un serveur du bastion. `extra` : identifiants tapés dans le
/// terminal (serveurs en mode rebond, comme pour la connexion rapide).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bastion_connect(
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
    let ticket = t["ticket"].as_str().ok_or(t!("The bastion gave no token", "Le bastion n'a pas donné de jeton"))?.to_string();
    let ssh_user = t["utilisateur_ssh"].as_str().unwrap_or_default().to_string();
    let bastion_values: serde_json::Map<String, Value> = [
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
    if t["protocole"].as_str() == Some("rdp") && t["mode"].as_str() == Some("enregistre") {
        // Bureau à distance enregistré : passage RDCleanPath du bastion (qui relaie et enregistre) ;
        // l'authentification Windows (NLA) reste entre le moteur RDP et le serveur.
        let local = pinned_forwarder(&b.host, b.api_port, &b.api_fingerprint).await.map_err(full)?;
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        values.insert("client".into(), json!("tab"));
        values.insert("rdcleanpathUrl".into(), json!(format!("ws://127.0.0.1:{local}/api/v1/rdp")));
        values.insert("rdcleanpathToken".into(), json!(ticket));
        values.extend(extra.into_iter().filter(|(k, _)| ["username", "password"].contains(&k.as_str())));
        return start_connection(&app, &state, "rdp", name, values, cols, rows, on_event).await;
    }
    if t["protocole"].as_str() == Some("rdp") {
        // Bureau à distance en rebond : tunnel par le bastion, identifiants Windows de bout en bout.
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        values.insert("client".into(), json!("tab"));
        values.insert("jumpHost".into(), Value::Object(bastion_values));
        values.extend(extra.into_iter().filter(|(k, _)| ["username", "password"].contains(&k.as_str())));
        return start_connection(&app, &state, "rdp", name, values, cols, rows, on_event).await;
    }
    if t["mode"].as_str() == Some("rebond") {
        // De bout en bout : le bastion relaie, l'authentification va au serveur.
        values.insert("host".into(), t["hote"].clone());
        values.insert("port".into(), t["port"].clone());
        if let Some(account) = t["compte"].as_str() {
            values.insert("username".into(), json!(account));
        }
        values.insert("auth".into(), json!("auto"));
        values.insert("jumpHost".into(), Value::Object(bastion_values));
    } else {
        values.extend(bastion_values);
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
        assert_eq!(split_address("bastion.acme.local").unwrap(), ("bastion.acme.local".into(), 8443));
        assert_eq!(split_address("https://10.0.0.5:9443/").unwrap(), ("10.0.0.5".into(), 9443));
        assert!(split_address("").is_err());
        assert!(split_address("hote:abc").is_err());
    }
}
