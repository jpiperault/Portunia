//! Extension Proxmox VE : serveurs Proxmox ajoutés dans Portunia.
//!
//! L'API de Proxmox (HTTPS, port 8006, certificat épinglé par son empreinte comme pour une
//! Gate) s'utilise avec un jeton d'API (`utilisateur@domaine!jeton`) ou un mot de passe ; le
//! secret reste dans le Gestionnaire d'identifiants Windows, le ticket de session aussi.
//! C'est une extension de fonction (voir extension.rs) : l'interface passe par
//! `ext_call("proxmox", …)`, qui vérifie la licence. Elle appelle l'API par la méthode `api` (inventaire, actions, instantanés,
//! sauvegardes, clonage, migration, tâches, stockages).
//!
//! Consoles : machines virtuelles, conteneurs et shell d'un nœud passent par la console VNC de
//! Proxmox (`vncproxy`, `vncshell`). Sa WebSocket est relayée sur un port local, où le moteur
//! VNC de Portunia se connecte comme à un serveur VNC ordinaire.
//!
//! Terminal : conteneurs, shell du nœud et console série d'une VM passent aussi par le terminal
//! texte de Proxmox (`termproxy`, celui de xterm.js). Le relais local parle Telnet au moteur
//! Telnet de Portunia (taille de la fenêtre par NAWS) et le protocole de termproxy à Proxmox
//! (« 0:longueur:données », « 1:colonnes:lignes: », « 2 » pour rester en vie) : un vrai onglet
//! terminal, avec copier-coller et recherche.
//!
//! Envoi : images ISO et modèles de conteneurs envoyés du PC vers un stockage (`upload`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::{
    commands::{full, CmdResult},
    connector::BoxFuture,
    extension::{self, ExtManifest, Extension, Host},
    gate::{client, pinned_config, root_cause, urlencode},
    license::Feature,
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
    api_as(p, None, method, path, params).await
}

/// Même appel avec une authentification imposée (`fixed`, jamais renouvelée), ou celle du serveur.
async fn api_as(p: &Pve, fixed: Option<&Auth>, method: reqwest::Method, path: &str, params: Option<&Value>) -> Result<Value> {
    if !path.starts_with('/') || path.contains("..") || path.contains('?') || path.contains('#') {
        bail!("chemin d'API invalide : {path}");
    }
    let (http, _) = client(Some(&p.fingerprint))?;
    let write = method != reqwest::Method::GET;
    // GET et DELETE : paramètres dans l'adresse ; POST et PUT : dans le corps.
    let in_body = method == reqwest::Method::POST || method == reqwest::Method::PUT;
    let mut renewed = false;
    loop {
        let owned;
        let a = match fixed {
            Some(a) => a,
            None => {
                owned = auth(p, renewed).await?;
                &owned
            }
        };
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
        if status == reqwest::StatusCode::UNAUTHORIZED && fixed.is_none() && !p.uses_token() && !renewed {
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
    /// Mot de passe des consoles gardé (serveur ajouté avec un jeton).
    has_console: bool,
}

fn view(p: Pve) -> PveView {
    let has_secret = crate::secrets::get(&p.secret_id(), "secret").ok().flatten().is_some();
    let has_console = crate::secrets::get(&p.secret_id(), "console").ok().flatten().is_some();
    PveView { has_secret, has_console, pve: p }
}

/// Extension « Proxmox VE » (Pro). Voir et retirer ses serveurs restent permis sans licence.
pub struct Proxmox;

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
struct ProbeArgs {
    address: String,
}

#[derive(Deserialize)]
struct SaveArgs {
    request: SaveRequest,
}

#[derive(Deserialize)]
struct ApiArgs {
    id: String,
    method: String,
    path: String,
    params: Option<Value>,
}

#[derive(Deserialize)]
struct PathArgs {
    id: String,
    path: String,
}

#[derive(Deserialize)]
struct ConsoleArgs {
    id: String,
    node: String,
    kind: String,
    vmid: Option<u32>,
    upgrade: Option<bool>,
    cmd: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct UploadArgs {
    id: String,
    node: String,
    storage: String,
    content: String,
    path: String,
}

impl Extension for Proxmox {
    fn manifest(&self) -> ExtManifest {
        ExtManifest { id: "proxmox", name: "Proxmox VE".into(), feature: Some(Feature::Proxmox), free: &["list", "remove"] }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, args: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            let e = |e: String| anyhow!(e);
            match method {
                "list" => extension::reply(pve_list(host)),
                "probe" => {
                    let a: ProbeArgs = extension::args(args)?;
                    pve_probe(a.address).await.map_err(e)
                }
                "save" => {
                    let a: SaveArgs = extension::args(args)?;
                    extension::reply(pve_save(host, a.request).await.map_err(e)?)
                }
                "remove" => {
                    let a: IdArgs = extension::args(args)?;
                    extension::reply(pve_remove(host, a.id).map_err(e)?)
                }
                "api" => {
                    let a: ApiArgs = extension::args(args)?;
                    pve_api(host, a.id, a.method, a.path, a.params).await.map_err(e)
                }
                "apiFull" => {
                    let a: PathArgs = extension::args(args)?;
                    pve_api_full(host, a.id, a.path).await.map_err(e)
                }
                "console" => {
                    let a: ConsoleArgs = extension::args(args)?;
                    pve_console(host, a).await
                }
                "terminal" => {
                    let a: ConsoleArgs = extension::args(args)?;
                    pve_terminal(host, a).await
                }
                "upload" => {
                    let a: UploadArgs = extension::args(args)?;
                    pve_upload(host, a).await.map_err(e)
                }
                _ => Err(extension::unknown("proxmox", method)),
            }
        })
    }
}

fn pve_list(host: &dyn Host) -> Vec<PveView> {
    load(&host.data_dir()).into_iter().map(view).collect()
}

/// Premier contact : empreinte du certificat présenté, à faire vérifier par l'utilisateur.
async fn pve_probe(address: String) -> CmdResult<Value> {
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
    /// Avec un jeton : mot de passe de l'utilisateur pour les consoles (facultatif ; vide : garder).
    #[serde(default)]
    console_password: Option<String>,
}

/// Ajout ou modification : vérifie l'accès (version de Proxmox) avant d'enregistrer.
async fn pve_save(host: &dyn Host, request: SaveRequest) -> CmdResult<PveView> {
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
    if let Some(password) = r.console_password.filter(|s| !s.is_empty()) {
        if p.uses_token() {
            // Vérifié tout de suite : un mauvais mot de passe ne se découvrirait qu'à la console.
            login(&p, &password).await.map_err(|e| t!(format!("Password for consoles: {e}"), format!("Mot de passe des consoles : {e}")).to_string())?;
            crate::secrets::set(&p.secret_id(), "console", &password).map_err(full)?;
        }
    }
    if !p.uses_token() {
        let _ = crate::secrets::delete(&p.secret_id(), "console");
    }
    let mut list = load(&host.data_dir());
    match list.iter_mut().find(|x| x.id == p.id) {
        Some(x) => *x = p.clone(),
        None => list.push(p.clone()),
    }
    save(&host.data_dir(), &list).map_err(full)?;
    Ok(view(p))
}

fn pve_remove(host: &dyn Host, id: String) -> CmdResult<()> {
    let mut list = load(&host.data_dir());
    if let Some(p) = list.iter().find(|p| p.id == id) {
        for key in ["secret", "ticket", "csrf", "console"] {
            let _ = crate::secrets::delete(&p.secret_id(), key);
        }
    }
    list.retain(|p| p.id != id);
    save(&host.data_dir(), &list).map_err(full)
}

/// Appel de l'API Proxmox (« GET », « POST », « PUT », « DELETE ») ; renvoie « data ».
async fn pve_api(host: &dyn Host, id: String, method: String, path: String, params: Option<Value>) -> CmdResult<Value> {
    let p = find(&host.data_dir(), &id).map_err(full)?;
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|_| "méthode invalide".to_string())?;
    api(&p, method, &path, params.as_ref()).await.map_err(full)
}

/// Lecture qui rend toute la réponse de l'API, pas seulement « data » (réseau d'un nœud :
/// « changes » = changements en attente d'application).
async fn pve_api_full(host: &dyn Host, id: String, path: String) -> CmdResult<Value> {
    let p = find(&host.data_dir(), &id).map_err(full)?;
    let data = api(&p, reqwest::Method::GET, &path, None).await.map_err(full)?;
    // « changes » n'est pas dans data : seconde lecture brute.
    let changes = raw_get(&p, &path).await.ok().and_then(|v| v.get("changes").cloned()).unwrap_or(Value::Null);
    Ok(json!({ "data": data, "changes": changes }))
}

/// GET sans traitement (réponse JSON entière).
async fn raw_get(p: &Pve, path: &str) -> Result<Value> {
    if !path.starts_with('/') || path.contains("..") || path.contains('?') {
        bail!("chemin d'API invalide : {path}");
    }
    let a = auth(p, false).await?;
    let (http, _) = client(Some(&p.fingerprint))?;
    let req = a.apply(http.get(format!("https://{}:{}/api2/json{path}", p.host, p.port)), false);
    Ok(req.send().await.map_err(|e| unreachable(p, &e))?.json().await?)
}

/// Console d'une machine virtuelle (`qemu`), d'un conteneur (`lxc`) ou shell d'un nœud
/// (`node`) : la console VNC de Proxmox, relayée sur un port local, ouverte par le moteur VNC.
async fn pve_console(host: &dyn Host, a: ConsoleArgs) -> Result<Value> {
    let ConsoleArgs { id, node, kind, vmid, upgrade, cols, rows, .. } = a;
    let p = find(&host.data_dir(), &id)?;
    if node.is_empty() || !node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        bail!("nœud invalide");
    }
    let (base, name) = match (kind.as_str(), vmid) {
        ("qemu" | "lxc", Some(vmid)) => (format!("/nodes/{node}/{kind}/{vmid}"), format!("{vmid} · {}", p.name)),
        ("node", _) => (format!("/nodes/{node}"), format!("{node} · {}", p.name)),
        _ => bail!("console inconnue"),
    };
    let (start, params) = match kind.as_str() {
        // « upgrade » : le shell lance la mise à jour des paquets (apt dist-upgrade), comme dans Proxmox.
        "node" if upgrade == Some(true) => (format!("{base}/vncshell"), json!({ "websocket": true, "cmd": "upgrade" })),
        "node" => (format!("{base}/vncshell"), json!({ "websocket": true })),
        // Les machines virtuelles donnent un mot de passe VNC à part ; ailleurs, le ticket en sert.
        "qemu" => (format!("{base}/vncproxy"), json!({ "websocket": true, "generate-password": true })),
        _ => (format!("{base}/vncproxy"), json!({ "websocket": true })),
    };
    let a = console_auth(&p).await?;
    let console = api_as(&p, Some(&a), reqwest::Method::POST, &start, Some(&params)).await?;
    let port = console["port"].as_u64().or_else(|| console["port"].as_str().and_then(|s| s.parse().ok())).ok_or_else(|| anyhow!("Proxmox n'a pas donné de port de console"))?;
    let ticket = console["ticket"].as_str().ok_or_else(|| anyhow!("Proxmox n'a pas donné de ticket de console"))?.to_string();
    let password = console["password"].as_str().map(str::to_string).unwrap_or_else(|| ticket.clone());
    let local = bridge(&p, &a, &format!("{base}/vncwebsocket?port={port}&vncticket={}", urlencode(&ticket))).await?;
    let values: HashMap<String, Value> = [("host".to_string(), json!("127.0.0.1")), ("port".to_string(), json!(local)), ("password".to_string(), json!(password))].into_iter().collect();
    host.open_connection("vnc", name, values, cols, rows).await
}

/// Authentification des consoles. Proxmox lie le ticket VNC à un utilisateur et refuse les jetons
/// d'API (« root@pam!portunia does not look like a valid user name ») : avec un jeton, la console
/// passe par un ticket de session, tiré du mot de passe des consoles.
async fn console_auth(p: &Pve) -> Result<Auth> {
    if !p.uses_token() {
        return auth(p, false).await;
    }
    let Some(password) = crate::secrets::get(&p.secret_id(), "console")? else {
        bail!(t!(
            format!("Proxmox does not open consoles with an API token. Give the password of {} for consoles: menu « … » of the server › Edit.", p.user),
            format!("Proxmox n'ouvre pas les consoles avec un jeton d'API. Donnez le mot de passe de {} pour les consoles : menu « … » du serveur › Modifier.", p.user)
        ));
    };
    login(p, &password).await
}

/// Relais local vers la WebSocket de la console (TLS épinglé) : une seule connexion, le flux
/// VNC passe tel quel dans les deux sens.
async fn bridge(p: &Pve, a: &Auth, path: &str) -> Result<u16> {
    let ws = console_ws(p, a, path).await?;
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

/// WebSocket de console de Proxmox (TLS épinglé), authentifiée comme la console.
async fn console_ws(p: &Pve, a: &Auth, path: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>> {
    let mut request = format!("wss://{}:{}/api2/json{path}", p.host, p.port).into_client_request()?;
    match a {
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
    Ok(ws)
}

/// Lecture du flux Telnet du moteur de Portunia : données (IAC IAC = 0xFF), taille de la
/// fenêtre (IAC SB NAWS l h IAC SE) ; les autres négociations sont ignorées.
#[derive(Default)]
struct TelnetIn {
    state: u8,
    sub: Vec<u8>,
}

enum TermIn {
    Data(Vec<u8>),
    Size(u16, u16),
}

impl TelnetIn {
    const IAC: u8 = 255;
    fn feed(&mut self, bytes: &[u8]) -> Vec<TermIn> {
        let mut out = Vec::new();
        let mut data = Vec::new();
        for &b in bytes {
            match self.state {
                // 0 : données ; 1 : après IAC ; 2 : option à sauter ; 3 : sous-négociation ; 4 : IAC dans la sous-négociation.
                0 if b == Self::IAC => self.state = 1,
                0 => data.push(b),
                1 => {
                    self.state = match b {
                        Self::IAC => {
                            data.push(Self::IAC);
                            0
                        }
                        250 => {
                            self.sub.clear();
                            3
                        }
                        251..=254 => 2,
                        _ => 0,
                    }
                }
                2 => self.state = 0,
                3 if b == Self::IAC => self.state = 4,
                3 => self.sub.push(b),
                _ => {
                    if b == 240 {
                        // NAWS : option 31, largeur et hauteur sur deux octets.
                        if self.sub.len() >= 5 && self.sub[0] == 31 {
                            let cols = u16::from_be_bytes([self.sub[1], self.sub[2]]);
                            let rows = u16::from_be_bytes([self.sub[3], self.sub[4]]);
                            if !data.is_empty() {
                                out.push(TermIn::Data(std::mem::take(&mut data)));
                            }
                            out.push(TermIn::Size(cols.max(1), rows.max(1)));
                        }
                        self.state = 0;
                    } else {
                        if b == Self::IAC {
                            self.sub.push(Self::IAC);
                        }
                        self.state = 3;
                    }
                }
            }
        }
        if !data.is_empty() {
            out.push(TermIn::Data(data));
        }
        out
    }
}

/// Message de termproxy pour une entrée du terminal.
fn term_message(input: &TermIn) -> Vec<u8> {
    match input {
        TermIn::Data(d) => {
            let mut m = format!("0:{}:", d.len()).into_bytes();
            m.extend_from_slice(d);
            m
        }
        TermIn::Size(c, r) => format!("1:{c}:{r}:").into_bytes(),
    }
}

/// Relais local Telnet ↔ termproxy : une seule connexion (l'onglet terminal).
async fn term_bridge(p: &Pve, a: &Auth, path: &str, user: &str, ticket: &str) -> Result<u16> {
    let ws = console_ws(p, a, path).await?;
    let hello = format!("{user}:{ticket}\n").into_bytes();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let local = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        let Ok(Ok((socket, _))) = tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept()).await else { return };
        let _ = socket.set_nodelay(true);
        let (mut tcp_read, mut tcp_write) = socket.into_split();
        let (mut ws_send, mut ws_recv) = ws.split();
        // Le serveur répète les caractères (WILL ECHO), sans mode ligne (WILL SGA), et veut la taille (DO NAWS).
        if tcp_write.write_all(&[255, 251, 1, 255, 251, 3, 255, 253, 31]).await.is_err() || ws_send.send(Message::Binary(hello.into())).await.is_err() {
            return;
        }
        let up = async {
            let mut buf = vec![0u8; 16 * 1024];
            let mut telnet = TelnetIn::default();
            let mut ping = tokio::time::interval(std::time::Duration::from_secs(30));
            ping.tick().await;
            loop {
                tokio::select! {
                    n = tcp_read.read(&mut buf) => match n {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            for input in telnet.feed(&buf[..n]) {
                                if ws_send.send(Message::Binary(term_message(&input).into())).await.is_err() {
                                    return;
                                }
                            }
                        }
                    },
                    _ = ping.tick() => {
                        if ws_send.send(Message::Binary(b"2".to_vec().into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = ws_send.close().await;
        };
        let down = async {
            // termproxy répond « OK » à l'authentification, avant la sortie du shell.
            let mut greeted = false;
            while let Some(Ok(message)) = ws_recv.next().await {
                let mut bytes = match message {
                    Message::Binary(b) => b.to_vec(),
                    Message::Text(t) => t.as_bytes().to_vec(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if !greeted {
                    greeted = true;
                    if bytes.starts_with(b"OK") {
                        bytes.drain(..2);
                    }
                }
                // 0xFF est l'octet IAC de Telnet : doublé.
                let mut out = Vec::with_capacity(bytes.len());
                for b in bytes {
                    out.push(b);
                    if b == 255 {
                        out.push(255);
                    }
                }
                if tcp_write.write_all(&out).await.is_err() {
                    break;
                }
            }
            let _ = tcp_write.shutdown().await;
        };
        tokio::select! { _ = up => {}, _ = down => {} }
    });
    Ok(local)
}

/// Terminal texte d'un conteneur (`lxc`), du nœud (`node`, `cmd` = « upgrade » pour la mise à
/// jour) ou console série d'une VM (`qemu`, si elle a un port série) dans un onglet terminal.
async fn pve_terminal(host: &dyn Host, a: ConsoleArgs) -> Result<Value> {
    let ConsoleArgs { id, node, kind, vmid, cmd, cols, rows, .. } = a;
    let p = find(&host.data_dir(), &id)?;
    if node.is_empty() || !node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        bail!("nœud invalide");
    }
    let (base, name) = match (kind.as_str(), vmid) {
        ("qemu" | "lxc", Some(vmid)) => (format!("/nodes/{node}/{kind}/{vmid}"), format!("{vmid} · {}", p.name)),
        ("node", _) => (format!("/nodes/{node}"), format!("{node} · {}", p.name)),
        _ => bail!("terminal inconnu"),
    };
    let mut params = json!({});
    if kind == "node" && cmd.as_deref() == Some("upgrade") {
        params["cmd"] = json!("upgrade");
    } else if kind == "qemu" {
        params["serial"] = json!("serial0");
    }
    let a = console_auth(&p).await?;
    let term = api_as(&p, Some(&a), reqwest::Method::POST, &format!("{base}/termproxy"), Some(&params)).await.map_err(|e| {
        let e = full(e);
        if kind == "qemu" {
            anyhow!(
                "{}",
                t!(
                    format!("{e}. The text console needs a serial port on the VM (Hardware › Add › Serial port) and a console on it in the guest system."),
                    format!("{e}. La console texte demande un port série sur la VM (Matériel › Ajouter › Port série) et une console dessus dans le système invité.")
                )
            )
        } else {
            anyhow!(e)
        }
    })?;
    let port = term["port"].as_u64().or_else(|| term["port"].as_str().and_then(|s| s.parse().ok())).ok_or_else(|| anyhow!("Proxmox n'a pas donné de port de terminal"))?;
    let ticket = term["ticket"].as_str().ok_or_else(|| anyhow!("Proxmox n'a pas donné de ticket de terminal"))?.to_string();
    let user = term["user"].as_str().map(str::to_string).unwrap_or_else(|| p.user.clone());
    let local = term_bridge(&p, &a, &format!("{base}/vncwebsocket?port={port}&vncticket={}", urlencode(&ticket)), &user, &ticket).await?;
    let values: HashMap<String, Value> = [("host".to_string(), json!("127.0.0.1")), ("port".to_string(), json!(local))].into_iter().collect();
    host.open_connection("telnet", name, values, cols, rows).await
}

/// Nom de fichier accepté par Proxmox pour un envoi (lettres, chiffres, « - _ . »).
fn upload_name(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let name: String = base.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect();
    if name.trim_matches(['.', '_']).is_empty() {
        "fichier.iso".into()
    } else {
        name
    }
}

/// Envoie un fichier du PC vers un stockage du nœud (image ISO, modèle de conteneur) ; la
/// progression part dans le canal de l'appel ({envoye, total}). Rend la tâche Proxmox (UPID).
async fn pve_upload(host: &dyn Host, a: UploadArgs) -> CmdResult<Value> {
    let UploadArgs { id, node, storage, content, path } = a;
    let on_progress = host.events().map_err(full)?;
    let p = find(&host.data_dir(), &id).map_err(full)?;
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !valid(&node) || !valid(&storage) || !["iso", "vztmpl", "import"].contains(&content.as_str()) {
        return Err("paramètres d'envoi invalides".into());
    }
    let file = tokio::fs::File::open(&path).await.map_err(|e| format!("{path} : {e}"))?;
    let total = file.metadata().await.map_err(|e| e.to_string())?.len();
    let name = upload_name(&path);
    let boundary = format!("----portunia{}", uuid::Uuid::new_v4().simple());
    let head = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"content\"\r\n\r\n{content}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"filename\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    let tail = format!("\r\n--{boundary}--\r\n").into_bytes();
    let length = head.len() as u64 + total + tail.len() as u64;
    let progress = on_progress.clone();
    // Fichier lu par morceaux ; progression au plus toutes les 300 ms.
    let chunks = futures_util::stream::unfold((file, 0u64, std::time::Instant::now()), move |(mut f, sent, last)| {
        let progress = progress.clone();
        async move {
            let mut buf = vec![0u8; 256 * 1024];
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    let sent = sent + n as u64;
                    let last = if last.elapsed() >= std::time::Duration::from_millis(300) {
                        progress(json!({ "envoye": sent, "total": total }));
                        std::time::Instant::now()
                    } else {
                        last
                    };
                    Some((Ok::<Vec<u8>, std::io::Error>(buf), (f, sent, last)))
                }
                Err(e) => Some((Err(e), (f, sent, last))),
            }
        }
    });
    let body = futures_util::stream::once(async move { Ok::<Vec<u8>, std::io::Error>(head) }).chain(chunks).chain(futures_util::stream::once(async move { Ok(tail) }));
    let a = auth(&p, false).await.map_err(full)?;
    let (http, _) = client(Some(&p.fingerprint)).map_err(full)?;
    let req = http
        .post(format!("https://{}:{}/api2/json/nodes/{node}/storage/{storage}/upload", p.host, p.port))
        .timeout(std::time::Duration::from_secs(24 * 3600))
        .header(reqwest::header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
        .header(reqwest::header::CONTENT_LENGTH, length)
        .body(reqwest::Body::wrap_stream(body));
    let resp = a.apply(req, true).send().await.map_err(|e| full(unreachable(&p, &e)))?;
    let status = resp.status();
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = value["message"].as_str().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string).unwrap_or_else(|| status.to_string());
        return Err(format!("Proxmox {} : {message}", status.as_u16()));
    }
    on_progress(json!({ "envoye": total, "total": total }));
    Ok(value["data"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telnet_vers_termproxy() {
        let mut t = TelnetIn::default();
        // Réponse WILL NAWS, taille 120×40, puis « ls » et un 0xFF doublé.
        let inputs = t.feed(&[255, 251, 31, 255, 250, 31, 0, 120, 0, 40, 255, 240, b'l', b's', 255, 255]);
        let messages: Vec<Vec<u8>> = inputs.iter().map(term_message).collect();
        assert_eq!(messages, vec![b"1:120:40:".to_vec(), [b"0:3:ls".as_slice(), &[255]].concat()]);
        // Coupé au milieu d'une négociation : la suite arrive au morceau suivant.
        assert!(t.feed(&[255, 250, 31, 0]).is_empty());
        let rest: Vec<Vec<u8>> = t.feed(&[80, 0, 24, 255, 240]).iter().map(term_message).collect();
        assert_eq!(rest, vec![b"1:80:24:".to_vec()]);
    }

    /// Essai réel : PVE_ADDR=hôte:8006 cargo test sonde_reelle -- --ignored
    #[test]
    #[ignore]
    fn sonde_reelle() {
        let address = std::env::var("PVE_ADDR").expect("PVE_ADDR");
        let v = tauri::async_runtime::block_on(Proxmox.call(&NoHost, "probe", json!({ "address": address }))).unwrap();
        assert_eq!(v["fingerprint"].as_str().unwrap().len(), 95, "{v}");
    }

    /// Hôte vide : la sonde n'en a pas besoin.
    struct NoHost;

    impl Host for NoHost {
        fn exec(&self, _: &str) -> Result<Arc<dyn crate::connector::RemoteExec>> { bail!("non") }
        fn files(&self, _: &str) -> Result<Arc<dyn crate::connector::RemoteFiles>> { bail!("non") }
        fn ssh_session(&self, _: &str) -> Result<Arc<dyn extension::SessionExec>> { bail!("non") }
        fn events(&self) -> Result<extension::Emit> { bail!("non") }
        fn job(&self) -> Arc<extension::Job> { unreachable!() }
        fn spawn(&self, _: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>>) {}
        fn data_dir(&self) -> PathBuf { std::env::temp_dir() }
        fn open_connection<'a>(&'a self, _: &'a str, _: String, _: HashMap<String, Value>, _: u16, _: u16) -> BoxFuture<'a, Value> { Box::pin(async { bail!("non") }) }
        fn documents_dir(&self) -> Result<PathBuf> { bail!("non") }
        fn observe(&self, _: &str, _: &str, _: &mut dyn FnMut() -> Result<Box<dyn extension::SessionObserver>>) -> Result<Value> { bail!("non") }
        fn unobserve(&self, _: &str, _: &str) -> Result<Option<Value>> { Ok(None) }
        fn notify(&self, _: &str, _: &str) -> Result<()> { bail!("non") }
    }

    #[test]
    fn nom_envoye() {
        assert_eq!(upload_name("C:\\ISO\\Debian 13 (net).iso"), "Debian_13__net_.iso");
        assert_eq!(upload_name("/tmp/alpine-3.20.tar.xz"), "alpine-3.20.tar.xz");
    }

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
