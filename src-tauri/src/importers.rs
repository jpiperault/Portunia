//! Import de sessions (~/.ssh/config, PuTTY, mRemoteNG) et sauvegarde Termoria.
//! Les mots de passe ne sont jamais importés ni exportés.

use std::{collections::HashMap, fs, path::PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connector::{TunnelKind, TunnelSpec};
use crate::store::{Session, Snippet};

/// Session proposée à l'import, avant confirmation.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub session: Session,
    /// Remarque affichée à côté (option non reprise…).
    pub note: Option<String>,
    /// Une session identique (protocole, hôte, port, utilisateur) existe déjà.
    #[serde(default)]
    pub duplicate: bool,
}

/// Clé de comparaison pour repérer les doublons.
pub fn identity(s: &Session) -> String {
    let v = |k: &str| s.values.get(k).map(|v| v.to_string().trim_matches('"').to_lowercase()).unwrap_or_default();
    format!("{}|{}|{}|{}|{}", s.protocol, v("host"), v("port"), v("username"), v("url"))
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default()
}

pub fn default_ssh_config() -> PathBuf {
    home().join(".ssh").join("config")
}

pub fn default_mremoteng() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("mRemoteNG")
        .join("confCons.xml")
}

fn session(name: &str, folder: &str, protocol: &str, values: Vec<(&str, Value)>) -> Session {
    Session {
        id: String::new(),
        name: name.to_string(),
        folder: folder.to_string(),
        protocol: protocol.to_string(),
        values: values.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        tags: vec![],
        secret_keys: vec![],
    }
}

fn tunnel(kind: TunnelKind, bind_port: u16, remote_host: &str, remote_port: u16) -> TunnelSpec {
    TunnelSpec {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        bind_port,
        remote_host: remote_host.to_string(),
        remote_port,
        auto_start: true,
    }
}

/// « host:port », « [::1]:port » → (hôte, port).
fn split_host_port(s: &str) -> Option<(String, u16)> {
    let s = s.trim();
    let (host, port) = if let Some(rest) = s.strip_prefix('[') {
        let (h, p) = rest.split_once("]:")?;
        (h, p)
    } else {
        s.rsplit_once(':')?
    };
    Some((host.to_string(), port.parse().ok()?))
}

/// Dernier nombre d'une adresse d'écoute « [adresse:]port ».
fn bind_port(s: &str) -> Option<u16> {
    s.rsplit(':').next()?.trim().parse().ok()
}

// ---------- ~/.ssh/config ----------

fn glob(pattern: &str, text: &str) -> bool {
    fn rec(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => rec(&p[1..], t) || (!t.is_empty() && rec(p, &t[1..])),
            (Some('?'), Some(_)) => rec(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => rec(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    rec(&p, &t)
}

fn expand_home(path: &str) -> String {
    let path = path.trim_matches('"');
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => home().join(rest).to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

pub fn parse_ssh_config(text: &str, folder: &str) -> Vec<Candidate> {
    // (motifs du bloc Host, options dans l'ordre)
    let mut blocks: Vec<(Vec<String>, Vec<(String, String)>)> = vec![(vec!["*".into()], vec![])];
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => blocks.push((value.split_whitespace().map(String::from).collect(), vec![])),
            // Les blocs Match ne sont pas interprétés : leurs options sont ignorées.
            "match" => blocks.push((vec![], vec![])),
            _ => blocks.last_mut().unwrap().1.push((key, value)),
        }
    }

    let mut out = Vec::new();
    for (patterns, _) in &blocks {
        for alias in patterns.iter().filter(|p| !p.contains(['*', '?', '!'])) {
            // Comme ssh : pour chaque option, la première valeur trouvée l'emporte.
            let mut opts: HashMap<String, String> = HashMap::new();
            let mut local = Vec::new();
            let mut dynamic = Vec::new();
            for (pats, options) in &blocks {
                let applies = pats.iter().any(|p| !p.starts_with('!') && glob(p, alias))
                    && !pats.iter().any(|p| p.strip_prefix('!').is_some_and(|n| glob(n, alias)));
                if !applies {
                    continue;
                }
                for (k, v) in options {
                    match k.as_str() {
                        "localforward" => local.push(v.clone()),
                        "dynamicforward" => dynamic.push(v.clone()),
                        _ => {
                            opts.entry(k.clone()).or_insert_with(|| v.clone());
                        }
                    }
                }
            }
            let host = opts.get("hostname").map(|h| h.replace("%h", alias)).unwrap_or_else(|| alias.clone());
            let port: u64 = opts.get("port").and_then(|p| p.parse().ok()).unwrap_or(22);
            let mut values = vec![("host", json!(host)), ("port", json!(port))];
            if let Some(user) = opts.get("user") {
                values.push(("username", json!(user)));
            }
            values.push(("auth", json!("key")));
            if let Some(key) = opts.get("identityfile") {
                values.push(("keyPath", json!(expand_home(key))));
            }
            let mut tunnels = Vec::new();
            for spec in &local {
                let mut parts = spec.split_whitespace();
                if let (Some(bind), Some(dest)) = (parts.next(), parts.next()) {
                    if let (Some(bp), Some((h, p))) = (bind_port(bind), split_host_port(dest)) {
                        tunnels.push(tunnel(TunnelKind::Local, bp, &h, p));
                    }
                }
            }
            for spec in &dynamic {
                if let Some(bp) = bind_port(spec) {
                    tunnels.push(tunnel(TunnelKind::Dynamic, bp, "", 0));
                }
            }
            if !tunnels.is_empty() {
                values.push(("tunnels", json!(tunnels)));
            }
            let mut notes = Vec::new();
            // ProxyJump : noms d'autres hôtes du fichier (importés comme sessions) ou user@hôte:port.
            if let Some(jump) = opts.get("proxyjump").filter(|j| !j.eq_ignore_ascii_case("none")) {
                values.push(("jump", json!(jump)));
            }
            if opts.contains_key("proxycommand") {
                notes.push("ProxyCommand non repris (utilisez « Serveur de rebond »)");
            }
            if !opts.contains_key("user") {
                notes.push("utilisateur à compléter");
            }
            out.push(Candidate {
                session: session(alias, folder, "ssh", values),
                note: (!notes.is_empty()).then(|| notes.join(" · ")),
                duplicate: false,
            });
        }
    }
    out
}

pub fn ssh_config(path: &PathBuf, folder: &str) -> Result<Vec<Candidate>> {
    let text = fs::read_to_string(path).with_context(|| format!("Lecture impossible : {}", path.display()))?;
    Ok(parse_ssh_config(&text, folder))
}

// ---------- PuTTY (registre Windows) ----------

/// Noms de session PuTTY : « Mon%20serveur » → « Mon serveur ».
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// « L8080=localhost:80,D1080,4L2222=db:22 » → tunnels (les R… sont ignorés).
pub fn parse_putty_forwards(s: &str) -> Vec<TunnelSpec> {
    s.split(',')
        .filter_map(|entry| {
            let entry = entry.trim().trim_start_matches(['4', '6']);
            let (kind, rest) = entry.split_at(entry.char_indices().nth(1)?.0);
            match kind {
                "L" => {
                    let (bind, dest) = rest.split_once('=')?;
                    let (h, p) = split_host_port(dest)?;
                    Some(tunnel(TunnelKind::Local, bind_port(bind)?, &h, p))
                }
                "D" => Some(tunnel(TunnelKind::Dynamic, bind_port(rest.trim_end_matches('='))?, "", 0)),
                _ => None,
            }
        })
        .collect()
}

#[cfg(windows)]
pub fn putty(folder: &str) -> Result<Vec<Candidate>> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let root = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\SimonTatham\PuTTY\Sessions")
        .context("Aucune session PuTTY trouvée sur ce PC")?;
    let mut out = Vec::new();
    for key_name in root.enum_keys().flatten() {
        let name = percent_decode(&key_name);
        if name == "Default Settings" {
            continue;
        }
        let Ok(key) = root.open_subkey(&key_name) else { continue };
        let get = |n: &str| key.get_value::<String, _>(n).unwrap_or_default();
        let protocol = get("Protocol");
        let mut host = get("HostName");
        let mut user = get("UserName");
        if let Some((u, h)) = host.clone().split_once('@') {
            user = u.to_string();
            host = h.to_string();
        }
        if host.is_empty() {
            continue;
        }
        let port = key.get_value::<u32, _>("PortNumber").unwrap_or(22);
        match protocol.as_str() {
            "ssh" => {
                let mut values = vec![("host", json!(host)), ("port", json!(port))];
                if !user.is_empty() {
                    values.push(("username", json!(user)));
                }
                let key_file = get("PublicKeyFile");
                values.push(("auth", json!("key")));
                if !key_file.is_empty() {
                    values.push(("keyPath", json!(key_file)));
                }
                let tunnels = parse_putty_forwards(&get("PortForwardings"));
                if !tunnels.is_empty() {
                    values.push(("tunnels", json!(tunnels)));
                }
                let note = user.is_empty().then(|| "utilisateur à compléter".to_string());
                out.push(Candidate { session: session(&name, folder, "ssh", values), note, duplicate: false });
            }
            "telnet" => out.push(Candidate {
                session: session(&name, folder, "telnet", vec![("host", json!(host)), ("port", json!(port))]),
                note: None, duplicate: false,
            }),
            other => out.push(Candidate {
                session: session(&name, folder, "", vec![("host", json!(host))]),
                note: Some(format!("protocole « {other} » pas encore pris en charge")), duplicate: false,
            }),
        }
    }
    Ok(out)
}

#[cfg(not(windows))]
pub fn putty(_folder: &str) -> Result<Vec<Candidate>> {
    bail!("L'import PuTTY n'est disponible que sous Windows")
}

// ---------- mRemoteNG (confCons.xml) ----------

pub fn parse_mremoteng(xml: &str, base_folder: &str) -> Result<Vec<Candidate>> {
    use quick_xml::{events::Event, Reader, XmlVersion};

    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<String> = Vec::new();
    let mut out = Vec::new();

    loop {
        let (event, empty) = match reader.read_event().context("Fichier mRemoteNG illisible")? {
            Event::Eof => break,
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::End(e) => {
                if e.name().as_ref() == "Node" {
                    stack.pop();
                }
                continue;
            }
            _ => continue,
        };
        let mut attrs = HashMap::new();
        for attr in event.attributes().flatten() {
            let value = attr.normalized_value(XmlVersion::Implicit1_0).map(|v| v.into_owned()).unwrap_or_default();
            attrs.insert(attr.key.as_ref().to_string(), value);
        }
        let tag = event.name().as_ref().to_string();
        if tag.ends_with("Connections") && attrs.get("FullFileEncryption").is_some_and(|v| v == "true") {
            bail!("Ce fichier mRemoteNG est entièrement chiffré. Dans mRemoteNG, désactivez « Chiffrement complet du fichier » puis réessayez.");
        }
        if tag != "Node" {
            continue;
        }
        let get = |k: &str| attrs.get(k).cloned().unwrap_or_default();
        let name = get("Name");
        if get("Type") == "Container" {
            if !empty {
                stack.push(name);
            }
            continue;
        }
        let folder = std::iter::once(base_folder.to_string())
            .chain(stack.iter().cloned())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        let host = get("Hostname");
        let port: u64 = get("Port").parse().unwrap_or(0);
        let user = get("Username");
        let domain = get("Domain");
        let protocol = get("Protocol");
        let candidate = match protocol.as_str() {
            "SSH2" | "SSH1" => {
                let mut values = vec![("host", json!(host)), ("port", json!(if port == 0 { 22 } else { port })), ("auth", json!("password"))];
                if !user.is_empty() {
                    values.push(("username", json!(user)));
                }
                Candidate {
                    session: session(&name, &folder, "ssh", values),
                    note: Some("mot de passe à ressaisir".into()), duplicate: false,
                }
            }
            "Telnet" => Candidate {
                session: session(&name, &folder, "telnet", vec![("host", json!(host)), ("port", json!(if port == 0 { 23 } else { port }))]),
                note: None, duplicate: false,
            },
            "RDP" => {
                let username = match (domain.is_empty(), user.is_empty()) {
                    (_, true) => String::new(),
                    (true, false) => user.clone(),
                    (false, false) => format!("{domain}\\{user}"),
                };
                let mut values = vec![("host", json!(host)), ("port", json!(if port == 0 { 3389 } else { port }))];
                if !username.is_empty() {
                    values.push(("username", json!(username)));
                }
                Candidate { session: session(&name, &folder, "rdp", values), note: None, duplicate: false }
            }
            "HTTP" | "HTTPS" => {
                let scheme = protocol.to_lowercase();
                let default = if scheme == "https" { 443 } else { 80 };
                let url = if port == 0 || port == default { format!("{scheme}://{host}") } else { format!("{scheme}://{host}:{port}") };
                Candidate { session: session(&name, &folder, "web", vec![("url", json!(url))]), note: None, duplicate: false }
            }
            other => Candidate {
                session: session(&name, &folder, "", vec![("host", json!(host))]),
                note: Some(format!("protocole « {other} » pas encore pris en charge")), duplicate: false,
            },
        };
        if !host.is_empty() {
            out.push(candidate);
        }
    }
    Ok(out)
}

pub fn mremoteng(path: &PathBuf, folder: &str) -> Result<Vec<Candidate>> {
    let xml = fs::read_to_string(path).with_context(|| format!("Lecture impossible : {}", path.display()))?;
    parse_mremoteng(&xml, folder)
}

// ---------- Sauvegarde Termoria ----------

#[derive(Serialize, Deserialize)]
pub struct Backup {
    pub app: String,
    pub version: u32,
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    /// Notes des sessions, par identifiant.
    #[serde(default)]
    pub notes: std::collections::HashMap<String, String>,
}

pub fn read_backup(path: &PathBuf) -> Result<Backup> {
    let text = fs::read_to_string(path).with_context(|| format!("Lecture impossible : {}", path.display()))?;
    let backup: Backup = serde_json::from_str(&text).context("Ce fichier n'est pas une sauvegarde Termoria")?;
    if backup.app != "termoria" {
        bail!("Ce fichier n'est pas une sauvegarde Termoria");
    }
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_complet() {
        let text = r#"
# commentaire
Host web prod-web
    HostName 10.0.1.12
    User deploy
    IdentityFile ~/.ssh/id_prod
    LocalForward 8080 localhost:80
    DynamicForward 1080

Host db
    HostName %h.interne
    Port 2222
    ProxyJump bastion

Host *.lan
    User admin

Host *
    User root
    Port 22
"#;
        let c = parse_ssh_config(text, "Import");
        let names: Vec<_> = c.iter().map(|c| c.session.name.as_str()).collect();
        assert_eq!(names, vec!["web", "prod-web", "db"]);
        let web = &c[0].session;
        assert_eq!(web.folder, "Import");
        assert_eq!(web.values["host"], json!("10.0.1.12"));
        assert_eq!(web.values["username"], json!("deploy"));
        assert!(web.values["keyPath"].as_str().unwrap().ends_with("id_prod"));
        let tunnels: Vec<TunnelSpec> = serde_json::from_value(web.values["tunnels"].clone()).unwrap();
        assert_eq!(tunnels.len(), 2);
        assert_eq!((tunnels[0].bind_port, tunnels[0].remote_host.as_str(), tunnels[0].remote_port), (8080, "localhost", 80));
        assert_eq!(tunnels[1].kind, TunnelKind::Dynamic);

        let db = &c[2];
        assert_eq!(db.session.values["host"], json!("db.interne"));
        assert_eq!(db.session.values["port"], json!(2222));
        assert_eq!(db.session.values["username"], json!("root"), "valeur par défaut de Host *");
        assert_eq!(db.session.values["jump"], json!("bastion"));
    }

    #[test]
    fn redirections_putty() {
        let t = parse_putty_forwards("L8080=localhost:80,D1080,R9000=x:1,4L2222=db.local:22");
        assert_eq!(t.len(), 3);
        assert_eq!((t[0].bind_port, t[0].remote_port), (8080, 80));
        assert_eq!(t[1].kind, TunnelKind::Dynamic);
        assert_eq!((t[2].bind_port, t[2].remote_host.as_str()), (2222, "db.local"));
        assert_eq!(percent_decode("Mon%20serveur%2Fprod"), "Mon serveur/prod");
    }

    #[test]
    fn mremoteng_avec_dossiers() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<mrng:Connections xmlns:mrng="http://mremoteng.org" Name="Connections" FullFileEncryption="false">
  <Node Name="Prod" Type="Container">
    <Node Name="web" Type="Connection" Protocol="SSH2" Hostname="10.0.1.12" Port="22" Username="deploy" />
    <Node Name="dc" Type="Connection" Protocol="RDP" Hostname="dc01" Port="3389" Username="admin" Domain="CORP" />
  </Node>
  <Node Name="nas" Type="Connection" Protocol="HTTPS" Hostname="nas.lan" Port="5001" />
  <Node Name="pi" Type="Connection" Protocol="VNC" Hostname="pi.lan" Port="5900" />
</mrng:Connections>"#;
        let c = parse_mremoteng(xml, "mRemoteNG").unwrap();
        assert_eq!(c.len(), 4);
        assert_eq!((c[0].session.folder.as_str(), c[0].session.protocol.as_str()), ("mRemoteNG/Prod", "ssh"));
        assert_eq!(c[1].session.values["username"], json!("CORP\\admin"));
        assert_eq!((c[2].session.folder.as_str(), c[2].session.values["url"].as_str().unwrap()), ("mRemoteNG", "https://nas.lan:5001"));
        assert_eq!(c[3].session.protocol, "", "VNC pas encore pris en charge");
    }

    #[test]
    fn mremoteng_chiffre_refuse() {
        let xml = r#"<mrng:Connections xmlns:mrng="http://mremoteng.org" FullFileEncryption="true">xxx</mrng:Connections>"#;
        assert!(parse_mremoteng(xml, "").is_err());
    }
}
