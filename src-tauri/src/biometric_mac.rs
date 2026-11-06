//! Touch ID (LocalAuthentication) et enveloppe de la clé du coffre dans le Trousseau macOS.
//!
//! Modèle de menace (même niveau que Windows Hello + DPAPI) : la clé de données est rangée
//! dans le Trousseau de la session (élément protégé par l'ACL de l'application) et `LAContext`
//! vérifie la présence de l'utilisateur avant que Portunia ne la relise. La liaison biométrique
//! forte (`SecAccessControl` + trousseau « data protection ») exige l'entitlement
//! `keychain-access-groups`, donc un Team ID Apple : hors périmètre tant qu'il n'existe pas.
//!
//! Règles de sécurité :
//! - le seul chemin qui rend la clé passe par `Ok(())` de l'authentification (`unlock_key`) ;
//!   annulation, échec, verrouillage biométrique ou erreur inconnue donnent `Err`, sans repli ;
//! - la clé ne figure ni dans un message d'erreur ni dans un journal ; les copies temporaires
//!   (réponse du Trousseau) sont effacées avant d'être libérées.

use std::{fmt, sync::mpsc};

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAError, LAPolicy};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use zeroize::Zeroizing;

/// Clé du coffre : effacée de la mémoire à la libération, de la lecture du Trousseau
/// jusqu'à son application au coffre.
pub type VaultKey = Zeroizing<[u8; 32]>;

/// Service du Trousseau pour l'enveloppe de la clé du coffre. À ne pas confondre avec
/// « Termoria », réservé aux mots de passe des sessions (`secrets.rs`).
pub const KEYCHAIN_SERVICE: &str = "fr.portunia.app.vaultkey";
pub const KEYCHAIN_ACCOUNT: &str = "vault";
/// Valeur du champ `biometric` de lock.json.
pub const KIND: &str = "touchid";

/// `errSecItemNotFound` (Security/SecBase.h).
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Échec de la vérification de présence. Toute variante est un refus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BiometricError {
    /// Annulé par l'utilisateur (Annuler, « Utiliser le mot de passe », interruption système).
    Cancelled,
    /// Pas de capteur, aucune empreinte enregistrée, ou code de l'appareil absent.
    NotAvailable,
    /// Trop d'essais : macOS exige le mot de passe de la session.
    LockedOut,
    /// Empreinte non reconnue.
    Failed,
    /// Réponse absente ou erreur inconnue (traitée comme un refus).
    Unknown,
}

impl fmt::Display for BiometricError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Cancelled => t!("Touch ID cancelled", "Touch ID annulé"),
            Self::NotAvailable => t!(
                "Touch ID is not available on this Mac",
                "Touch ID n'est pas disponible sur ce Mac"
            ),
            Self::LockedOut => t!(
                "Touch ID is locked: use the master password",
                "Touch ID est verrouillé : utilisez le mot de passe maître"
            ),
            Self::Failed => t!("Fingerprint not recognised", "Empreinte non reconnue"),
            Self::Unknown => t!("Touch ID check failed", "La vérification Touch ID a échoué"),
        })
    }
}

impl std::error::Error for BiometricError {}

/// Échec du déverrouillage biométrique : jamais de clé dans ce cas.
#[derive(Debug, PartialEq, Eq)]
pub enum UnlockError {
    Auth(BiometricError),
    /// Aucun élément dans le Trousseau (supprimé à la main ou jamais écrit).
    NoKey,
    /// Élément illisible ou de taille inattendue (le détail ne contient jamais la clé).
    Keychain(String),
}

impl fmt::Display for UnlockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auth(e) => e.fmt(f),
            Self::NoKey => f.write_str(t!("The key is no longer in the Keychain: unlock with the master password and enable Touch ID again", "La clé n'est plus dans le Trousseau : déverrouillez avec le mot de passe maître puis réactivez Touch ID")),
            Self::Keychain(detail) => write!(f, "{}: {detail}", t!("Keychain error", "Erreur du Trousseau")),
        }
    }
}

impl std::error::Error for UnlockError {}

/// Vérification de présence de l'utilisateur (Touch ID en production, faux dans les tests).
pub trait Authenticator {
    fn available(&self) -> bool;
    /// `Ok(())` uniquement si l'utilisateur est authentifié.
    fn authenticate(&self, reason: &str) -> Result<(), BiometricError>;
}

/// Enveloppe de la clé du coffre (Trousseau en production, mémoire dans les tests).
pub trait KeyStore {
    fn save(&self, key: &[u8; 32]) -> Result<(), String>;
    fn load(&self) -> Result<Option<VaultKey>, String>;
    /// Supprimer un élément absent n'est pas une erreur.
    fn delete(&self) -> Result<(), String>;
}

/// Authentifie puis relit la clé. La clé n'est lue QU'APRÈS `Ok(())` : c'est le seul chemin.
pub fn unlock_key(
    auth: &dyn Authenticator,
    store: &dyn KeyStore,
    reason: &str,
) -> Result<VaultKey, UnlockError> {
    if let Err(e) = auth.authenticate(reason) {
        return Err(UnlockError::Auth(e));
    }
    match store.load() {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err(UnlockError::NoKey),
        Err(detail) => Err(UnlockError::Keychain(detail)),
    }
}

// ---------- Trousseau ----------

/// Trousseau de la session (élément de mot de passe générique, ACL par défaut : l'application
/// qui crée l'élément y accède sans question).
pub struct KeychainStore {
    service: &'static str,
    account: &'static str,
}

impl KeychainStore {
    pub const fn vault() -> Self {
        Self {
            service: KEYCHAIN_SERVICE,
            account: KEYCHAIN_ACCOUNT,
        }
    }

    #[cfg(test)]
    const fn named(service: &'static str, account: &'static str) -> Self {
        Self { service, account }
    }
}

/// Détail d'une erreur du Trousseau (code et message système, jamais de donnée de l'élément).
fn describe(e: &security_framework::base::Error) -> String {
    format!("{} ({})", e.message().unwrap_or_default(), e.code())
}

impl KeyStore for KeychainStore {
    fn save(&self, key: &[u8; 32]) -> Result<(), String> {
        set_generic_password(self.service, self.account, key).map_err(|e| describe(&e))
    }

    fn load(&self) -> Result<Option<VaultKey>, String> {
        match get_generic_password(self.service, self.account) {
            Ok(bytes) => {
                // La réponse brute est effacée à la libération, quel que soit le résultat.
                let bytes = Zeroizing::new(bytes);
                let mut key: VaultKey = Zeroizing::new([0u8; 32]);
                if bytes.len() != key.len() {
                    return Err("unexpected size".to_string());
                }
                key.copy_from_slice(&bytes);
                Ok(Some(key))
            }
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(describe(&e)),
        }
    }

    fn delete(&self) -> Result<(), String> {
        match delete_generic_password(self.service, self.account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }
}

// ---------- Touch ID ----------

const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

/// Classe un code `LAError`. Tout code inconnu est un refus (`Unknown`).
fn classify(code: isize) -> BiometricError {
    if [
        LAError::UserCancel.0,
        LAError::UserFallback.0,
        LAError::SystemCancel.0,
        LAError::AppCancel.0,
    ]
    .contains(&code)
    {
        BiometricError::Cancelled
    } else if code == LAError::BiometryLockout.0 {
        BiometricError::LockedOut
    } else if [
        LAError::BiometryNotAvailable.0,
        LAError::BiometryNotEnrolled.0,
        LAError::PasscodeNotSet.0,
    ]
    .contains(&code)
    {
        BiometricError::NotAvailable
    } else if code == LAError::AuthenticationFailed.0 {
        BiometricError::Failed
    } else {
        BiometricError::Unknown
    }
}

/// Erreur d'un `NSError*` reçu par le bloc de réponse (nul = inconnue). Générique pour ne pas
/// nommer `NSError` (type de objc2-foundation, qui n'est pas une dépendance directe).
fn error_outcome(error: *mut NSError) -> BiometricError {
    // SAFETY: `error` est nul ou un NSError valide fourni par LocalAuthentication pour la durée du bloc.
    match unsafe { error.as_ref() } {
        Some(error) => classify(error.code()),
        None => BiometricError::Unknown,
    }
}

/// Touch ID réel. Exige un Mac avec capteur et au moins une empreinte enregistrée.
pub struct TouchId;

impl Authenticator for TouchId {
    fn available(&self) -> bool {
        // SAFETY: création d'un contexte et vérification préalable de la politique, sans effet de bord.
        unsafe { LAContext::new().canEvaluatePolicy_error(POLICY).is_ok() }
    }

    fn authenticate(&self, reason: &str) -> Result<(), BiometricError> {
        // SAFETY: le contexte reste vivant jusqu'à la réponse du bloc (recv ci-dessous).
        let context = unsafe { LAContext::new() };
        // SAFETY: vérification préalable de la politique, sans effet de bord.
        if let Err(e) = unsafe { context.canEvaluatePolicy_error(POLICY) } {
            return Err(match classify(e.code()) {
                BiometricError::Cancelled | BiometricError::Failed => BiometricError::NotAvailable,
                other => other,
            });
        }
        if reason.is_empty() {
            // LAContext lève une exception Objective-C sur un texte vide : refus plutôt que plantage.
            return Err(BiometricError::Unknown);
        }
        let text = NSString::from_str(reason);

        let (tx, rx) = mpsc::channel::<Result<(), BiometricError>>();
        let block = RcBlock::new(move |success: Bool, error: *mut NSError| {
            // Seul `success == YES` est un succès ; tout le reste est un refus.
            let outcome = if success.as_bool() {
                Ok(())
            } else {
                Err(error_outcome(error))
            };
            let _ = tx.send(outcome);
        });
        // SAFETY: le bloc de réponse n'emporte que l'émetteur du canal, qui est `Send`.
        unsafe {
            context.evaluatePolicy_localizedReason_reply(POLICY, &text, &block);
        }
        // Pas de réponse (bloc détruit) = refus.
        let outcome = rx.recv().unwrap_or(Err(BiometricError::Unknown));
        drop(block);
        outcome
    }
}

/// Texte affiché par macOS dans la boîte Touch ID.
pub fn unlock_reason() -> &'static str {
    t!(
        "Unlock the Portunia vault",
        "Déverrouiller le coffre Portunia"
    )
}

/// Texte de la boîte Touch ID quand l'utilisateur active le déverrouillage biométrique.
pub fn enable_reason() -> &'static str {
    t!(
        "Enable Portunia unlocking with Touch ID",
        "Activer le déverrouillage de Portunia par Touch ID"
    )
}

/// Mémorise qu'une disponibilité a été constatée. Seul un résultat POSITIF est conservé : le
/// matériel ne disparaît pas pendant la vie du processus, alors qu'une empreinte peut être
/// enregistrée pendant qu'il tourne (un « non » doit donc être reposé). Si toutes les empreintes
/// sont ensuite retirées, l'invite elle-même (`authenticate`) revérifie et refuse.
pub struct AvailabilityCache(std::sync::atomic::AtomicBool);

impl Default for AvailabilityCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AvailabilityCache {
    pub const fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    pub fn get(&self, probe: impl FnOnce() -> bool) -> bool {
        use std::sync::atomic::Ordering;
        if self.0.load(Ordering::Relaxed) {
            return true;
        }
        let available = probe();
        if available {
            self.0.store(true, Ordering::Relaxed);
        }
        available
    }
}

static TOUCH_ID_SEEN: AvailabilityCache = AvailabilityCache::new();

/// Touch ID est-il utilisable sur ce Mac ? Un seul `LAContext` créé une fois le succès constaté.
pub fn available() -> bool {
    TOUCH_ID_SEEN.get(|| TouchId.available())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct FakeAuth {
        result: Result<(), BiometricError>,
        calls: Cell<u32>,
    }

    impl FakeAuth {
        fn new(result: Result<(), BiometricError>) -> Self {
            Self {
                result,
                calls: Cell::new(0),
            }
        }
    }

    impl Authenticator for FakeAuth {
        fn available(&self) -> bool {
            true
        }
        fn authenticate(&self, _reason: &str) -> Result<(), BiometricError> {
            self.calls.set(self.calls.get() + 1);
            self.result
        }
    }

    #[derive(Default)]
    struct FakeStore {
        item: RefCell<Option<[u8; 32]>>,
        loads: Cell<u32>,
        fail_load: Cell<bool>,
    }

    impl KeyStore for FakeStore {
        fn save(&self, key: &[u8; 32]) -> Result<(), String> {
            *self.item.borrow_mut() = Some(*key);
            Ok(())
        }
        fn load(&self) -> Result<Option<VaultKey>, String> {
            self.loads.set(self.loads.get() + 1);
            if self.fail_load.get() {
                return Err("illisible".into());
            }
            Ok((*self.item.borrow()).map(Zeroizing::new))
        }
        fn delete(&self) -> Result<(), String> {
            *self.item.borrow_mut() = None;
            Ok(())
        }
    }

    const KEY: [u8; 32] = [7; 32];

    #[test]
    fn succes_rend_la_cle() {
        let store = FakeStore::default();
        store.save(&KEY).unwrap();
        let auth = FakeAuth::new(Ok(()));
        let key: VaultKey = unlock_key(&auth, &store, "raison").unwrap();
        assert_eq!(*key, KEY);
        assert_eq!(auth.calls.get(), 1);
    }

    #[test]
    fn tout_echec_ne_rend_jamais_de_cle_et_ne_lit_pas_le_trousseau() {
        let all = [
            BiometricError::Cancelled,
            BiometricError::NotAvailable,
            BiometricError::LockedOut,
            BiometricError::Failed,
            BiometricError::Unknown,
        ];
        for error in all {
            let store = FakeStore::default();
            store.save(&KEY).unwrap();
            let result = unlock_key(&FakeAuth::new(Err(error)), &store, "raison");
            assert_eq!(result.err(), Some(UnlockError::Auth(error)));
            assert_eq!(
                store.loads.get(),
                0,
                "le Trousseau n'est pas lu sans authentification ({error:?})"
            );
        }
    }

    #[test]
    fn element_absent_ou_illisible_donne_une_erreur() {
        let store = FakeStore::default();
        assert_eq!(
            unlock_key(&FakeAuth::new(Ok(())), &store, "r").err(),
            Some(UnlockError::NoKey)
        );
        store.save(&KEY).unwrap();
        store.fail_load.set(true);
        assert!(matches!(
            unlock_key(&FakeAuth::new(Ok(())), &store, "r"),
            Err(UnlockError::Keychain(_))
        ));
    }

    #[test]
    fn les_messages_ne_contiennent_pas_la_cle() {
        let store = FakeStore::default();
        store.save(&KEY).unwrap();
        store.fail_load.set(true);
        let text = unlock_key(&FakeAuth::new(Ok(())), &store, "r")
            .unwrap_err()
            .to_string();
        assert!(!text.contains("[7"), "{text}");
    }

    #[test]
    fn codes_laerror_classes_et_inconnu_refuse() {
        assert_eq!(classify(LAError::UserCancel.0), BiometricError::Cancelled);
        assert_eq!(classify(LAError::UserFallback.0), BiometricError::Cancelled);
        assert_eq!(classify(LAError::SystemCancel.0), BiometricError::Cancelled);
        assert_eq!(
            classify(LAError::BiometryLockout.0),
            BiometricError::LockedOut
        );
        assert_eq!(
            classify(LAError::BiometryNotEnrolled.0),
            BiometricError::NotAvailable
        );
        assert_eq!(
            classify(LAError::BiometryNotAvailable.0),
            BiometricError::NotAvailable
        );
        assert_eq!(
            classify(LAError::AuthenticationFailed.0),
            BiometricError::Failed
        );
        assert_eq!(classify(123_456), BiometricError::Unknown);
        assert_eq!(error_outcome(std::ptr::null_mut()), BiometricError::Unknown);
    }

    #[test]
    fn la_cle_rendue_est_dans_un_zeroizing() {
        // Le type même impose l'effacement à la libération (zeroize).
        fn assert_zeroizing(_: &Zeroizing<[u8; 32]>) {}
        let store = FakeStore::default();
        store.save(&KEY).unwrap();
        let key = unlock_key(&FakeAuth::new(Ok(())), &store, "r").unwrap();
        assert_zeroizing(&key);
        let loaded = store.load().unwrap().unwrap();
        assert_zeroizing(&loaded);
    }

    #[test]
    fn service_distinct_de_celui_des_secrets_de_session() {
        assert_eq!(KEYCHAIN_SERVICE, "fr.portunia.app.vaultkey");
        assert_eq!(KEYCHAIN_ACCOUNT, "vault");
        assert_ne!(KEYCHAIN_SERVICE, "Termoria");
    }

    /// Procédure manuelle : `cargo test -- --ignored trousseau_reel`. Écrit, relit puis supprime un
    /// élément de test dans le Trousseau de la session (peut afficher une demande d'accès).
    #[test]
    #[ignore = "touche le vrai Trousseau : à lancer à la main sur un Mac déverrouillé"]
    fn trousseau_reel_aller_retour_et_suppression() {
        let store = KeychainStore::named("fr.portunia.app.vaultkey.test", "vault-test");
        store.delete().unwrap();
        assert!(store.load().unwrap().is_none());
        store.save(&KEY).unwrap();
        assert_eq!(*store.load().unwrap().unwrap(), KEY);
        store.save(&[8; 32]).unwrap();
        assert_eq!(
            *store.load().unwrap().unwrap(),
            [8; 32],
            "écrase l'élément existant"
        );
        store.delete().unwrap();
        assert!(store.load().unwrap().is_none());
        store.delete().unwrap();
    }

    #[test]
    fn disponibilite_positive_calculee_une_seule_fois() {
        let cache = AvailabilityCache::new();
        let probes = Cell::new(0);
        let probe = || {
            probes.set(probes.get() + 1);
            true
        };
        assert!(cache.get(probe));
        assert!(cache.get(probe));
        assert!(cache.get(probe));
        assert_eq!(
            probes.get(),
            1,
            "un seul LAContext pour toute la vie du processus"
        );
    }

    /// Une empreinte peut être enregistrée pendant que l'application tourne : un résultat
    /// négatif ne doit jamais être mémorisé.
    #[test]
    fn disponibilite_negative_jamais_memorisee() {
        let cache = AvailabilityCache::new();
        let answers = RefCell::new(vec![true, false, false]);
        let probe = || answers.borrow_mut().pop().unwrap();
        assert!(!cache.get(probe), "pas d'empreinte au départ");
        assert!(!cache.get(probe));
        assert!(cache.get(probe), "empreinte enregistrée ensuite : détectée");
        assert!(
            cache.get(probe),
            "puis mémorisée (le sondage vide ne serait plus appelé)"
        );
    }

    #[test]
    fn raison_d_activation_en_francais_non_vide() {
        assert!(enable_reason().contains("Touch ID"));
    }

    /// Procédure manuelle : `cargo test -- --ignored touch_id_reel`, puis poser le doigt.
    #[test]
    #[ignore = "exige Touch ID et une action de l'utilisateur"]
    fn touch_id_reel() {
        assert!(TouchId.available(), "Touch ID doit être configuré");
        TouchId.authenticate(unlock_reason()).unwrap();
    }
}
