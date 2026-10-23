//! Tunnels SSH : redirection de port locale (ssh -L) et proxy SOCKS5 (ssh -D).
//! Les ports n'écoutent que sur 127.0.0.1 : rien n'est exposé au réseau.

use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use anyhow::{anyhow, bail, Context, Result};
use russh::client;
use tauri::async_runtime::{spawn, JoinHandle};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use crate::connector::{BoxFuture, PortForwarder, TunnelKind, TunnelSpec, TunnelStatus};

struct Running {
    spec: TunnelSpec,
    listener: JoinHandle<()>,
    stats: Arc<Stats>,
}

#[derive(Default)]
struct Stats {
    connections: AtomicU32,
    last_error: Mutex<Option<String>>,
}

pub struct SshForwarder<H: client::Handler> {
    handle: Arc<client::Handle<H>>,
    running: Mutex<HashMap<String, Running>>,
}

impl<H: client::Handler> SshForwarder<H> {
    pub fn new(handle: Arc<client::Handle<H>>) -> Self {
        Self {
            handle,
            running: Mutex::new(HashMap::new()),
        }
    }
}

impl<H: client::Handler> Drop for SshForwarder<H> {
    fn drop(&mut self) {
        for (_, tunnel) in self.running.lock().unwrap().drain() {
            tunnel.listener.abort();
        }
    }
}

impl<H: client::Handler + 'static> PortForwarder for SshForwarder<H> {
    fn start(&self, spec: TunnelSpec) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if spec.kind == TunnelKind::Local && (spec.remote_host.trim().is_empty() || spec.remote_port == 0) {
                bail!("Indiquez l'hôte et le port de destination");
            }
            if self.running.lock().unwrap().contains_key(&spec.id) {
                return Ok(());
            }
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, spec.bind_port));
            let listener = TcpListener::bind(addr)
                .await
                .with_context(|| format!("Le port local {} est déjà utilisé ou interdit", spec.bind_port))?;

            let stats = Arc::new(Stats::default());
            let (handle, tunnel, task_stats) = (self.handle.clone(), spec.clone(), stats.clone());
            let task = spawn(async move {
                while let Ok((socket, peer)) = listener.accept().await {
                    let (handle, tunnel, stats) = (handle.clone(), tunnel.clone(), task_stats.clone());
                    spawn(async move {
                        stats.connections.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = serve(&handle, &tunnel, socket, peer).await {
                            *stats.last_error.lock().unwrap() = Some(format!("{e:#}"));
                        }
                        stats.connections.fetch_sub(1, Ordering::Relaxed);
                    });
                }
            });
            self.running.lock().unwrap().insert(spec.id.clone(), Running { spec, listener: task, stats });
            Ok(())
        })
    }

    fn stop(&self, id: &str) {
        if let Some(tunnel) = self.running.lock().unwrap().remove(id) {
            tunnel.listener.abort();
        }
    }

    fn list(&self) -> Vec<TunnelStatus> {
        self.running
            .lock()
            .unwrap()
            .values()
            .map(|t| TunnelStatus {
                spec: t.spec.clone(),
                connections: t.stats.connections.load(Ordering::Relaxed),
                last_error: t.stats.last_error.lock().unwrap().clone(),
            })
            .collect()
    }
}

/// Une connexion entrante : on ouvre un canal « direct-tcpip » vers la destination.
async fn serve<H: client::Handler>(
    handle: &client::Handle<H>,
    spec: &TunnelSpec,
    mut socket: TcpStream,
    peer: SocketAddr,
) -> Result<()> {
    let (host, port) = match spec.kind {
        TunnelKind::Local => (spec.remote_host.clone(), spec.remote_port),
        TunnelKind::Dynamic => socks5_handshake(&mut socket).await?,
    };
    let channel = handle
        .channel_open_direct_tcpip(host.clone(), port as u32, peer.ip().to_string(), peer.port() as u32)
        .await;
    let channel = match channel {
        Ok(channel) => channel,
        Err(e) => {
            if spec.kind == TunnelKind::Dynamic {
                // 0x05 : connexion refusée par la destination.
                let _ = socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err(anyhow!("{host}:{port} injoignable depuis le serveur : {e}"));
        }
    };
    if spec.kind == TunnelKind::Dynamic {
        socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    }
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
    Ok(())
}

/// Négociation SOCKS5 (RFC 1928), sans authentification, commande CONNECT seulement.
async fn socks5_handshake(socket: &mut TcpStream) -> Result<(String, u16)> {
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!("Le navigateur doit utiliser un proxy SOCKS5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 0xFF]).await?;
        bail!("Le client SOCKS exige une authentification, non prise en charge");
    }
    socket.write_all(&[5, 0]).await?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await?;
    if request[1] != 1 {
        socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!("Commande SOCKS non prise en charge");
    }
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            socket.read_exact(&mut ip).await?;
            Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let len = socket.read_u8().await? as usize;
            let mut name = vec![0u8; len];
            socket.read_exact(&mut name).await?;
            String::from_utf8(name).context("Nom d'hôte SOCKS invalide")?
        }
        4 => {
            let mut ip = [0u8; 16];
            socket.read_exact(&mut ip).await?;
            Ipv6Addr::from(ip).to_string()
        }
        _ => bail!("Type d'adresse SOCKS inconnu"),
    };
    let port = socket.read_u16().await?;
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn handshake(bytes: &'static [u8]) -> Result<(String, u16)> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(bytes).await.unwrap();
            let mut reply = [0u8; 2];
            c.read_exact(&mut reply).await.unwrap();
            reply
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let result = socks5_handshake(&mut server).await;
        assert_eq!(client.await.unwrap(), [5, 0]);
        result
    }

    #[tokio::test]
    async fn socks5_nom_de_domaine() {
        // version 5, 1 méthode (aucune auth) | CONNECT, domaine « db.local », port 5432
        let req: &[u8] = b"\x05\x01\x00\x05\x01\x00\x03\x08db.local\x15\x38";
        assert_eq!(handshake(req).await.unwrap(), ("db.local".into(), 5432));
    }

    #[tokio::test]
    async fn socks5_ipv4() {
        let req: &[u8] = &[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 12, 0, 80];
        assert_eq!(handshake(req).await.unwrap(), ("10.0.0.12".into(), 80));
    }
}
