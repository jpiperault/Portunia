//! Assistant de clés SSH : liste des clés de ~/.ssh, création (Ed25519 ou RSA),
//! installation de la clé publique sur un serveur par une connexion ouverte.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use russh::keys::{
    ssh_key::{rand_core::CryptoRng, LineEnding},
    Algorithm, HashAlg, PrivateKey, PublicKey,
};
use serde::Serialize;

use crate::connector::RemoteExec;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// Nom du fichier (id_ed25519…).
    pub name: String,
    /// Chemin de la clé privée.
    pub path: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: String,
    /// Ligne à copier dans authorized_keys.
    pub public: String,
    /// Protégée par une phrase secrète.
    pub encrypted: bool,
}

pub fn ssh_dir() -> Result<PathBuf> {
    let home = std::env::var_os("USERPROFILE").ok_or_else(|| anyhow!(t!("Home folder not found", "Dossier personnel introuvable")))?;
    Ok(PathBuf::from(home).join(".ssh"))
}

/// Clés de ~/.ssh : chaque fichier .pub accompagné de sa clé privée.
pub fn list() -> Result<Vec<KeyInfo>> {
    let dir = ssh_dir()?;
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut keys: Vec<KeyInfo> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()?.to_str()? != "pub" {
                return None;
            }
            let private = path.with_extension("");
            if private.is_file() { info(&private).ok() } else { None }
        })
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

fn info(private: &Path) -> Result<KeyInfo> {
    let public_text = fs::read_to_string(private.with_extension("pub"))?;
    let public = PublicKey::from_openssh(public_text.trim())?;
    let encrypted = fs::read_to_string(private)
        .ok()
        .and_then(|t| PrivateKey::from_openssh(t).ok())
        .map(|k| k.is_encrypted())
        .unwrap_or(false);
    Ok(KeyInfo {
        name: private.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(),
        path: private.display().to_string(),
        algorithm: algorithm_label(&public.algorithm()),
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        comment: public.comment().to_string(),
        public: public_text.trim().to_string(),
        encrypted,
    })
}

fn algorithm_label(alg: &Algorithm) -> String {
    match alg {
        Algorithm::Ed25519 => "Ed25519".into(),
        Algorithm::Rsa { .. } => "RSA".into(),
        Algorithm::Ecdsa { curve } => format!("ECDSA {curve}"),
        other => other.as_str().to_string(),
    }
}

/// Nom de fichier sûr : lettres, chiffres, point, tiret, souligné.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Crée une paire de clés dans ~/.ssh. Refuse d'écraser une clé existante.
pub fn generate(name: &str, kind: &str, comment: &str, passphrase: Option<&str>) -> Result<KeyInfo> {
    generate_in(&ssh_dir()?, name, kind, comment, passphrase, &mut rand::rng())
}

fn generate_in(
    dir: &Path,
    name: &str,
    kind: &str,
    comment: &str,
    passphrase: Option<&str>,
    rng: &mut impl CryptoRng,
) -> Result<KeyInfo> {
    if !valid_name(name) {
        bail!(t!("Invalid file name: letters, digits, « . », « - » and « _ » only", "Nom de fichier invalide : lettres, chiffres, « . », « - » et « _ » uniquement"));
    }
    let private_path = dir.join(name);
    let public_path = dir.join(format!("{name}.pub"));
    if private_path.exists() || public_path.exists() {
        bail!("{}", t!(format!("A key « {name} » already exists in {}", dir.display()), format!("Une clé « {name} » existe déjà dans {}", dir.display())));
    }
    let algorithm = match kind {
        "ed25519" => Algorithm::Ed25519,
        "rsa" => Algorithm::Rsa { hash: None },
        other => bail!("{}", t!(format!("Unknown key type: {other}"), format!("Type de clé inconnu : {other}"))),
    };
    let mut key = PrivateKey::random(rng, algorithm).context(t!("Cannot create the key", "Création de la clé impossible"))?;
    key.set_comment(clean_comment(comment));
    let public = key.public_key().to_openssh()?;
    if let Some(pass) = passphrase.filter(|p| !p.is_empty()) {
        key = key.encrypt(rng, pass).map_err(|e| anyhow!("{}", t!(format!("Cannot encrypt the key: {e}"), format!("Chiffrement de la clé impossible : {e}"))))?;
    }
    let private = key.to_openssh(LineEnding::LF)?;
    fs::create_dir_all(dir)?;
    fs::write(&private_path, private.as_bytes())?;
    fs::write(&public_path, format!("{public}\n"))?;
    info(&private_path)
}

/// Commentaire sans caractères gênants pour un shell (il finit dans une commande).
fn clean_comment(comment: &str) -> String {
    comment
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "@._- ".contains(*c))
        .take(80)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Ligne de clé publique acceptée : « type base64 [commentaire] », sans caractère spécial.
fn safe_public_line(line: &str) -> Option<String> {
    let line = line.trim();
    let mut parts = line.splitn(3, ' ');
    let (kind, data) = (parts.next()?, parts.next()?);
    let comment = parts.next().unwrap_or("");
    let ok = kind.chars().all(|c| c.is_ascii_alphanumeric() || "-@.".contains(c))
        && data.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c))
        && comment == clean_comment(comment);
    (ok && PublicKey::from_openssh(line).is_ok()).then(|| line.to_string())
}

/// Résultat de l'installation.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Installed {
    Added,
    AlreadyThere,
}

/// Commande POSIX : ajoute la clé à ~/.ssh/authorized_keys si elle n'y est pas, droits corrigés.
fn install_command(line: &str) -> String {
    let file = "~/.ssh/authorized_keys";
    [
        "umask 077".to_string(),
        format!("mkdir -p ~/.ssh && touch {file} && chmod 700 ~/.ssh && chmod 600 {file} || exit 1"),
        format!("if grep -qxF '{line}' {file}; then echo PORTUNIA_DEJA; exit 0; fi"),
        // Dernière ligne sans retour à la ligne : on en ajoute un avant la clé.
        format!("if [ -s {file} ] && [ -n \"$(tail -c1 {file})\" ]; then echo >> {file}; fi"),
        format!("echo '{line}' >> {file} && echo PORTUNIA_AJOUT"),
    ]
    .join("; ")
}

pub async fn install(exec: &dyn RemoteExec, public: &str) -> Result<Installed> {
    let line = safe_public_line(public).ok_or_else(|| anyhow!(t!("Unreadable public key", "Clé publique illisible")))?;
    let out = exec.run(install_command(&line)).await?;
    if out.stdout.contains("PORTUNIA_DEJA") {
        Ok(Installed::AlreadyThere)
    } else if out.stdout.contains("PORTUNIA_AJOUT") {
        Ok(Installed::Added)
    } else {
        let code = out.status.map(|c| format!(" (code {c})")).unwrap_or_default();
        let detail = format!("{}{code}", out.stderr.trim());
        let detail = if detail.is_empty() { String::new() } else { format!(" : {detail}") };
        bail!(
            "{}",
            t!(
                format!(
                    "Installation failed{detail}.\nThe server must be a Unix-like system (Linux, BSD, macOS). \
                     On Windows, add the key to C:\\Users\\<account>\\.ssh\\authorized_keys \
                     (administrators: C:\\ProgramData\\ssh\\administrators_authorized_keys)."
                ),
                format!(
                    "Installation impossible{detail}.\nLe serveur doit être un système de type Unix (Linux, BSD, macOS). \
                     Sous Windows, ajoutez la clé à C:\\Users\\<compte>\\.ssh\\authorized_keys \
                     (administrateurs : C:\\ProgramData\\ssh\\administrators_authorized_keys)."
                )
            )
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cree_une_cle_chiffree_et_la_relit() {
        let dir = std::env::temp_dir().join(format!("portunia-keys-{}", uuid::Uuid::new_v4()));
        let info = generate_in(&dir, "id_test", "ed25519", "julien@PC;rm -rf", Some("phrase"), &mut rand::rng()).unwrap();
        assert_eq!(info.algorithm, "Ed25519");
        assert!(info.encrypted);
        assert_eq!(info.comment, "julien@PCrm -rf");
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert!(safe_public_line(&info.public).is_some());
        // Relecture avec la phrase secrète
        let text = fs::read_to_string(dir.join("id_test")).unwrap();
        assert!(PrivateKey::from_openssh(text).unwrap().decrypt("phrase").is_ok());
        // Pas d'écrasement, pas de chemin
        assert!(generate_in(&dir, "id_test", "ed25519", "", None, &mut rand::rng()).is_err());
        assert!(generate_in(&dir, "../x", "ed25519", "", None, &mut rand::rng()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "lent en debug : cargo test --release -- --ignored"]
    fn cree_une_cle_rsa() {
        let dir = std::env::temp_dir().join(format!("portunia-keys-{}", uuid::Uuid::new_v4()));
        let info = generate_in(&dir, "id_rsa", "rsa", "", None, &mut rand::rng()).unwrap();
        assert_eq!(info.algorithm, "RSA");
        assert!(!info.encrypted);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuse_les_lignes_dangereuses() {
        assert!(safe_public_line("ssh-ed25519 AAAA' ; rm -rf ~ '").is_none());
        assert!(safe_public_line("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl x'y").is_none());
        let cmd = install_command("ssh-ed25519 AAAA test");
        assert!(cmd.contains("grep -qxF 'ssh-ed25519 AAAA test'"));
    }
}
