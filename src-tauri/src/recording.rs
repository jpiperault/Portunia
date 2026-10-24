//! Enregistrement des sessions terminal (édition Pro).
//!
//! Format asciicast v2 (`.cast`, celui d'asciinema) : une ligne d'en-tête JSON,
//! puis une ligne par événement `[secondes, "o", "texte"]`. À l'arrêt, une copie
//! en texte brut (`.txt`, sans codes de couleur) est écrite à côté.
//! Seul ce que le serveur affiche est enregistré : les mots de passe tapés
//! (jamais réaffichés par le serveur) n'apparaissent pas.

use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;

pub struct Recorder {
    path: PathBuf,
    file: BufWriter<File>,
    start: Instant,
    /// Octets UTF-8 incomplets en fin de bloc, gardés pour le bloc suivant.
    pending: Vec<u8>,
}

impl Recorder {
    pub fn start(dir: &Path, stamp: &str, title: &str, cols: u16, rows: u16) -> Result<Self> {
        fs::create_dir_all(dir).with_context(|| format!("Dossier d'enregistrement inaccessible : {}", dir.display()))?;
        let safe = |s: &str| -> String {
            s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
        };
        let path = dir.join(format!("{}_{}.cast", safe(stamp), safe(title)));
        let mut file = BufWriter::new(File::create(&path).with_context(|| format!("Création impossible : {}", path.display()))?);
        let header = json!({
            "version": 2, "width": cols, "height": rows,
            "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            "title": title,
        });
        writeln!(file, "{header}")?;
        Ok(Self { path, file, start: Instant::now(), pending: Vec::new() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn output(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        // N'écrit que la partie UTF-8 complète ; le reste attend le bloc suivant.
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => self.pending.len(),
        };
        let chunk: Vec<u8> = self.pending.drain(..valid).collect();
        if chunk.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&chunk);
        let _ = writeln!(self.file, "{}", json!([self.elapsed(), "o", text]));
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let _ = writeln!(self.file, "{}", json!([self.elapsed(), "r", format!("{cols}x{rows}")]));
    }

    fn elapsed(&self) -> f64 {
        (self.start.elapsed().as_secs_f64() * 1000.0).round() / 1000.0
    }

    /// Termine l'enregistrement et écrit la copie texte. Renvoie le chemin du `.cast`.
    pub fn finish(mut self) -> Result<PathBuf> {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.output(&rest);
        }
        self.file.flush()?;
        let cast = fs::read_to_string(&self.path)?;
        fs::write(self.path.with_extension("txt"), cast_to_text(&cast))?;
        Ok(self.path)
    }
}

/// Texte affiché pendant la session, sans codes de couleur ni de déplacement.
pub fn cast_to_text(cast: &str) -> String {
    let mut out = String::new();
    for line in cast.lines().skip(1) {
        let Ok(serde_json::Value::Array(event)) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if event.get(1).and_then(|v| v.as_str()) == Some("o") {
            if let Some(text) = event.get(2).and_then(|v| v.as_str()) {
                out.push_str(text);
            }
        }
    }
    strip_ansi(&out)
}

/// Retire les séquences d'échappement ANSI et normalise les fins de ligne.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI : ESC [ … lettre finale
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC : ESC ] … BEL ou ESC \
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' || (n == '\x1b' && chars.peek() == Some(&'\\')) {
                            if n == '\x1b' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Séquences à deux caractères (ESC =, ESC >, ESC ( B…)
                Some('(') | Some(')') => {
                    chars.next();
                }
                _ => {}
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\x07' | '\x08' | '\0' => {}
            _ => out.push(c),
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    path: String,
    name: String,
    size: u64,
    /// Secondes Unix.
    modified: u64,
}

pub fn list(dir: &Path) -> Vec<RecordingInfo> {
    let mut items: Vec<RecordingInfo> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "cast"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(RecordingInfo {
                path: e.path().display().to_string(),
                name: e.path().file_stem()?.to_string_lossy().into_owned(),
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_secs(),
            })
        })
        .collect();
    items.sort_by(|a, b| b.modified.cmp(&a.modified));
    items
}

/// Lecture d'un enregistrement, limitée au dossier des enregistrements.
pub fn read(dir: &Path, path: &str) -> Result<String> {
    let file = PathBuf::from(path);
    let dir = fs::canonicalize(dir)?;
    let real = fs::canonicalize(&file).context("Enregistrement introuvable")?;
    if !real.starts_with(&dir) || real.extension().is_none_or(|x| x != "cast") {
        anyhow::bail!("Ce fichier n'est pas un enregistrement de Termoria");
    }
    Ok(fs::read_to_string(real)?)
}

pub fn delete(dir: &Path, path: &str) -> Result<()> {
    read(dir, path)?; // mêmes vérifications
    let cast = PathBuf::from(path);
    fs::remove_file(&cast)?;
    let _ = fs::remove_file(cast.with_extension("txt"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retire_les_codes_ansi() {
        let raw = "\x1b[1;32mdeploy@web\x1b[0m:~$ ls\r\n\x1b]0;titre\x07fichier.txt\r\n";
        assert_eq!(strip_ansi(raw), "deploy@web:~$ ls\nfichier.txt\n");
    }

    #[test]
    fn enregistre_et_convertit() {
        let dir = std::env::temp_dir().join(format!("termoria-rec-{}", uuid::Uuid::new_v4()));
        let mut rec = Recorder::start(&dir, "2026-10-24_10-00-00", "srv web", 80, 24).unwrap();
        rec.output("bonjour \x1b[31m".as_bytes());
        // « é » coupé entre deux blocs
        let e = "é".as_bytes();
        rec.output(&[b'c', b'a', b'f', e[0]]);
        rec.output(&[e[1], b'\r', b'\n']);
        rec.resize(100, 30);
        let path = rec.finish().unwrap();
        assert!(path.file_name().unwrap().to_string_lossy().ends_with("srv_web.cast"));
        let cast = fs::read_to_string(&path).unwrap();
        assert!(cast.lines().next().unwrap().contains("\"version\":2"));
        assert_eq!(fs::read_to_string(path.with_extension("txt")).unwrap(), "bonjour café\n");
        assert_eq!(list(&dir).len(), 1);
        assert!(read(&dir, &path.display().to_string()).is_ok());
        assert!(read(&dir, "C:\\Windows\\win.ini").is_err());
        delete(&dir, &path.display().to_string()).unwrap();
        let _ = fs::remove_dir_all(dir);
    }
}
