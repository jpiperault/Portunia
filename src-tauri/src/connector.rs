//! Contrat d'une extension (« connecteur »).
//!
//! Le cœur de Portunia ne connaît aucun protocole : chaque connecteur décrit
//! ses champs de formulaire et le type de vue qu'il affiche, puis ouvre la
//! connexion. Ajouter un protocole = implémenter `Connector` et l'enregistrer
//! dans `Registry`.

use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc,
    },
};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

/// Type de vue affichée par l'application pour ce protocole.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    /// Terminal intégré dans un onglet (SSH, Telnet, série…).
    Terminal,
    /// Écran distant affiché dans un onglet (VNC…) : voir `ScreenEvent`.
    Screen,
    /// Session ouverte dans une application externe. Plus utilisé par les extensions
    /// intégrées (le RDP s'affiche dans un onglet), mais disponible pour d'autres.
    #[allow(dead_code)]
    Desktop,
    /// Page web (consoles d'administration).
    Web,
    /// Explorateur de fichiers seul (FTP, S3…) : pas de terminal.
    Files,
}

#[derive(Serialize, Clone)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FieldKind {
    Text,
    Number,
    /// Stocké dans le Gestionnaire d'identifiants Windows, jamais sur disque.
    Secret,
    File,
    Bool,
    Choice { options: Vec<ChoiceOption> },
    /// Liste de tunnels (`Vec<TunnelSpec>`), éditée par un composant dédié.
    Tunnels,
    /// Texte libre avec des suggestions fournies par le connecteur (ex. ports COM présents).
    Suggest { source: String },
}

#[derive(Serialize, Clone)]
pub struct ShowIf {
    pub key: String,
    pub equals: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: FieldKind,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_if: Option<ShowIf>,
    /// Champ masqué (et ignoré) quand cet autre champ est rempli (ex. identifiants partagés).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_by: Option<String>,
}

impl Field {
    pub fn new(key: &str, label: &str, kind: FieldKind) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            kind,
            required: false,
            default: None,
            placeholder: None,
            show_if: None,
            hidden_by: None,
        }
    }

    pub fn hidden_by(mut self, key: &str) -> Self {
        self.hidden_by = Some(key.into());
        self
    }

    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub fn default(mut self, value: impl Into<Value>) -> Self {
        self.default = Some(value.into());
        self
    }

    pub fn placeholder(mut self, text: &str) -> Self {
        self.placeholder = Some(text.into());
        self
    }

    /// N'affiche le champ que si un autre champ vaut `equals` (« !x » : tout sauf x).
    pub fn show_if(mut self, key: &str, equals: &str) -> Self {
        self.show_if = Some(ShowIf {
            key: key.into(),
            equals: equals.into(),
        });
        self
    }
}

pub fn choice(options: &[(&str, &str)]) -> FieldKind {
    FieldKind::Choice {
        options: options
            .iter()
            .map(|(value, label)| ChoiceOption {
                value: (*value).into(),
                label: (*label).into(),
            })
            .collect(),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub view: ViewKind,
    pub builtin: bool,
    /// Proposée dans le catalogue : à installer avant de servir (sauf si des sessions l'utilisent déjà).
    pub catalog: bool,
    /// La connexion propose un explorateur de fichiers distant (voir `RemoteFiles`).
    pub file_browser: bool,
    /// La connexion sait ouvrir des tunnels (voir `PortForwarder`).
    pub port_forwarding: bool,
    pub fields: Vec<Field>,
}

/// Où un connecteur terminal envoie ce qu'il reçoit.
pub trait Sink: Send + Sync {
    fn data(&self, bytes: &[u8]);
    /// Question posée à l'utilisateur (ex. empreinte d'un nouveau serveur). `None` : pas
    /// d'interface pour répondre (commande sans terminal) ; l'appelant doit alors refuser.
    fn confirm(&self, _question: Confirm) -> Option<tokio::sync::oneshot::Receiver<bool>> {
        None
    }
    /// Image d'un écran distant (vue `Screen`).
    fn screen(&self, _event: ScreenEvent) {}
    /// Zone d'image en binaire (voir `pixels_packet`) : envoyée telle quelle à la page, sans
    /// base64 ni JSON. Même ordre que `screen`.
    fn screen_pixels(&self, _packet: Vec<u8>) {}
    /// Fin de la connexion ; `reason` est renseigné en cas d'erreur.
    fn closed(&self, reason: Option<String>);
}

/// Paquet binaire d'une zone d'image : « P », x, y, largeur, hauteur (u16 petit-boutien),
/// puis les pixels RGBA. Même format que celui du moteur RDP (`portunia-rdp`).
pub fn pixels_packet(x: u16, y: u16, width: u16, height: u16, rgba: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(9 + rgba.len());
    packet.push(b'P');
    for v in [x, y, width, height] {
        packet.extend_from_slice(&v.to_le_bytes());
    }
    packet.extend_from_slice(rgba);
    packet
}

/// Ce qu'une connexion graphique envoie à l'interface.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScreenEvent {
    /// Taille de l'écran distant (efface l'image).
    #[serde(rename_all = "camelCase")]
    Resize { width: u16, height: u16 },
    /// Pixels RGBA bruts, encodés en base64.
    #[serde(rename_all = "camelCase")]
    Image { x: u16, y: u16, width: u16, height: u16, rgba: String },
    /// Image JPEG encodée en base64.
    #[serde(rename_all = "camelCase")]
    Jpeg { x: u16, y: u16, width: u16, height: u16, data: String },
    /// Copie d'une zone de l'écran vers une autre.
    #[serde(rename_all = "camelCase")]
    Copy { x: u16, y: u16, width: u16, height: u16, src_x: u16, src_y: u16 },
    Bell,
    /// Le presse-papiers distant a changé.
    Clipboard { text: String },
    /// Bureau à distance, copie de fichiers : possible dans la session.
    Files { allowed: bool },
    /// Le presse-papiers du serveur contient (ou plus) des fichiers.
    RemoteFiles { available: bool },
    FilesOffered { count: usize },
    FileSent { name: String },
    FileProgress { name: String, done: u64, total: u64 },
    FilesSaved { dir: String, count: usize },
    FileError { code: String, name: Option<String> },
}

/// Clavier, souris et presse-papiers envoyés à un écran distant.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    /// `keysym` : touche X11 (VNC) ; `code` : touche physique du navigateur (RDP).
    Key {
        keysym: u32,
        down: bool,
        #[serde(default)]
        code: Option<String>,
    },
    /// Position en pixels de l'écran distant ; boutons : 1 gauche, 2 milieu, 4 droit, 8/16 molette.
    Pointer { x: u16, y: u16, buttons: u8 },
    /// L'onglet a changé de taille (pixels) : le bureau distant peut s'adapter.
    Resize { width: u16, height: u16 },
    Clipboard { text: String },
    /// Bureau à distance : fichiers de ce poste mis au presse-papiers de la session.
    SendFiles { paths: Vec<String> },
    /// Bureau à distance : fichiers copiés sur le serveur, enregistrés dans ce dossier.
    FetchFiles { dir: String },
}

/// Connexion terminal ouverte, pilotée par l'interface.
pub trait TerminalConnection: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    fn close(&self);
    /// Accès aux fichiers du serveur, si le protocole le permet.
    fn files(&self) -> Option<Arc<dyn RemoteFiles>> {
        None
    }
    /// Tunnels (redirection de ports), si le protocole le permet.
    fn forwarder(&self) -> Option<Arc<dyn PortForwarder>> {
        None
    }
    /// Commandes lancées à côté du terminal (installation d'une clé…), si le protocole le permet.
    fn exec(&self) -> Option<Arc<dyn RemoteExec>> {
        None
    }
    /// Clavier / souris pour un écran distant (vue `Screen`).
    fn input(&self, _event: InputEvent) -> Result<()> {
        Err(anyhow!(t!("This session does not accept this kind of input", "Cette session n'accepte pas ce type de saisie")))
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    /// Un port de ce PC mène à `remote_host:remote_port` vu depuis le serveur (ssh -L).
    Local,
    /// Proxy SOCKS5 sur ce PC : tout passe par le serveur (ssh -D).
    Dynamic,
    /// Un port du serveur mène à `remote_host:remote_port` vu depuis ce PC (ssh -R).
    Remote,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    pub id: String,
    pub kind: TunnelKind,
    pub bind_port: u16,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default)]
    pub remote_port: u16,
    /// Ouvert automatiquement à la connexion.
    #[serde(default)]
    pub auto_start: bool,
}

impl TunnelSpec {
    pub fn describe(&self) -> String {
        match self.kind {
            TunnelKind::Local => format!(
                "localhost:{} → {}:{}",
                self.bind_port, self.remote_host, self.remote_port
            ),
            TunnelKind::Dynamic => format!("proxy SOCKS localhost:{}", self.bind_port),
            TunnelKind::Remote => format!(
                "serveur:{} → {}:{} (ce PC)",
                self.bind_port, self.remote_host, self.remote_port
            ),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub spec: TunnelSpec,
    /// Connexions en cours à travers le tunnel.
    pub connections: u32,
    /// Dernière erreur rencontrée par une connexion du tunnel.
    pub last_error: Option<String>,
}

/// Tunnels ouverts sur une connexion (ils se ferment avec elle).
pub trait PortForwarder: Send + Sync {
    fn start(&self, spec: TunnelSpec) -> BoxFuture<'_, ()>;
    fn stop(&self, id: &str);
    fn list(&self) -> Vec<TunnelStatus>;
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Avancement d'un transfert : (octets transférés, taille totale).
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Date de modification (secondes Unix).
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

/// Explorateur de fichiers distant. Les chemins sont ceux du serveur (`/`).
pub trait RemoteFiles: Send + Sync {
    fn home(&self) -> BoxFuture<'_, String>;
    fn list(&self, path: String) -> BoxFuture<'_, Vec<RemoteEntry>>;
    fn download(&self, remote: String, local: PathBuf, progress: Progress) -> BoxFuture<'_, ()>;
    fn upload(&self, local: PathBuf, remote: String, progress: Progress) -> BoxFuture<'_, ()>;
    fn mkdir(&self, path: String) -> BoxFuture<'_, ()>;
    /// Supprime un fichier, ou un dossier et tout son contenu.
    fn remove(&self, path: String, is_dir: bool) -> BoxFuture<'_, ()>;
    fn rename(&self, from: String, to: String) -> BoxFuture<'_, ()>;
    /// Change la date de modification (secondes Unix), pour qu'une copie garde celle de l'original.
    /// Sans effet si le protocole ne le permet pas.
    fn set_modified(&self, _path: String, _secs: u64) -> BoxFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    /// Reprise d'un téléchargement : `local` contient déjà les `offset` premiers octets.
    fn download_from(&self, _remote: String, _local: PathBuf, _offset: u64, _progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async { anyhow::bail!("{}", t!("This protocol cannot resume a transfer", "Ce protocole ne sait pas reprendre un transfert")) })
    }
    /// Reprise d'un envoi : le fichier du serveur contient déjà les `offset` premiers octets.
    fn upload_from(&self, _local: PathBuf, _remote: String, _offset: u64, _progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async { anyhow::bail!("{}", t!("This protocol cannot resume a transfer", "Ce protocole ne sait pas reprendre un transfert")) })
    }
}

/// Fichier en cours de téléchargement, renommé à la fin : « rapport.pdf.partiel ».
pub fn partial_path(local: &std::path::Path) -> PathBuf {
    let mut name = local.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".partiel");
    local.with_file_name(name)
}

pub enum Outcome {
    /// La session s'affiche dans un onglet terminal.
    Terminal(Box<dyn TerminalConnection>),
    /// La session s'est ouverte ailleurs (fenêtre, application externe).
    Detached(String),
}

#[derive(Clone)]
pub struct ConnectContext {
    pub app: AppHandle,
    pub session_name: String,
    /// Valeurs des champs, secrets compris.
    pub values: HashMap<String, Value>,
    pub cols: u16,
    pub rows: u16,
    pub sink: Arc<dyn Sink>,
    pub data_dir: PathBuf,
}

impl ConnectContext {
    /// Valeur texte nettoyée, `None` si absente ou vide.
    pub fn str(&self, key: &str) -> Option<String> {
        match self.values.get(key)? {
            Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    /// Valeur brute (mots de passe : les espaces comptent).
    pub fn raw(&self, key: &str) -> Option<String> {
        match self.values.get(key)? {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    }

    pub fn require(&self, key: &str, label: &str) -> Result<String> {
        self.str(key)
            .ok_or_else(|| anyhow!("{}", t!(format!("Required field missing: {label}"), format!("Champ requis manquant : {label}"))))
    }

    pub fn port(&self, default: u16) -> Result<u16> {
        match self.str("port") {
            None => Ok(default),
            Some(s) => s.parse().map_err(|_| anyhow!("{}", t!(format!("Invalid port: {s}"), format!("Port invalide : {s}")))),
        }
    }

    pub fn bool(&self, key: &str) -> bool {
        matches!(self.values.get(key), Some(Value::Bool(true)))
    }
}

pub trait Connector: Send + Sync {
    fn manifest(&self) -> Manifest;
    /// Fonction payante requise (vérifiée par le cœur avant la connexion).
    fn required_feature(&self) -> Option<crate::license::Feature> {
        None
    }
    /// Appelé hors du thread de l'interface : peut bloquer (réseau).
    fn connect(&self, ctx: ConnectContext) -> Result<Outcome>;
    /// Suggestions pour un champ `Suggest` (appelé à l'ouverture du formulaire).
    fn suggestions(&self, _source: &str) -> Vec<ChoiceOption> {
        Vec::new()
    }
}

/// Commandes envoyées au thread d'une connexion terminal.
pub enum Cmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// `TerminalConnection` générique : transmet les commandes à un thread de travail.
pub struct WorkerConnection {
    tx: Sender<Cmd>,
}

impl WorkerConnection {
    pub fn new() -> (Self, Receiver<Cmd>) {
        let (tx, rx) = mpsc::channel();
        (Self { tx }, rx)
    }
}

impl TerminalConnection for WorkerConnection {
    fn write(&self, data: &[u8]) -> Result<()> {
        self.tx
            .send(Cmd::Write(data.to_vec()))
            .map_err(|_| anyhow!(t!("Session closed", "Session fermée")))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.tx
            .send(Cmd::Resize(cols, rows))
            .map_err(|_| anyhow!(t!("Session closed", "Session fermée")))
    }

    fn close(&self) {
        let _ = self.tx.send(Cmd::Close);
    }
}

/// Résultat d'une commande lancée sur le serveur.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub status: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

/// Exécution de commandes sur le serveur, hors du terminal (canal séparé).
pub trait RemoteExec: Send + Sync {
    fn run(&self, command: String) -> BoxFuture<'_, ExecOutput>;
}

/// Question oui / non posée à l'utilisateur pendant une connexion.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Confirm {
    pub title: String,
    pub message: String,
    /// Détail en police fixe (empreinte…).
    pub detail: String,
    pub accept: String,
    pub reject: String,
}
