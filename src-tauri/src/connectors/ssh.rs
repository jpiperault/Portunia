//! SSH avec russh (100 % Rust) : algorithmes modernes (curve25519, ed25519,
//! chacha20-poly1305…), compatibles avec OpenSSH 10 et suivants.

use std::{
    borrow::Cow,
    collections::HashMap,
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use russh::{
    cipher,
    client::{self, KeyboardInteractiveAuthResponse},
    kex,
    keys::{
        agent::client::AgentClient, load_secret_key, Algorithm, HashAlg, PrivateKeyWithHashAlg,
        PublicKey, PublicKeyOrCertificate,
    },
    mac, ChannelMsg, Disconnect, Names, Preferred,
};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::forward::{serve_remote, RemoteForwards, SshForwarder};
use super::sftp::SftpFiles;
use crate::connector::*;
use serde_json::Value;

pub struct SshConnector;

impl Connector for SshConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "ssh".into(),
            name: "SSH".into(),
            version: "0.5.0".into(),
            description: "Terminal sécurisé : clé privée, mot de passe ou agent.".into(),
            view: ViewKind::Terminal,
            builtin: true,
            file_browser: true,
            port_forwarding: true,
            fields: vec![
                Field::new("host", "Hôte", FieldKind::Text)
                    .required()
                    .placeholder("serveur.exemple.fr ou 10.0.0.12"),
                Field::new("port", "Port", FieldKind::Number).default(22),
                Field::new("credential", "Identifiants partagés", FieldKind::Suggest { source: "credentials".into() })
                    .placeholder("Vide = identifiants propres à cette session"),
                Field::new("username", "Utilisateur", FieldKind::Text).required().hidden_by("credential"),
                Field::new(
                    "auth",
                    "Authentification",
                    choice(&[
                        ("key", "Clé privée"),
                        ("password", "Mot de passe"),
                        ("agent", "Agent (Pageant / OpenSSH)"),
                    ]),
                )
                .default("key")
                .hidden_by("credential"),
                Field::new("keyPath", "Fichier de clé privée", FieldKind::File)
                    .placeholder("Vide = ~/.ssh/id_ed25519, id_ecdsa ou id_rsa")
                    .show_if("auth", "key")
                    .hidden_by("credential"),
                Field::new("passphrase", "Phrase de passe de la clé", FieldKind::Secret)
                    .show_if("auth", "key")
                    .hidden_by("credential"),
                Field::new("password", "Mot de passe", FieldKind::Secret)
                    .show_if("auth", "password")
                    .hidden_by("credential"),
                Field::new(
                    "legacy",
                    "Compatibilité anciens équipements (autorise des algorithmes faibles)",
                    FieldKind::Bool,
                )
                .default(false),
                Field::new("jump", "Serveur de rebond (bastion)", FieldKind::Suggest { source: "ssh-sessions".into() })
                    .placeholder("Vide = connexion directe. Session SSH ou utilisateur@hôte:port"),
                Field::new("mac", "Adresse MAC (Wake-on-LAN)", FieldKind::Text)
                    .placeholder("Facultatif : AA:BB:CC:DD:EE:FF, pour réveiller la machine"),
                Field::new("x11", "Afficher les applications graphiques du serveur (X11)", FieldKind::Bool).default(false),
                Field::new("x11Display", "Serveur X de ce PC", FieldKind::Text)
                    .placeholder("localhost:0 (VcXsrv, X410…)")
                    .show_if("x11", "true"),
                Field::new("tunnels", "Tunnels", FieldKind::Tunnels),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        // Appelé sur un thread bloquant : on attend la connexion, puis la
        // session continue dans une tâche asynchrone.
        let (tx, rx) = unbounded_channel();
        let sink = ctx.sink.clone();
        // Ports ouverts sur le serveur (-R) : leurs connexions arrivent au gestionnaire SSH.
        let remote: RemoteForwards = Arc::default();
        let extras = Extras { remote: remote.clone(), x11: x11_display(&ctx)? };
        let (handle, channel, hops) = tauri::async_runtime::block_on(open(&ctx, &extras))?;
        let handle = Arc::new(handle);
        // L'explorateur de fichiers ouvre son propre canal SFTP sur la même connexion.
        let files: Arc<dyn RemoteFiles> = Arc::new(SftpFiles::new(handle.clone()));
        let forwarder: Arc<dyn PortForwarder> = Arc::new(SshForwarder::new(handle.clone(), remote));
        let exec: Arc<dyn RemoteExec> = Arc::new(SshExec { handle: handle.clone() });

        // Tunnels à ouvrir dès la connexion.
        let tunnels: Vec<TunnelSpec> = ctx
            .values
            .get("tunnels")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        for spec in tunnels.into_iter().filter(|t| t.auto_start) {
            let line = match tauri::async_runtime::block_on(forwarder.start(spec.clone())) {
                Ok(()) => format!("\x1b[90m[Termoria] Tunnel ouvert : {}\x1b[0m\r\n", spec.describe()),
                Err(e) => format!("\x1b[33m[Termoria] Tunnel {} impossible : {e:#}\x1b[0m\r\n", spec.describe()),
            };
            sink.data(line.as_bytes());
        }

        tauri::async_runtime::spawn(async move {
            let (mut read, write) = channel.split();
            let result = pump(&mut read, &write, rx, sink.as_ref()).await;
            let _ = write.close().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "fr")
                .await;
            // Les serveurs de rebond se ferment après la session.
            drop(hops);
            sink.closed(result.err().map(|e| format!("{e:#}")));
        });
        Ok(Outcome::Terminal(Box::new(SshConnection { tx, files, forwarder, exec })))
    }
}

struct SshConnection {
    tx: UnboundedSender<Cmd>,
    files: Arc<dyn RemoteFiles>,
    forwarder: Arc<dyn PortForwarder>,
    exec: Arc<dyn RemoteExec>,
}

impl TerminalConnection for SshConnection {
    fn write(&self, data: &[u8]) -> Result<()> {
        self.tx
            .send(Cmd::Write(data.to_vec()))
            .map_err(|_| anyhow!("Session fermée"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.tx
            .send(Cmd::Resize(cols, rows))
            .map_err(|_| anyhow!("Session fermée"))
    }

    fn close(&self) {
        let _ = self.tx.send(Cmd::Close);
    }

    fn files(&self) -> Option<Arc<dyn RemoteFiles>> {
        Some(self.files.clone())
    }

    fn forwarder(&self) -> Option<Arc<dyn PortForwarder>> {
        Some(self.forwarder.clone())
    }

    fn exec(&self) -> Option<Arc<dyn RemoteExec>> {
        Some(self.exec.clone())
    }
}


/// Commandes sur un canal séparé de la même connexion.
struct SshExec {
    handle: Arc<Handle>,
}

impl RemoteExec for SshExec {
    fn run(&self, command: String) -> BoxFuture<'_, ExecOutput> {
        Box::pin(async move {
            let mut channel = self.handle.channel_open_session().await?;
            channel.exec(true, command.as_bytes()).await?;
            let (mut stdout, mut stderr, mut status) = (Vec::new(), Vec::new(), None);
            let collect = async {
                while let Some(msg) = channel.wait().await {
                    match msg {
                        ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                        ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                        ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                        _ => {}
                    }
                }
            };
            tokio::time::timeout(Duration::from_secs(30), collect)
                .await
                .map_err(|_| anyhow!("Le serveur n'a pas répondu à temps"))?;
            Ok(ExecOutput {
                status,
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            })
        })
    }
}
type Channel = russh::Channel<client::Msg>;

type Handle = client::Handle<Handler>;
type Hops = Vec<Handle>;

/// Ouvre la session SSH et son terminal. Les connexions aux serveurs de rebond
/// sont renvoyées pour rester ouvertes aussi longtemps que la session.
async fn open(ctx: &ConnectContext, extras: &Extras) -> Result<(Handle, Channel, Hops)> {
    let (handle, hops) = session(ctx, 0, Some(extras)).await?;
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", ctx.cols as u32, ctx.rows as u32, 0, 0, &[])
        .await?;
    if extras.x11.is_some() {
        // Le serveur crée un DISPLAY ; les applications graphiques arrivent au gestionnaire SSH.
        let cookie = uuid::Uuid::new_v4().simple().to_string();
        channel
            .request_x11(false, false, "MIT-MAGIC-COOKIE-1", cookie, 0)
            .await
            .map_err(|e| anyhow!("Affichage X11 refusé par le serveur : {e} (X11Forwarding yes dans sshd_config ?)"))?;
    }
    // « remoteCommand » (shell d'un conteneur, journaux…) : lancée à la place du shell, avec terminal.
    match ctx.str("remoteCommand") {
        Some(command) => channel.exec(false, command.as_bytes()).await?,
        None => channel.request_shell(false).await?,
    }
    Ok((handle, channel, hops))
}


/// Sortie gardée par serveur pour une commande lancée sur plusieurs serveurs.
const MAX_OUTPUT: usize = 64 * 1024;

/// Lance une commande sans terminal (connexion dédiée, fermée ensuite).
/// Les messages de la connexion (clé du serveur, rebonds) sont ignorés.
pub async fn run_command(ctx: &ConnectContext, command: &str, timeout: Duration) -> Result<ExecOutput> {
    let (handle, hops) = session(ctx, 0, None).await?;
    let result = tokio::time::timeout(timeout, async {
        let mut channel = handle.channel_open_session().await?;
        channel.exec(true, command.as_bytes()).await?;
        let (mut stdout, mut stderr, mut status) = (Vec::new(), Vec::new(), None);
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } if stdout.len() < MAX_OUTPUT => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } if stderr.len() < MAX_OUTPUT => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>(ExecOutput {
            status,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    })
    .await;
    let _ = handle.disconnect(Disconnect::ByApplication, "", "fr").await;
    drop(hops);
    result.map_err(|_| anyhow!("Pas de fin de la commande après {} s", timeout.as_secs()))?
}

/// Destination des messages d'une connexion sans terminal : rien n'est affiché.
pub struct QuietSink;

impl Sink for QuietSink {
    fn data(&self, _bytes: &[u8]) {}
    fn closed(&self, _reason: Option<String>) {}
}

/// Ce que seule la session d'un terminal reçoit (pas les bastions ni les commandes multiples).
struct Extras {
    remote: RemoteForwards,
    /// Adresse TCP du serveur X de ce PC.
    x11: Option<String>,
}

/// « localhost:0 », « :1 », « 127.0.0.1:0.0 » → « 127.0.0.1:6000 » (port 6000 + écran).
fn x11_display(ctx: &ConnectContext) -> Result<Option<String>> {
    if !ctx.bool("x11") {
        return Ok(None);
    }
    let display = ctx.str("x11Display").unwrap_or_else(|| "localhost:0".into());
    let (host, rest) = display.rsplit_once(':').ok_or_else(|| anyhow!("Écran X11 invalide : {display} (ex. localhost:0)"))?;
    let number: u16 = rest.split('.').next().unwrap_or("0").parse().map_err(|_| anyhow!("Écran X11 invalide : {display}"))?;
    let host = if host.is_empty() || host == "localhost" { "127.0.0.1" } else { host };
    Ok(Some(format!("{host}:{}", 6000 + number)))
}
/// Établissement de la connexion SSH (empreinte d'un nouveau serveur à confirmer comprise).
const HANDSHAKE: Duration = Duration::from_secs(330);

/// Rebonds enchaînés au plus (bastion → bastion → serveur).
const MAX_HOPS: usize = 3;

/// Connexion authentifiée, directe ou à travers le serveur de rebond `jumpHost`
/// (valeurs complètes d'une autre session, préparées par le cœur).
fn session<'a>(ctx: &'a ConnectContext, depth: usize, extras: Option<&'a Extras>) -> Pin<Box<dyn Future<Output = Result<(Handle, Hops)>> + Send + 'a>> {
    Box::pin(async move {
        let host = ctx.require("host", "Hôte")?;
        let port = ctx.port(22)?;
        let user = ctx.require("username", "Utilisateur")?;

        let config = Arc::new(client::Config {
            // Détecte une connexion morte en moins d'une minute (réseau coupé, veille).
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            preferred: if ctx.bool("legacy") { legacy_preferred() } else { Preferred::DEFAULT },
            ..Default::default()
        });
        let rejection = Arc::new(Mutex::new(None));
        let handler = Handler {
            known_hosts: ctx.data_dir.join("known_hosts.json"),
            host_id: format!("{host}:{port}"),
            sink: ctx.sink.clone(),
            rejection: rejection.clone(),
            remote: extras.map(|e| e.remote.clone()),
            x11: extras.and_then(|e| e.x11.clone()),
            x11_warned: Arc::default(),
        };

        let mut hops = Hops::new();
        let connected = match ctx.values.get("jumpHost") {
            Some(Value::Object(jump)) => {
                if depth >= MAX_HOPS {
                    bail!("Trop de serveurs de rebond enchaînés (maximum {MAX_HOPS})");
                }
                let mut hop = ctx.clone();
                hop.values = jump.clone().into_iter().collect();
                let via = hop.str("host").unwrap_or_default();
                let (bastion, earlier) = session(&hop, depth + 1, None)
                    .await
                    .with_context(|| format!("Serveur de rebond {via}"))?;
                ctx.sink.data(format!("\x1b[90m[Termoria] Rebond par {via} vers {host}:{port}\x1b[0m\r\n").as_bytes());
                let tunnel = bastion
                    .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
                    .await
                    .with_context(|| format!("{via} n'a pas pu joindre {host}:{port}"))?;
                hops = earlier;
                hops.push(bastion);
                tokio::time::timeout(HANDSHAKE, client::connect_stream(config, tunnel.into_stream(), handler)).await
            }
            // TCP : 15 s au plus. Poignée de main : plus longue, l'utilisateur peut avoir une empreinte à vérifier.
            _ => match tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect((host.as_str(), port))).await {
                Err(_) => bail!("Pas de réponse de {host}:{port} (délai dépassé)"),
                Ok(Err(e)) => return Err(anyhow!(e).context(format!("Connexion impossible à {host}:{port}"))),
                Ok(Ok(tcp)) => {
                    let _ = tcp.set_nodelay(true);
                    tokio::time::timeout(HANDSHAKE, client::connect_stream(config, tcp, handler)).await
                }
            },
        };
        let mut handle = match connected {
            Err(_) => bail!("Pas de réponse de {host}:{port} pendant l'établissement de la connexion (délai dépassé)"),
            Ok(Ok(handle)) => handle,
            Ok(Err(e)) => {
                // Clé du serveur refusée : on affiche l'explication détaillée.
                if let Some(reason) = rejection.lock().unwrap().take() {
                    bail!(reason);
                }
                return Err(anyhow!(e).context(format!("Connexion impossible à {host}:{port}")));
            }
        };

        let ok = match ctx.str("auth").as_deref().unwrap_or("key") {
            "password" => {
                let password = ctx
                    .raw("password")
                    .ok_or_else(|| anyhow!("Aucun mot de passe enregistré pour cette session"))?;
                auth_password(&mut handle, &user, &password).await?
            }
            "agent" => auth_agent(&mut handle, &user).await?,
            // Connexion rapide : clé par défaut si elle s'ouvre sans phrase secrète, puis agent.
            "auto" => {
                let mut ok = false;
                if let Some(key) = default_key().and_then(|p| load_secret_key(&p, None).ok()) {
                    let hash = handle.best_supported_rsa_hash().await?.flatten();
                    ok = handle
                        .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                        .await?
                        .success();
                }
                if !ok {
                    ok = auth_agent(&mut handle, &user).await.unwrap_or(false);
                }
                ok
            }
            _ => {
                let path = ctx
                    .str("keyPath")
                    .map(PathBuf::from)
                    .or_else(default_key)
                    .ok_or_else(|| anyhow!("Aucune clé privée trouvée dans ~/.ssh"))?;
                let key = load_secret_key(&path, ctx.raw("passphrase").as_deref())
                    .with_context(|| format!("Lecture de la clé impossible : {}", path.display()))?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await?
                    .success()
            }
        };
        if !ok {
            bail!(
                "Authentification refusée pour {user}@{host}.\n\
                 Vérifiez l'identifiant. Note : par défaut, OpenSSH interdit la connexion \
                 de root par mot de passe (PermitRootLogin prohibit-password)."
            );
        }

        Ok((handle, hops))
    })
}

/// Mot de passe, puis « keyboard-interactive » (utilisé par certains serveurs
/// pour la saisie du mot de passe).
async fn auth_password(handle: &mut client::Handle<Handler>, user: &str, password: &str) -> Result<bool> {
    if handle.authenticate_password(user, password).await?.success() {
        return Ok(true);
    }
    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None::<String>)
        .await?;
    for _ in 0..5 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
    Ok(false)
}

/// Agent OpenSSH de Windows, sinon Pageant.
async fn auth_agent(handle: &mut client::Handle<Handler>, user: &str) -> Result<bool> {
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        if try_agent(handle, user, agent).await? {
            return Ok(true);
        }
    }
    if let Ok(agent) = AgentClient::connect_pageant().await {
        return try_agent(handle, user, agent).await;
    }
    bail!("Aucun agent SSH trouvé (service « OpenSSH Authentication Agent » ou Pageant)")
}

async fn try_agent<S>(handle: &mut client::Handle<Handler>, user: &str, mut agent: AgentClient<S>) -> Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow!("Agent SSH : {e}"))?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let key = identity.public_key().into_owned();
        let result = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
            .map_err(|e| anyhow!("Agent SSH : {e:?}"))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

// Algorithmes anciens, ajoutés APRÈS les modernes : ils ne sont choisis que
// si le serveur ne propose rien de mieux.
const LEGACY_KEX: &[kex::Name] = &[kex::DH_GEX_SHA1, kex::DH_G14_SHA1, kex::DH_G1_SHA1];
const LEGACY_CIPHERS: &[cipher::Name] = &[
    cipher::AES_256_CBC,
    cipher::AES_192_CBC,
    cipher::AES_128_CBC,
    cipher::TRIPLE_DES_CBC,
];
const LEGACY_MACS: &[mac::Name] = &[mac::HMAC_SHA1_ETM, mac::HMAC_SHA1];

fn legacy_preferred() -> Preferred {
    let base = Preferred::DEFAULT;
    // Les pseudo-algorithmes d'extension (ext-info, strict-kex) restent en fin de liste.
    let (real, extensions): (Vec<kex::Name>, Vec<kex::Name>) = base
        .kex
        .iter()
        .copied()
        .partition(|k| !k.as_ref().contains("@openssh.com") && !k.as_ref().starts_with("ext-info"));
    let kex = real.into_iter().chain(LEGACY_KEX.iter().copied()).chain(extensions).collect::<Vec<_>>();
    let mut key = base.key.to_vec();
    key.push(Algorithm::Dsa);
    Preferred {
        kex: Cow::Owned(kex),
        key: Cow::Owned(key),
        cipher: Cow::Owned(base.cipher.iter().chain(LEGACY_CIPHERS).copied().collect()),
        mac: Cow::Owned(base.mac.iter().chain(LEGACY_MACS).copied().collect()),
        ..base
    }
}

/// Liste des algorithmes faibles réellement négociés avec le serveur.
fn weak_algorithms(names: &Names) -> Vec<String> {
    let mut weak = Vec::new();
    if LEGACY_KEX.contains(&names.kex) {
        weak.push(format!("échange de clés {}", names.kex.as_ref()));
    }
    if LEGACY_CIPHERS.contains(&names.cipher) {
        weak.push(format!("chiffrement {}", names.cipher.as_ref()));
    }
    for m in [&names.client_mac, &names.server_mac] {
        if LEGACY_MACS.contains(m) {
            weak.push(format!("intégrité {}", m.as_ref()));
            break;
        }
    }
    match names.key {
        Algorithm::Dsa => weak.push("clé de serveur ssh-dss".into()),
        Algorithm::Rsa { hash: None } => weak.push("clé de serveur ssh-rsa (SHA-1)".into()),
        _ => {}
    }
    weak
}

fn default_key() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| Path::new(&home).join(".ssh").join(name))
        .find(|path| path.exists())
}

/// Relaie la saisie de l'interface et la sortie du serveur.
async fn pump(
    read: &mut russh::ChannelReadHalf,
    write: &russh::ChannelWriteHalf<client::Msg>,
    mut rx: UnboundedReceiver<Cmd>,
    sink: &dyn Sink,
) -> Result<()> {
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(Cmd::Write(data)) => write.data_bytes(data).await?,
                Some(Cmd::Resize(cols, rows)) => write.window_change(cols as u32, rows as u32, 0, 0).await?,
                Some(Cmd::Close) | None => return Ok(()),
            },
            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => sink.data(&data),
                Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitStatus { .. }) => return Ok(()),
                // Canal coupé sans fin de session : connexion perdue (réseau, veille…).
                None => bail!("connexion interrompue"),
                Some(_) => {}
            },
        }
    }
}

struct Handler {
    known_hosts: PathBuf,
    host_id: String,
    sink: Arc<dyn Sink>,
    /// Explication à afficher si la clé du serveur est refusée.
    rejection: Arc<Mutex<Option<String>>>,
    /// Ports ouverts sur le serveur (-R), seulement pour la session d'un terminal.
    remote: Option<RemoteForwards>,
    /// Serveur X de ce PC (adresse TCP) si l'affichage X11 est demandé.
    x11: Option<String>,
    x11_warned: Arc<std::sync::atomic::AtomicBool>,
}

static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

impl client::Handler for Handler {
    type Error = russh::Error;

    /// Connexion reçue sur un port ouvert sur le serveur (-R) : reliée à sa destination sur ce PC.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote.as_ref().and_then(|r| {
            r.lock().unwrap().get(&connected_port).map(|t| (t.host.clone(), t.port, t.stats.clone()))
        });
        match target {
            Some((host, port, stats)) => {
                reply.accept().await;
                tokio::spawn(serve_remote(channel, host, port, stats));
            }
            None => reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await,
        }
        Ok(())
    }

    /// Application graphique lancée sur le serveur : reliée au serveur X de ce PC (VcXsrv, X410…).
    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(display) = self.x11.clone() else {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        };
        reply.accept().await;
        let (sink, warned) = (self.sink.clone(), self.x11_warned.clone());
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect(&display).await {
                Ok(mut local) => {
                    let mut remote = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
                }
                Err(_) if !warned.swap(true, std::sync::atomic::Ordering::Relaxed) => {
                    sink.data(format!(
                        "\r\n\x1b[33m[Termoria] Une application graphique veut s'afficher, mais aucun serveur X ne répond sur {display}.\r\n\
                         Démarrez VcXsrv (« Disable access control » coché) ou X410, puis relancez l'application.\x1b[0m\r\n"
                    ).as_bytes());
                }
                Err(_) => {}
            }
        });
        Ok(())
    }

    /// Avertit dans le terminal si la connexion utilise un algorithme faible.
    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let weak = weak_algorithms(names);
        if !weak.is_empty() {
            self.sink.data(
                format!(
                    "\x1b[33m[Termoria] Attention : connexion peu sûre ({}). \
                     Mettez à jour l'équipement si possible.\x1b[0m\r\n",
                    weak.join(", ")
                )
                .as_bytes(),
            );
        }
        Ok(())
    }

    /// Vérifie la clé du serveur (« confiance au premier usage ») :
    /// une clé qui change bloque la connexion.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let public = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();

        let expected = {
            let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            read_known(&self.known_hosts).get(&self.host_id).cloned()
        };
        match expected {
            Some(expected) if expected == fingerprint => return Ok(true),
            Some(expected) => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "ATTENTION : la clé du serveur {} a changé.\n\
                     Attendue : {expected}\nReçue : {fingerprint}\n\
                     Connexion refusée : quelqu'un pourrait intercepter la connexion. Si ce changement \
                     est normal (serveur réinstallé), supprimez la ligne « {} » de {}.",
                    self.host_id,
                    self.host_id,
                    self.known_hosts.display()
                ));
                return Ok(false);
            }
            None => {}
        }

        // Serveur jamais vu par Termoria : déjà vérifié avec OpenSSH (~/.ssh/known_hosts) ?
        let (host, port) = self.host_id.rsplit_once(':').map(|(h, p)| (h.to_string(), p.parse().unwrap_or(22))).unwrap_or((self.host_id.clone(), 22));
        let openssh = openssh_fingerprints(&host, port);
        let accepted = if openssh.contains(&fingerprint) {
            self.sink.data(b"\x1b[90m[Termoria] Serveur reconnu (~/.ssh/known_hosts)\x1b[0m\r\n");
            true
        } else if !openssh.is_empty() {
            *self.rejection.lock().unwrap() = Some(format!(
                "ATTENTION : la clé du serveur {} ne correspond pas à celle de ~/.ssh/known_hosts.\n\
                 Reçue : {fingerprint}\nConnexion refusée : quelqu'un pourrait intercepter la connexion.",
                self.host_id
            ));
            return Ok(false);
        } else {
            // Première connexion : l'utilisateur confirme l'empreinte, comme avec OpenSSH.
            let question = Confirm {
                title: format!("Nouveau serveur : {}", self.host_id),
                message: "Termoria ne connaît pas encore ce serveur. Vérifiez que l'empreinte ci-dessous est bien celle du \
                          serveur (son administrateur peut l'obtenir avec « ssh-keygen -lf » sur la clé de l'hôte). \
                          Elle sera mémorisée : un changement futur bloquera la connexion."
                    .into(),
                detail: format!("{} {fingerprint}", public.algorithm().as_str()),
                accept: "Faire confiance et se connecter".into(),
                reject: "Annuler".into(),
            };
            let answer = match self.sink.confirm(question) {
                Some(rx) => matches!(tokio::time::timeout(Duration::from_secs(300), rx).await, Ok(Ok(true))),
                None => {
                    *self.rejection.lock().unwrap() = Some(format!(
                        "Serveur {} jamais vérifié : ouvrez-le une fois dans un onglet pour confirmer sa clé.",
                        self.host_id
                    ));
                    return Ok(false);
                }
            };
            if !answer {
                *self.rejection.lock().unwrap() = Some("Clé du serveur non confirmée : connexion annulée.".into());
            }
            answer
        };
        if accepted {
            let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let mut known = read_known(&self.known_hosts);
            known.insert(self.host_id.clone(), fingerprint.clone());
            if let Ok(text) = serde_json::to_string_pretty(&known) {
                let _ = crate::vault::write(&self.known_hosts, &text);
            }
            self.sink.data(format!("\x1b[90m[Termoria] Nouveau serveur mémorisé ({fingerprint})\x1b[0m\r\n").as_bytes());
        }
        Ok(accepted)
    }
}

fn read_known(path: &Path) -> HashMap<String, String> {
    // Chiffré avec les autres données quand un mot de passe maître est défini.
    crate::vault::load_json(path).0
}

/// Empreintes (SHA256) que ~/.ssh/known_hosts d'OpenSSH associe à cet hôte,
/// noms hachés compris (« |1|sel|hachage »). Les lignes @revoked / @cert-authority sont ignorées.
fn openssh_fingerprints(host: &str, port: u16) -> Vec<String> {
    let Some(home) = std::env::var_os("USERPROFILE") else { return Vec::new() };
    let Ok(text) = fs::read_to_string(Path::new(&home).join(".ssh").join("known_hosts")) else { return Vec::new() };
    known_hosts_fingerprints(&text, host, port)
}

fn known_hosts_fingerprints(text: &str, host: &str, port: u16) -> Vec<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let name = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    let matches_pattern = |pattern: &str| -> bool {
        if let Some(rest) = pattern.strip_prefix("|1|") {
            let Some((salt, hash)) = rest.split_once('|') else { return false };
            let (Ok(salt), Ok(hash)) = (STANDARD.decode(salt), STANDARD.decode(hash)) else { return false };
            let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &salt);
            ring::hmac::verify(&key, name.as_bytes(), &hash).is_ok()
        } else {
            pattern.eq_ignore_ascii_case(&name)
        }
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('@'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let (hosts, kind, data) = (parts.next()?, parts.next()?, parts.next()?);
            // Comme OpenSSH : un motif nié (« !hôte ») exclut l'hôte même si un autre le désigne.
            if hosts.split(',').any(|p| p.strip_prefix('!').is_some_and(|n| matches_pattern(n)))
                || !hosts.split(',').any(|p| !p.starts_with('!') && matches_pattern(p))
            {
                return None;
            }
            let key = PublicKey::from_openssh(&format!("{kind} {data}")).ok()?;
            Some(key.fingerprint(HashAlg::Sha256).to_string())
        })
        .collect()
}

#[cfg(test)]
mod known_hosts_tests {
    use super::*;

    /// Lignes hachées par « ssh-keygen -H » (OpenSSH pour Windows), empreinte donnée par « ssh-keygen -lf ».
    const HASHED: &str = "|1|eU2qlFkRlru2Yq/D0ZzGFZOVwTU=|jAAoef4DunMYjIgbcAIpwEGTv0Q= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtq4SAHiITjyoq6OPA+F5+5y55c4DI3V84+mrrXmMTK\n\
|1|/Undn3L5YO/g20k1MjhgjsI+IuI=|mF1yyWud6qkaqdi1BTMvSrL3iZk= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtq4SAHiITjyoq6OPA+F5+5y55c4DI3V84+mrrXmMTK\n";
    const FINGERPRINT: &str = "SHA256:fi111SBeLJCCWkbnrVt90w0E72Z2bW4rRWilXUkm4R4";

    #[test]
    fn noms_haches_d_openssh() {
        assert_eq!(known_hosts_fingerprints(HASHED, "example.com", 22), vec![FINGERPRINT.to_string()]);
        assert_eq!(known_hosts_fingerprints(HASHED, "example.com", 2222), vec![FINGERPRINT.to_string()]);
        assert!(known_hosts_fingerprints(HASHED, "example.org", 22).is_empty());
        assert!(known_hosts_fingerprints(HASHED, "example.com", 2200).is_empty());
    }

    #[test]
    fn noms_en_clair_et_marqueurs() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtq4SAHiITjyoq6OPA+F5+5y55c4DI3V84+mrrXmMTK";
        let text = format!("# commentaire\nsrv1,10.0.0.1 {key}\n@revoked srv2 {key}\n!srv3,srv3 {key}\n");
        assert_eq!(known_hosts_fingerprints(&text, "10.0.0.1", 22), vec![FINGERPRINT.to_string()]);
        assert_eq!(known_hosts_fingerprints(&text, "SRV1", 22).len(), 1);
        assert!(known_hosts_fingerprints(&text, "srv2", 22).is_empty(), "les clés révoquées ne valent pas confiance");
        assert!(known_hosts_fingerprints(&text, "srv3", 22).is_empty(), "motif nié");
    }
}
