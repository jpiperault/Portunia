//! Identifiants partagés : un compte (utilisateur + mot de passe, clé ou agent)
//! utilisé par plusieurs sessions. Les secrets vont dans le Gestionnaire
//! d'identifiants Windows, comme ceux des sessions ; credentials.json ne
//! contient que le reste.

use std::{collections::HashMap, path::PathBuf};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::secrets;

/// Secrets possibles d'un identifiant.
pub const SECRET_KEYS: [&str; 2] = ["password", "passphrase"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub username: String,
    /// password, key ou agent
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub key_path: String,
    /// Domaine Windows (RDP), facultatif.
    #[serde(default)]
    pub domain: String,
    /// Secrets enregistrés (noms seulement).
    #[serde(default)]
    pub secret_keys: Vec<String>,
}

fn default_auth() -> String {
    "password".into()
}

/// Identifiant d'une entrée du Gestionnaire d'identifiants Windows.
fn vault_id(id: &str) -> String {
    format!("credential:{id}")
}

pub struct Credentials {
    path: PathBuf,
    list: Vec<Credential>,
    /// Fichier chiffré non lu (verrouillé) : aucune écriture avant de l'avoir relu.
    locked: bool,
}

impl Credentials {
    pub fn load(path: PathBuf) -> Self {
        let (list, locked) = crate::vault::load_json(&path);
        Self { path, list, locked }
    }

    /// Relit le fichier (après déverrouillage).
    pub fn reload(&mut self) {
        (self.list, self.locked) = crate::vault::load_json(&self.path);
    }

    /// Réécrit le fichier dans le mode courant (chiffré ou non).
    pub fn rewrite(&self) -> Result<()> {
        self.persist()
    }

    pub fn list(&self) -> Vec<Credential> {
        let mut list = self.list.clone();
        list.sort_by_key(|c| c.name.to_lowercase());
        list
    }

    /// Par identifiant ou par nom (sans tenir compte des majuscules).
    pub fn find(&self, key: &str) -> Option<&Credential> {
        let key = key.trim();
        self.list.iter().find(|c| c.id == key).or_else(|| self.list.iter().find(|c| c.name.eq_ignore_ascii_case(key)))
    }

    /// Crée ou met à jour. Un secret vide garde la valeur enregistrée.
    pub fn save(&mut self, mut credential: Credential, secrets_in: &HashMap<String, String>) -> Result<Credential> {
        credential.name = credential.name.trim().to_string();
        if credential.name.is_empty() {
            bail!("Donnez un nom à l'identifiant");
        }
        if self.list.iter().any(|c| c.id != credential.id && c.name.eq_ignore_ascii_case(&credential.name)) {
            bail!("Un identifiant « {} » existe déjà", credential.name);
        }
        if !["password", "key", "agent"].contains(&credential.auth.as_str()) {
            bail!("Type d'authentification inconnu : {}", credential.auth);
        }
        if credential.id.is_empty() {
            credential.id = uuid::Uuid::new_v4().to_string();
        }
        let previous = self.list.iter().find(|c| c.id == credential.id).map(|c| c.secret_keys.clone()).unwrap_or_default();
        credential.secret_keys = previous;
        for key in SECRET_KEYS {
            if let Some(value) = secrets_in.get(key).filter(|v| !v.is_empty()) {
                secrets::set(&vault_id(&credential.id), key, value)?;
                if !credential.secret_keys.iter().any(|k| k == key) {
                    credential.secret_keys.push(key.into());
                }
            }
        }
        match self.list.iter_mut().find(|c| c.id == credential.id) {
            Some(existing) => *existing = credential.clone(),
            None => self.list.push(credential.clone()),
        }
        self.persist()?;
        Ok(credential)
    }

    /// Ajout tel quel (restauration d'une sauvegarde), sans secret.
    pub fn restore(&mut self, mut credential: Credential) -> Result<()> {
        credential.secret_keys.clear();
        self.list.push(credential);
        self.persist()
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        if let Some(pos) = self.list.iter().position(|c| c.id == id) {
            let removed = self.list.remove(pos);
            for key in &removed.secret_keys {
                secrets::delete(&vault_id(&removed.id), key)?;
            }
            self.persist()?;
        }
        Ok(())
    }

    /// Remplace dans `values` ce que fournit l'identifiant nommé par le champ « credential ».
    pub fn apply(&self, values: &mut HashMap<String, Value>) -> Result<()> {
        let Some(key) = values.get("credential").and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty()) else {
            return Ok(());
        };
        let Some(c) = self.find(key) else {
            bail!("Identifiant « {key} » introuvable (supprimé ?)");
        };
        let user = if c.domain.trim().is_empty() || c.username.contains('\\') {
            c.username.clone()
        } else {
            format!("{}\\{}", c.domain.trim(), c.username)
        };
        if !user.is_empty() {
            values.insert("username".into(), Value::String(user));
        }
        values.insert("auth".into(), Value::String(c.auth.clone()));
        if c.auth == "key" {
            if c.key_path.trim().is_empty() {
                values.remove("keyPath");
            } else {
                values.insert("keyPath".into(), Value::String(c.key_path.clone()));
            }
        }
        for key in SECRET_KEYS {
            values.remove(key);
            if c.secret_keys.iter().any(|k| k == key) {
                if let Some(secret) = secrets::get(&vault_id(&c.id), key)? {
                    values.insert(key.into(), Value::String(secret));
                }
            }
        }
        Ok(())
    }

    fn persist(&self) -> Result<()> {
        if self.locked {
            bail!("Termoria est verrouillé : les identifiants ne sont pas chargés");
        }
        crate::vault::write(&self.path, &serde_json::to_string_pretty(&self.list)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store() -> (Credentials, PathBuf) {
        let path = std::env::temp_dir().join(format!("termoria-cred-{}.json", uuid::Uuid::new_v4()));
        (Credentials::load(path.clone()), path)
    }

    fn cred(name: &str, auth: &str) -> Credential {
        Credential { id: String::new(), name: name.into(), username: "admin".into(), auth: auth.into(), key_path: "C:\\k\\id".into(), domain: String::new(), secret_keys: vec![] }
    }

    #[test]
    fn noms_uniques_et_relecture() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (mut store, path) = store();
        let saved = store.save(cred("Admin prod", "key"), &HashMap::new()).unwrap();
        assert!(!saved.id.is_empty());
        assert!(store.save(cred("admin PROD", "key"), &HashMap::new()).is_err());
        assert!(store.save(cred("x", "kerberos"), &HashMap::new()).is_err());
        let again = Credentials::load(path.clone());
        assert_eq!(again.find("admin prod").unwrap().id, saved.id);
        assert_eq!(again.find(&saved.id).unwrap().name, "Admin prod");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn remplace_les_valeurs_de_la_session() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (mut store, path) = store();
        let mut c = cred("Domaine", "key");
        c.domain = "CORP".into();
        store.save(c, &HashMap::new()).unwrap();
        let mut values: HashMap<String, Value> = HashMap::from([
            ("credential".into(), Value::String("domaine".into())),
            ("username".into(), Value::String("ancien".into())),
            ("auth".into(), Value::String("password".into())),
            ("password".into(), Value::String("ancien".into())),
        ]);
        store.apply(&mut values).unwrap();
        assert_eq!(values["username"], "CORP\\admin");
        assert_eq!(values["auth"], "key");
        assert_eq!(values["keyPath"], "C:\\k\\id");
        assert!(!values.contains_key("password"), "le mot de passe de la session ne doit pas rester");
        // Sans identifiant : rien ne change ; identifiant inconnu : erreur claire.
        let mut plain = HashMap::from([("username".into(), Value::String("u".into()))]);
        store.apply(&mut plain).unwrap();
        assert_eq!(plain["username"], "u");
        let mut unknown = HashMap::from([("credential".into(), Value::String("inexistant".into()))]);
        assert!(store.apply(&mut unknown).is_err());
        fs::remove_file(path).unwrap();
    }
}
