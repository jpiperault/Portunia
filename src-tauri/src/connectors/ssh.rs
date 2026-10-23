//! SSH avec russh (100 % Rust) : algorithmes modernes (curve25519, ed25519,
//! chacha20-poly1305…), compatibles avec OpenSSH 10 et suivants.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use russh::{
    client::{self, KeyboardInteractiveAuthResponse},
    keys::{
        agent::client::AgentClient, load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey,
        PublicKeyOrCertificate,
    },
    ChannelMsg, Disconnect,
};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::connector::*;

pub struct SshConnector;

impl Connector for SshConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "ssh".into(),
            name: "SSH".into(),
            version: "0.2.0".into(),
            description: "Terminal sécurisé : clé privée, mot de passe ou agent.".into(),
            view: ViewKind::Terminal,
            builtin: true,
            fields: vec![
                Field::new("host", "Hôte", FieldKind::Text)
                    .required()
                    .placeholder("serveur.exemple.fr ou 10.0.0.12"),
                Field::new("port", "Port", FieldKind::Number).default(22),
                Field::new("username", "Utilisateur", FieldKind::Text).required(),
                Field::new(
                    "auth",
                    "Authentification",
                    choice(&[
                        ("key", "Clé privée"),
                        ("password", "Mot de passe"),
                        ("agent", "Agent (Pageant / OpenSSH)"),
                    ]),
                )
                .default("key"),
                Field::new("keyPath", "Fichier de clé privée", FieldKind::File)
                    .placeholder("Vide = ~/.ssh/id_ed25519, id_ecdsa ou id_rsa")
                    .show_if("auth", "key"),
                Field::new("passphrase", "Phrase de passe de la clé", FieldKind::Secret)
                    .show_if("auth", "key"),
                Field::new("password", "Mot de passe", FieldKind::Secret)
                    .show_if("auth", "password"),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        // Appelé sur un thread bloquant : on attend la connexion, puis la
        // session continue dans une tâche asynchrone.
        let (tx, rx) = unbounded_channel();
        let sink = ctx.sink.clone();
        let (handle, channel) = tauri::async_runtime::block_on(open(&ctx))?;
        tauri::async_runtime::spawn(async move {
            let (mut read, write) = channel.split();
            let result = pump(&mut read, &write, rx, sink.as_ref()).await;
            let _ = write.close().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "fr")
                .await;
            sink.closed(result.err().map(|e| format!("{e:#}")));
        });
        Ok(Outcome::Terminal(Box::new(SshConnection { tx })))
    }
}

struct SshConnection {
    tx: UnboundedSender<Cmd>,
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
}

type Channel = russh::Channel<client::Msg>;

async fn open(ctx: &ConnectContext) -> Result<(client::Handle<Handler>, Channel)> {
    let host = ctx.require("host", "Hôte")?;
    let port = ctx.port(22)?;
    let user = ctx.require("username", "Utilisateur")?;

    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let rejection = Arc::new(Mutex::new(None));
    let handler = Handler {
        known_hosts: ctx.data_dir.join("known_hosts.json"),
        host_id: format!("{host}:{port}"),
        sink: ctx.sink.clone(),
        rejection: rejection.clone(),
    };

    let connecting = client::connect(config, (host.as_str(), port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connecting).await {
        Err(_) => bail!("Pas de réponse de {host}:{port} (délai dépassé)"),
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

    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", ctx.cols as u32, ctx.rows as u32, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    Ok((handle, channel))
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
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return Ok(()),
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
}

static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

impl client::Handler for Handler {
    type Error = russh::Error;

    /// Vérifie la clé du serveur (« confiance au premier usage ») :
    /// une clé qui change bloque la connexion.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let public = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();

        let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut known: HashMap<String, String> = fs::read_to_string(&self.known_hosts)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();

        match known.get(&self.host_id) {
            Some(expected) if *expected == fingerprint => Ok(true),
            Some(expected) => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "ATTENTION : la clé du serveur {} a changé.\n\
                     Attendue : {expected}\nReçue : {fingerprint}\n\
                     Connexion refusée. Si ce changement est normal (serveur réinstallé), \
                     supprimez la ligne « {} » de {}.",
                    self.host_id,
                    self.host_id,
                    self.known_hosts.display()
                ));
                Ok(false)
            }
            None => {
                known.insert(self.host_id.clone(), fingerprint.clone());
                if let Ok(text) = serde_json::to_string_pretty(&known) {
                    let _ = fs::write(&self.known_hosts, text);
                }
                self.sink.data(
                    format!("\x1b[90m[Termoria] Nouveau serveur mémorisé ({fingerprint})\x1b[0m\r\n")
                        .as_bytes(),
                );
                Ok(true)
            }
        }
    }
}
