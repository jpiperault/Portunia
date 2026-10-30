//! FTP et FTPS (TLS explicite) : un explorateur de fichiers dans un onglet.
//! La connexion de contrôle est rouverte d'elle-même si le serveur l'a fermée
//! (inactivité), puis l'opération est relancée une fois.

use std::{
    fs::File,
    io::{Read, Write},
    net::{SocketAddr, ToSocketAddrs},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use suppaftp::{list::ListParser, types::FileType, FtpError, RustlsConnector, RustlsFtpStream};

use crate::connector::*;
use crate::tls::tls_config;

pub struct FtpConnector;

impl Connector for FtpConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "ftp".into(),
            name: "FTP / FTPS".into(),
            version: "0.1.0".into(),
            description: t!("Files on an FTP server, encrypted (FTPS) or not.", "Fichiers d'un serveur FTP, chiffré (FTPS) ou non.").into(),
            view: ViewKind::Files,
            builtin: true,
            file_browser: true,
            port_forwarding: false,
            fields: vec![
                Field::new("host", t!("Host", "Hôte"), FieldKind::Text).required().placeholder(t!("ftp.example.com", "ftp.exemple.fr")),
                Field::new("port", "Port", FieldKind::Number).default(21),
                Field::new(
                    "security",
                    t!("Encryption", "Chiffrement"),
                    choice(&[("explicit", t!("FTPS (explicit TLS)", "FTPS (TLS explicite)")), ("none", t!("None (FTP)", "Aucun (FTP)"))]),
                )
                .default("explicit"),
                Field::new("insecureTls", t!("Accept an unverified certificate (self-signed)", "Accepter un certificat non vérifié (auto-signé)"), FieldKind::Bool)
                    .default(false)
                    .show_if("security", "explicit"),
                Field::new("credential", t!("Shared credentials", "Identifiants partagés"), FieldKind::Suggest { source: "credentials".into() })
                    .placeholder(t!("Empty = this session's own credentials", "Vide = identifiants propres à cette session")),
                Field::new("username", t!("User", "Utilisateur"), FieldKind::Text)
                    .placeholder(t!("Empty = anonymous", "Vide = anonymous"))
                    .hidden_by("credential"),
                Field::new("password", t!("Password", "Mot de passe"), FieldKind::Secret).hidden_by("credential"),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let params = Params {
            host: ctx.require("host", t!("Host", "Hôte"))?,
            port: ctx.port(21)?,
            tls: ctx.str("security").as_deref() != Some("none"),
            insecure: ctx.bool("insecureTls"),
            user: ctx.str("username").unwrap_or_else(|| "anonymous".into()),
            password: ctx.raw("password").unwrap_or_default(),
        };
        // Première connexion tout de suite : une erreur d'identifiants s'affiche à l'ouverture.
        let stream = params.open()?;
        let files = Arc::new(FtpFiles { inner: Arc::new(Inner { params, stream: Mutex::new(Some(stream)) }) });
        Ok(Outcome::Terminal(Box::new(FtpConnection { files })))
    }
}

struct Params {
    host: String,
    port: u16,
    tls: bool,
    insecure: bool,
    user: String,
    password: String,
}

impl Params {
    fn open(&self) -> Result<RustlsFtpStream> {
        let addr: SocketAddr = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .with_context(|| format!("Nom introuvable : {}", self.host))?
            .next()
            .ok_or_else(|| anyhow!("{}", t!(format!("Name not found: {}", self.host), format!("Nom introuvable : {}", self.host))))?;
        let mut stream = RustlsFtpStream::connect_timeout(addr, Duration::from_secs(15))
            .map_err(|e| anyhow!("{}", t!(format!("Cannot connect to {}:{}: {e}", self.host, self.port), format!("Connexion impossible à {}:{} : {e}", self.host, self.port))))?;
        if self.tls {
            stream = stream.into_secure(RustlsConnector::from(tls_config(self.insecure)?), &self.host).map_err(|e| {
                anyhow!("{}", t!(format!("The server refuses encryption (FTPS): {e}. Choose « None » if it does not offer it, or accept its certificate if it is self-signed."), format!("Le serveur refuse le chiffrement (FTPS) : {e}. Choisissez « Aucun » s'il ne le propose pas, ou acceptez son certificat s'il est auto-signé.")))
            })?;
        }
        stream.login(&self.user, &self.password).map_err(|e| anyhow!("{}", t!(format!("Credentials refused by {}: {e}", self.host), format!("Identifiants refusés par {} : {e}", self.host))))?;
        stream.transfer_type(FileType::Binary)?;
        Ok(stream)
    }
}


struct Inner {
    params: Params,
    stream: Mutex<Option<RustlsFtpStream>>,
}

impl Inner {
    /// Exécute `op` sur la connexion ; si elle est tombée, la rouvre et réessaie une fois.
    fn with<T>(&self, op: impl Fn(&mut RustlsFtpStream) -> Result<T>) -> Result<T> {
        let mut guard = self.stream.lock().unwrap();
        if guard.is_none() {
            *guard = Some(self.params.open()?);
        }
        match op(guard.as_mut().unwrap()) {
            Err(e) if is_connection_lost(&e) => {
                *guard = Some(self.params.open()?);
                op(guard.as_mut().unwrap())
            }
            other => other,
        }
    }

    fn list(&self, path: &str) -> Result<Vec<RemoteEntry>> {
        self.with(|ftp| {
            let lines = match ftp.mlsd(Some(path)) {
                Ok(lines) => lines.into_iter().map(|l| (l, true)).collect::<Vec<_>>(),
                // Serveur sans MLSD : LIST (format Unix ou Windows).
                Err(_) => ftp.list(Some(path))?.into_iter().map(|l| (l, false)).collect(),
            };
            let mut out = Vec::new();
            for (line, mlsd) in lines {
                let parsed = if mlsd {
                    ListParser::parse_mlsd(&line)
                } else {
                    ListParser::parse_posix(&line).or_else(|_| ListParser::parse_dos(&line))
                };
                let Ok(file) = parsed else { continue };
                let name = file.name().to_string();
                if name == "." || name == ".." || name.is_empty() {
                    continue;
                }
                out.push(RemoteEntry {
                    path: join(path, &name),
                    name,
                    is_dir: file.is_directory(),
                    is_link: file.is_symlink(),
                    size: file.size() as u64,
                    modified: file.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()),
                    permissions: None,
                });
            }
            Ok(out)
        })
    }

    fn remove_tree(&self, path: &str) -> Result<()> {
        for entry in self.list(path)? {
            if entry.is_dir && !entry.is_link {
                self.remove_tree(&entry.path)?;
            } else {
                self.with(|ftp| Ok(ftp.rm(&entry.path)?))?;
            }
        }
        self.with(|ftp| Ok(ftp.rmdir(path)?))
    }
}

fn is_connection_lost(e: &anyhow::Error) -> bool {
    match e.downcast_ref::<FtpError>() {
        Some(FtpError::ConnectionError(_)) => true,
        // 421 : service fermé (délai d'inactivité dépassé)
        Some(FtpError::UnexpectedResponse(r)) => r.status.code() == 421,
        _ => false,
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

const CHUNK: usize = 256 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Copie avec suivi de la progression.
fn copy(from: &mut impl Read, to: &mut impl Write, total: u64, progress: &Progress) -> Result<()> {
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut last = Instant::now();
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n])?;
        done += n as u64;
        if last.elapsed() >= PROGRESS_EVERY {
            progress(done, total.max(done));
            last = Instant::now();
        }
    }
    progress(done, total.max(done));
    Ok(())
}

pub struct FtpFiles {
    inner: Arc<Inner>,
}

/// Les opérations FTP sont bloquantes : elles tournent hors du moteur asynchrone.
fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> BoxFuture<'static, T> {
    Box::pin(async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| anyhow!(e))? })
}

impl RemoteFiles for FtpFiles {
    fn home(&self) -> BoxFuture<'_, String> {
        let inner = self.inner.clone();
        blocking(move || inner.with(|ftp| Ok(ftp.pwd()?)))
    }

    fn list(&self, path: String) -> BoxFuture<'_, Vec<RemoteEntry>> {
        let inner = self.inner.clone();
        blocking(move || inner.list(&path))
    }

    fn download(&self, remote: String, local: PathBuf, progress: Progress) -> BoxFuture<'_, ()> {
        let inner = self.inner.clone();
        blocking(move || {
            inner.with(|ftp| {
                let total = ftp.size(&remote).unwrap_or(0) as u64;
                let mut out = File::create(&local).with_context(|| format!("Écriture impossible : {}", local.display()))?;
                let mut stream = ftp.retr_as_stream(&remote)?;
                copy(&mut stream, &mut out, total, &progress)?;
                stream.finish()?;
                Ok(())
            })
        })
    }

    fn upload(&self, local: PathBuf, remote: String, progress: Progress) -> BoxFuture<'_, ()> {
        let inner = self.inner.clone();
        blocking(move || {
            let total = std::fs::metadata(&local)?.len();
            inner.with(|ftp| {
                let mut file = File::open(&local).with_context(|| format!("Lecture impossible : {}", local.display()))?;
                let mut stream = ftp.put_with_stream(&remote)?;
                copy(&mut file, &mut stream, total, &progress)?;
                stream.finish()?;
                Ok(())
            })
        })
    }

    fn mkdir(&self, path: String) -> BoxFuture<'_, ()> {
        let inner = self.inner.clone();
        blocking(move || inner.with(|ftp| Ok(ftp.mkdir(&path)?)))
    }

    fn remove(&self, path: String, is_dir: bool) -> BoxFuture<'_, ()> {
        let inner = self.inner.clone();
        blocking(move || if is_dir { inner.remove_tree(&path) } else { inner.with(|ftp| Ok(ftp.rm(&path)?)) })
    }

    fn rename(&self, from: String, to: String) -> BoxFuture<'_, ()> {
        let inner = self.inner.clone();
        blocking(move || inner.with(|ftp| Ok(ftp.rename(&from, &to)?)))
    }
}

/// « Connexion » d'un onglet fichiers : pas de terminal, seulement l'explorateur.
struct FtpConnection {
    files: Arc<FtpFiles>,
}

impl TerminalConnection for FtpConnection {
    fn write(&self, _data: &[u8]) -> Result<()> {
        bail!(t!("This tab has no terminal", "Cet onglet n'a pas de terminal"))
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }

    fn close(&self) {
        if let Ok(mut guard) = self.files.inner.stream.lock() {
            if let Some(mut ftp) = guard.take() {
                let _ = ftp.quit();
            }
        }
    }

    fn files(&self) -> Option<Arc<dyn RemoteFiles>> {
        Some(self.files.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chemins() {
        assert_eq!(join("/", "pub"), "/pub");
        assert_eq!(join("/pub", "a.txt"), "/pub/a.txt");
    }

    #[test]
    fn analyse_des_listes() {
        let unix = ListParser::parse_posix("drwxr-xr-x    2 ftp      ftp          4096 Oct 23 18:02 www").unwrap();
        assert!(unix.is_directory());
        assert_eq!(unix.name(), "www");
        let dos = ListParser::parse_dos("10-23-26  06:02PM                 1234 index.html").unwrap();
        assert_eq!(dos.size(), 1234);
        let mlsd = ListParser::parse_mlsd("type=file;size=812;modify=20261023180200; robots.txt").unwrap();
        assert_eq!(mlsd.name(), "robots.txt");
    }
}

#[cfg(test)]
mod reseau {
    use super::*;

    /// Serveur public de démonstration (lecture seule) : cargo test -- --ignored ftps_reel
    #[test]
    #[ignore = "nécessite Internet"]
    fn ftps_reel() {
        for tls in [true, false] {
            let params = Params { host: "test.rebex.net".into(), port: 21, tls, insecure: false, user: "demo".into(), password: "password".into() };
            let inner = Inner { stream: Mutex::new(Some(params.open().unwrap())), params };
            let home = inner.with(|ftp| Ok(ftp.pwd()?)).unwrap();
            let list = inner.list(&home).unwrap();
            println!("TLS={tls} home={home} {:?}", list.iter().map(|e| (&e.name, e.is_dir, e.size)).collect::<Vec<_>>());
            assert!(list.iter().any(|e| e.name == "readme.txt" && !e.is_dir));
            let local = std::env::temp_dir().join(format!("portunia-ftp-{tls}.txt"));
            let p: Progress = Arc::new(|_, _| {});
            inner.with(|ftp| {
                let mut out = File::create(&local)?;
                let mut s = ftp.retr_as_stream("readme.txt")?;
                copy(&mut s, &mut out, 0, &p)?;
                s.finish()?;
                Ok(())
            }).unwrap();
            assert!(std::fs::metadata(&local).unwrap().len() > 100);
            // Connexion perdue : rouverte d'elle-même.
            inner.stream.lock().unwrap().as_mut().unwrap().quit().unwrap();
            *inner.stream.lock().unwrap() = None;
            assert!(!inner.list(&home).unwrap().is_empty());
        }
    }
}
