//! Notes Markdown par session, rangées à part des sessions (notes.json).

use std::{collections::HashMap, path::PathBuf};

use anyhow::Result;

pub struct Notes {
    path: PathBuf,
    notes: HashMap<String, String>,
    /// Fichier chiffré non lu (verrouillé) : aucune écriture avant de l'avoir relu.
    locked: bool,
}

impl Notes {
    pub fn load(path: PathBuf) -> Self {
        let (notes, locked) = crate::vault::load_json(&path);
        Self { path, notes, locked }
    }

    /// Relit le fichier (après déverrouillage).
    pub fn reload(&mut self) {
        (self.notes, self.locked) = crate::vault::load_json(&self.path);
    }

    /// Réécrit le fichier dans le mode courant (chiffré ou non).
    pub fn rewrite(&self) -> Result<()> {
        self.save()
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
        if self.locked {
            anyhow::bail!("Portunia est verrouillé : les notes ne sont pas chargées");
        }
        // Écriture atomique (fichier temporaire puis remplacement), chiffrée si besoin.
        crate::vault::write(&self.path, &serde_json::to_string_pretty(&self.notes)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn enregistre_relit_et_supprime() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = std::env::temp_dir().join(format!("portunia-notes-{}.json", uuid::Uuid::new_v4()));
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
