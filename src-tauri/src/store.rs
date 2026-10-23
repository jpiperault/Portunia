//! Sessions enregistrées, dans `sessions.json` (dossier de données de l'appli).
//! Les secrets n'y figurent jamais : voir `secrets.rs`.

use std::{collections::HashMap, fs, path::PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub folder: String,
    pub protocol: String,
    #[serde(default)]
    pub values: HashMap<String, Value>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Champs secrets enregistrés dans le coffre Windows pour cette session.
    #[serde(default)]
    pub secret_keys: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct FileFormat {
    version: u32,
    sessions: Vec<Session>,
}

pub struct Store {
    path: PathBuf,
    sessions: Vec<Session>,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let sessions = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FileFormat>(&text) {
                Ok(file) => file.sessions,
                Err(_) => {
                    // Ne jamais écraser un fichier illisible : on le met de côté.
                    let _ = fs::rename(&path, path.with_extension("json.illisible"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { path, sessions }
    }

    fn persist(&self) -> Result<()> {
        let file = FileFormat {
            version: 1,
            sessions: self.sessions.clone(),
        };
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&file)?)
            .with_context(|| format!("Écriture impossible : {}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("Écriture impossible : {}", self.path.display()))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Session> {
        self.sessions.clone()
    }

    pub fn get(&self, id: &str) -> Option<Session> {
        self.sessions.iter().find(|s| s.id == id).cloned()
    }

    pub fn upsert(&mut self, session: Session) -> Result<Session> {
        match self.sessions.iter_mut().find(|s| s.id == session.id) {
            Some(existing) => *existing = session.clone(),
            None => self.sessions.push(session.clone()),
        }
        self.persist()?;
        Ok(session)
    }

    pub fn remove(&mut self, id: &str) -> Result<Option<Session>> {
        let Some(index) = self.sessions.iter().position(|s| s.id == id) else {
            return Ok(None);
        };
        let removed = self.sessions.remove(index);
        self.persist()?;
        Ok(Some(removed))
    }
}
