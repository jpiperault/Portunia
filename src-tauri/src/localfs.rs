//! Fichiers de ce PC : le volet gauche d'une session de fichiers (SFTP, FTP, S3).
//! Chemins Windows ou Unix ; le chemin vide désigne la liste des lecteurs (Windows) ou la racine (Unix).

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
    Ok(crate::platform::home_dir().map(|h| h.display().to_string()).unwrap_or_else(|| DEFAULT_ROOT.into()))
}

/// Point de départ quand le dossier personnel est inconnu.
#[cfg(windows)]
const DEFAULT_ROOT: &str = "C:\\";
#[cfg(not(windows))]
const DEFAULT_ROOT: &str = "/";

/// « %USERPROFILE%\Projets » ou « ~\Projets » → chemin complet.
fn expand(dir: &str) -> PathBuf {
    let home = crate::platform::home_dir().map(|h| h.display().to_string()).unwrap_or_default();
    expand_with(dir, &home)
}

fn expand_with(dir: &str, home: &str) -> PathBuf {
    let dir = dir.replace("%USERPROFILE%", home);
    match dir.strip_prefix('~') {
        Some(rest) => Path::new(home).join(rest.trim_start_matches(['\\', '/'])),
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
            permissions: hidden(&name, &meta).then_some(HIDDEN),
            name,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Marque « fichier caché » transmise à l'interface dans `permissions` (pas de droits Unix ici).
const HIDDEN: u32 = 0x8000_0000;

#[cfg(windows)]
fn hidden(_name: &str, meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

/// Sous Unix, un fichier est caché quand son nom commence par un point.
#[cfg(not(windows))]
fn hidden(name: &str, _meta: &fs::Metadata) -> bool {
    is_dot_file(name)
}

#[cfg(not(windows))]
fn is_dot_file(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// Unix : une seule « racine », le système de fichiers.
#[cfg(not(windows))]
fn drives() -> Vec<RemoteEntry> {
    vec![RemoteEntry { name: "/".into(), path: "/".into(), is_dir: true, is_link: false, size: 0, modified: None, permissions: None }]
}

#[cfg(windows)]
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
#[cfg(windows)]
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

/// Programme et arguments pour montrer un chemin : `open -R` (fichier) ou `open` (dossier) sous
/// macOS ; `xdg-open` sur le dossier (le parent d'un fichier) ailleurs. Le chemin reste un
/// argument distinct, jamais inséré dans une chaîne shell.
#[cfg(not(windows))]
fn reveal_invocation(path: &Path, is_dir: bool, macos: bool) -> (&'static str, Vec<std::ffi::OsString>) {
    use std::ffi::OsString;
    if macos {
        let mut args: Vec<OsString> = if is_dir { vec![] } else { vec!["-R".into()] };
        args.push(path.as_os_str().to_owned());
        return ("open", args);
    }
    let folder = if is_dir { path } else { path.parent().unwrap_or(path) };
    ("xdg-open", vec![folder.as_os_str().to_owned()])
}

/// Montre le fichier dans le Finder (sélectionné), ou ouvre le dossier.
#[cfg(not(windows))]
#[tauri::command]
pub fn local_reveal(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.unlocked()?;
    let path = validate_reveal_path(&path)?;
    let (program, args) = reveal_invocation(path, path.is_dir(), cfg!(target_os = "macos"));
    let mut child = std::process::Command::new(program).args(args).spawn().map_err(err)?;
    // `open` et `xdg-open` rendent la main aussitôt : on récolte le processus pour ne pas laisser de zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Chemin à montrer : absolu (un chemin relatif commençant par « - » serait pris pour une option)
/// et existant.
#[cfg(not(windows))]
fn validate_reveal_path(path: &str) -> CmdResult<&Path> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(t!("Give an absolute path", "Indiquez un chemin absolu").to_string());
    }
    if !path.exists() {
        return Err(t!(format!("{} does not exist", path.display()), format!("{} n'existe pas", path.display())));
    }
    Ok(path)
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

    #[test]
    fn tilde_et_variable_profil_pointent_vers_le_dossier_personnel() {
        assert_eq!(expand_with("~/Projets", "/Users/moi"), PathBuf::from("/Users/moi/Projets"));
        assert_eq!(expand_with("~\\Projets", "/Users/moi"), PathBuf::from("/Users/moi/Projets"));
        assert_eq!(expand_with("/etc", "/Users/moi"), PathBuf::from("/etc"));
        assert_eq!(expand_with("%USERPROFILE%/x", "/Users/moi"), PathBuf::from("/Users/moi/x"));
    }

    #[cfg(not(windows))]
    #[test]
    fn fichiers_caches_unix() {
        assert!(is_dot_file(".ssh"));
        assert!(!is_dot_file("notes.txt"));
        assert!(!is_dot_file("."));
        assert!(!is_dot_file(".."));
        let dir = std::env::temp_dir().join(format!("portunia-hidden-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".secret"), "x").unwrap();
        fs::write(dir.join("visible"), "x").unwrap();
        let entries = list(dir.display().to_string()).unwrap();
        let flag = |name: &str| entries.iter().find(|e| e.name == name).unwrap().permissions;
        assert_eq!(flag(".secret"), Some(HIDDEN));
        assert_eq!(flag("visible"), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn reveler_sans_chaine_shell() {
        use std::ffi::OsString;
        let file = Path::new("/Users/moi/a b; rm -rf ~ x.txt");
        assert_eq!(reveal_invocation(file, false, true), ("open", vec![OsString::from("-R"), file.as_os_str().to_owned()]));
        let dir = Path::new("/Users/moi/Dossier");
        assert_eq!(reveal_invocation(dir, true, true), ("open", vec![dir.as_os_str().to_owned()]));
        assert_eq!(reveal_invocation(file, false, false), ("xdg-open", vec![OsString::from("/Users/moi")]));
        assert_eq!(reveal_invocation(dir, true, false), ("xdg-open", vec![dir.as_os_str().to_owned()]));
    }

    #[cfg(not(windows))]
    #[test]
    fn la_racine_unix_remplace_la_liste_des_lecteurs() {
        assert_eq!(drives().iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["/"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn valide_le_chemin_a_reveler() {
        assert!(validate_reveal_path("relatif/x").is_err());
        assert!(validate_reveal_path("-R").is_err());
        let err = validate_reveal_path("/nonexistent/portunia/x.txt").unwrap_err();
        assert!(err.contains("/nonexistent/portunia/x.txt"), "{err}");
        assert_eq!(validate_reveal_path("/").unwrap(), Path::new("/"));
    }
}
