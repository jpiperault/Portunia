//! Mots de passe et phrases de passe, rangés dans le Gestionnaire
//! d'identifiants Windows (chiffré par le compte utilisateur).

use anyhow::Result;
use keyring::Entry;

// Ancien nom du logiciel, gardé : les mots de passe déjà rangés sont sous ce nom.
const SERVICE: &str = "Termoria";

/// Compte du Trousseau / du Gestionnaire d'identifiants : `{session_id}/{key}`.
fn account(session_id: &str, key: &str) -> String {
    format!("{session_id}/{key}")
}

fn entry(session_id: &str, key: &str) -> Result<Entry> {
    Ok(Entry::new(SERVICE, &account(session_id, key))?)
}

pub fn set(session_id: &str, key: &str, value: &str) -> Result<()> {
    entry(session_id, key)?.set_password(value)?;
    Ok(())
}

pub fn get(session_id: &str, key: &str) -> Result<Option<String>> {
    match entry(session_id, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(session_id: &str, key: &str) -> Result<()> {
    match entry(session_id, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_et_compte_inchanges() {
        assert_eq!(SERVICE, "Termoria");
        assert_eq!(account("abc-123", "password"), "abc-123/password");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn distinct_du_service_de_la_cle_du_coffre() {
        assert_ne!(SERVICE, crate::biometric_mac::KEYCHAIN_SERVICE);
    }
}
