//! Transferts de dossiers entiers et édition de fichiers distants, construits
//! sur le contrat `RemoteFiles` : valables pour toute extension qui le fournit.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use anyhow::{Context, Result};

use crate::connector::{Progress, RemoteFiles};

/// Caractères interdits dans un nom de fichier Windows.
pub fn windows_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        return "_".into();
    }
    // Noms réservés de Windows (CON, NUL, COM1, LPT1…), même suivis d'une extension.
    let stem = trimmed.split('.').next().unwrap_or("").trim_end().to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved { format!("_{trimmed}") } else { trimmed }
}

/// Extensions que Windows exécute (ou installe, ou monte) au lieu de les ouvrir dans un éditeur :
/// « Modifier » ne doit jamais lancer un programme venu d'un serveur.
const RUNS_WHEN_OPENED: &[&str] = &[
    "exe", "com", "scr", "pif", "cpl", "msi", "msp", "msc", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf",
    "wsh", "hta", "lnk", "url", "reg", "jar", "appref-ms", "application", "gadget", "inf", "scf", "settingcontent-ms",
    "library-ms", "search-ms", "diagcab", "chm", "iso", "img", "vhd", "vhdx", "msix", "appx", "appinstaller", "xll",
];

/// Le fichier s'exécuterait si on l'ouvrait avec son application par défaut.
pub fn runs_when_opened(name: &str) -> bool {
    let lower = name.trim_end_matches(['.', ' ']).to_lowercase();
    lower.rsplit_once('.').is_some_and(|(_, ext)| RUNS_WHEN_OPENED.contains(&ext))
}

fn remote_join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

/// Progression cumulée sur plusieurs fichiers.
fn offset(progress: &Progress, base: u64, total: u64) -> Progress {
    let p = progress.clone();
    Arc::new(move |done, _| p(base + done, total))
}

/// Télécharge un dossier distant et tout son contenu dans `local`.
pub async fn download_tree(files: &dyn RemoteFiles, remote: &str, local: &Path, progress: Progress) -> Result<usize> {
    let mut stack = vec![(remote.to_string(), local.to_path_buf())];
    let mut jobs = Vec::new();
    let mut total = 0u64;
    while let Some((dir, target)) = stack.pop() {
        tokio::fs::create_dir_all(&target).await.with_context(|| format!("Création impossible : {}", target.display()))?;
        for entry in files.list(dir).await? {
            let path = target.join(windows_name(&entry.name));
            if entry.is_dir {
                // Les liens vers des dossiers ne sont pas suivis (risque de boucle).
                if !entry.is_link {
                    stack.push((entry.path, path));
                }
            } else {
                total += entry.size;
                jobs.push((entry.path, path, entry.size));
            }
        }
    }
    let count = jobs.len();
    let mut done = 0u64;
    for (remote_file, local_file, size) in jobs {
        files.download(remote_file, local_file, offset(&progress, done, total)).await?;
        done += size;
    }
    progress(done, total.max(done));
    Ok(count)
}

/// Envoie un dossier local et tout son contenu dans le dossier distant `remote_parent`.
pub async fn upload_tree(files: &dyn RemoteFiles, local: &Path, remote_parent: &str, progress: Progress) -> Result<usize> {
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "dossier".into());
    let root = remote_join(remote_parent, &name);
    let mut dirs = vec![(local.to_path_buf(), root.clone())];
    let mut jobs = Vec::new();
    let mut total = 0u64;
    let mut index = 0;
    while index < dirs.len() {
        let (dir, remote_dir) = dirs[index].clone();
        index += 1;
        let mut entries = tokio::fs::read_dir(&dir).await.with_context(|| format!("Lecture impossible : {}", dir.display()))?;
        while let Some(entry) = entries.next_entry().await? {
            let meta = entry.metadata().await?;
            let target = remote_join(&remote_dir, &entry.file_name().to_string_lossy());
            if meta.is_dir() {
                dirs.push((entry.path(), target));
            } else if meta.is_file() {
                total += meta.len();
                jobs.push((entry.path(), target, meta.len()));
            }
        }
    }
    // Les dossiers d'abord, du haut vers le bas ; un dossier déjà présent n'est pas une erreur.
    for (_, remote_dir) in &dirs {
        let _ = files.mkdir(remote_dir.clone()).await;
    }
    let count = jobs.len();
    let mut done = 0u64;
    for (local_file, remote_file, size) in jobs {
        files.upload(local_file, remote_file, offset(&progress, done, total)).await?;
        done += size;
    }
    progress(done, total.max(done));
    Ok(count)
}

/// Copie locale d'un fichier distant pour l'éditer : `%TEMP%\termoria-edition\<id>\<nom>`.
pub fn edit_copy_path(id: &str, remote: &str) -> PathBuf {
    let name = remote.rsplit('/').next().unwrap_or("fichier");
    std::env::temp_dir().join("termoria-edition").join(id).join(windows_name(name))
}

pub fn modified(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Intervalle de surveillance d'un fichier en cours d'édition.
pub const EDIT_POLL: Duration = Duration::from_millis(800);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noms_venus_du_serveur() {
        assert_eq!(windows_name(r"..\..\Démarrage\x.exe"), ".._.._Démarrage_x.exe");
        assert_eq!(windows_name(".."), "_");
        assert_eq!(windows_name("a:flux"), "a_flux");
        assert_eq!(windows_name("CON"), "_CON");
        assert_eq!(windows_name("nul.txt"), "_nul.txt");
        assert_eq!(windows_name("com1.log"), "_com1.log");
        assert_eq!(windows_name("console.log"), "console.log");
        assert_eq!(windows_name("COM10"), "COM10");
    }

    #[test]
    fn fichiers_executables() {
        for name in ["setup.exe", "run.BAT", "a.js", "lien.lnk", "x.hta", "piege.exe. ", "page.url"] {
            assert!(runs_when_opened(name), "{name}");
        }
        for name in ["nginx.conf", "index.html", "script.sh", "notes.md", "exe", ".bashrc", "app.json"] {
            assert!(!runs_when_opened(name), "{name}");
        }
    }
    use crate::connector::{BoxFuture, RemoteEntry};
    use std::{collections::BTreeMap, sync::Mutex};

    /// Faux serveur en mémoire.
    #[derive(Default)]
    struct Memory {
        files: Mutex<BTreeMap<String, Vec<u8>>>,
        dirs: Mutex<Vec<String>>,
    }

    impl RemoteFiles for Memory {
        fn home(&self) -> BoxFuture<'_, String> {
            Box::pin(async { Ok("/".into()) })
        }
        fn list(&self, path: String) -> BoxFuture<'_, Vec<RemoteEntry>> {
            Box::pin(async move {
                let prefix = if path.ends_with('/') { path.clone() } else { format!("{path}/") };
                let mut out = Vec::new();
                for d in self.dirs.lock().unwrap().iter() {
                    if let Some(rest) = d.strip_prefix(&prefix) {
                        if !rest.is_empty() && !rest.contains('/') {
                            out.push(RemoteEntry { name: rest.into(), path: d.clone(), is_dir: true, is_link: false, size: 0, modified: None, permissions: None });
                        }
                    }
                }
                for (f, data) in self.files.lock().unwrap().iter() {
                    if let Some(rest) = f.strip_prefix(&prefix) {
                        if !rest.contains('/') {
                            out.push(RemoteEntry { name: rest.into(), path: f.clone(), is_dir: false, is_link: false, size: data.len() as u64, modified: None, permissions: None });
                        }
                    }
                }
                Ok(out)
            })
        }
        fn download(&self, remote: String, local: PathBuf, progress: Progress) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                let data = self.files.lock().unwrap().get(&remote).cloned().unwrap_or_default();
                std::fs::write(&local, &data)?;
                progress(data.len() as u64, data.len() as u64);
                Ok(())
            })
        }
        fn upload(&self, local: PathBuf, remote: String, progress: Progress) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                let data = std::fs::read(&local)?;
                progress(data.len() as u64, data.len() as u64);
                self.files.lock().unwrap().insert(remote, data);
                Ok(())
            })
        }
        fn mkdir(&self, path: String) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                self.dirs.lock().unwrap().push(path);
                Ok(())
            })
        }
        fn remove(&self, _: String, _: bool) -> BoxFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn rename(&self, _: String, _: String) -> BoxFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn aller_retour_d_un_dossier() {
        let base = std::env::temp_dir().join(format!("termoria-tree-{}", uuid::Uuid::new_v4()));
        let src = base.join("site");
        std::fs::create_dir_all(src.join("css")).unwrap();
        std::fs::write(src.join("index.html"), b"<h1>ok</h1>").unwrap();
        std::fs::write(src.join("css").join("style.css"), b"body{}").unwrap();

        let server = Memory::default();
        let last = Arc::new(Mutex::new((0u64, 0u64)));
        let l = last.clone();
        let progress: Progress = Arc::new(move |d, t| *l.lock().unwrap() = (d, t));
        assert_eq!(upload_tree(&server, &src, "/var/www", progress.clone()).await.unwrap(), 2);
        assert!(server.files.lock().unwrap().contains_key("/var/www/site/css/style.css"));
        assert_eq!(*last.lock().unwrap(), (17, 17));

        let back = base.join("copie");
        assert_eq!(download_tree(&server, "/var/www/site", &back, progress).await.unwrap(), 2);
        assert_eq!(std::fs::read(back.join("css").join("style.css")).unwrap(), b"body{}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn noms_windows() {
        assert_eq!(windows_name("rapport:2026?.txt"), "rapport_2026_.txt");
        assert_eq!(windows_name("fin. "), "fin");
    }
}
