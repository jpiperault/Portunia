//! Fichiers de ce PC : le volet gauche d'une session de fichiers (SFTP, FTP, S3).
//! Chemins Windows ; le chemin vide désigne la liste des lecteurs.

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use tauri::State;

use crate::commands::{err, AppState, CmdResult};
use crate::connector::RemoteEntry;

/// Dossier utilisateur, ou celui demandé s'il existe.
#[tauri::command]
pub fn local_home(state: State<'_, AppState>, start: Option<String>) -> CmdResult<String> {
    state.unlocked()?;
    if let Some(dir) = start.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        let expanded = expand(&dir);
        if expanded.is_dir() {
            return Ok(expanded.display().to_string());
        }
    }
    Ok(std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into()))
}

/// « %USERPROFILE%\Projets » ou « ~\Projets » → chemin complet.
fn expand(dir: &str) -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let dir = dir.replace("%USERPROFILE%", &home);
    match dir.strip_prefix('~') {
        Some(rest) => Path::new(&home).join(rest.trim_start_matches(['\\', '/'])),
        None => PathBuf::from(dir),
    }
}

/// Liste d'un dossier de ce PC : refusée tant que Portunia est verrouillé, comme les fichiers du serveur.
#[tauri::command]
pub fn local_list(state: State<'_, AppState>, path: String) -> CmdResult<Vec<RemoteEntry>> {
    state.unlocked()?;
    list(path)
}

fn list(path: String) -> CmdResult<Vec<RemoteEntry>> {
    if path.is_empty() {
        return Ok(drives());
    }
    let dir = fs::read_dir(&path).map_err(|e| t!(format!("Cannot open {path}: {e}"), format!("Ouverture impossible de {path} : {e}")))?;
    let mut entries = Vec::new();
    for entry in dir.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        // Les liens vers des dossiers (jonctions) s'ouvrent comme des dossiers.
        let meta = fs::metadata(entry.path()).or_else(|_| entry.metadata());
        let Ok(meta) = meta else { continue };
        entries.push(RemoteEntry {
            path: entry.path().display().to_string(),
            is_dir: meta.is_dir(),
            is_link: kind.is_symlink(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()),
            permissions: hidden(&meta).then_some(HIDDEN),
            name,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Marque « fichier caché » transmise à l'interface dans `permissions` (pas de droits Unix ici).
const HIDDEN: u32 = 0x8000_0000;

#[cfg(windows)]
fn hidden(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn hidden(_meta: &fs::Metadata) -> bool {
    false
}

fn drives() -> Vec<RemoteEntry> {
    (b'A'..=b'Z')
        .map(|letter| format!("{}:\\", letter as char))
        .filter(|root| Path::new(root).is_dir())
        .map(|root| RemoteEntry {
            name: root.trim_end_matches('\\').to_string(),
            path: root,
            is_dir: true,
            is_link: false,
            size: 0,
            modified: None,
            permissions: None,
        })
        .collect()
}

#[tauri::command]
pub fn local_mkdir(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.unlocked()?;
    fs::create_dir(&path).map_err(err)
}

#[tauri::command]
pub fn local_rename(state: State<'_, AppState>, from: String, to: String) -> CmdResult<()> {
    state.unlocked()?;
    rename(from, to)
}

fn rename(from: String, to: String) -> CmdResult<()> {
    if Path::new(&to).exists() {
        return Err(t!(format!("{to} already exists"), format!("{to} existe déjà")));
    }
    fs::rename(&from, &to).map_err(err)
}

/// Montre le fichier dans l'Explorateur Windows (sélectionné), ou ouvre le dossier.
#[tauri::command]
pub fn local_reveal(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.unlocked()?;
    let mut command = std::process::Command::new("explorer.exe");
    if Path::new(&path).is_dir() {
        command.arg(&path);
    } else {
        command.arg(format!("/select,{path}"));
    }
    command.spawn().map(|_| ()).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liste_un_dossier() {
        let dir = std::env::temp_dir().join(format!("portunia-localfs-{}", std::process::id()));
        fs::create_dir_all(dir.join("sous")).unwrap();
        fs::write(dir.join("b.txt"), "abc").unwrap();
        let list = list(dir.display().to_string()).unwrap();
        assert_eq!(list.iter().map(|e| (e.name.as_str(), e.is_dir, e.size)).collect::<Vec<_>>(), [("sous", true, 0), ("b.txt", false, 3)]);
        rename(dir.join("b.txt").display().to_string(), dir.join("c.txt").display().to_string()).unwrap();
        assert!(rename(dir.join("c.txt").display().to_string(), dir.join("sous").display().to_string()).is_err());
        fs::remove_dir_all(&dir).unwrap();
        // Les lettres de lecteur n'existent que sous Windows.
        #[cfg(windows)]
        assert!(!drives().is_empty());
    }
}
