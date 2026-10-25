//! Notes Markdown par session, rangées à part des sessions (notes.json).

use std::{collections::HashMap, fs, path::PathBuf};

use anyhow::Result;

pub struct Notes {
    path: PathBuf,
    notes: HashMap<String, String>,
}

impl Notes {
    pub fn load(path: PathBuf) -> Self {
        let notes = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self { path, notes }
    }

    pub fn get(&self, id: &str) -> String {
        self.notes.get(id).cloned().unwrap_or_default()
    }

    /// Sessions qui ont une note (pour l'icône de l'arbre).
    pub fn ids(&self) -> Vec<String> {
        self.notes.keys().cloned().collect()
    }

    pub fn all(&self) -> &HashMap<String, String> {
        &self.notes
    }

    /// Une note vide est supprimée.
    pub fn set(&mut self, id: &str, text: &str) -> Result<()> {
        if text.trim().is_empty() {
            self.notes.remove(id);
        } else {
            self.notes.insert(id.to_string(), text.to_string());
        }
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        if self.notes.remove(id).is_some() {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        // Écriture dans un fichier temporaire puis remplacement : pas de note tronquée.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&self.notes)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enregistre_relit_et_supprime() {
        let path = std::env::temp_dir().join(format!("termoria-notes-{}.json", uuid::Uuid::new_v4()));
        let mut notes = Notes::load(path.clone());
        notes.set("a", "# Prod\n- [ ] sauvegarde").unwrap();
        notes.set("b", "x").unwrap();
        notes.set("b", "   ").unwrap();
        let again = Notes::load(path.clone());
        assert_eq!(again.get("a"), "# Prod\n- [ ] sauvegarde");
        assert_eq!(again.ids(), vec!["a".to_string()]);
        notes.remove("a").unwrap();
        assert!(Notes::load(path.clone()).ids().is_empty());
        fs::remove_file(path).unwrap();
    }
}
