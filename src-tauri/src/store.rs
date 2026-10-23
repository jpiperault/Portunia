//! Sessions enregistrées, dans `sessions.json` (dossier de données de l'appli).
//! Les secrets n'y figurent jamais : voir `secrets.rs`.

use std::{collections::HashMap, fs, path::PathBuf};

use anyhow::{bail, Context, Result};
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
    /// Dossiers créés explicitement (ils existent même vides).
    /// Chemins séparés par `/` : « Production/Web ».
    #[serde(default)]
    folders: Vec<String>,
}

pub struct Store {
    path: PathBuf,
    sessions: Vec<Session>,
    folders: Vec<String>,
}

/// « /Prod//Web/ » → « Prod/Web ». Chaîne vide = racine.
pub fn normalize_folder(path: &str) -> String {
    path.split(['/', '\\'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Si `path` est `from` ou l'un de ses sous-dossiers, son nouveau chemin sous `to`.
fn reparent(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(if to.is_empty() { rest.to_string() } else { format!("{to}/{rest}") })
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let file = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FileFormat>(&text) {
                Ok(file) => file,
                Err(_) => {
                    // Ne jamais écraser un fichier illisible : on le met de côté.
                    let _ = fs::rename(&path, path.with_extension("json.illisible"));
                    FileFormat::default()
                }
            },
            Err(_) => FileFormat::default(),
        };
        Self {
            path,
            sessions: file.sessions,
            folders: file.folders,
        }
    }

    fn persist(&self) -> Result<()> {
        let file = FileFormat {
            version: 2,
            sessions: self.sessions.clone(),
            folders: self.folders.clone(),
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

    /// Tous les dossiers : créés explicitement, utilisés par une session, et leurs parents.
    pub fn folders(&self) -> Vec<String> {
        let mut all = std::collections::BTreeSet::new();
        for folder in self.folders.iter().chain(self.sessions.iter().map(|s| &s.folder)) {
            let mut path = folder.as_str();
            while !path.is_empty() {
                all.insert(path.to_string());
                path = parent_of(path);
            }
        }
        all.into_iter().collect()
    }

    pub fn create_folder(&mut self, path: &str) -> Result<String> {
        let path = normalize_folder(path);
        if path.is_empty() {
            bail!("Donnez un nom au dossier");
        }
        if !self.folders.contains(&path) {
            self.folders.push(path.clone());
            self.persist()?;
        }
        Ok(path)
    }

    /// Renomme ou déplace un dossier avec tout son contenu.
    pub fn rename_folder(&mut self, from: &str, to: &str) -> Result<()> {
        let (from, to) = (normalize_folder(from), normalize_folder(to));
        if from.is_empty() || to.is_empty() {
            bail!("Nom de dossier invalide");
        }
        if from == to {
            return Ok(());
        }
        if reparent(&to, &from, "").is_some() {
            bail!("Impossible de déplacer un dossier dans lui-même");
        }
        if self.folders().contains(&to) {
            bail!("Le dossier « {to} » existe déjà");
        }
        for folder in &mut self.folders {
            if let Some(moved) = reparent(folder, &from, &to) {
                *folder = moved;
            }
        }
        for session in &mut self.sessions {
            if let Some(moved) = reparent(&session.folder, &from, &to) {
                session.folder = moved;
            }
        }
        self.persist()
    }

    /// Supprime un dossier ; son contenu (sessions et sous-dossiers) remonte d'un niveau.
    pub fn delete_folder(&mut self, path: &str) -> Result<()> {
        let path = normalize_folder(path);
        let parent = parent_of(&path).to_string();
        self.folders.retain(|f| *f != path);
        for folder in &mut self.folders {
            if let Some(moved) = reparent(folder, &path, &parent) {
                *folder = moved;
            }
        }
        self.folders.retain(|f| !f.is_empty());
        self.folders.sort();
        self.folders.dedup();
        for session in &mut self.sessions {
            if let Some(moved) = reparent(&session.folder, &path, &parent) {
                session.folder = moved;
            }
        }
        self.persist()
    }

    pub fn move_sessions(&mut self, ids: &[String], folder: &str) -> Result<()> {
        let folder = normalize_folder(folder);
        for session in self.sessions.iter_mut().filter(|s| ids.contains(&s.id)) {
            session.folder = folder.clone();
        }
        self.persist()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(folders: &[&str], sessions: &[(&str, &str)]) -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("termoria-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut store = Store::load(dir.join("sessions.json"));
        store.folders = folders.iter().map(|f| f.to_string()).collect();
        store.sessions = sessions
            .iter()
            .map(|(id, folder)| Session {
                id: id.to_string(),
                name: id.to_string(),
                folder: folder.to_string(),
                protocol: "ssh".into(),
                values: HashMap::new(),
                tags: vec![],
                secret_keys: vec![],
            })
            .collect();
        (store, dir)
    }

    fn folder_of(store: &Store, id: &str) -> String {
        store.get(id).unwrap().folder
    }

    #[test]
    fn normalise_les_chemins() {
        assert_eq!(normalize_folder(" /Prod// Web /"), "Prod/Web");
        assert_eq!(normalize_folder(r"Prod\Web"), "Prod/Web");
        assert_eq!(normalize_folder("  "), "");
    }

    #[test]
    fn liste_les_dossiers_et_leurs_parents() {
        let (store, _) = store_with(&["Vide"], &[("a", "Prod/Web/Front")]);
        assert_eq!(store.folders(), vec!["Prod", "Prod/Web", "Prod/Web/Front", "Vide"]);
    }

    #[test]
    fn renomme_un_dossier_avec_son_contenu() {
        let (mut store, _) = store_with(&["Prod/Vide"], &[("a", "Prod"), ("b", "Prod/Web"), ("c", "Production")]);
        store.rename_folder("Prod", "Clients/Prod").unwrap();
        assert_eq!(folder_of(&store, "a"), "Clients/Prod");
        assert_eq!(folder_of(&store, "b"), "Clients/Prod/Web");
        assert_eq!(folder_of(&store, "c"), "Production", "un préfixe de nom n'est pas un sous-dossier");
        assert!(store.folders().contains(&"Clients/Prod/Vide".to_string()));
    }

    #[test]
    fn refuse_un_dossier_dans_lui_meme_ou_un_doublon() {
        let (mut store, _) = store_with(&[], &[("a", "Prod/Web"), ("b", "Lab")]);
        assert!(store.rename_folder("Prod", "Prod/Web/Prod").is_err());
        assert!(store.rename_folder("Prod", "Lab").is_err());
    }

    #[test]
    fn supprimer_un_dossier_remonte_son_contenu() {
        let (mut store, _) = store_with(&["Prod/Web/Vide"], &[("a", "Prod/Web"), ("b", "Prod/Web/Front"), ("c", "Prod")]);
        store.delete_folder("Prod/Web").unwrap();
        assert_eq!(folder_of(&store, "a"), "Prod");
        assert_eq!(folder_of(&store, "b"), "Prod/Front");
        assert_eq!(folder_of(&store, "c"), "Prod");
        assert!(store.folders().contains(&"Prod/Vide".to_string()));
        assert!(!store.folders().contains(&"Prod/Web".to_string()));
    }

    #[test]
    fn deplace_des_sessions_et_persiste() {
        let (mut store, dir) = store_with(&[], &[("a", ""), ("b", "Lab")]);
        store.move_sessions(&["a".into(), "b".into()], "/Prod/").unwrap();
        let reloaded = Store::load(dir.join("sessions.json"));
        assert_eq!(folder_of(&reloaded, "a"), "Prod");
        assert_eq!(folder_of(&reloaded, "b"), "Prod");
        let _ = fs::remove_dir_all(dir);
    }
}
