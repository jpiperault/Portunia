//! Éditions de Portunia (Gratuit, Pro, Équipes) et vérification des licences.
//!
//! Point de contrôle unique : toute fonctionnalité payante appelle
//! `License::allows(Feature::…)`. Une licence est un petit texte JSON signé
//! (Ed25519) par l'éditeur ; elle se vérifie hors ligne, sans serveur.

use std::{fs, path::PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};

/// Avant la mise en vente, toutes les fonctionnalités Pro et Équipes sont
/// débloquées. Passer à `false` le jour du lancement commercial.
pub const PREVIEW: bool = true;

/// Clé publique de l'éditeur (base64, 32 octets). Générée avec `license-tool keygen`.
const PUBLIC_KEY: &str = "CLE_PUBLIQUE_LICENCES_A_GENERER";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    Free,
    Pro,
    Team,
}

/// Fonctionnalités réservées à une édition payante.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    /// Enregistrement et rejeu des sessions.
    SessionRecording,
    /// Alertes de la supervision (notifications quand un serveur tombe).
    MonitoringAlerts,
    /// Synchronisation chiffrée entre PC (à venir).
    Sync,
    /// Coffres de mots de passe externes (à venir).
    Vaults,
    /// Espaces partagés d'équipe (à venir).
    TeamSpaces,
    /// Tableau de bord d'un serveur (CPU, mémoire, disques…).
    ServerDashboard,
    /// Commande lancée sur plusieurs serveurs.
    MultiExec,
    /// Conteneurs Docker et Kubernetes.
    Containers,
    /// Stockage objet S3.
    CloudStorage,
    /// Administration d'une Gate depuis Portunia.
    GateAdmin,
}

impl Feature {
    pub const ALL: [Feature; 10] = [
        Feature::SessionRecording,
        Feature::MonitoringAlerts,
        Feature::Sync,
        Feature::Vaults,
        Feature::TeamSpaces,
        Feature::ServerDashboard,
        Feature::MultiExec,
        Feature::Containers,
        Feature::CloudStorage,
        Feature::GateAdmin,
    ];

    /// Édition minimale qui débloque la fonctionnalité.
    pub fn edition(self) -> Edition {
        match self {
            Feature::TeamSpaces | Feature::GateAdmin => Edition::Team,
            _ => Edition::Pro,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Feature::SessionRecording => t!("Session recording", "Enregistrement des sessions"),
            Feature::MonitoringAlerts => t!("Monitoring alerts", "Alertes de supervision"),
            Feature::Sync => t!("Encrypted sync between PCs", "Synchronisation chiffrée entre PC"),
            Feature::Vaults => t!("Password vaults (Bitwarden, KeePass…)", "Coffres de mots de passe (Bitwarden, KeePass…)"),
            Feature::TeamSpaces => t!("Shared team spaces", "Espaces partagés d'équipe"),
            Feature::ServerDashboard => t!("Server dashboard", "Tableau de bord des serveurs"),
            Feature::MultiExec => t!("Command on several servers", "Commande sur plusieurs serveurs"),
            Feature::Containers => t!("Docker and Kubernetes containers", "Conteneurs Docker et Kubernetes"),
            Feature::CloudStorage => t!("S3 storage", "Stockage S3"),
            Feature::GateAdmin => t!("Gate administration", "Administration des Gates"),
        }
    }
}

/// Contenu signé d'une licence.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LicenseData {
    pub id: String,
    pub name: String,
    pub email: String,
    pub edition: Edition,
    /// Nombre de postes (Équipes).
    #[serde(default = "one")]
    pub seats: u32,
    /// Date d'émission (AAAA-MM-JJ).
    pub issued: String,
    /// Fin des mises à jour incluses ou de l'abonnement (AAAA-MM-JJ), si limitée.
    #[serde(default)]
    pub expires: Option<String>,
}

fn one() -> u32 {
    1
}

/// Fichier de licence : les données et leur signature.
#[derive(Serialize, Deserialize)]
struct SignedLicense {
    data: LicenseData,
    signature: String,
}

pub struct License {
    path: PathBuf,
    current: Option<LicenseData>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureStatus {
    feature: Feature,
    label: &'static str,
    edition: Edition,
    allowed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    edition: Edition,
    preview: bool,
    license: Option<LicenseData>,
    expired: bool,
    features: Vec<FeatureStatus>,
}

/// Date du jour au format AAAA-MM-JJ (UTC), sans dépendance de calendrier.
fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Algorithme de Howard Hinnant (jours depuis 1970 → date civile).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Vérifie la signature d'une licence et renvoie ses données.
pub fn verify(text: &str, public_key_b64: &str) -> Result<LicenseData> {
    let signed: SignedLicense = serde_json::from_str(text.trim()).context(t!("This text is not a Portunia licence", "Ce texte n'est pas une licence Portunia"))?;
    let key = B64.decode(public_key_b64).map_err(|_| anyhow!(t!("Invalid licence public key", "Clé publique de licence invalide")))?;
    let signature = B64.decode(&signed.signature).map_err(|_| anyhow!(t!("Unreadable licence signature", "Signature de licence illisible")))?;
    let message = serde_json::to_vec(&signed.data)?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&message, &signature)
        .map_err(|_| anyhow!(t!("Invalid licence: wrong signature", "Licence invalide : signature incorrecte")))?;
    Ok(signed.data)
}

impl License {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("license.json");
        let current = fs::read_to_string(&path).ok().and_then(|t| verify(&t, PUBLIC_KEY).ok());
        Self { path, current }
    }

    fn expired(&self) -> bool {
        match self.current.as_ref().and_then(|l| l.expires.as_deref()) {
            Some(end) => today().as_str() > end,
            None => false,
        }
    }

    /// Édition en vigueur. Une licence Pro expirée garde l'édition Pro
    /// (licence perpétuelle : seules les nouvelles versions ne sont plus incluses).
    pub fn edition(&self) -> Edition {
        match &self.current {
            Some(l) if l.edition == Edition::Team && self.expired() => Edition::Free,
            Some(l) => l.edition,
            None => Edition::Free,
        }
    }

    /// Point de contrôle unique des fonctionnalités payantes.
    pub fn allows(&self, feature: Feature) -> bool {
        PREVIEW || self.edition() >= feature.edition()
    }

    pub fn require(&self, feature: Feature) -> Result<()> {
        if self.allows(feature) {
            Ok(())
        } else {
            bail!("{}", t!(format!("« {} » is reserved for the {} edition", feature.label(), match feature.edition() {
                Edition::Team => t!("Teams", "Équipes"),
                _ => "Pro",
            }), format!("« {} » est réservé à l'édition {}", feature.label(), match feature.edition() {
                Edition::Team => t!("Teams", "Équipes"),
                _ => "Pro",
            })))
        }
    }

    pub fn status(&self) -> LicenseStatus {
        LicenseStatus {
            edition: self.edition(),
            preview: PREVIEW,
            license: self.current.clone(),
            expired: self.expired(),
            features: Feature::ALL
                .iter()
                .map(|&f| FeatureStatus { feature: f, label: f.label(), edition: f.edition(), allowed: self.allows(f) })
                .collect(),
        }
    }

    pub fn activate(&mut self, text: &str) -> Result<()> {
        let data = verify(text, PUBLIC_KEY)?;
        fs::write(&self.path, text.trim()).context(t!("Cannot save the licence", "Impossible d'enregistrer la licence"))?;
        self.current = Some(data);
        Ok(())
    }

    pub fn remove(&mut self) -> Result<()> {
        let _ = fs::remove_file(&self.path);
        self.current = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{rand::SystemRandom, signature::{Ed25519KeyPair, KeyPair}};

    fn signed(edition: Edition, expires: Option<&str>) -> (String, String) {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let data = LicenseData {
            id: "L-1".into(),
            name: "Test".into(),
            email: "test@example.com".into(),
            edition,
            seats: 1,
            issued: "2026-10-24".into(),
            expires: expires.map(String::from),
        };
        let signature = B64.encode(pair.sign(&serde_json::to_vec(&data).unwrap()).as_ref());
        let text = serde_json::to_string(&SignedLicense { data, signature }).unwrap();
        (text, B64.encode(pair.public_key().as_ref()))
    }

    #[test]
    fn licence_valide_acceptee() {
        let (text, key) = signed(Edition::Pro, None);
        assert_eq!(verify(&text, &key).unwrap().edition, Edition::Pro);
    }

    #[test]
    fn licence_modifiee_refusee() {
        let (text, key) = signed(Edition::Pro, None);
        let forged = text.replace("\"pro\"", "\"team\"");
        assert!(verify(&forged, &key).is_err());
    }

    #[test]
    fn autre_cle_refusee() {
        let (text, _) = signed(Edition::Pro, None);
        let (_, other_key) = signed(Edition::Pro, None);
        assert!(verify(&text, &other_key).is_err());
    }

    /// Licence produite par `tools/license-tool` avec une clé de TEST (pas la clé de vente) :
    /// garantit que l'outil vendeur et Portunia parlent le même format.
    #[test]
    fn licence_de_l_outil_vendeur() {
        let key = "2YHQHCTM2oI1vUVzoUj8aOy2vsSftD3lTQozieBTZ9I=";
        let text = r#"{"data":{"id":"TRM-TEST","name":"Client Test","email":"client@example.com","edition":"pro","seats":1,"issued":"2026-10-23","expires":"2027-10-24"},"signature":"hdHYZfJnNWqwss8aPSYoOdf7j5ZTYIC3hGpu/BXcHnC01KBPDUDzdEQKWdHcK5GQ/LP5rOLmT9SkF/B9KXi6Bw=="}"#;
        let data = verify(text, key).unwrap();
        assert_eq!((data.edition, data.email.as_str(), data.expires.as_deref()), (Edition::Pro, "client@example.com", Some("2027-10-24")));
    }

    #[test]
    fn date_du_jour_plausible() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert!(t.as_str() >= "2024-01-01");
    }

    #[test]
    fn editions_ordonnees() {
        assert!(Edition::Team > Edition::Pro && Edition::Pro > Edition::Free);
        assert_eq!(Feature::TeamSpaces.edition(), Edition::Team);
    }
}
