//! Serveur SSH de test, sur ce PC (127.0.0.1:2222), pour essayer la saisie des identifiants
//! dans le terminal sans Docker ni vrai serveur.
//!
//! - refuse toutes les clés et l'agent : Termoria doit demander le mot de passe ;
//! - accepte seulement `test` / `termoria-test` ;
//! - ouvre un faux shell qui répète ce qu'on tape.
//!
//! Lancement (clé d'hôte créée avant par ssh-keygen) :
//!   cargo run --example serveur-ssh-test -- <fichier de clé d'hôte>

use std::sync::Arc;

use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};

const USER: &str = "test";
const PASSWORD: &str = "termoria-test";

#[derive(Clone, Default)]
struct Server {
    line: String,
    /// Canal du shell : les autres (SFTP du panneau Fichiers…) sont ignorés.
    shell: Option<ChannelId>,
}

impl russh::server::Server for Server {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self::default()
    }
    fn handle_session_error(&mut self, error: <Self::Handler as russh::server::Handler>::Error) {
        println!("erreur de session : {error:?}");
    }
}

impl russh::server::Handler for Server {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, user: &str, _key: &russh::keys::PublicKey) -> Result<Auth, Self::Error> {
        println!("clé refusée pour {user}");
        Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        let ok = user == USER && password == PASSWORD;
        println!("mot de passe pour {user} : {}", if ok { "accepté" } else { "refusé" });
        Ok(if ok { Auth::Accept } else { Auth::Reject { proceed_with_methods: None, partial_success: false } })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        self.shell = Some(channel);
        session.channel_success(channel)?;
        session.data(channel, format!("Serveur de test Termoria : connecté en tant que {USER}.\r\n{USER}@test:~$ ").into_bytes())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if self.shell != Some(channel) {
            return Ok(());
        }
        for &b in data {
            match b {
                b'\r' => {
                    let reply = if self.line.is_empty() { String::new() } else { format!("vous avez tapé : {}\r\n", self.line) };
                    self.line.clear();
                    session.data(channel, format!("\r\n{reply}{USER}@test:~$ ").into_bytes())?;
                }
                3 | 4 => return Err(russh::Error::Disconnect),
                0x7f => {
                    if self.line.pop().is_some() {
                        session.data(channel, b"\x08 \x08".to_vec())?;
                    }
                }
                _ => {
                    self.line.push(b as char);
                    session.data(channel, vec![b])?;
                }
            }
        }
        Ok(())
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let path = std::env::args().nth(1).expect("chemin de la clé d'hôte (ssh-keygen -t ed25519 -N \"\" -f …)");
    let key = russh::keys::load_secret_key(&path, None).expect("clé d'hôte illisible");
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: std::time::Duration::from_millis(300),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    println!("Serveur SSH de test sur 127.0.0.1:2222 ({USER} / {PASSWORD})");
    Server::default().run_on_address(config, ("127.0.0.1", 2222)).await.unwrap();
}
