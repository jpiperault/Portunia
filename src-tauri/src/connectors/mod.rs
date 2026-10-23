//! Extensions intégrées. Chaque fichier est un protocole indépendant.

pub mod forward;
pub mod rdp;
pub mod serial;
pub mod sftp;
pub mod ssh;
pub mod telnet;
pub mod web;

use anyhow::{bail, Result};

/// Refuse les retours à la ligne, qui permettraient d'injecter des réglages
/// dans un fichier de configuration généré.
pub fn single_line(value: &str, label: &str) -> Result<()> {
    if value.contains(['\r', '\n']) {
        bail!("{label} ne doit pas contenir de retour à la ligne");
    }
    Ok(())
}
