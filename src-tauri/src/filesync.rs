//! Comparer un dossier de ce PC et un dossier du serveur (Pro) : les écarts servent
//! ensuite à synchroniser, fichier par fichier, depuis l'interface.

use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::UNIX_EPOCH,
};

use anyhow::{bail, Result};
use serde::Serialize;
use tauri::State;

use crate::commands::{files_of, full, AppState, CmdResult};
use crate::connector::RemoteFiles;
use crate::license::Feature;

/// Au-delà, la comparaison s'arrête : mieux vaut choisir un dossier plus précis.
const MAX_ENTRIES: usize = 50_000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub size: u64,
    pub modified: Option<u64>,
    pub is_dir: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    OnlyLocal,
    OnlyRemote,
    LocalNewer,
    RemoteNewer,
    /// Tailles différentes (comparaison par taille seulement) : le sens choisi décide.
    Different,
    /// Même date, contenu différent, ou fichier d'un côté et dossier de l'autre : à trancher.
    Conflict,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// Chemin relatif, séparé par « / ».
    pub path: String,
    pub local: Option<Side>,
    pub remote: Option<Side>,
    pub status: Status,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub diffs: Vec<Diff>,
    pub same: usize,
    pub excluded: usize,
}

/// Motif d'exclusion : « .git/ » (dossier), « *.log » (nom), « dist/*.map » (chemin relatif).
fn excluded(patterns: &[String], rel: &str, is_dir: bool) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    patterns.iter().any(|p| {
        let (p, dir_only) = match p.strip_suffix('/') {
            Some(p) => (p, true),
            None => (p.as_str(), false),
        };
        if p.is_empty() || (dir_only && !is_dir) {
            return false;
        }
        if p.contains('/') { glob(p.trim_start_matches('/'), rel) } else { glob(p, name) }
    })
}

/// `*` : n'importe quelle suite, `?` : un caractère. Sans distinction de casse (Windows).
fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

type Tree = BTreeMap<String, Side>;

/// Fichiers et dossiers d'un dossier de ce PC (les liens vers des dossiers ne sont pas suivis).
fn walk_local(root: &Path, patterns: &[String], excluded_count: &mut usize) -> Result<Tree> {
    let mut tree = Tree::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(&rel) };
        for entry in fs::read_dir(&dir)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else { continue };
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if excluded(patterns, &child, meta.is_dir()) {
                *excluded_count += 1;
                continue;
            }
            let side = Side {
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()),
                is_dir: meta.is_dir(),
            };
            if side.is_dir && !meta.file_type().is_symlink() {
                stack.push(child.clone());
            }
            tree.insert(child, side);
            if tree.len() > MAX_ENTRIES {
                bail!("{}", t!(format!("More than {MAX_ENTRIES} files on this PC: choose a narrower folder or exclude some"), format!("Plus de {MAX_ENTRIES} fichiers sur ce PC : choisissez un dossier plus précis ou excluez-en")));
            }
        }
    }
    Ok(tree)
}

async fn walk_remote(files: &dyn RemoteFiles, root: &str, patterns: &[String], excluded_count: &mut usize) -> Result<Tree> {
    let mut tree = Tree::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { root.to_string() } else { format!("{}/{rel}", root.trim_end_matches('/')) };
        for entry in files.list(dir).await? {
            let child = if rel.is_empty() { entry.name.clone() } else { format!("{rel}/{}", entry.name) };
            if excluded(patterns, &child, entry.is_dir) {
                *excluded_count += 1;
                continue;
            }
            if entry.is_dir && !entry.is_link {
                stack.push(child.clone());
            }
            tree.insert(child, Side { size: if entry.is_dir { 0 } else { entry.size }, modified: entry.modified, is_dir: entry.is_dir });
            if tree.len() > MAX_ENTRIES {
                bail!("{}", t!(format!("More than {MAX_ENTRIES} files on the server: choose a narrower folder or exclude some"), format!("Plus de {MAX_ENTRIES} fichiers sur le serveur : choisissez un dossier plus précis ou excluez-en")));
            }
        }
    }
    Ok(tree)
}

/// Mêmes dates, à la précision près : 2 s, ou la minute quand un serveur FTP ne donne pas les secondes.
fn same_time(a: Option<u64>, b: Option<u64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            let gap = a.abs_diff(b);
            gap <= 2 || ((a % 60 == 0 || b % 60 == 0) && gap < 60)
        }
        _ => true,
    }
}

/// Écarts entre les deux arborescences. Un dossier présent d'un seul côté est un seul écart
/// (son contenu suit) ; les dossiers présents des deux côtés ne sont pas listés.
fn compare(local: &Tree, remote: &Tree, by_size: bool) -> (Vec<Diff>, usize) {
    let mut diffs = Vec::new();
    let mut same = 0;
    // Dossier absent de l'autre côté : son contenu n'est pas listé à part.
    let inside = |path: &str, tree: &Tree, other: &Tree| {
        path.match_indices('/').any(|(i, _)| {
            let parent = &path[..i];
            tree.get(parent).is_some_and(|s| s.is_dir) && !other.contains_key(parent)
        })
    };
    for (path, l) in local {
        if inside(path, local, remote) {
            continue;
        }
        let status = match remote.get(path) {
            None => Status::OnlyLocal,
            Some(r) if l.is_dir && r.is_dir => continue,
            Some(r) if l.is_dir != r.is_dir => Status::Conflict,
            Some(r) if by_size => {
                if l.size == r.size { same += 1; continue; }
                Status::Different
            }
            Some(r) if same_time(l.modified, r.modified) => {
                if l.size == r.size { same += 1; continue; }
                Status::Conflict
            }
            Some(r) if l.modified > r.modified => Status::LocalNewer,
            Some(_) => Status::RemoteNewer,
        };
        diffs.push(Diff { path: path.clone(), local: Some(*l), remote: remote.get(path).copied(), status });
    }
    for (path, r) in remote {
        if !local.contains_key(path) && !inside(path, remote, local) {
            diffs.push(Diff { path: path.clone(), local: None, remote: Some(*r), status: Status::OnlyRemote });
        }
    }
    diffs.sort_by(|a, b| a.path.cmp(&b.path));
    (diffs, same)
}

#[tauri::command]
pub async fn fs_compare(
    state: State<'_, AppState>,
    connection_id: String,
    local: String,
    remote: String,
    by_size: bool,
    exclude: Vec<String>,
) -> CmdResult<Comparison> {
    state.unlocked()?;
    state.license.lock().unwrap().require(Feature::FileSync).map_err(full)?;
    let files = files_of(&state, &connection_id)?;
    let patterns: Vec<String> = exclude.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    let mut excluded_count = 0;
    let root = Path::new(&local).to_path_buf();
    let pats = patterns.clone();
    let (local_tree, local_excluded) = tauri::async_runtime::spawn_blocking(move || {
        let mut count = 0;
        walk_local(&root, &pats, &mut count).map(|t| (t, count))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(full)?;
    let remote_tree = walk_remote(files.as_ref(), &remote, &patterns, &mut excluded_count).await.map_err(full)?;
    let (diffs, same) = compare(&local_tree, &remote_tree, by_size);
    Ok(Comparison { diffs, same, excluded: excluded_count + local_excluded })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(size: u64, modified: u64) -> Side {
        Side { size, modified: Some(modified), is_dir: false }
    }

    fn dir() -> Side {
        Side { size: 0, modified: None, is_dir: true }
    }

    #[test]
    fn motifs() {
        let p = vec![".git/".to_string(), "*.log".into(), "dist/*.map".into()];
        assert!(excluded(&p, ".git", true));
        assert!(!excluded(&p, ".git", false));
        assert!(excluded(&p, "logs/app.LOG", false));
        assert!(excluded(&p, "dist/a.js.map", false));
        assert!(!excluded(&p, "src/a.js.map", false));
        assert!(glob("a*b?c", "axxbyc"));
        assert!(!glob("a*b?c", "axxbc"));
    }

    #[test]
    fn ecarts() {
        let local: Tree = [
            ("app.js".to_string(), side(10, 2000)),
            ("same.txt".into(), side(5, 1000)),
            ("conflit.txt".into(), side(5, 1000)),
            ("neuf".into(), dir()),
            ("neuf/a.txt".into(), side(1, 1000)),
            ("site".into(), dir()),
            ("site/index.html".into(), side(3, 1000)),
        ]
        .into();
        let remote: Tree = [
            ("app.js".to_string(), side(9, 1000)),
            ("same.txt".into(), side(5, 1001)),
            ("conflit.txt".into(), side(6, 1000)),
            ("vieux.txt".into(), side(1, 3000)),
            ("site".into(), dir()),
            ("site/index.html".into(), side(3, 4000)),
        ]
        .into();
        let (diffs, same) = compare(&local, &remote, false);
        let got: Vec<_> = diffs.iter().map(|d| (d.path.as_str(), d.status)).collect();
        assert_eq!(
            got,
            [
                ("app.js", Status::LocalNewer),
                ("conflit.txt", Status::Conflict),
                ("neuf", Status::OnlyLocal),
                ("site/index.html", Status::RemoteNewer),
                ("vieux.txt", Status::OnlyRemote),
            ]
        );
        assert_eq!(same, 1);
        // Par taille seulement : les dates ne comptent plus.
        let (diffs, _) = compare(&local, &remote, true);
        assert!(diffs.iter().any(|d| d.path == "app.js" && d.status == Status::Different));
        assert!(!diffs.iter().any(|d| d.path == "site/index.html"));
    }

    #[test]
    fn precision_ftp() {
        assert!(same_time(Some(1200), Some(1259)));
        assert!(!same_time(Some(1201), Some(1259)));
        assert!(same_time(Some(1201), Some(1203)));
    }

    #[test]
    fn dossier_local() {
        let dir = std::env::temp_dir().join(format!("portunia-sync-{}", std::process::id()));
        fs::create_dir_all(dir.join(".git/objects")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/a.txt"), "abc").unwrap();
        fs::write(dir.join("debug.log"), "x").unwrap();
        let mut count = 0;
        let tree = walk_local(&dir, &[".git/".into(), "*.log".into()], &mut count).unwrap();
        assert_eq!(tree.keys().collect::<Vec<_>>(), ["src", "src/a.txt"]);
        assert_eq!(count, 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
