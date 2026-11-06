//! Chiffrement au repos des données de Portunia quand un mot de passe maître est défini.
//!
//! Schéma :
//! - une **clé de données** aléatoire (256 bits) chiffre les fichiers sessions.json,
//!   notes.json, credentials.json et known_hosts.json en AES-256-GCM (nonce aléatoire de
//!   96 bits à chaque écriture ; le nom du fichier sert de donnée associée, un fichier ne peut
//!   donc pas être échangé contre un autre) ;
//! - cette clé est **enveloppée** (AES-256-GCM) par une clé dérivée du mot de passe maître
//!   (PBKDF2-HMAC-SHA256, 600 000 itérations, sel propre) et rangée dans lock.json ;
//! - pour Windows Hello, une seconde copie est protégée par **DPAPI** (liée au compte Windows) ;
//!   sous macOS, la clé est rangée dans le Trousseau (voir `biometric_mac.rs`) ;
//! - les mots de passe des sessions restent dans le Gestionnaire d'identifiants Windows.
//!
//! Sans mot de passe maître, les fichiers restent en clair (comportement d'origine).
//! Mot de passe oublié et Windows Hello indisponible : les données chiffrées sont perdues.

use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        RwLock,
    },
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN},
    rand::{SecureRandom, SystemRandom},
};
use zeroize::Zeroizing;

/// En-tête d'un fichier chiffré (ancien nom du logiciel, gardé : c'est le format des fichiers).
const MAGIC: &[u8] = b"TERMORIA-CHIFFRE-1\n";

/// Clé de données en mémoire (présente une fois déverrouillé). `Zeroizing` en efface les octets
/// quand elle est remplacée (nouveau mot de passe, déverrouillage Hello / Touch ID), retirée
/// (fin du chiffrement) ou à la fermeture de l'application (`lib.rs`, `RunEvent::Exit`) : une
/// `static` n'est pas détruite à la sortie du processus. Le verrouillage de l'interface ne
/// l'efface PAS (les sessions ouvertes en ont besoin). Limite connue : les copies de pile
/// temporaires (valeurs `[u8; 32]` passées par valeur) ne sont pas toutes traçables ; on passe des références et des `Zeroizing` partout où c'est possible.
static KEY: RwLock<Option<Zeroizing<[u8; 32]>>> = RwLock::new(None);
/// Chiffrement actif : toute écriture doit être chiffrée.
static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::SeqCst);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// Installe la clé ; l'ancienne, remplacée, est effacée.
pub fn install_key(key: Zeroizing<[u8; 32]>) {
    *KEY.write().unwrap_or_else(|e| e.into_inner()) = Some(key);
}

/// Retire la clé (fin du chiffrement, fermeture de l'application) : ses octets sont effacés.
pub fn clear_key() {
    *KEY.write().unwrap_or_else(|e| e.into_inner()) = None;
}

/// `Some` installe, `None` efface (voir `install_key` / `clear_key`). Pratique pour les tests.
#[cfg(test)]
pub fn set_key(key: Option<[u8; 32]>) {
    match key {
        Some(key) => install_key(Zeroizing::new(key)),
        None => clear_key(),
    }
}

pub fn has_key() -> bool {
    KEY.read().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// Copie de la clé, effacée à sa libération. Préférer `with_key` quand une référence suffit.
pub fn key() -> Option<Zeroizing<[u8; 32]>> {
    KEY.read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|k| {
            // Copie directement dans un `Zeroizing` (pas de temporaire `[u8; 32]` sur la pile).
            let mut copy = Zeroizing::new([0u8; 32]);
            copy.copy_from_slice(&k[..]);
            copy
        })
}

/// Exécute `f` avec une référence à la clé, sans en faire de copie.
fn with_key<R>(f: impl FnOnce(&[u8; 32]) -> R) -> Option<R> {
    KEY.read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|k| f(k))
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    SystemRandom::new().fill(&mut out).map_err(|_| {
        anyhow!(t!(
            "Random generator unavailable",
            "Générateur aléatoire indisponible"
        ))
    })?;
    Ok(out)
}

/// nonce ‖ texte chiffré ‖ étiquette.
pub fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let sealing = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| anyhow!(t!("Invalid key", "Clé invalide")))?,
    );
    let nonce_bytes = random_bytes::<NONCE_LEN>()?;
    // Copie du clair effacée à la libération ; capacité réservée pour que l'étiquette ne force
    // pas de réallocation (l'ancien bloc ne serait pas effacé).
    let mut buf = Zeroizing::new(Vec::with_capacity(plain.len() + AES_256_GCM.tag_len()));
    buf.extend_from_slice(plain);
    sealing
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(aad),
            &mut *buf,
        )
        .map_err(|_| anyhow!(t!("Encryption failed", "Chiffrement impossible")))?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&buf);
    Ok(out)
}

pub fn open(key: &[u8; 32], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE_LEN + 16 {
        bail!(t!(
            "Truncated encrypted data",
            "Données chiffrées tronquées"
        ));
    }
    let opening = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| anyhow!(t!("Invalid key", "Clé invalide")))?,
    );
    let (nonce, rest) = sealed.split_at(NONCE_LEN);
    // Le clair déchiffré en place est effacé à la libération de `buf`.
    let mut buf = Zeroizing::new(rest.to_vec());
    let nonce = Nonce::try_assume_unique_for_key(nonce)
        .map_err(|_| anyhow!(t!("Invalid nonce", "Nonce invalide")))?;
    let plain = opening
        .open_in_place(nonce, Aad::from(aad), &mut buf)
        .map_err(|_| {
            anyhow!(t!(
                "Decryption failed: wrong key or modified file",
                "Déchiffrement impossible : clé incorrecte ou fichier modifié"
            ))
        })?;
    Ok(plain.to_vec())
}

/// Clé de 256 bits dérivée d'une phrase de passe (PBKDF2-HMAC-SHA256).
pub fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(iterations.max(1)).unwrap(),
        salt,
        passphrase.as_bytes(),
        &mut out[..],
    );
    out
}

/// Contenu d'un fichier de données.
#[derive(Debug, PartialEq)]
pub enum Content {
    Missing,
    Text(String),
    /// Chiffré, mais Portunia est verrouillé (clé absente).
    Locked,
}

fn aad(path: &Path) -> Vec<u8> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .into_bytes()
}

/// Résultat de la vérification d'une clé contre les fichiers chiffrés du coffre.
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
pub enum KeyCheck {
    /// Au moins un fichier chiffré s'ouvre avec cette clé.
    Valid,
    /// Un fichier chiffré ne s'ouvre pas avec cette clé (ou est illisible).
    Invalid,
    /// Aucun fichier chiffré : rien ne permet de vérifier.
    NoData,
}

/// Fichiers chiffrés du coffre (voir l'en-tête du module).
#[cfg(target_os = "macos")]
const VAULT_FILES: [&str; 4] = [
    "sessions.json",
    "notes.json",
    "credentials.json",
    "known_hosts.json",
];

/// Vérifie une clé en déchiffrant le premier fichier chiffré de `dir` (AES-GCM authentifié :
/// une mauvaise clé échoue toujours). S'il s'ouvre, la clé est valide ; sinon (clé fausse ou
/// fichier illisible) elle est rejetée. Ne modifie rien.
#[cfg(target_os = "macos")]
pub fn verify_key(dir: &Path, key: &[u8; 32]) -> KeyCheck {
    // Le premier fichier chiffré trouvé décide : un seul suffit, tous sont chiffrés par la même clé.
    for name in VAULT_FILES {
        let path = dir.join(name);
        let Ok(bytes) = fs::read(&path) else { continue };
        let Some(sealed) = bytes.strip_prefix(MAGIC) else {
            continue;
        };
        let opened = B64
            .decode(sealed.trim_ascii())
            .ok()
            .and_then(|sealed| open(key, &sealed, &aad(&path)).ok());
        return if opened.is_some() {
            KeyCheck::Valid
        } else {
            KeyCheck::Invalid
        };
    }
    KeyCheck::NoData
}

/// Lit un fichier, chiffré ou non.
pub fn read(path: &Path) -> Result<Content> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Content::Missing),
        Err(e) => {
            return Err(e).with_context(|| format!("Lecture impossible : {}", path.display()))
        }
    };
    let Some(sealed) = bytes.strip_prefix(MAGIC) else {
        return Ok(Content::Text(String::from_utf8(bytes).context(t!(
            "Unreadable file (encoding)",
            "Fichier illisible (encodage)"
        ))?));
    };
    if !has_key() {
        return Ok(Content::Locked);
    }
    let sealed = B64
        .decode(sealed.trim_ascii())
        .context(t!("Unreadable encrypted file", "Fichier chiffré illisible"))?;
    // Verrouillé entre-temps : clé absente = fichier illisible, comme ci-dessus.
    let Some(plain) = with_key(|key| open(key, &sealed, &aad(path))) else {
        return Ok(Content::Locked);
    };
    let plain = plain.with_context(|| format!("{}", path.display()))?;
    Ok(Content::Text(String::from_utf8(plain).context(t!(
        "Unreadable file (encoding)",
        "Fichier illisible (encodage)"
    ))?))
}

/// Écrit un fichier (atomiquement), chiffré si le chiffrement est actif.
pub fn write(path: &Path, text: &str) -> Result<()> {
    let bytes = if enabled() {
        let sealed = with_key(|key| seal(key, text.as_bytes(), &aad(path)))
            .ok_or_else(|| {
                anyhow!(t!(
                    "Portunia is locked: write refused",
                    "Portunia est verrouillé : écriture refusée"
                ))
            })??;
        let mut out = MAGIC.to_vec();
        out.extend_from_slice(B64.encode(sealed).as_bytes());
        out.push(b'\n');
        out
    } else {
        text.as_bytes().to_vec()
    };
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).with_context(|| format!("Écriture impossible : {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("Écriture impossible : {}", path.display()))?;
    Ok(())
}

/// Charge un fichier JSON. Renvoie aussi « verrouillé » : fichier chiffré non lisible pour
/// l'instant, qu'il ne faut surtout pas écraser avant de l'avoir relu.
pub fn load_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> (T, bool) {
    match read(path) {
        Ok(Content::Text(text)) => (serde_json::from_str(&text).unwrap_or_default(), false),
        Ok(Content::Missing) => (T::default(), false),
        Ok(Content::Locked) | Err(_) => (T::default(), true),
    }
}

// ---------- Protection de la clé par le compte Windows (DPAPI), pour Windows Hello ----------

#[cfg(windows)]
pub mod dpapi {
    use super::*;
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    fn run(data: &[u8], protect: bool) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    windows::core::w!("Portunia"),
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )?;
            } else {
                CryptUnprotectData(
                    &input,
                    None,
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )?;
            }
            let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
            Ok(out)
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        run(data, true).map_err(|e| {
            anyhow!(
                "{}",
                t!(
                    format!("Windows protection failed: {e}"),
                    format!("Protection Windows impossible : {e}")
                )
            )
        })
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
        run(data, false).map_err(|e| {
            anyhow!(
                "{}",
                t!(
                    format!("Unreadable Windows Hello key (another account or another PC?): {e}"),
                    format!("Clé Windows Hello illisible (autre compte ou autre PC ?) : {e}")
                )
            )
        })
    }
}

#[cfg(not(windows))]
pub mod dpapi {
    use super::*;
    pub fn protect(_data: &[u8]) -> Result<Vec<u8>> {
        bail!("Windows uniquement")
    }
    pub fn unprotect(_data: &[u8]) -> Result<Vec<u8>> {
        bail!("Windows uniquement")
    }
}

#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("portunia-vault-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn aller_retour_et_verrouillage() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = temp("sessions.json");
        let key = random_bytes::<32>().unwrap();
        set_key(Some(key));
        set_enabled(true);
        write(&path, "{\"secret\": \"srv-prod\"}").unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(raw.starts_with(MAGIC));
        assert!(
            !String::from_utf8_lossy(&raw).contains("srv-prod"),
            "rien en clair sur le disque"
        );
        assert_eq!(
            read(&path).unwrap(),
            Content::Text("{\"secret\": \"srv-prod\"}".into())
        );
        // Verrouillé : lecture « Locked », écriture refusée (jamais de clair par accident).
        set_key(None);
        assert_eq!(read(&path).unwrap(), Content::Locked);
        assert!(write(&path, "{}").is_err());
        // Mauvaise clé : erreur, pas de données.
        set_key(Some(random_bytes::<32>().unwrap()));
        assert!(read(&path).is_err());
        set_key(None);
        set_enabled(false);
    }

    /// Effacer la clé la retire ; la remplacer remplace l'ancienne (l'ancienne est effacée de la
    /// mémoire par `Zeroizing` à sa libération : cet effacement-là ne se teste pas directement,
    /// lire de la mémoire libérée serait un comportement indéfini).
    #[test]
    fn cle_effacee_ou_remplacee() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let first = random_bytes::<32>().unwrap();
        let second = random_bytes::<32>().unwrap();
        set_key(Some(first));
        assert!(has_key());
        assert_eq!(key().as_deref(), Some(&first));
        set_key(Some(second));
        assert_eq!(key().as_deref(), Some(&second), "ancienne clé remplacée");
        clear_key();
        assert!(!has_key() && key().is_none());
        // Plus de clé : fichier chiffré illisible et écriture refusée.
        let path = temp("sessions.json");
        set_key(Some(first));
        set_enabled(true);
        write(&path, "{}").unwrap();
        clear_key();
        assert_eq!(read(&path).unwrap(), Content::Locked);
        assert!(write(&path, "{}").is_err());
        set_enabled(false);
    }

    #[test]
    fn fichier_modifie_ou_echange_detecte() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let key = random_bytes::<32>().unwrap();
        set_key(Some(key));
        set_enabled(true);
        let a = temp("notes.json");
        write(&a, "notes").unwrap();
        // Un octet modifié : refusé.
        let mut raw = fs::read(&a).unwrap();
        let i = raw.len() - 5;
        raw[i] = if raw[i] == b'A' { b'B' } else { b'A' };
        fs::write(&a, &raw).unwrap();
        assert!(read(&a).is_err());
        // Fichier d'un autre nom copié à sa place : refusé (nom = donnée associée).
        let b = a.with_file_name("sessions.json");
        write(&b, "sessions").unwrap();
        fs::copy(&b, &a).unwrap();
        assert!(read(&a).is_err());
        set_key(None);
        set_enabled(false);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn verification_de_la_cle_sur_un_fichier_chiffre() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = temp("sessions.json");
        let dir = path.parent().unwrap().to_path_buf();
        let key = random_bytes::<32>().unwrap();
        // Rien de chiffré : impossible de vérifier.
        assert_eq!(verify_key(&dir, &key), KeyCheck::NoData);
        fs::write(dir.join("notes.json"), "{}").unwrap();
        assert_eq!(
            verify_key(&dir, &key),
            KeyCheck::NoData,
            "un fichier en clair ne prouve rien"
        );
        set_key(Some(key));
        set_enabled(true);
        write(&path, "[]").unwrap();
        set_key(None);
        set_enabled(false);
        assert_eq!(verify_key(&dir, &key), KeyCheck::Valid);
        assert_eq!(
            verify_key(&dir, &random_bytes::<32>().unwrap()),
            KeyCheck::Invalid
        );
        // Fichier chiffré illisible : refus, jamais « valide ».
        fs::write(
            dir.join("credentials.json"),
            format!("{}garbage", String::from_utf8_lossy(MAGIC)),
        )
        .unwrap();
        // Seul fichier chiffré, illisible : refus même avec la bonne clé, jamais « valide ».
        fs::remove_file(&path).unwrap();
        assert_eq!(verify_key(&dir, &key), KeyCheck::Invalid);
    }

    #[test]
    fn sans_mot_de_passe_maitre_le_fichier_reste_lisible() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_key(None);
        set_enabled(false);
        let path = temp("sessions.json");
        write(&path, "[]").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
        assert_eq!(read(&path).unwrap(), Content::Text("[]".into()));
        assert_eq!(
            read(&path.with_file_name("absent.json")).unwrap(),
            Content::Missing
        );
    }

    #[cfg(windows)]
    #[test]
    fn protection_par_le_compte_windows() {
        let secret = random_bytes::<32>().unwrap();
        let protected = dpapi::protect(&secret).unwrap();
        assert_ne!(&protected[..], &secret[..]);
        assert_eq!(dpapi::unprotect(&protected).unwrap(), secret);
    }
}
