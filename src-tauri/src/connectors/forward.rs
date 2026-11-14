//! Tunnels SSH : redirection de port locale (ssh -L), proxy SOCKS5 (ssh -D) et
//! redirection inverse (ssh -R). Les ports de ce PC n'écoutent que sur 127.0.0.1,
//! ceux du serveur que sur sa boucle locale : rien n'est exposé au réseau.

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
    /// Écoute locale (-L, -D) ; aucune pour -R (c'est le serveur qui écoute).
    listener: Option<JoinHandle<()>>,
    /// Port ouvert sur le serveur (-R).
    remote_port: Option<u32>,
    stats: Arc<Stats>,
}

#[derive(Default)]
pub struct Stats {
    connections: AtomicU32,
    last_error: Mutex<Option<String>>,
}

/// Destination d'un port ouvert sur le serveur (-R), partagée avec le gestionnaire SSH
/// qui reçoit les connexions « forwarded-tcpip ».
pub struct RemoteTarget {
    pub host: String,
    pub port: u16,
    pub stats: Arc<Stats>,
}

pub type RemoteForwards = Arc<Mutex<HashMap<u32, RemoteTarget>>>;

pub struct SshForwarder<H: client::Handler> {
    handle: Arc<client::Handle<H>>,
    running: Mutex<HashMap<String, Running>>,
    remote: RemoteForwards,
}

impl<H: client::Handler> SshForwarder<H> {
    pub fn new(handle: Arc<client::Handle<H>>, remote: RemoteForwards) -> Self {
        Self {
            handle,
            running: Mutex::new(HashMap::new()),
            remote,
        }
    }
}

impl<H: client::Handler> Drop for SshForwarder<H> {
    fn drop(&mut self) {
        for (_, tunnel) in self.running.lock().unwrap().drain() {
            if let Some(l) = tunnel.listener {
                l.abort();
            }
        }
    }
}

impl<H: client::Handler + 'static> PortForwarder for SshForwarder<H> {
    fn start(&self, spec: TunnelSpec) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if spec.kind != TunnelKind::Dynamic && (spec.remote_host.trim().is_empty() || spec.remote_port == 0) {
                bail!(t!("Give the destination host and port", "Indiquez l'hôte et le port de destination"));
            }
            if self.running.lock().unwrap().contains_key(&spec.id) {
                return Ok(());
            }
            if spec.kind == TunnelKind::Remote {
                // Le serveur écoute sur sa boucle locale ; ses connexions arrivent au gestionnaire SSH.
                let port = self
                    .handle
                    .tcpip_forward("127.0.0.1", spec.bind_port as u32)
                    .await
                    .map_err(|e| anyhow!("{}", t!(format!("The server refuses to open port {}: {e} (AllowTcpForwarding?)", spec.bind_port), format!("Le serveur refuse d'ouvrir le port {} : {e} (AllowTcpForwarding ?)", spec.bind_port))))?;
                let port = if port == 0 { spec.bind_port as u32 } else { port };
                let stats = Arc::new(Stats::default());
                self.remote.lock().unwrap().insert(port, RemoteTarget { host: spec.remote_host.clone(), port: spec.remote_port, stats: stats.clone() });
                self.running.lock().unwrap().insert(spec.id.clone(), Running { spec, listener: None, remote_port: Some(port), stats });
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
            self.running.lock().unwrap().insert(spec.id.clone(), Running { spec, listener: Some(task), remote_port: None, stats });
            Ok(())
        })
    }

    fn stop(&self, id: &str) {
        let Some(tunnel) = self.running.lock().unwrap().remove(id) else { return };
        if let Some(l) = tunnel.listener {
            l.abort();
        }
        if let Some(port) = tunnel.remote_port {
            self.remote.lock().unwrap().remove(&port);
            let handle = self.handle.clone();
            spawn(async move {
                let _ = handle.cancel_tcpip_forward("127.0.0.1", port).await;
            });
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
        TunnelKind::Remote => unreachable!("-R : pas d'écoute locale"),
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
            return Err(anyhow!("{}", t!(format!("{host}:{port} unreachable from the server: {e}"), format!("{host}:{port} injoignable depuis le serveur : {e}"))));
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
pub(crate) async fn socks5_handshake(socket: &mut TcpStream) -> Result<(String, u16)> {
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!(t!("The browser must use a SOCKS5 proxy", "Le navigateur doit utiliser un proxy SOCKS5"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 0xFF]).await?;
        bail!(t!("The SOCKS client requires authentication, not supported", "Le client SOCKS exige une authentification, non prise en charge"));
    }
    socket.write_all(&[5, 0]).await?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await?;
    if request[1] != 1 {
        socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!(t!("SOCKS command not supported", "Commande SOCKS non prise en charge"));
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
            String::from_utf8(name).context(t!("Invalid SOCKS host name", "Nom d'hôte SOCKS invalide"))?
        }
        4 => {
            let mut ip = [0u8; 16];
            socket.read_exact(&mut ip).await?;
            Ipv6Addr::from(ip).to_string()
        }
        _ => bail!(t!("Unknown SOCKS address type", "Type d'adresse SOCKS inconnu")),
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

/// Connexion arrivée par un port ouvert sur le serveur (-R) : reliée à la destination sur ce PC.
pub async fn serve_remote(channel: russh::Channel<client::Msg>, host: String, port: u16, stats: Arc<Stats>) {
    stats.connections.fetch_add(1, Ordering::Relaxed);
    let result = async {
        let mut local = TcpStream::connect((host.as_str(), port))
            .await
            .with_context(|| format!("{host}:{port} injoignable depuis ce PC"))?;
        let mut remote = channel.into_stream();
        tokio::io::copy_bidirectional(&mut remote, &mut local).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(e) = result {
        *stats.last_error.lock().unwrap() = Some(format!("{e:#}"));
    }
    stats.connections.fetch_sub(1, Ordering::Relaxed);
}
