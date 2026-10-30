//! Verrouillage de Portunia : mot de passe maître et, en option, Windows Hello.
//! Verrouillé, l'application refuse d'ouvrir des sessions et de lire les mots
//! de passe enregistrés ; l'interface masque tout derrière l'écran de déverrouillage.

use std::{
    fs,
    num::NonZeroU32,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{pbkdf2, rand::{SecureRandom, SystemRandom}};
use serde::{Deserialize, Serialize};

use crate::vault;

/// PBKDF2-HMAC-SHA256 : 600 000 itérations (recommandation OWASP 2023).
const ITERATIONS: u32 = if cfg!(test) { 1_000 } else { 600_000 };

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LockConfig {
    salt: String,
    hash: String,
    iterations: u32,
    /// Windows Hello accepté pour déverrouiller.
    hello: bool,
    /// Verrouillage automatique après ce nombre de minutes d'inactivité (0 = jamais).
    timeout_minutes: u32,
    /// Sel de la clé qui enveloppe la clé de données (distinct de celui du mot de passe).
    #[serde(default)]
    key_salt: String,
    /// Clé de données (chiffrement des fichiers) enveloppée par le mot de passe maître.
    #[serde(default)]
    data_key: Option<String>,
    /// Même clé protégée par le compte Windows (DPAPI), pour déverrouiller avec Windows Hello.
    #[serde(default)]
    hello_key: Option<String>,
}

/// Fichiers de données à réécrire après un changement du chiffrement.
#[derive(Debug, PartialEq)]
pub enum DataChange {
    None,
    /// Chiffrer les fichiers (mot de passe maître défini, ou ancienne configuration migrée).
    Encrypt,
    /// Les remettre en clair (mot de passe maître retiré).
    Decrypt,
}

/// Donnée associée de l'enveloppe de la clé de données (ancien nom du logiciel, gardé : format).
const WRAP_AAD: &[u8] = b"termoria-cle-de-donnees";

fn wrap(password: &str, salt: &[u8], iterations: u32, key: &[u8; 32]) -> Result<String> {
    let kek: [u8; 32] = derive(password, salt, iterations).try_into().map_err(|_| anyhow!("Dérivation"))?;
    Ok(B64.encode(vault::seal(&kek, key, WRAP_AAD)?))
}

fn unwrap_key(password: &str, salt: &[u8], iterations: u32, wrapped: &str) -> Result<[u8; 32]> {
    let kek: [u8; 32] = derive(password, salt, iterations).try_into().map_err(|_| anyhow!("Dérivation"))?;
    let plain = vault::open(&kek, &B64.decode(wrapped)?, WRAP_AAD)?;
    plain.try_into().map_err(|_| anyhow!(t!("Invalid data key", "Clé de données invalide")))
}

pub struct Lock {
    path: PathBuf,
    config: Option<LockConfig>,
    locked: AtomicBool,
    /// Essais manqués et attente imposée avant le prochain (contre les essais en série).
    throttle: std::sync::Mutex<(u32, Option<std::time::Instant>)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    enabled: bool,
    /// Données chiffrées sur le disque.
    encrypted: bool,
    locked: bool,
    hello: bool,
    hello_available: bool,
    timeout_minutes: u32,
}

fn derive(password: &str, salt: &[u8], iterations: u32) -> Vec<u8> {
    let mut out = vec![0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(iterations).unwrap(),
        salt,
        password.as_bytes(),
        &mut out,
    );
    out
}

impl Lock {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("lock.json");
        let config: Option<LockConfig> = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok());
        // Protégé par mot de passe : verrouillé au démarrage.
        let locked = AtomicBool::new(config.is_some());
        // Fichiers chiffrés : toute écriture devra l'être aussi.
        vault::set_enabled(config.as_ref().is_some_and(|c| c.data_key.is_some()));
        Self { path, config, locked, throttle: Default::default() }
    }

    fn save(&self) -> Result<()> {
        match &self.config {
            Some(config) => fs::write(&self.path, serde_json::to_string_pretty(config)?).context(t!("Cannot write", "Écriture impossible")),
            None => {
                let _ = fs::remove_file(&self.path);
                Ok(())
            }
        }
    }

    pub fn is_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }

    /// Erreur si l'application est verrouillée (point de contrôle des actions sensibles).
    pub fn ensure_unlocked(&self) -> Result<()> {
        if self.is_locked() {
            bail!(t!("Portunia is locked", "Portunia est verrouillé"));
        }
        Ok(())
    }

    fn check(&self, password: &str) -> bool {
        let Some(c) = &self.config else { return true };
        let (Ok(salt), Ok(hash)) = (B64.decode(&c.salt), B64.decode(&c.hash)) else { return false };
        pbkdf2::verify(
            pbkdf2::PBKDF2_HMAC_SHA256,
            NonZeroU32::new(c.iterations.max(1)).unwrap(),
            &salt,
            password.as_bytes(),
            &hash,
        )
        .is_ok()
    }

    /// Définit ou change le mot de passe maître (l'ancien est demandé s'il existe).
    pub fn set_password(&mut self, current: &str, new: &str) -> Result<DataChange> {
        if self.config.is_some() {
            self.check_throttled(current).map_err(|e| anyhow!("{}", t!(format!("Wrong current password: {e}"), format!("Mot de passe actuel incorrect : {e}"))))?;
        }
        if new.chars().count() < 8 {
            bail!(t!("The master password must have at least 8 characters", "Le mot de passe maître doit contenir au moins 8 caractères"));
        }
        let mut salt = [0u8; 16];
        SystemRandom::new().fill(&mut salt).map_err(|_| anyhow!(t!("Random generator unavailable", "Générateur aléatoire indisponible")))?;
        let previous = self.config.clone();
        // Clé de données : celle en mémoire (déverrouillé), sinon une nouvelle (premier mot de passe).
        let (key, change) = match (vault::key(), previous.as_ref().and_then(|c| c.data_key.as_ref())) {
            (Some(key), Some(_)) => (key, DataChange::None),
            _ => (vault::random_bytes::<32>()?, DataChange::Encrypt),
        };
        let key_salt = vault::random_bytes::<16>()?;
        let hello = previous.as_ref().map(|c| c.hello).unwrap_or(false);
        self.config = Some(LockConfig {
            salt: B64.encode(salt),
            hash: B64.encode(derive(new, &salt, ITERATIONS)),
            iterations: ITERATIONS,
            hello,
            timeout_minutes: previous.as_ref().map(|c| c.timeout_minutes).unwrap_or(15),
            key_salt: B64.encode(key_salt),
            data_key: Some(wrap(new, &key_salt, ITERATIONS, &key)?),
            hello_key: if hello { vault::dpapi::protect(&key).ok().map(|b| B64.encode(b)) } else { None },
        });
        self.save()?;
        vault::set_key(Some(key));
        vault::set_enabled(true);
        Ok(change)
    }

    /// Retire le mot de passe maître : les fichiers seront remis en clair (DataChange::Decrypt) ;
    /// la clé reste en mémoire le temps de cette réécriture.
    pub fn disable(&mut self, password: &str) -> Result<DataChange> {
        self.check_throttled(password)?;
        let encrypted = self.config.as_ref().is_some_and(|c| c.data_key.is_some());
        self.config = None;
        self.locked.store(false, Ordering::SeqCst);
        self.save()?;
        vault::set_enabled(false);
        Ok(if encrypted { DataChange::Decrypt } else { DataChange::None })
    }

    pub fn set_options(&mut self, hello: bool, timeout_minutes: u32) -> Result<()> {
        let config = self.config.as_mut().ok_or_else(|| anyhow!(t!("First set a master password", "Définissez d'abord un mot de passe maître")))?;
        config.hello = hello;
        config.timeout_minutes = timeout_minutes.min(24 * 60);
        // Windows Hello doit pouvoir rendre la clé de données : copie protégée par le compte Windows.
        config.hello_key = match (hello, vault::key()) {
            (true, Some(key)) if config.data_key.is_some() => Some(B64.encode(vault::dpapi::protect(&key)?)),
            (true, _) => config.hello_key.clone(),
            (false, _) => None,
        };
        self.save()
    }

    pub fn lock(&self) -> Result<()> {
        if self.config.is_none() {
            bail!(t!("First set a master password (Settings › Security)", "Définissez d'abord un mot de passe maître (Paramètres › Sécurité)"));
        }
        self.locked.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Vérifie le mot de passe ; après 5 échecs, attente croissante (5 s, 10 s, 20 s… jusqu'à 5 min).
    fn check_throttled(&self, password: &str) -> Result<()> {
        self.throttled(|| self.check(password))
    }

    /// Applique la limite d'essais à une vérification quelconque du mot de passe.
    fn throttled(&self, verify: impl FnOnce() -> bool) -> Result<()> {
        let mut t = self.throttle.lock().unwrap();
        if let Some(until) = t.1 {
            let now = std::time::Instant::now();
            if until > now {
                bail!("{}", t!(format!("Too many attempts: try again in {} s", (until - now).as_secs() + 1), format!("Trop d'essais : réessayez dans {} s", (until - now).as_secs() + 1)));
            }
        }
        if verify() {
            *t = (0, None);
            return Ok(());
        }
        t.0 += 1;
        if t.0 >= 5 {
            let wait = (5u64 << (t.0 - 5).min(6)).min(300);
            t.1 = Some(std::time::Instant::now() + std::time::Duration::from_secs(wait));
            bail!("{}", t!(format!("Wrong password. Too many attempts: wait {wait} s"), format!("Mot de passe incorrect. Trop d'essais : attendez {wait} s")));
        }
        bail!(t!("Wrong password", "Mot de passe incorrect"))
    }

    /// Déverrouille et rend la clé de données. Une configuration d'avant le chiffrement
    /// est migrée : clé créée, fichiers à chiffrer (DataChange::Encrypt).
    pub fn unlock_with_password(&mut self, password: &str) -> Result<DataChange> {
        let config = self.config.clone().ok_or_else(|| anyhow!(t!("No master password", "Aucun mot de passe maître")))?;
        let change = match &config.data_key {
            Some(wrapped) => {
                // Ouvrir la clé de données vérifie le mot de passe (AES-GCM) : un seul calcul
                // PBKDF2 au lieu de deux, le déverrouillage est deux fois plus rapide.
                let salt = B64.decode(&config.key_salt)?;
                let mut key = None;
                self.throttled(|| {
                    key = unwrap_key(password, &salt, config.iterations, wrapped).ok();
                    key.is_some()
                })?;
                vault::set_key(key);
                DataChange::None
            }
            None => {
                self.check_throttled(password)?;
                let key = vault::random_bytes::<32>()?;
                let key_salt = vault::random_bytes::<16>()?;
                let c = self.config.as_mut().unwrap();
                c.key_salt = B64.encode(key_salt);
                c.data_key = Some(wrap(password, &key_salt, c.iterations, &key)?);
                vault::set_key(Some(key));
                vault::set_enabled(true);
                DataChange::Encrypt
            }
        };
        // Windows Hello activé avant le chiffrement : sa copie de la clé est créée maintenant.
        let c = self.config.as_mut().unwrap();
        if c.hello && c.hello_key.is_none() {
            if let Some(key) = vault::key() {
                c.hello_key = vault::dpapi::protect(&key).ok().map(|b| B64.encode(b));
            }
        }
        self.save()?;
        self.locked.store(false, Ordering::SeqCst);
        Ok(change)
    }

    pub fn hello_enabled(&self) -> bool {
        self.config.as_ref().is_some_and(|c| c.hello)
    }

    /// Appelé après une vérification Windows Hello réussie.
    pub fn unlock_with_hello(&self) -> Result<()> {
        if !self.hello_enabled() {
            bail!(t!("Windows Hello is not enabled for Portunia", "Windows Hello n'est pas activé pour Portunia"));
        }
        let config = self.config.as_ref().unwrap();
        match (&config.hello_key, &config.data_key) {
            (Some(protected), _) => {
                let key = vault::dpapi::unprotect(&B64.decode(protected)?)?;
                vault::set_key(Some(key.try_into().map_err(|_| anyhow!(t!("Invalid Windows Hello key", "Clé Windows Hello invalide")))?));
            }
            (None, Some(_)) => bail!(t!("Unlock once with the master password: Windows Hello will then be ready for encrypted data.", "Déverrouillez une fois avec le mot de passe maître : Windows Hello sera ensuite prêt pour les données chiffrées.")),
            (None, None) => {}
        }
        self.locked.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn status(&self) -> LockStatus {
        LockStatus {
            enabled: self.config.is_some(),
            encrypted: self.config.as_ref().is_some_and(|c| c.data_key.is_some()),
            locked: self.is_locked(),
            hello: self.hello_enabled(),
            hello_available: hello::available(),
            timeout_minutes: self.config.as_ref().map(|c| c.timeout_minutes).unwrap_or(15),
        }
    }
}

/// Windows Hello (visage, empreinte, code PIN).
pub mod hello {
    #[cfg(windows)]
    pub fn available() -> bool {
        use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.join())
            .map(|a| a == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    /// Demande la vérification, rattachée à la fenêtre de Portunia. Bloquant.
    #[cfg(windows)]
    pub fn verify(hwnd: *mut core::ffi::c_void, message: &str) -> anyhow::Result<bool> {
        use windows::{
            core::{factory, HSTRING},
            Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier},
            Win32::{Foundation::HWND, System::WinRT::IUserConsentVerifierInterop},
        };
        use windows_future::IAsyncOperation;
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        let operation: IAsyncOperation<UserConsentVerificationResult> =
            unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd), &HSTRING::from(message))? };
        Ok(operation.join()? == UserConsentVerificationResult::Verified)
    }

    #[cfg(not(windows))]
    pub fn available() -> bool {
        false
    }

    #[cfg(not(windows))]
    pub fn verify(_hwnd: *mut core::ffi::c_void, _message: &str) -> anyhow::Result<bool> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Remet l'état global du chiffrement à zéro (comme un redémarrage de Portunia).
    fn restart(dir: &std::path::Path) -> Lock {
        vault::set_key(None);
        vault::set_enabled(false);
        Lock::load(dir)
    }

    #[test]
    fn chiffrement_des_donnees() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        vault::set_key(None);
        vault::set_enabled(false);
        let dir = std::env::temp_dir().join(format!("portunia-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let data = dir.join("sessions.json");
        let mut lock = Lock::load(&dir);
        // Premier mot de passe : clé créée, fichiers à chiffrer.
        assert_eq!(lock.set_password("", "un bon mot de passe").unwrap(), DataChange::Encrypt);
        vault::write(&data, "srv-prod-01").unwrap();
        assert!(!fs::read_to_string(&data).unwrap().contains("srv-prod"), "rien en clair");
        assert!(!fs::read_to_string(dir.join("lock.json")).unwrap().contains("srv-prod"));

        // Redémarrage : verrouillé, fichier illisible, écriture refusée.
        let mut lock = restart(&dir);
        assert!(lock.is_locked() && vault::enabled());
        assert_eq!(vault::read(&data).unwrap(), vault::Content::Locked);
        assert!(vault::write(&data, "écrasé").is_err());
        assert!(lock.unlock_with_password("faux mot de passe").is_err());
        assert_eq!(lock.unlock_with_password("un bon mot de passe").unwrap(), DataChange::None);
        assert_eq!(vault::read(&data).unwrap(), vault::Content::Text("srv-prod-01".into()));

        // Changement de mot de passe : même clé, ré-enveloppée.
        assert_eq!(lock.set_password("un bon mot de passe", "nouveau mot de passe").unwrap(), DataChange::None);
        let mut lock = restart(&dir);
        assert!(lock.unlock_with_password("un bon mot de passe").is_err(), "l'ancien ne marche plus");
        lock.unlock_with_password("nouveau mot de passe").unwrap();
        assert_eq!(vault::read(&data).unwrap(), vault::Content::Text("srv-prod-01".into()));

        // Retrait : fichiers à remettre en clair, écritures en clair ensuite.
        assert_eq!(lock.disable("nouveau mot de passe").unwrap(), DataChange::Decrypt);
        assert!(!vault::enabled());
        vault::write(&data, "srv-prod-01").unwrap();
        assert_eq!(fs::read_to_string(&data).unwrap(), "srv-prod-01");
        let lock = restart(&dir);
        assert!(!lock.is_locked() && !vault::enabled());
    }

    #[test]
    fn ancienne_configuration_migree() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        vault::set_key(None);
        vault::set_enabled(false);
        let dir = std::env::temp_dir().join(format!("portunia-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut lock = Lock::load(&dir);
        lock.set_password("", "un bon mot de passe").unwrap();
        // lock.json d'une version d'avant le chiffrement : pas de clé de données.
        let path = dir.join("lock.json");
        let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.remove("keySalt");
        obj.remove("dataKey");
        obj.remove("helloKey");
        fs::write(&path, json.to_string()).unwrap();
        fs::write(dir.join("notes.json"), "{\"a\": \"en clair\"}").unwrap();

        let mut lock = restart(&dir);
        assert!(!vault::enabled(), "rien n'est chiffré avant la migration");
        assert_eq!(vault::read(&dir.join("notes.json")).unwrap(), vault::Content::Text("{\"a\": \"en clair\"}".into()));
        assert_eq!(lock.unlock_with_password("un bon mot de passe").unwrap(), DataChange::Encrypt);
        assert!(vault::enabled() && vault::key().is_some());
        let mut lock = restart(&dir);
        assert_eq!(lock.unlock_with_password("un bon mot de passe").unwrap(), DataChange::None, "migré une seule fois");
    }

    #[cfg(windows)]
    #[test]
    fn windows_hello_rend_la_cle() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        vault::set_key(None);
        vault::set_enabled(false);
        let dir = std::env::temp_dir().join(format!("portunia-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut lock = Lock::load(&dir);
        lock.set_password("", "un bon mot de passe").unwrap();
        let key = vault::key().unwrap();
        lock.set_options(true, 15).unwrap();
        let lock = restart(&dir);
        assert!(vault::key().is_none());
        // (La vérification du visage / de l'empreinte a lieu avant, dans la commande.)
        lock.unlock_with_hello().unwrap();
        assert_eq!(vault::key(), Some(key));
        vault::set_key(None);
        vault::set_enabled(false);
    }

    fn temp_lock() -> Lock {
        let dir = std::env::temp_dir().join(format!("portunia-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Lock::load(&dir)
    }

    #[test]
    fn essais_limites() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        lock.lock().unwrap();
        for _ in 0..4 {
            assert_eq!(lock.unlock_with_password("faux").unwrap_err().to_string(), t!("Wrong password", "Mot de passe incorrect"));
        }
        assert!(lock.unlock_with_password("faux").unwrap_err().to_string().contains(t!("wait 5 s", "attendez 5 s")));
        // Même le bon mot de passe est refusé pendant l'attente.
        assert!(lock.unlock_with_password("un bon mot de passe").unwrap_err().to_string().contains(t!("try again", "réessayez")));
        assert!(lock.is_locked());
        // Attente écoulée : le bon mot de passe passe et remet le compteur à zéro.
        lock.throttle.lock().unwrap().1 = None;
        lock.unlock_with_password("un bon mot de passe").unwrap();
        assert_eq!(lock.throttle.lock().unwrap().0, 0);
    }

    #[test]
    fn cycle_complet() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        assert!(!lock.is_locked());
        assert!(lock.lock().is_err(), "sans mot de passe, pas de verrouillage");
        assert!(lock.set_password("", "court").is_err());
        lock.set_password("", "un bon mot de passe").unwrap();
        lock.lock().unwrap();
        assert!(lock.ensure_unlocked().is_err());
        assert!(lock.unlock_with_password("faux").is_err());
        lock.unlock_with_password("un bon mot de passe").unwrap();
        assert!(lock.ensure_unlocked().is_ok());
        assert!(lock.set_password("faux", "nouveau mot de passe").is_err());
        lock.set_password("un bon mot de passe", "nouveau mot de passe").unwrap();
        assert!(lock.disable("un bon mot de passe").is_err());
        lock.disable("nouveau mot de passe").unwrap();
        assert!(!lock.status().enabled);
    }

    #[test]
    fn verrouille_au_redemarrage() {
        let _g = crate::vault::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        let reloaded = Lock::load(lock.path.parent().unwrap());
        assert!(reloaded.is_locked());
        lock.disable("un bon mot de passe").unwrap();
    }
}
