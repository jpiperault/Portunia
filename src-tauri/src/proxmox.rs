//! Extension Proxmox VE : serveurs Proxmox ajoutés dans Portunia.
//!
//! L'API de Proxmox (HTTPS, port 8006, certificat épinglé par son empreinte comme pour une
//! Gate) s'utilise avec un jeton d'API (`utilisateur@domaine!jeton`) ou un mot de passe ; le
//! secret reste dans le Gestionnaire d'identifiants Windows, le ticket de session aussi.
//! L'interface appelle l'API à travers `pve_api` (inventaire, actions, instantanés,
//! sauvegardes, clonage, migration, tâches, stockages).
//!
//! Consoles : machines virtuelles, conteneurs et shell d'un nœud passent tous par la console
//! VNC de Proxmox (`vncproxy`, `vncshell`). Sa WebSocket est relayée sur un port local, où
//! le moteur VNC de Portunia se connecte comme à un serveur VNC ordinaire.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::{
    commands::{full, start_connection, AppState, CmdResult, ConnectResponse},
    gate::{client, pinned_config, root_cause, urlencode},
};

const FILE: &str = "proxmox.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pve {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    /// Empreinte SHA-256 du certificat, vérifiée à chaque appel.
    pub fingerprint: String,
    /// « root@pam », « admin@pve »…
    pub user: String,
    /// Nom du jeton d'API (« portunia ») ; vide : connexion par mot de passe.
    #[serde(default)]
    pub token_id: String,
}

impl Pve {
    fn secret_id(&self) -> String {
        format!("proxmox-{}", self.id)
    }
    fn uses_token(&self) -> bool {
        !self.token_id.is_empty()
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

fn load(data_dir: &Path) -> Vec<Pve> {
    crate::vault::load_json(&path(data_dir)).0
}

fn save(data_dir: &Path, list: &[Pve]) -> Result<()> {
    crate::vault::write(&path(data_dir), &serde_json::to_string_pretty(list)?)
}

fn find(data_dir: &Path, id: &str) -> Result<Pve> {
    load(data_dir).into_iter().find(|p| p.id == id).ok_or_else(|| anyhow!(t!("Unknown Proxmox server", "Serveur Proxmox inconnu")))
}

/// « hôte », « hôte:port » ou « https://hôte:port/ » → (hôte, port, 8006 par défaut).
fn split_address(address: &str) -> Result<(String, u16)> {
    let a = address.trim().trim_start_matches("https://").split('/').next().unwrap_or_default().to_string();
    if a.is_empty() {
        bail!(t!("Give the Proxmox server's address", "Indiquez l'adresse du serveur Proxmox"));
    }
    match a.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') || h.starts_with('[') => {
            Ok((h.trim_matches(['[', ']']).to_string(), p.parse().map_err(|_| anyhow!("{}", t!(format!("Invalid port: {p}"), format!("Port invalide : {p}"))))?))
        }
        _ => Ok((a.trim_matches(['[', ']']).to_string(), 8006)),
    }
}

// ---------- Authentification ----------

/// Comment se présenter à l'API.
enum Auth {
    /// En-tête « PVEAPIToken=utilisateur@domaine!jeton=secret ».
    Token(String),
    /// Ticket de session (cookie) et jeton anti-CSRF des écritures.
    Ticket { ticket: String, csrf: String },
}

impl Auth {
    fn apply(&self, req: reqwest::RequestBuilder, write: bool) -> reqwest::RequestBuilder {
        match self {
            Auth::Token(header) => req.header(reqwest::header::AUTHORIZATION, header),
            Auth::Ticket { ticket, csrf } => {
                let req = req.header(reqwest::header::COOKIE, format!("PVEAuthCookie={}", urlencode(ticket)));
                if write {
                    req.header("CSRFPreventionToken", csrf)
                } else {
                    req
                }
            }
        }
    }
}

fn secret(p: &Pve) -> Result<String> {
    crate::secrets::get(&p.secret_id(), "secret")?.ok_or_else(|| anyhow!(t!("Proxmox secret missing: edit the server and give it again", "Secret Proxmox manquant : modifiez le serveur et redonnez-le")))
}

/// Paramètres en « application/x-www-form-urlencoded », comme les attend l'API (vrai/faux : 1/0).
fn form(params: &Value) -> String {
    let Some(map) = params.as_object() else { return String::new() };
    map.iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| {
            let text = match v {
                Value::Bool(b) => (*b as u8).to_string(),
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            format!("{}={}", urlencode(k), urlencode(&text))
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// Nouveau ticket avec le mot de passe ; gardé pour les appels suivants (2 h chez Proxmox).
async fn login(p: &Pve, password: &str) -> Result<Auth> {
    let (http, _) = client(Some(&p.fingerprint))?;
    let resp = http
        .post(format!("https://{}:{}/api2/json/access/ticket", p.host, p.port))
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form(&json!({ "username": p.user, "password": password })))
        .send()
        .await
        .map_err(|e| unreachable(p, &e))?;
    let status = resp.status();
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    let data = &value["data"];
    if !status.is_success() || data["ticket"].as_str().is_none() {
        bail!(t!("Proxmox refused the user or password", "Proxmox a refusé l'utilisateur ou le mot de passe"));
    }
    if data["NeedTFA"].as_i64() == Some(1) {
        bail!(t!(
            "This Proxmox account uses two-factor authentication: create an API token for Portunia instead (Datacenter › Permissions › API Tokens)",
            "Ce compte Proxmox a une double authentification : créez plutôt un jeton d'API pour Portunia (Datacenter › Permissions › API Tokens)"
        ));
    }
    let ticket = data["ticket"].as_str().unwrap_or_default().to_string();
    let csrf = data["CSRFPreventionToken"].as_str().unwrap_or_default().to_string();
    let _ = crate::secrets::set(&p.secret_id(), "ticket", &ticket);
    let _ = crate::secrets::set(&p.secret_id(), "csrf", &csrf);
    Ok(Auth::Ticket { ticket, csrf })
}

/// Authentification en cours : jeton d'API, ou ticket gardé (`renew` : en demander un neuf).
async fn auth(p: &Pve, renew: bool) -> Result<Auth> {
    if p.uses_token() {
        return Ok(Auth::Token(format!("PVEAPIToken={}!{}={}", p.user, p.token_id, secret(p)?)));
    }
    if !renew {
        if let (Some(ticket), Some(csrf)) = (crate::secrets::get(&p.secret_id(), "ticket")?, crate::secrets::get(&p.secret_id(), "csrf")?) {
            return Ok(Auth::Ticket { ticket, csrf });
        }
    }
    login(p, &secret(p)?).await
}

fn unreachable(p: &Pve, e: &reqwest::Error) -> anyhow::Error {
    anyhow!("{}", t!(format!("Proxmox unreachable ({}:{}): {}", p.host, p.port, root_cause(e)), format!("Proxmox injoignable ({}:{}) : {}", p.host, p.port, root_cause(e))))
}

/// Appel de l'API ; renvoie le champ « data ». Ticket expiré : un nouveau, une fois.
async fn api(p: &Pve, method: reqwest::Method, path: &str, params: Option<&Value>) -> Result<Value> {
    if !path.starts_with('/') || path.contains("..") || path.contains('?') || path.contains('#') {
        bail!("chemin d'API invalide : {path}");
    }
    let (http, _) = client(Some(&p.fingerprint))?;
    let write = method != reqwest::Method::GET;
    // GET et DELETE : paramètres dans l'adresse ; POST et PUT : dans le corps.
    let in_body = method == reqwest::Method::POST || method == reqwest::Method::PUT;
    let mut renewed = false;
    loop {
        let a = auth(p, renewed).await?;
        let mut url = format!("https://{}:{}/api2/json{path}", p.host, p.port);
        let mut req = if in_body {
            http.request(method.clone(), &url)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(params.map(form).unwrap_or_default())
        } else {
            if let Some(q) = params.map(form).filter(|q| !q.is_empty()) {
                url = format!("{url}?{q}");
            }
            http.request(method.clone(), &url)
        };
        req = a.apply(req, write);
        let resp = req.send().await.map_err(|e| unreachable(p, &e))?;
        let status = resp.status();
        let reason = status.canonical_reason().unwrap_or_default().to_string();
        let value: Value = resp.json().await.unwrap_or(Value::Null);
        if status == reqwest::StatusCode::UNAUTHORIZED && !p.uses_token() && !renewed {
            renewed = true;
            continue;
        }
        if !status.is_success() {
            // Proxmox explique les erreurs de paramètres dans « errors », le reste dans le statut.
            let detail = value["errors"].as_object().map(|m| m.iter().map(|(k, v)| format!("{k}: {}", v.as_str().unwrap_or_default().trim())).collect::<Vec<_>>().join(" ; "));
            let message = value["message"].as_str().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
            bail!("Proxmox {} : {}", status.as_u16(), detail.filter(|d| !d.is_empty()).or(message).unwrap_or(reason));
        }
        return Ok(value["data"].clone());
    }
}

// ---------- Commandes ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PveView {
    #[serde(flatten)]
    pve: Pve,
    has_secret: bool,
}

fn view(p: Pve) -> PveView {
    let has_secret = crate::secrets::get(&p.secret_id(), "secret").ok().flatten().is_some();
    PveView { has_secret, pve: p }
}

fn require(state: &AppState) -> CmdResult<()> {
    state.unlocked()?;
    state.license.lock().unwrap().require(crate::license::Feature::Proxmox).map_err(full)
}

#[tauri::command]
pub fn pve_list(state: State<'_, AppState>) -> CmdResult<Vec<PveView>> {
    state.unlocked()?;
    Ok(load(&state.data_dir).into_iter().map(view).collect())
}

/// Premier contact : empreinte du certificat présenté, à faire vérifier par l'utilisateur.
#[tauri::command]
pub async fn pve_probe(address: String) -> CmdResult<Value> {
    let (host, port) = split_address(&address).map_err(full)?;
    let (http, seen) = client(None).map_err(full)?;
    let resp = http
        .get(format!("https://{host}:{port}/api2/json/version"))
        .send()
        .await
        .map_err(|e| t!(format!("Proxmox unreachable ({host}:{port}): {}", root_cause(&e)), format!("Proxmox injoignable ({host}:{port}) : {}", root_cause(&e))).to_string())?;
    // Sans authentification, Proxmox répond 401 : c'est attendu, seule l'empreinte compte ici.
    if !(resp.status().is_success() || resp.status() == reqwest::StatusCode::UNAUTHORIZED) {
        return Err(t!("This server does not answer like Proxmox VE", "Ce serveur ne répond pas comme Proxmox VE").into());
    }
    let fp = seen.lock().unwrap().clone().unwrap_or_default();
    Ok(json!({ "host": host, "port": port, "fingerprint": fp }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    /// Serveur déjà ajouté (modification) ; sinon ajout.
    id: Option<String>,
    name: String,
    host: String,
    port: u16,
    fingerprint: String,
    user: String,
    token_id: String,
    /// Mot de passe ou secret du jeton ; vide en modification : garder l'actuel.
    secret: Option<String>,
}

/// Ajout ou modification : vérifie l'accès (version de Proxmox) avant d'enregistrer.
#[tauri::command]
pub async fn pve_save(state: State<'_, AppState>, request: SaveRequest) -> CmdResult<PveView> {
    require(&state)?;
    let r = request;
    if r.user.trim().is_empty() || !r.user.contains('@') {
        return Err(t!("User: user@realm (root@pam, admin@pve…)", "Utilisateur : utilisateur@domaine (root@pam, admin@pve…)").into());
    }
    let p = Pve {
        id: r.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: if r.name.trim().is_empty() { r.host.clone() } else { r.name.trim().to_string() },
        host: r.host.trim().to_string(),
        port: r.port,
        fingerprint: r.fingerprint.clone(),
        user: r.user.trim().to_string(),
        token_id: r.token_id.trim().to_string(),
    };
    let old_secret = crate::secrets::get(&p.secret_id(), "secret").ok().flatten();
    let secret = r.secret.filter(|s| !s.is_empty()).or(old_secret.clone()).ok_or(t!("Give the password or the token secret", "Indiquez le mot de passe ou le secret du jeton"))?;
    crate::secrets::set(&p.secret_id(), "secret", &secret).map_err(full)?;
    let _ = crate::secrets::delete(&p.secret_id(), "ticket");
    let check = api(&p, reqwest::Method::GET, "/version", None).await;
    if let Err(e) = check {
        // Échec : l'ancien secret revient, rien n'est enregistré.
        match old_secret {
            Some(s) => crate::secrets::set(&p.secret_id(), "secret", &s).map_err(full)?,
            None => {
                let _ = crate::secrets::delete(&p.secret_id(), "secret");
            }
        }
        return Err(full(e));
    }
    let mut list = load(&state.data_dir);
    match list.iter_mut().find(|x| x.id == p.id) {
        Some(x) => *x = p.clone(),
        None => list.push(p.clone()),
    }
    save(&state.data_dir, &list).map_err(full)?;
    Ok(view(p))
}

#[tauri::command]
pub fn pve_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.unlocked()?;
    let mut list = load(&state.data_dir);
    if let Some(p) = list.iter().find(|p| p.id == id) {
        for key in ["secret", "ticket", "csrf"] {
            let _ = crate::secrets::delete(&p.secret_id(), key);
        }
    }
    list.retain(|p| p.id != id);
    save(&state.data_dir, &list).map_err(full)
}

/// Appel de l'API Proxmox (« GET », « POST », « PUT », « DELETE ») ; renvoie « data ».
#[tauri::command]
pub async fn pve_api(state: State<'_, AppState>, id: String, method: String, path: String, params: Option<Value>) -> CmdResult<Value> {
    require(&state)?;
    let p = find(&state.data_dir, &id).map_err(full)?;
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|_| "méthode invalide".to_string())?;
    api(&p, method, &path, params.as_ref()).await.map_err(full)
}

/// Console d'une machine virtuelle (`qemu`), d'un conteneur (`lxc`) ou shell d'un nœud
/// (`node`) : la console VNC de Proxmox, relayée sur un port local, ouverte par le moteur VNC.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pve_console(app: AppHandle, state: State<'_, AppState>, id: String, node: String, kind: String, vmid: Option<u32>, upgrade: Option<bool>, cols: u16, rows: u16, on_event: Channel) -> CmdResult<ConnectResponse> {
    require(&state)?;
    let p = find(&state.data_dir, &id).map_err(full)?;
    if node.is_empty() || !node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("nœud invalide".into());
    }
    let (base, name) = match (kind.as_str(), vmid) {
        ("qemu" | "lxc", Some(vmid)) => (format!("/nodes/{node}/{kind}/{vmid}"), format!("{vmid} · {}", p.name)),
        ("node", _) => (format!("/nodes/{node}"), format!("{node} · {}", p.name)),
        _ => return Err("console inconnue".into()),
    };
    let (start, params) = match kind.as_str() {
        // « upgrade » : le shell lance la mise à jour des paquets (apt dist-upgrade), comme dans Proxmox.
        "node" if upgrade == Some(true) => (format!("{base}/vncshell"), json!({ "websocket": true, "cmd": "upgrade" })),
        "node" => (format!("{base}/vncshell"), json!({ "websocket": true })),
        // Les machines virtuelles donnent un mot de passe VNC à part ; ailleurs, le ticket en sert.
        "qemu" => (format!("{base}/vncproxy"), json!({ "websocket": true, "generate-password": true })),
        _ => (format!("{base}/vncproxy"), json!({ "websocket": true })),
    };
    let console = api(&p, reqwest::Method::POST, &start, Some(&params)).await.map_err(full)?;
    let port = console["port"].as_u64().or_else(|| console["port"].as_str().and_then(|s| s.parse().ok())).ok_or("Proxmox n'a pas donné de port de console")?;
    let ticket = console["ticket"].as_str().ok_or("Proxmox n'a pas donné de ticket de console")?.to_string();
    let password = console["password"].as_str().map(str::to_string).unwrap_or_else(|| ticket.clone());
    let local = bridge(&p, &format!("{base}/vncwebsocket?port={port}&vncticket={}", urlencode(&ticket))).await.map_err(full)?;
    let values: HashMap<String, Value> = [("host".to_string(), json!("127.0.0.1")), ("port".to_string(), json!(local)), ("password".to_string(), json!(password))].into_iter().collect();
    start_connection(&app, &state, "vnc", name, values, cols, rows, on_event).await
}

/// Relais local vers la WebSocket de la console (TLS épinglé) : une seule connexion, le flux
/// VNC passe tel quel dans les deux sens.
async fn bridge(p: &Pve, path: &str) -> Result<u16> {
    let a = auth(p, false).await?;
    let mut request = format!("wss://{}:{}/api2/json{path}", p.host, p.port).into_client_request()?;
    match &a {
        Auth::Token(header) => {
            request.headers_mut().insert("authorization", header.parse()?);
        }
        Auth::Ticket { ticket, .. } => {
            request.headers_mut().insert("cookie", format!("PVEAuthCookie={}", urlencode(ticket)).parse()?);
        }
    }
    request.headers_mut().insert("sec-websocket-protocol", "binary".parse()?);
    let name = rustls::pki_types::ServerName::try_from(p.host.clone()).map_err(|_| anyhow!(t!("Invalid Proxmox address", "Adresse Proxmox invalide")))?;
    let tcp = tokio::net::TcpStream::connect((p.host.as_str(), p.port)).await?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(pinned_config(&p.fingerprint)?)).connect(name, tcp).await?;
    let (ws, _) = tokio_tungstenite::client_async(request, tls).await.map_err(|e| anyhow!("{}", t!(format!("Proxmox console: {e}"), format!("Console Proxmox : {e}"))))?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let local = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        let Ok(Ok((socket, _))) = tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept()).await else { return };
        let _ = socket.set_nodelay(true);
        let (mut tcp_read, mut tcp_write) = socket.into_split();
        let (mut ws_send, mut ws_recv) = ws.split();
        let up = async {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match tcp_read.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ws_send.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = ws_send.close().await;
        };
        let down = async {
            while let Some(Ok(message)) = ws_recv.next().await {
                let bytes = match message {
                    Message::Binary(b) => b.to_vec(),
                    Message::Text(t) => t.as_bytes().to_vec(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if tcp_write.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            let _ = tcp_write.shutdown().await;
        };
        tokio::select! { _ = up => {}, _ = down => {} }
    });
    Ok(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adresses() {
        assert_eq!(split_address("pve.local").unwrap(), ("pve.local".into(), 8006));
        assert_eq!(split_address("https://10.0.0.5:8006/#v1:0:18").unwrap(), ("10.0.0.5".into(), 8006));
        assert_eq!(split_address("pve:9443").unwrap(), ("pve".into(), 9443));
        assert!(split_address(" ").is_err());
    }

    #[test]
    fn formulaire() {
        assert_eq!(form(&json!({ "websocket": true, "name": "a b", "vmid": 101, "x": null })), "name=a%20b&vmid=101&websocket=1");
    }
}
