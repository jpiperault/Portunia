//! Contrat d'une extension (« connecteur »).
//!
//! Le cœur de Termoria ne connaît aucun protocole : chaque connecteur décrit
//! ses champs de formulaire et le type de vue qu'il affiche, puis ouvre la
//! connexion. Ajouter un protocole = implémenter `Connector` et l'enregistrer
//! dans `Registry`.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc,
    },
};

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/// Type de vue affichée par l'application pour ce protocole.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    /// Terminal intégré dans un onglet (SSH, Telnet, série…).
    Terminal,
    /// Bureau à distance (RDP, VNC…).
    Desktop,
    /// Page web (consoles d'administration).
    Web,
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
        }
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

    /// N'affiche le champ que si un autre champ vaut `equals`.
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
    pub fields: Vec<Field>,
}

/// Où un connecteur terminal envoie ce qu'il reçoit.
pub trait Sink: Send + Sync {
    fn data(&self, bytes: &[u8]);
    /// Fin de la connexion ; `reason` est renseigné en cas d'erreur.
    fn closed(&self, reason: Option<String>);
}

/// Connexion terminal ouverte, pilotée par l'interface.
pub trait TerminalConnection: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    fn close(&self);
}

pub enum Outcome {
    /// La session s'affiche dans un onglet terminal.
    Terminal(Box<dyn TerminalConnection>),
    /// La session s'est ouverte ailleurs (fenêtre, application externe).
    Detached(String),
}

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
            .ok_or_else(|| anyhow!("Champ requis manquant : {label}"))
    }

    pub fn port(&self, default: u16) -> Result<u16> {
        match self.str("port") {
            None => Ok(default),
            Some(s) => s.parse().map_err(|_| anyhow!("Port invalide : {s}")),
        }
    }

    pub fn bool(&self, key: &str) -> bool {
        matches!(self.values.get(key), Some(Value::Bool(true)))
    }
}

pub trait Connector: Send + Sync {
    fn manifest(&self) -> Manifest;
    /// Appelé hors du thread de l'interface : peut bloquer (réseau).
    fn connect(&self, ctx: ConnectContext) -> Result<Outcome>;
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
