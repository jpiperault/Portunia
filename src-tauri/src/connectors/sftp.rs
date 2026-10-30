//! Explorateur de fichiers via SFTP, sur une connexion SSH déjà ouverte.
//! Réutilisable par tout connecteur basé sur russh.

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use russh::client;
use russh_sftp::client::SftpSession;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

use crate::connector::{BoxFuture, Progress, RemoteEntry, RemoteFiles};

const CHUNK: usize = 256 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

pub struct SftpFiles<H: client::Handler> {
    handle: Arc<client::Handle<H>>,
    /// Ouvert à la première utilisation, puis réutilisé.
    session: Mutex<Option<Arc<SftpSession>>>,
}

impl<H: client::Handler> SftpFiles<H> {
    pub fn new(handle: Arc<client::Handle<H>>) -> Self {
        Self {
            handle,
            session: Mutex::new(None),
        }
    }

    async fn session(&self) -> Result<Arc<SftpSession>> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_ref() {
            return Ok(session.clone());
        }
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| anyhow!("{}", t!(format!("SFTP unavailable on this server: {e}"), format!("SFTP indisponible sur ce serveur : {e}"))))?;
        let session = Arc::new(session);
        *guard = Some(session.clone());
        Ok(session)
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>> {
        let sftp = self.session().await?;
        let dir = sftp.read_dir(path).await.map_err(err)?;
        let mut entries = Vec::new();
        for entry in dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let kind = entry.file_type();
            let full = join(path, &name);
            // Un lien vers un dossier doit pouvoir s'ouvrir comme un dossier.
            let is_dir = if kind.is_symlink() {
                sftp.metadata(full.clone()).await.map(|m| m.is_dir()).unwrap_or(false)
            } else {
                kind.is_dir()
            };
            entries.push(RemoteEntry {
                name,
                path: full,
                is_dir,
                is_link: kind.is_symlink(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(u64::from),
                permissions: meta.permissions,
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Suppression récursive : le contenu d'abord, le dossier ensuite.
    fn remove_tree<'a>(&'a self, path: String) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            for entry in self.list_dir(&path).await? {
                if entry.is_dir && !entry.is_link {
                    self.remove_tree(entry.path).await?;
                } else {
                    sftp.remove_file(entry.path).await.map_err(err)?;
                }
            }
            sftp.remove_dir(path).await.map_err(err)?;
            Ok(())
        })
    }
}

impl<H: client::Handler> RemoteFiles for SftpFiles<H> {
    fn home(&self) -> BoxFuture<'_, String> {
        Box::pin(async move {
            let sftp = self.session().await?;
            Ok(sftp.canonicalize(".").await.map_err(err)?)
        })
    }

    fn list(&self, path: String) -> BoxFuture<'_, Vec<RemoteEntry>> {
        Box::pin(async move { self.list_dir(&path).await })
    }

    fn download(&self, remote: String, local: PathBuf, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            let mut source = sftp.open(remote).await.map_err(err)?;
            let total = source.metadata().await.ok().and_then(|m| m.size).unwrap_or(0);
            let mut target = tokio::fs::File::create(&local).await?;
            let result = copy(&mut source, &mut target, total, &progress).await;
            drop(target);
            if result.is_err() {
                // Pas de fichier à moitié téléchargé.
                let _ = tokio::fs::remove_file(&local).await;
            }
            result
        })
    }

    fn upload(&self, local: PathBuf, remote: String, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            let mut source = tokio::fs::File::open(&local).await?;
            let total = source.metadata().await?.len();
            let mut target = sftp.create(remote).await.map_err(err)?;
            copy(&mut source, &mut target, total, &progress).await?;
            target.shutdown().await?;
            Ok(())
        })
    }

    fn mkdir(&self, path: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.session().await?.create_dir(path).await.map_err(err)?;
            Ok(())
        })
    }

    fn remove(&self, path: String, is_dir: bool) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if is_dir {
                self.remove_tree(path).await
            } else {
                self.session().await?.remove_file(path).await.map_err(err)?;
                Ok(())
            }
        })
    }

    fn rename(&self, from: String, to: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.session().await?.rename(from, to).await.map_err(err)?;
            Ok(())
        })
    }
}

async fn copy<R, W>(source: &mut R, target: &mut W, total: u64, progress: &Progress) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut last = Instant::now();
    progress(0, total);
    loop {
        let n = source.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        target.write_all(&buf[..n]).await?;
        done += n as u64;
        if last.elapsed() >= PROGRESS_EVERY {
            progress(done, total);
            last = Instant::now();
        }
    }
    target.flush().await?;
    progress(done, total.max(done));
    Ok(())
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn err(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("{e}")
}
