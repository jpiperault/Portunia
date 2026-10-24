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

/// Sessions auxquelles une commande enregistrée est proposée.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    All,
    /// Les sessions de ce dossier et de ses sous-dossiers.
    Folder { path: String },
    Session { id: String },
}

/// Commande enregistrée, envoyée au terminal en un clic.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// Peut contenir plusieurs lignes et des variables : {{host}}, {{username}}…
    pub command: String,
    pub scope: Scope,
    /// Appuyer sur Entrée après la commande.
    #[serde(default = "yes")]
    pub run: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Default)]
struct FileFormat {
    version: u32,
    sessions: Vec<Session>,
    /// Dossiers créés explicitement (ils existent même vides).
    /// Chemins séparés par `/` : « Production/Web ».
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    snippets: Vec<Snippet>,
    #[serde(default)]
    folder_colors: HashMap<String, String>,
}

pub struct Store {
    path: PathBuf,
    sessions: Vec<Session>,
    folders: Vec<String>,
    snippets: Vec<Snippet>,
    folder_colors: HashMap<String, String>,
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
            snippets: file.snippets,
            folder_colors: file.folder_colors,
        }
    }

    fn persist(&self) -> Result<()> {
        let file = FileFormat {
            version: 4,
            sessions: self.sessions.clone(),
            folders: self.folders.clone(),
            snippets: self.snippets.clone(),
            folder_colors: self.folder_colors.clone(),
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
        self.move_snippet_scopes(&from, &to);
        self.move_folder_colors(&from, &to);
        self.persist()
    }

    /// Les commandes d'un dossier déplacé le suivent (vers la racine : toutes les sessions).
    fn move_snippet_scopes(&mut self, from: &str, to: &str) {
        for snippet in &mut self.snippets {
            if let Scope::Folder { path } = &snippet.scope {
                if let Some(moved) = reparent(path, from, to) {
                    snippet.scope = if moved.is_empty() { Scope::All } else { Scope::Folder { path: moved } };
                }
            }
        }
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
        self.move_snippet_scopes(&path, &parent);
        self.folder_colors.remove(&path);
        self.move_folder_colors(&path, &parent);
        self.persist()
    }

    /// Ajoute des sessions importées (nouveaux identifiants, sans mot de passe).
    pub fn add_sessions(&mut self, sessions: Vec<Session>) -> Result<usize> {
        let mut added = 0;
        for mut session in sessions.into_iter().filter(|s| !s.protocol.is_empty()) {
            session.id = uuid::Uuid::new_v4().to_string();
            session.name = session.name.trim().to_string();
            if session.name.is_empty() {
                session.name = "Session importée".into();
            }
            session.folder = normalize_folder(&session.folder);
            session.secret_keys.clear();
            self.sessions.push(session);
            added += 1;
        }
        self.persist()?;
        Ok(added)
    }

    /// Contenu d'une sauvegarde : sessions (sans secrets), dossiers, commandes.
    pub fn export_parts(&self) -> (Vec<Session>, Vec<String>, Vec<Snippet>) {
        let sessions = self
            .sessions
            .iter()
            .cloned()
            .map(|mut s| {
                s.secret_keys.clear();
                s
            })
            .collect();
        (sessions, self.folders(), self.snippets.clone())
    }

    /// Restaure une sauvegarde : ce qui existe déjà (même identifiant) est conservé.
    /// Renvoie (sessions ajoutées, sessions déjà présentes, commandes ajoutées).
    pub fn merge_backup(
        &mut self,
        sessions: Vec<Session>,
        folders: Vec<String>,
        snippets: Vec<Snippet>,
    ) -> Result<(usize, usize, usize)> {
        let (mut added, mut skipped, mut snips) = (0, 0, 0);
        for mut session in sessions {
            if session.id.is_empty() || self.sessions.iter().any(|s| s.id == session.id) {
                skipped += 1;
                continue;
            }
            session.folder = normalize_folder(&session.folder);
            session.secret_keys.clear();
            self.sessions.push(session);
            added += 1;
        }
        for folder in folders.iter().map(|f| normalize_folder(f)).filter(|f| !f.is_empty()) {
            if !self.folders.contains(&folder) {
                self.folders.push(folder);
            }
        }
        for snippet in snippets {
            if !self.snippets.iter().any(|s| s.id == snippet.id) {
                self.snippets.push(snippet);
                snips += 1;
            }
        }
        self.persist()?;
        Ok((added, skipped, snips))
    }

    /// Couleur des dossiers (héritée par les sous-dossiers et les sessions).
    pub fn folder_colors(&self) -> HashMap<String, String> {
        self.folder_colors.clone()
    }

    pub fn set_folder_color(&mut self, path: &str, color: Option<String>) -> Result<()> {
        let path = normalize_folder(path);
        if path.is_empty() {
            bail!("Dossier invalide");
        }
        match color.filter(|c| !c.is_empty()) {
            Some(c) => self.folder_colors.insert(path, c),
            None => self.folder_colors.remove(&path),
        };
        self.persist()
    }

    fn move_folder_colors(&mut self, from: &str, to: &str) {
        let moved: Vec<(String, String, String)> = self
            .folder_colors
            .iter()
            .filter_map(|(k, v)| reparent(k, from, to).map(|new| (k.clone(), new, v.clone())))
            .collect();
        for (old, _, _) in &moved {
            self.folder_colors.remove(old);
        }
        for (_, new, color) in moved.into_iter().filter(|(_, p, _)| !p.is_empty()) {
            self.folder_colors.entry(new).or_insert(color);
        }
    }

    pub fn snippets(&self) -> Vec<Snippet> {
        self.snippets.clone()
    }

    pub fn upsert_snippet(&mut self, mut snippet: Snippet) -> Result<Snippet> {
        snippet.name = snippet.name.trim().to_string();
        if snippet.name.is_empty() || snippet.command.trim().is_empty() {
            bail!("Donnez un nom et une commande");
        }
        if let Scope::Folder { path } = &snippet.scope {
            let path = normalize_folder(path);
            snippet.scope = if path.is_empty() { Scope::All } else { Scope::Folder { path } };
        }
        if snippet.id.is_empty() {
            snippet.id = uuid::Uuid::new_v4().to_string();
        }
        match self.snippets.iter_mut().find(|s| s.id == snippet.id) {
            Some(existing) => *existing = snippet.clone(),
            None => self.snippets.push(snippet.clone()),
        }
        self.persist()?;
        Ok(snippet)
    }

    pub fn delete_snippet(&mut self, id: &str) -> Result<()> {
        self.snippets.retain(|s| s.id != id);
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
        // Les commandes propres à cette session disparaissent avec elle.
        self.snippets.retain(|s| s.scope != Scope::Session { id: id.to_string() });
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

    fn snippet(store: &mut Store, scope: Scope) -> String {
        store
            .upsert_snippet(Snippet {
                id: String::new(),
                name: "logs".into(),
                command: "tail -f /var/log/syslog".into(),
                scope,
                run: true,
            })
            .unwrap()
            .id
    }

    fn scope_of(store: &Store, id: &str) -> Scope {
        store.snippets().into_iter().find(|s| s.id == id).unwrap().scope
    }

    #[test]
    fn les_commandes_suivent_les_dossiers() {
        let (mut store, _) = store_with(&[], &[("a", "Prod/Web")]);
        let web = snippet(&mut store, Scope::Folder { path: "/Prod/Web/".into() });
        let prod = snippet(&mut store, Scope::Folder { path: "Prod".into() });
        assert_eq!(scope_of(&store, &web), Scope::Folder { path: "Prod/Web".into() });

        store.rename_folder("Prod", "Clients/Prod").unwrap();
        assert_eq!(scope_of(&store, &web), Scope::Folder { path: "Clients/Prod/Web".into() });

        store.delete_folder("Clients").unwrap();
        assert_eq!(scope_of(&store, &web), Scope::Folder { path: "Prod/Web".into() });
        store.delete_folder("Prod").unwrap();
        assert_eq!(scope_of(&store, &prod), Scope::All, "un dossier supprimé à la racine : toutes les sessions");
    }

    #[test]
    fn supprimer_une_session_supprime_ses_commandes() {
        let (mut store, _) = store_with(&[], &[("a", ""), ("b", "")]);
        snippet(&mut store, Scope::Session { id: "a".into() });
        let keep = snippet(&mut store, Scope::Session { id: "b".into() });
        store.remove("a").unwrap();
        assert_eq!(store.snippets().len(), 1);
        assert_eq!(store.snippets()[0].id, keep);
    }

    #[test]
    fn refuse_une_commande_vide() {
        let (mut store, _) = store_with(&[], &[]);
        let empty = Snippet { id: String::new(), name: " ".into(), command: "ls".into(), scope: Scope::All, run: true };
        assert!(store.upsert_snippet(empty).is_err());
    }

    #[test]
    fn les_couleurs_suivent_les_dossiers() {
        let (mut store, _) = store_with(&["Prod/Web"], &[]);
        store.set_folder_color("Prod", Some("red".into())).unwrap();
        store.set_folder_color("Prod/Web", Some("orange".into())).unwrap();
        store.rename_folder("Prod", "Clients/Prod").unwrap();
        assert_eq!(store.folder_colors().get("Clients/Prod").map(String::as_str), Some("red"));
        assert_eq!(store.folder_colors().get("Clients/Prod/Web").map(String::as_str), Some("orange"));
        store.delete_folder("Clients/Prod").unwrap();
        assert!(!store.folder_colors().contains_key("Clients/Prod"));
        assert_eq!(store.folder_colors().get("Clients/Web").map(String::as_str), Some("orange"));
        store.set_folder_color("Clients/Web", None).unwrap();
        assert!(store.folder_colors().is_empty());
    }
}
