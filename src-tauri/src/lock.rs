//! Verrouillage de Termoria : mot de passe maître et, en option, Windows Hello.
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
        Self { path, config, locked, throttle: Default::default() }
    }

    fn save(&self) -> Result<()> {
        match &self.config {
            Some(config) => fs::write(&self.path, serde_json::to_string_pretty(config)?).context("Écriture impossible"),
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
            bail!("Termoria est verrouillé");
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
    pub fn set_password(&mut self, current: &str, new: &str) -> Result<()> {
        if self.config.is_some() {
            self.check_throttled(current).map_err(|e| anyhow!("Mot de passe actuel incorrect : {e}"))?;
        }
        if new.chars().count() < 8 {
            bail!("Le mot de passe maître doit contenir au moins 8 caractères");
        }
        let mut salt = [0u8; 16];
        SystemRandom::new().fill(&mut salt).map_err(|_| anyhow!("Générateur aléatoire indisponible"))?;
        let previous = self.config.clone();
        self.config = Some(LockConfig {
            salt: B64.encode(salt),
            hash: B64.encode(derive(new, &salt, ITERATIONS)),
            iterations: ITERATIONS,
            hello: previous.as_ref().map(|c| c.hello).unwrap_or(false),
            timeout_minutes: previous.as_ref().map(|c| c.timeout_minutes).unwrap_or(15),
        });
        self.save()
    }

    pub fn disable(&mut self, password: &str) -> Result<()> {
        self.check_throttled(password)?;
        self.config = None;
        self.locked.store(false, Ordering::SeqCst);
        self.save()
    }

    pub fn set_options(&mut self, hello: bool, timeout_minutes: u32) -> Result<()> {
        let config = self.config.as_mut().ok_or_else(|| anyhow!("Définissez d'abord un mot de passe maître"))?;
        config.hello = hello;
        config.timeout_minutes = timeout_minutes.min(24 * 60);
        self.save()
    }

    pub fn lock(&self) -> Result<()> {
        if self.config.is_none() {
            bail!("Définissez d'abord un mot de passe maître (Paramètres › Sécurité)");
        }
        self.locked.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Vérifie le mot de passe ; après 5 échecs, attente croissante (5 s, 10 s, 20 s… jusqu'à 5 min).
    fn check_throttled(&self, password: &str) -> Result<()> {
        let mut t = self.throttle.lock().unwrap();
        if let Some(until) = t.1 {
            let now = std::time::Instant::now();
            if until > now {
                bail!("Trop d'essais : réessayez dans {} s", (until - now).as_secs() + 1);
            }
        }
        if self.check(password) {
            *t = (0, None);
            return Ok(());
        }
        t.0 += 1;
        if t.0 >= 5 {
            let wait = (5u64 << (t.0 - 5).min(6)).min(300);
            t.1 = Some(std::time::Instant::now() + std::time::Duration::from_secs(wait));
            bail!("Mot de passe incorrect. Trop d'essais : attendez {wait} s");
        }
        bail!("Mot de passe incorrect")
    }

    pub fn unlock_with_password(&self, password: &str) -> Result<()> {
        self.check_throttled(password)?;
        self.locked.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn hello_enabled(&self) -> bool {
        self.config.as_ref().is_some_and(|c| c.hello)
    }

    /// Appelé après une vérification Windows Hello réussie.
    pub fn unlock_with_hello(&self) -> Result<()> {
        if !self.hello_enabled() {
            bail!("Windows Hello n'est pas activé pour Termoria");
        }
        self.locked.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn status(&self) -> LockStatus {
        LockStatus {
            enabled: self.config.is_some(),
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

    /// Demande la vérification, rattachée à la fenêtre de Termoria. Bloquant.
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

    fn temp_lock() -> Lock {
        let dir = std::env::temp_dir().join(format!("termoria-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Lock::load(&dir)
    }

    #[test]
    fn essais_limites() {
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        lock.lock().unwrap();
        for _ in 0..4 {
            assert_eq!(lock.unlock_with_password("faux").unwrap_err().to_string(), "Mot de passe incorrect");
        }
        assert!(lock.unlock_with_password("faux").unwrap_err().to_string().contains("attendez 5 s"));
        // Même le bon mot de passe est refusé pendant l'attente.
        assert!(lock.unlock_with_password("un bon mot de passe").unwrap_err().to_string().contains("réessayez"));
        assert!(lock.is_locked());
        // Attente écoulée : le bon mot de passe passe et remet le compteur à zéro.
        lock.throttle.lock().unwrap().1 = None;
        lock.unlock_with_password("un bon mot de passe").unwrap();
        assert_eq!(lock.throttle.lock().unwrap().0, 0);
    }

    #[test]
    fn cycle_complet() {
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
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        let reloaded = Lock::load(lock.path.parent().unwrap());
        assert!(reloaded.is_locked());
        lock.disable("un bon mot de passe").unwrap();
    }
}
