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
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};

use crate::connector::{partial_path, BoxFuture, Progress, RemoteEntry, RemoteFiles};

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
    fn set_modified(&self, path: String, secs: u64) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            let time = u32::try_from(secs).unwrap_or(u32::MAX);
            let attrs = russh_sftp::protocol::FileAttributes { atime: Some(time), mtime: Some(time), ..Default::default() };
            sftp.set_metadata(path, attrs).await.map_err(err)?;
            Ok(())
        })
    }

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
            // Écrit à côté puis renomme : jamais de fichier à moitié téléchargé sous son vrai nom ;
            // en cas d'échec, la partie reçue reste (« .partiel ») pour une reprise.
            let partial = partial_path(&local);
            let mut target = tokio::fs::File::create(&partial).await?;
            let result = copy(&mut source, &mut target, total, &progress, 0).await;
            drop(target);
            finish_download(result, &partial, &local).await
        })
    }

    fn download_from(&self, remote: String, local: PathBuf, offset: u64, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            let mut source = sftp.open(remote).await.map_err(err)?;
            let total = source.metadata().await.ok().and_then(|m| m.size).unwrap_or(0);
            let partial = partial_path(&local);
            let have = tokio::fs::metadata(&partial).await.map(|m| m.len()).unwrap_or(0);
            // La partie gardée fait foi ; plus longue que le fichier du serveur : tout recommence.
            let offset = if have == offset && offset <= total { offset } else { 0 };
            let mut target = if offset > 0 { tokio::fs::OpenOptions::new().append(true).open(&partial).await? } else { tokio::fs::File::create(&partial).await? };
            source.seek(std::io::SeekFrom::Start(offset)).await?;
            let result = copy(&mut source, &mut target, total, &progress, offset).await;
            drop(target);
            finish_download(result, &partial, &local).await
        })
    }

    fn upload_from(&self, local: PathBuf, remote: String, offset: u64, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            let mut source = tokio::fs::File::open(&local).await?;
            let total = source.metadata().await?.len();
            let have = sftp.metadata(remote.clone()).await.ok().and_then(|m| m.size).unwrap_or(0);
            let offset = if have == offset && offset <= total { offset } else { 0 };
            let flags = if offset > 0 { russh_sftp::protocol::OpenFlags::WRITE } else { russh_sftp::protocol::OpenFlags::CREATE | russh_sftp::protocol::OpenFlags::TRUNCATE | russh_sftp::protocol::OpenFlags::WRITE };
            let mut target = sftp.open_with_flags(remote, flags).await.map_err(err)?;
            target.seek(std::io::SeekFrom::Start(offset)).await?;
            source.seek(std::io::SeekFrom::Start(offset)).await?;
            copy(&mut source, &mut target, total, &progress, offset).await?;
            target.shutdown().await?;
            Ok(())
        })
    }

    fn upload(&self, local: PathBuf, remote: String, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let sftp = self.session().await?;
            let mut source = tokio::fs::File::open(&local).await?;
            let total = source.metadata().await?.len();
            let mut target = sftp.create(remote).await.map_err(err)?;
            copy(&mut source, &mut target, total, &progress, 0).await?;
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

/// Fin d'un téléchargement : complet, la partie reçue prend le vrai nom ; sinon elle reste
/// pour une reprise (rien à garder si rien n'est arrivé).
async fn finish_download(result: Result<()>, partial: &std::path::Path, local: &std::path::Path) -> Result<()> {
    match result {
        Ok(()) => {
            tokio::fs::rename(partial, local).await?;
            Ok(())
        }
        Err(e) => {
            if tokio::fs::metadata(partial).await.map(|m| m.len()).unwrap_or(0) == 0 {
                let _ = tokio::fs::remove_file(partial).await;
            }
            Err(e)
        }
    }
}

/// Copie avec avancement ; `start` : octets déjà transférés (reprise).
async fn copy<R, W>(source: &mut R, target: &mut W, total: u64, progress: &Progress, start: u64) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = start;
    let mut last = Instant::now();
    progress(start, total);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::RemoteFiles;

    struct AnyKey;
    impl client::Handler for AnyKey {
        type Error = russh::Error;
        async fn check_server_key(&mut self, _: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    /// Reprise réelle contre un serveur SFTP d'essai (banc) :
    /// SFTP_ESSAI=root@hôte:22 SFTP_CLE=~/.ssh/cle cargo test --lib reprise_reelle -- --ignored
    #[tokio::test]
    #[ignore]
    async fn reprise_reelle() {
        let target = std::env::var("SFTP_ESSAI").expect("SFTP_ESSAI");
        let (user, addr) = target.split_once('@').unwrap();
        let key = russh::keys::load_secret_key(std::env::var("SFTP_CLE").expect("SFTP_CLE"), None).unwrap();
        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(config, addr, AnyKey).await.unwrap();
        let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
        assert!(handle.authenticate_publickey(user, russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.unwrap().success());
        let files = SftpFiles::new(Arc::new(handle));
        let dir = std::env::temp_dir().join(format!("portunia-reprise-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
        let local = dir.join("source.bin");
        std::fs::write(&local, &data).unwrap();
        let remote = "/tmp/portunia-reprise.bin".to_string();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let s = seen.clone();
        let progress: Progress = Arc::new(move |d, t| s.lock().unwrap().push((d, t)));
        // Envoi complet, puis serveur tronqué à 1 Mo et envoi repris.
        files.upload(local.clone(), remote.clone(), progress.clone()).await.unwrap();
        {
            let sftp = files.session().await.unwrap();
            let mut f = sftp.open_with_flags(remote.clone(), russh_sftp::protocol::OpenFlags::WRITE | russh_sftp::protocol::OpenFlags::TRUNCATE).await.unwrap();
            f.write_all(&data[..1_000_000]).await.unwrap();
            f.shutdown().await.unwrap();
        }
        seen.lock().unwrap().clear();
        files.upload_from(local.clone(), remote.clone(), 1_000_000, progress.clone()).await.unwrap();
        assert_eq!(seen.lock().unwrap().first().copied(), Some((1_000_000, 3_000_000)), "l'avancement part de la reprise");
        // Téléchargement repris depuis une partie de 1,5 Mo.
        let back = dir.join("retour.bin");
        std::fs::write(partial_path(&back), &data[..1_500_000]).unwrap();
        files.download_from(remote.clone(), back.clone(), 1_500_000, progress.clone()).await.unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data, "fichier reconstitué à l'identique");
        assert!(!partial_path(&back).exists(), "la partie a pris le vrai nom");
        // Téléchargement complet ordinaire : pas de « .partiel » qui reste.
        let full = dir.join("complet.bin");
        files.download(remote.clone(), full.clone(), progress).await.unwrap();
        assert_eq!(std::fs::read(&full).unwrap(), data);
        assert!(!partial_path(&full).exists());
        let _ = files.remove(remote, false).await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
