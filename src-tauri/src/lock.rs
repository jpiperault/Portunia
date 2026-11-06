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
use ring::{
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use crate::biometric_mac::{self, KeyStore, KeychainStore};
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
    /// Capteur biométrique actif : « touchid » (macOS). Absent = comportement d'origine
    /// (Windows Hello si `hello`). Jamais écrit sous Windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    biometric: Option<String>,
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
    let kek: [u8; 32] = derive(password, salt, iterations)
        .try_into()
        .map_err(|_| anyhow!("Dérivation"))?;
    Ok(B64.encode(vault::seal(&kek, key, WRAP_AAD)?))
}

fn unwrap_key(password: &str, salt: &[u8], iterations: u32, wrapped: &str) -> Result<[u8; 32]> {
    let kek: [u8; 32] = derive(password, salt, iterations)
        .try_into()
        .map_err(|_| anyhow!("Dérivation"))?;
    let plain = vault::open(&kek, &B64.decode(wrapped)?, WRAP_AAD)?;
    plain
        .try_into()
        .map_err(|_| anyhow!(t!("Invalid data key", "Clé de données invalide")))
}

pub struct Lock {
    path: PathBuf,
    config: Option<LockConfig>,
    locked: AtomicBool,
    /// Essais manqués et attente imposée avant le prochain (contre les essais en série).
    throttle: std::sync::Mutex<(u32, Option<std::time::Instant>)>,
    /// Trousseau qui range la clé du coffre pour Touch ID (remplaçable par un faux dans les tests).
    #[cfg(target_os = "macos")]
    store: Box<dyn KeyStore + Send>,
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
        let config: Option<LockConfig> = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
        // Protégé par mot de passe : verrouillé au démarrage.
        let locked = AtomicBool::new(config.is_some());
        // Fichiers chiffrés : toute écriture devra l'être aussi.
        vault::set_enabled(config.as_ref().is_some_and(|c| c.data_key.is_some()));
        Self {
            path,
            config,
            locked,
            throttle: Default::default(),
            #[cfg(target_os = "macos")]
            store: Box::new(KeychainStore::vault()),
        }
    }

    fn save(&self) -> Result<()> {
        match &self.config {
            Some(config) => fs::write(&self.path, serde_json::to_string_pretty(config)?)
                .context(t!("Cannot write", "Écriture impossible")),
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
        let (Ok(salt), Ok(hash)) = (B64.decode(&c.salt), B64.decode(&c.hash)) else {
            return false;
        };
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
            self.check_throttled(current).map_err(|e| {
                anyhow!(
                    "{}",
                    t!(
                        format!("Wrong current password: {e}"),
                        format!("Mot de passe actuel incorrect : {e}")
                    )
                )
            })?;
        }
        if new.chars().count() < 8 {
            bail!(t!(
                "The master password must have at least 8 characters",
                "Le mot de passe maître doit contenir au moins 8 caractères"
            ));
        }
        let mut salt = [0u8; 16];
        SystemRandom::new().fill(&mut salt).map_err(|_| {
            anyhow!(t!(
                "Random generator unavailable",
                "Générateur aléatoire indisponible"
            ))
        })?;
        let previous = self.config.clone();
        // Clé de données : celle en mémoire (déverrouillé), sinon une nouvelle (premier mot de passe).
        let (key, change) = match (
            vault::key(),
            previous.as_ref().and_then(|c| c.data_key.as_ref()),
        ) {
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
            hello_key: if hello {
                vault::dpapi::protect(&key).ok().map(|b| B64.encode(b))
            } else {
                None
            },
            biometric: previous.as_ref().and_then(|c| c.biometric.clone()),
        });
        self.save()?;
        vault::set_key(Some(key));
        vault::set_enabled(true);
        #[cfg(target_os = "macos")]
        self.refresh_touch_id(&key)?;
        Ok(change)
    }

    /// Retire le mot de passe maître : les fichiers seront remis en clair (DataChange::Decrypt) ;
    /// la clé reste en mémoire le temps de cette réécriture.
    pub fn disable(&mut self, password: &str) -> Result<DataChange> {
        self.check_throttled(password)?;
        // Touch ID : la clé ne doit pas survivre dans le Trousseau. Suppression toujours tentée
        // (élément absent = succès), même si lock.json ne déclare pas Touch ID ; échec = on
        // s'arrête, rien n'est retiré.
        #[cfg(target_os = "macos")]
        self.store.delete().map_err(|e| {
            keychain_error(
                t!(
                    "Cannot remove the key from the Keychain",
                    "Impossible de retirer la clé du Trousseau"
                ),
                &e,
            )
        })?;
        let encrypted = self.config.as_ref().is_some_and(|c| c.data_key.is_some());
        self.config = None;
        self.locked.store(false, Ordering::SeqCst);
        self.save()?;
        vault::set_enabled(false);
        Ok(if encrypted {
            DataChange::Decrypt
        } else {
            DataChange::None
        })
    }

    /// macOS : `hello` active ou retire Touch ID. Activation = la clé du coffre (en mémoire, donc
    /// déverrouillé par mot de passe) est rangée dans le Trousseau avant que lock.json ne bascule.
    /// Tout échec laisse la configuration et le Trousseau cohérents, sans repli.
    #[cfg(target_os = "macos")]
    pub fn set_options(&mut self, hello: bool, timeout_minutes: u32) -> Result<()> {
        let backup = self.config.clone();
        let active = self.touch_id_enabled();
        let config = self.config.as_mut().ok_or_else(|| {
            anyhow!(t!(
                "First set a master password",
                "Définissez d'abord un mot de passe maître"
            ))
        })?;
        let enabling = hello && !active;
        if enabling {
            let key = match (config.data_key.is_some(), vault::key()) {
                // Copie issue de `vault::key()` (`[u8; 32]`), aussitôt placée sous Zeroizing.
                (true, Some(key)) => biometric_mac::VaultKey::new(key),
                _ => bail!(t!(
                    "Unlock Portunia with the master password before enabling Touch ID",
                    "Déverrouillez Portunia avec le mot de passe maître avant d'activer Touch ID"
                )),
            };
            self.store.save(&key).map_err(|e| {
                keychain_error(
                    t!(
                        "Cannot store the key in the Keychain",
                        "Impossible de ranger la clé dans le Trousseau"
                    ),
                    &e,
                )
            })?;
            config.biometric = Some(biometric_mac::KIND.to_string());
            config.hello = true;
        } else if !hello {
            // Toujours tenter la suppression (élément absent = succès), même si lock.json ne
            // déclare pas Touch ID : un élément résiduel ne doit pas survivre à la désactivation.
            self.store.delete().map_err(|e| {
                keychain_error(
                    t!(
                        "Cannot remove the key from the Keychain",
                        "Impossible de retirer la clé du Trousseau"
                    ),
                    &e,
                )
            })?;
            config.biometric = None;
            config.hello = false;
        }
        config.timeout_minutes = timeout_minutes.min(24 * 60);
        if let Err(e) = self.save() {
            // Enregistrement impossible : on revient à l'état d'avant. Le retrait de l'élément
            // fraîchement créé est un nettoyage au mieux, l'erreur d'origine est renvoyée.
            self.config = backup;
            if enabling {
                let _ = self.store.delete();
            }
            return Err(e);
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn set_options(&mut self, hello: bool, timeout_minutes: u32) -> Result<()> {
        let config = self.config.as_mut().ok_or_else(|| {
            anyhow!(t!(
                "First set a master password",
                "Définissez d'abord un mot de passe maître"
            ))
        })?;
        config.hello = hello;
        config.timeout_minutes = timeout_minutes.min(24 * 60);
        // Windows Hello doit pouvoir rendre la clé de données : copie protégée par le compte Windows.
        config.hello_key = match (hello, vault::key()) {
            (true, Some(key)) if config.data_key.is_some() => {
                Some(B64.encode(vault::dpapi::protect(&key)?))
            }
            (true, _) => config.hello_key.clone(),
            (false, _) => None,
        };
        self.save()
    }

    pub fn lock(&self) -> Result<()> {
        if self.config.is_none() {
            bail!(t!(
                "First set a master password (Settings › Security)",
                "Définissez d'abord un mot de passe maître (Paramètres › Sécurité)"
            ));
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
                bail!(
                    "{}",
                    t!(
                        format!(
                            "Too many attempts: try again in {} s",
                            (until - now).as_secs() + 1
                        ),
                        format!(
                            "Trop d'essais : réessayez dans {} s",
                            (until - now).as_secs() + 1
                        )
                    )
                );
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
            bail!(
                "{}",
                t!(
                    format!("Wrong password. Too many attempts: wait {wait} s"),
                    format!("Mot de passe incorrect. Trop d'essais : attendez {wait} s")
                )
            );
        }
        bail!(t!("Wrong password", "Mot de passe incorrect"))
    }

    /// Déverrouille et rend la clé de données. Une configuration d'avant le chiffrement
    /// est migrée : clé créée, fichiers à chiffrer (DataChange::Encrypt).
    pub fn unlock_with_password(&mut self, password: &str) -> Result<DataChange> {
        let config = self
            .config
            .clone()
            .ok_or_else(|| anyhow!(t!("No master password", "Aucun mot de passe maître")))?;
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
            bail!(t!(
                "Windows Hello is not enabled for Portunia",
                "Windows Hello n'est pas activé pour Portunia"
            ));
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

    /// Touch ID actif (lock.json : `biometric == "touchid"`).
    #[cfg(target_os = "macos")]
    pub fn touch_id_enabled(&self) -> bool {
        self.config
            .as_ref()
            .is_some_and(|c| c.hello && c.biometric.as_deref() == Some(biometric_mac::KIND))
    }

    /// Dernière étape du déverrouillage Touch ID : `key` ne peut venir que de
    /// `biometric_mac::unlock_key`, donc d'une authentification réussie. Refusé si Touch ID n'est
    /// pas actif ou si le coffre n'a pas de clé de données.
    #[cfg(target_os = "macos")]
    ///
    /// La clé est vérifiée AVANT d'être appliquée : elle doit ouvrir un fichier chiffré existant du
    /// coffre (`vault::verify_key`, sans nouveau champ dans lock.json). Sans fichier chiffré,
    /// rien ne permet de vérifier : refus (le mot de passe maître reste disponible), Touch ID
    /// inchangé. Clé qui ne correspond pas (sauvegarde restaurée, élément remplacé) : refus,
    /// Touch ID désactivé et élément supprimé, pour ne jamais réessayer une clé fausse ; si la
    /// suppression échoue, Touch ID reste déclaré (état cohérent avec le Trousseau).
    #[cfg(target_os = "macos")]
    pub fn finish_biometric_unlock(&mut self, key: biometric_mac::VaultKey) -> Result<()> {
        if !self.touch_id_enabled() {
            bail!(t!(
                "Touch ID is not enabled for Portunia",
                "Touch ID n'est pas activé pour Portunia"
            ));
        }
        if !self.config.as_ref().is_some_and(|c| c.data_key.is_some()) {
            bail!(t!(
                "Unlock once with the master password: Touch ID will then be ready for encrypted data.",
                "Déverrouillez une fois avec le mot de passe maître : Touch ID sera ensuite prêt pour les données chiffrées."
            ));
        }
        let dir = self
            .path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        match vault::verify_key(dir, &key) {
            vault::KeyCheck::Valid => {}
            vault::KeyCheck::NoData => bail!(t!(
                "The Keychain key cannot be checked yet (no encrypted data): use the master password",
                "La clé du Trousseau ne peut pas être vérifiée (aucune donnée chiffrée) : utilisez le mot de passe maître"
            )),
            vault::KeyCheck::Invalid => {
                let mismatch = t!(
                    "The Keychain key no longer matches the vault: use the master password",
                    "La clé du Trousseau ne correspond plus au coffre : utilisez le mot de passe maître"
                );
                self.store.delete().map_err(|e| {
                    keychain_error(
                        t!(
                            "The Keychain key no longer matches the vault and could not be removed",
                            "La clé du Trousseau ne correspond plus au coffre et n'a pas pu être retirée"
                        ),
                        &e,
                    )
                })?;
                if let Some(config) = self.config.as_mut() {
                    config.biometric = None;
                    config.hello = false;
                }
                self.save()?;
                bail!(mismatch);
            }
        }
        // `vault` garde la clé en `[u8; 32]` (Windows inchangé) : seule cette copie sort du Zeroizing.
        vault::set_key(Some(*key));
        self.locked.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Après un changement de mot de passe : réécrit l'élément du Trousseau si Touch ID reste actif.
    /// En cas d'échec on ferme (Touch ID désactivé, élément supprimé au mieux) plutôt que de laisser
    /// une clé périmée, et l'erreur est renvoyée.
    #[cfg(target_os = "macos")]
    fn refresh_touch_id(&mut self, key: &[u8; 32]) -> Result<()> {
        if !self.touch_id_enabled() {
            return Ok(());
        }
        let Err(detail) = self.store.save(key) else {
            return Ok(());
        };
        // Suppression de l'élément périmé : si elle échoue, Touch ID reste déclaré (l'élément
        // existe encore) et les deux erreurs sont renvoyées.
        if let Err(delete_detail) = self.store.delete() {
            return Err(keychain_error(
                t!(
                    "Password changed, but the Keychain key could not be updated nor removed (Touch ID still enabled)",
                    "Mot de passe changé, mais la clé du Trousseau n'a pu être ni mise à jour ni retirée (Touch ID toujours actif)"
                ),
                &format!("{detail} / {delete_detail}"),
            ));
        }
        if let Some(config) = self.config.as_mut() {
            config.biometric = None;
            config.hello = false;
        }
        self.save()?;
        Err(keychain_error(
            t!(
                "Password changed, but Touch ID was turned off: the Keychain could not be updated",
                "Mot de passe changé, mais Touch ID a été désactivé : le Trousseau n'a pas pu être mis à jour"
            ),
            &detail,
        ))
    }

    pub fn status(&self) -> LockStatus {
        LockStatus {
            enabled: self.config.is_some(),
            encrypted: self.config.as_ref().is_some_and(|c| c.data_key.is_some()),
            locked: self.is_locked(),
            // « hello » = biométrie active (Windows Hello ou Touch ID) ; nom gardé pour l'interface.
            #[cfg(target_os = "macos")]
            hello: self.touch_id_enabled(),
            #[cfg(not(target_os = "macos"))]
            hello: self.hello_enabled(),
            hello_available: biometric_kind().is_some(),
            timeout_minutes: self
                .config
                .as_ref()
                .map(|c| c.timeout_minutes)
                .unwrap_or(15),
        }
    }
}

/// Erreur du Trousseau avec son contexte (le détail vient de macOS, jamais de la clé).
#[cfg(target_os = "macos")]
fn keychain_error(context: &str, detail: &str) -> anyhow::Error {
    anyhow!("{context} : {detail}")
}

/// Capteur biométrique utilisable : `"hello"` (Windows), `"touchid"` (macOS) ou `None`
/// (pas de capteur, pas configuré, autre système).
pub fn biometric_kind() -> Option<&'static str> {
    #[cfg(windows)]
    return hello::available().then_some("hello");
    #[cfg(target_os = "macos")]
    return biometric_mac::available().then_some(biometric_mac::KIND);
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

/// Windows Hello (visage, empreinte, code PIN).
pub mod hello {
    #[cfg(windows)]
    pub fn available() -> bool {
        use windows::Security::Credentials::UI::{
            UserConsentVerifier, UserConsentVerifierAvailability,
        };
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
        let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(HWND(hwnd), &HSTRING::from(message))?
        };
        Ok(operation.join()? == UserConsentVerificationResult::Verified)
    }

    // Hors Windows, `biometric_kind()` ne passe pas par ce module (Touch ID : biometric_mac).
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
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        vault::set_key(None);
        vault::set_enabled(false);
        let dir = std::env::temp_dir().join(format!("portunia-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let data = dir.join("sessions.json");
        let mut lock = Lock::load(&dir);
        // Premier mot de passe : clé créée, fichiers à chiffrer.
        assert_eq!(
            lock.set_password("", "un bon mot de passe").unwrap(),
            DataChange::Encrypt
        );
        vault::write(&data, "srv-prod-01").unwrap();
        assert!(
            !fs::read_to_string(&data).unwrap().contains("srv-prod"),
            "rien en clair"
        );
        assert!(!fs::read_to_string(dir.join("lock.json"))
            .unwrap()
            .contains("srv-prod"));

        // Redémarrage : verrouillé, fichier illisible, écriture refusée.
        let mut lock = restart(&dir);
        assert!(lock.is_locked() && vault::enabled());
        assert_eq!(vault::read(&data).unwrap(), vault::Content::Locked);
        assert!(vault::write(&data, "écrasé").is_err());
        assert!(lock.unlock_with_password("faux mot de passe").is_err());
        assert_eq!(
            lock.unlock_with_password("un bon mot de passe").unwrap(),
            DataChange::None
        );
        assert_eq!(
            vault::read(&data).unwrap(),
            vault::Content::Text("srv-prod-01".into())
        );

        // Changement de mot de passe : même clé, ré-enveloppée.
        assert_eq!(
            lock.set_password("un bon mot de passe", "nouveau mot de passe")
                .unwrap(),
            DataChange::None
        );
        let mut lock = restart(&dir);
        assert!(
            lock.unlock_with_password("un bon mot de passe").is_err(),
            "l'ancien ne marche plus"
        );
        lock.unlock_with_password("nouveau mot de passe").unwrap();
        assert_eq!(
            vault::read(&data).unwrap(),
            vault::Content::Text("srv-prod-01".into())
        );

        // Retrait : fichiers à remettre en clair, écritures en clair ensuite.
        assert_eq!(
            lock.disable("nouveau mot de passe").unwrap(),
            DataChange::Decrypt
        );
        assert!(!vault::enabled());
        vault::write(&data, "srv-prod-01").unwrap();
        assert_eq!(fs::read_to_string(&data).unwrap(), "srv-prod-01");
        let lock = restart(&dir);
        assert!(!lock.is_locked() && !vault::enabled());
    }

    #[test]
    fn ancienne_configuration_migree() {
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        vault::set_key(None);
        vault::set_enabled(false);
        let dir = std::env::temp_dir().join(format!("portunia-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut lock = Lock::load(&dir);
        lock.set_password("", "un bon mot de passe").unwrap();
        // lock.json d'une version d'avant le chiffrement : pas de clé de données.
        let path = dir.join("lock.json");
        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.remove("keySalt");
        obj.remove("dataKey");
        obj.remove("helloKey");
        fs::write(&path, json.to_string()).unwrap();
        fs::write(dir.join("notes.json"), "{\"a\": \"en clair\"}").unwrap();

        let mut lock = restart(&dir);
        assert!(!vault::enabled(), "rien n'est chiffré avant la migration");
        assert_eq!(
            vault::read(&dir.join("notes.json")).unwrap(),
            vault::Content::Text("{\"a\": \"en clair\"}".into())
        );
        assert_eq!(
            lock.unlock_with_password("un bon mot de passe").unwrap(),
            DataChange::Encrypt
        );
        assert!(vault::enabled() && vault::key().is_some());
        let mut lock = restart(&dir);
        assert_eq!(
            lock.unlock_with_password("un bon mot de passe").unwrap(),
            DataChange::None,
            "migré une seule fois"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_hello_rend_la_cle() {
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        lock.lock().unwrap();
        for _ in 0..4 {
            assert_eq!(
                lock.unlock_with_password("faux").unwrap_err().to_string(),
                t!("Wrong password", "Mot de passe incorrect")
            );
        }
        assert!(lock
            .unlock_with_password("faux")
            .unwrap_err()
            .to_string()
            .contains(t!("wait 5 s", "attendez 5 s")));
        // Même le bon mot de passe est refusé pendant l'attente.
        assert!(lock
            .unlock_with_password("un bon mot de passe")
            .unwrap_err()
            .to_string()
            .contains(t!("try again", "réessayez")));
        assert!(lock.is_locked());
        // Attente écoulée : le bon mot de passe passe et remet le compteur à zéro.
        lock.throttle.lock().unwrap().1 = None;
        lock.unlock_with_password("un bon mot de passe").unwrap();
        assert_eq!(lock.throttle.lock().unwrap().0, 0);
    }

    #[test]
    fn cycle_complet() {
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        assert!(!lock.is_locked());
        assert!(
            lock.lock().is_err(),
            "sans mot de passe, pas de verrouillage"
        );
        assert!(lock.set_password("", "court").is_err());
        lock.set_password("", "un bon mot de passe").unwrap();
        lock.lock().unwrap();
        assert!(lock.ensure_unlocked().is_err());
        assert!(lock.unlock_with_password("faux").is_err());
        lock.unlock_with_password("un bon mot de passe").unwrap();
        assert!(lock.ensure_unlocked().is_ok());
        assert!(lock.set_password("faux", "nouveau mot de passe").is_err());
        lock.set_password("un bon mot de passe", "nouveau mot de passe")
            .unwrap();
        assert!(lock.disable("un bon mot de passe").is_err());
        lock.disable("nouveau mot de passe").unwrap();
        assert!(!lock.status().enabled);
    }

    #[test]
    fn verrouille_au_redemarrage() {
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        let reloaded = Lock::load(lock.path.parent().unwrap());
        assert!(reloaded.is_locked());
        lock.disable("un bon mot de passe").unwrap();
    }

    #[test]
    fn lock_json_sans_champ_biometric_se_lit_comme_avant() {
        let _g = crate::vault::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut lock = temp_lock();
        lock.set_password("", "un bon mot de passe").unwrap();
        let path = lock.path.clone();
        // Sans activation biométrique, le fichier ne contient pas le nouveau champ (Windows inchangé).
        assert!(!fs::read_to_string(&path).unwrap().contains("biometric"));
        // Un fichier existant (sans le champ) se relit : biométrie absente, Hello conservé tel quel.
        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        json["hello"] = serde_json::Value::Bool(true);
        fs::write(&path, json.to_string()).unwrap();
        let reloaded = Lock::load(path.parent().unwrap());
        let config = reloaded.config.as_ref().unwrap();
        assert_eq!(config.biometric, None);
        assert!(config.hello && reloaded.hello_enabled());
        assert!(reloaded.is_locked());
        vault::set_key(None);
        vault::set_enabled(false);
    }

    #[cfg(target_os = "macos")]
    mod touch_id {
        use super::*;
        use crate::biometric_mac::{KeyStore, KIND};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };

        /// Trousseau en mémoire, partagé avec le test pour inspecter l'élément.
        #[derive(Clone, Default)]
        struct MemStore {
            item: Arc<Mutex<Option<[u8; 32]>>>,
            fail_save: Arc<AtomicBool>,
            fail_delete: Arc<AtomicBool>,
        }

        impl KeyStore for MemStore {
            fn save(&self, key: &[u8; 32]) -> Result<(), String> {
                if self.fail_save.load(Ordering::SeqCst) {
                    return Err("refusé".into());
                }
                *self.item.lock().unwrap() = Some(*key);
                Ok(())
            }
            fn load(&self) -> Result<Option<biometric_mac::VaultKey>, String> {
                Ok((*self.item.lock().unwrap()).map(zeroize::Zeroizing::new))
            }
            fn delete(&self) -> Result<(), String> {
                if self.fail_delete.load(Ordering::SeqCst) {
                    return Err("refusé".into());
                }
                *self.item.lock().unwrap() = None;
                Ok(())
            }
        }

        fn lock_with_store() -> (Lock, MemStore) {
            let mut lock = temp_lock();
            let store = MemStore::default();
            lock.store = Box::new(store.clone());
            lock.set_password("", "un bon mot de passe").unwrap();
            (lock, store)
        }

        fn reset() {
            vault::set_key(None);
            vault::set_enabled(false);
        }

        #[test]
        fn activation_range_la_cle_et_enregistre_touchid() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            let key = vault::key().unwrap();
            lock.set_options(true, 15).unwrap();
            assert_eq!(*store.item.lock().unwrap(), Some(key));
            assert!(lock.hello_enabled());
            let json = fs::read_to_string(&lock.path).unwrap();
            assert!(json.contains("\"biometric\": \"touchid\""), "{json}");
            assert!(
                !json.contains("helloKey\": \""),
                "pas de copie DPAPI sur Mac"
            );
            reset();
        }

        #[test]
        fn activation_refusee_si_le_trousseau_echoue_et_rien_ne_change() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            store.fail_save.store(true, Ordering::SeqCst);
            assert!(lock.set_options(true, 15).is_err());
            assert!(!lock.hello_enabled());
            assert_eq!(lock.config.as_ref().unwrap().biometric, None);
            assert!(!fs::read_to_string(&lock.path)
                .unwrap()
                .contains("biometric"));
            reset();
        }

        #[test]
        fn activation_exige_le_coffre_ouvert() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            vault::set_key(None);
            assert!(lock.set_options(true, 15).is_err());
            assert_eq!(*store.item.lock().unwrap(), None);
            reset();
        }

        #[test]
        fn desactivation_supprime_l_element_et_remet_biometric_a_zero() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            lock.set_options(false, 15).unwrap();
            assert_eq!(*store.item.lock().unwrap(), None);
            assert!(!lock.hello_enabled());
            assert_eq!(lock.config.as_ref().unwrap().biometric, None);
            assert!(!fs::read_to_string(&lock.path)
                .unwrap()
                .contains("biometric"));
            reset();
        }

        #[test]
        fn desactivation_echoue_si_la_suppression_echoue_et_garde_touchid_actif() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            store.fail_delete.store(true, Ordering::SeqCst);
            assert!(lock.set_options(false, 15).is_err());
            assert!(
                lock.hello_enabled(),
                "état cohérent avec l'élément resté dans le Trousseau"
            );
            reset();
        }

        #[test]
        fn changer_le_delai_ne_touche_pas_au_trousseau() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            store.fail_save.store(true, Ordering::SeqCst);
            lock.set_options(true, 30).unwrap();
            assert!(lock.hello_enabled());
            reset();
        }

        #[test]
        fn changement_de_mot_de_passe_reecrit_l_enveloppe_si_touchid_reste_actif() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            let key = vault::key().unwrap();
            *store.item.lock().unwrap() = Some([0; 32]); // valeur périmée
            lock.set_password("un bon mot de passe", "nouveau mot de passe")
                .unwrap();
            assert_eq!(*store.item.lock().unwrap(), Some(key));
            assert!(lock.hello_enabled());
            reset();
        }

        #[test]
        fn changement_de_mot_de_passe_echoue_ferme_touchid_et_supprime_l_element() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            store.fail_save.store(true, Ordering::SeqCst);
            assert!(lock
                .set_password("un bon mot de passe", "nouveau mot de passe")
                .is_err());
            assert!(
                !lock.hello_enabled(),
                "Touch ID désactivé plutôt que clé périmée"
            );
            assert_eq!(*store.item.lock().unwrap(), None);
            // Le nouveau mot de passe, lui, est bien enregistré.
            assert!(lock.check("nouveau mot de passe"));
            reset();
        }

        #[test]
        fn retrait_du_mot_de_passe_supprime_l_element() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            lock.disable("un bon mot de passe").unwrap();
            assert_eq!(*store.item.lock().unwrap(), None);
            assert!(!lock.path.exists());
            reset();
        }

        #[test]
        fn retrait_refuse_si_l_element_ne_peut_etre_supprime() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            store.fail_delete.store(true, Ordering::SeqCst);
            assert!(lock.disable("un bon mot de passe").is_err());
            assert!(
                lock.path.exists() && lock.hello_enabled(),
                "la clé ne reste jamais seule dans le Trousseau"
            );
            reset();
        }

        #[test]
        fn mauvais_mot_de_passe_ne_supprime_rien() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            assert!(lock.disable("faux").is_err());
            assert!(store.item.lock().unwrap().is_some());
            reset();
        }

        #[test]
        fn deverrouillage_touch_id_applique_la_cle() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, _store) = lock_with_store();
            let key = vault::key().unwrap();
            write_vault_file(&lock);
            lock.set_options(true, 15).unwrap();
            lock.lock().unwrap();
            vault::set_key(None);
            lock.finish_biometric_unlock(zeroize::Zeroizing::new(key))
                .unwrap();
            assert!(!lock.is_locked());
            assert_eq!(vault::key(), Some(key));
            reset();
        }

        /// Un fichier chiffré du coffre, qui sert à vérifier la clé rendue par le Trousseau.
        fn write_vault_file(lock: &Lock) {
            vault::write(&lock.path.with_file_name("sessions.json"), "[]").unwrap();
        }

        #[test]
        fn cle_du_trousseau_qui_ne_correspond_pas_au_coffre_est_refusee() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            write_vault_file(&lock);
            lock.set_options(true, 15).unwrap();
            lock.lock().unwrap();
            vault::set_key(None);
            let wrong = zeroize::Zeroizing::new([9u8; 32]);
            assert!(lock.finish_biometric_unlock(wrong).is_err());
            assert!(
                lock.is_locked() && vault::key().is_none(),
                "aucune clé appliquée"
            );
            // Élément périmé supprimé et Touch ID désactivé : mot de passe maître requis.
            assert_eq!(*store.item.lock().unwrap(), None);
            assert!(!lock.hello_enabled());
            assert_eq!(lock.config.as_ref().unwrap().biometric, None);
            reset();
        }

        #[test]
        fn cle_non_verifiable_sans_fichier_chiffre_est_refusee_sans_desactiver() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            let key = vault::key().unwrap();
            lock.set_options(true, 15).unwrap();
            lock.lock().unwrap();
            vault::set_key(None);
            // Coffre vide : rien ne permet de vérifier, on refuse (même avec la bonne clé).
            assert!(lock
                .finish_biometric_unlock(zeroize::Zeroizing::new(key))
                .is_err());
            assert!(lock.is_locked() && vault::key().is_none());
            assert_eq!(*store.item.lock().unwrap(), Some(key), "élément conservé");
            assert!(lock.hello_enabled());
            reset();
        }

        #[test]
        fn cle_refusee_mais_suppression_impossible_garde_touchid_et_signale() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            write_vault_file(&lock);
            lock.set_options(true, 15).unwrap();
            lock.lock().unwrap();
            vault::set_key(None);
            store.fail_delete.store(true, Ordering::SeqCst);
            assert!(lock
                .finish_biometric_unlock(zeroize::Zeroizing::new([9u8; 32]))
                .is_err());
            assert!(lock.hello_enabled(), "état cohérent avec l'élément resté");
            assert!(vault::key().is_none());
            reset();
        }

        #[test]
        fn element_residuel_supprime_par_disable_meme_sans_touchid_actif() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            *store.item.lock().unwrap() = Some([5; 32]);
            assert!(!lock.touch_id_enabled());
            lock.disable("un bon mot de passe").unwrap();
            assert_eq!(*store.item.lock().unwrap(), None);
            reset();
        }

        #[test]
        fn disable_echoue_si_la_suppression_de_l_element_residuel_echoue() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            *store.item.lock().unwrap() = Some([5; 32]);
            store.fail_delete.store(true, Ordering::SeqCst);
            assert!(lock.disable("un bon mot de passe").is_err());
            assert!(lock.path.exists(), "rien n'est retiré");
            reset();
        }

        #[test]
        fn decocher_touchid_supprime_aussi_un_element_residuel() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            *store.item.lock().unwrap() = Some([5; 32]);
            lock.set_options(false, 15).unwrap();
            assert_eq!(*store.item.lock().unwrap(), None);
            reset();
        }

        #[test]
        fn changement_de_mot_de_passe_echec_ecriture_et_suppression_garde_touchid_et_signale() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, store) = lock_with_store();
            lock.set_options(true, 15).unwrap();
            store.fail_save.store(true, Ordering::SeqCst);
            store.fail_delete.store(true, Ordering::SeqCst);
            assert!(lock
                .set_password("un bon mot de passe", "nouveau mot de passe")
                .is_err());
            assert!(
                lock.hello_enabled(),
                "l'élément est encore là : Touch ID reste déclaré"
            );
            assert!(store.item.lock().unwrap().is_some());
            reset();
        }

        #[test]
        fn deverrouillage_touch_id_refuse_si_non_active() {
            let _g = crate::vault::TEST_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (mut lock, _store) = lock_with_store();
            lock.lock().unwrap();
            vault::set_key(None);
            assert!(lock
                .finish_biometric_unlock(zeroize::Zeroizing::new([1; 32]))
                .is_err());
            assert!(lock.is_locked() && vault::key().is_none());
            assert_eq!(KIND, "touchid");
            reset();
        }
    }
}
