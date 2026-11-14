//! Extension « Reprise des transferts » (Pro) : un téléchargement ou un envoi interrompu
//! (réseau coupé, session fermée) repart d'où il s'était arrêté, au lieu de tout recommencer.
//!
//! Téléchargement : la partie reçue est gardée à côté du fichier (« rapport.pdf.partiel ») par
//! le connecteur ; la reprise la complète, puis lui donne son vrai nom. Envoi : la reprise lit la
//! taille du fichier sur le serveur et envoie la suite. Seuls les protocoles qui savent se placer
//! dans un fichier (SFTP) reprennent ; les autres le disent.

use std::{path::PathBuf, sync::Arc};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connector::{partial_path, BoxFuture, Progress};
use crate::extension::{args, reply, unknown, ExtManifest, Extension, Host};
use crate::license::Feature;

pub struct Resume;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    connection_id: String,
    remote: String,
    local: String,
    /// Date du serveur (secondes Unix), gardée sur la copie comme au téléchargement ordinaire.
    #[serde(default)]
    modified: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    connection_id: String,
    local: String,
    remote: String,
}

#[derive(Deserialize)]
struct Partial {
    local: String,
}

#[derive(Serialize)]
struct PartialInfo {
    /// Octets déjà reçus (0 : rien à reprendre).
    have: u64,
}

fn progress_to(host: &dyn Host) -> Result<Progress> {
    let emit = host.events()?;
    Ok(Arc::new(move |done, total| emit(json!({ "done": done, "total": total }))))
}

impl Extension for Resume {
    fn manifest(&self) -> ExtManifest {
        ExtManifest {
            id: "transfers",
            name: t!("Resume interrupted transfers", "Reprise des transferts interrompus").into(),
            feature: Some(Feature::TransferResume),
            // Savoir ce qui reste à reprendre est permis sans licence.
            free: &["partial"],
        }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, a: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "partial" => {
                    let Partial { local } = args(a)?;
                    let have = std::fs::metadata(partial_path(&PathBuf::from(local))).map(|m| m.len()).unwrap_or(0);
                    reply(PartialInfo { have })
                }
                "download" => {
                    let d: Download = args(a)?;
                    let files = host.files(&d.connection_id)?;
                    let local = PathBuf::from(&d.local);
                    let have = std::fs::metadata(partial_path(&local)).map(|m| m.len()).unwrap_or(0);
                    files.download_from(d.remote, local.clone(), have, progress_to(host)?).await?;
                    if let Some(secs) = d.modified {
                        let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
                        let _ = std::fs::File::options().write(true).open(&local).and_then(|f| f.set_modified(time));
                    }
                    reply(json!({ "repris": have }))
                }
                "upload" => {
                    let u: Upload = args(a)?;
                    let files = host.files(&u.connection_id)?;
                    // Taille déjà sur le serveur : lue dans son dossier.
                    let (dir, name) = u.remote.rsplit_once('/').map(|(d, n)| (if d.is_empty() { "/".to_string() } else { d.to_string() }, n.to_string())).unwrap_or((".".into(), u.remote.clone()));
                    let have = files.list(dir).await.ok().and_then(|l| l.into_iter().find(|e| e.name == name && !e.is_dir).map(|e| e.size)).unwrap_or(0);
                    files.upload_from(PathBuf::from(&u.local), u.remote, have, progress_to(host)?).await?;
                    reply(json!({ "repris": have }))
                }
                _ => Err(unknown("transfers", method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nom_du_fichier_partiel() {
        assert_eq!(partial_path(std::path::Path::new("/tmp/rapport.pdf")), PathBuf::from("/tmp/rapport.pdf.partiel"));
    }
}
