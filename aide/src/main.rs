//! Portunia Assist : le programme de la personne aidée.
//!
//!   portunia-assist --relais wss://acces.exemple.fr/assistance/relais   assistance par le relais d'un bastion
//!   portunia-assist --ecoute 127.0.0.1:13390                            essai : serveur RDP local direct
//! Options d'essai : --mire (mire au lieu de l'écran), --saisie-notee (souris et clavier notés,
//! pas rejoués), --accord-auto (accepte sans demander).

mod display;
mod input;
mod relay;

use std::{net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use ironrdp_server::{
    tokio_rustls::{
        rustls::{
            self,
            pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
        },
        TlsAcceptor,
    },
    RdpServer,
};

pub type Server = RdpServer;

/// Certificat TLS jetable, créé à chaque lancement (la session est en plus chiffrée de bout en
/// bout par le code quand elle passe par le relais).
fn tls() -> Result<TlsAcceptor> {
    let cert = rcgen::generate_simple_self_signed(vec!["portunia-assist".into()])?;
    let der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![der], key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

struct Options {
    source: display::Source,
    noted: bool,
}

/// Serveur RDP de l'écran ; sans contrôle accordé, la souris et le clavier sont ignorés.
fn server(opts: &Options, addr: SocketAddr, control: bool) -> Result<RdpServer> {
    let display = display::Display::new(opts.source)?;
    let (width, height) = display.desktop();
    let input = input::Input { dry_run: opts.noted, ignore: !control, width, height, log: Vec::new() };
    Ok(RdpServer::builder().with_addr(addr).with_tls(tls()?).with_input_handler(input).with_display_handler(display).build())
}

/// Fenêtre provisoire en ligne de commande (la vraie fenêtre vient ensuite).
struct Console {
    auto: bool,
}

impl relay::Ui for Console {
    fn code(&mut self, code: &str) {
        eprintln!("CODE {code}");
    }
    fn consent(&mut self, who: &str) -> Option<bool> {
        if self.auto {
            eprintln!("accord donné à {who} (essai)");
            return Some(true);
        }
        eprint!("{who} veut vous aider. Accepter ? [o/N] ");
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok()?;
        line.trim().eq_ignore_ascii_case("o").then_some(true)
    }
    fn connected(&mut self, who: &str, control: bool) {
        eprintln!("{who} {} votre écran", if control { "voit et contrôle" } else { "voit" });
    }
    fn ended(&mut self, reason: &str) {
        eprintln!("FIN {reason}");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let value = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    // Diagnostic : RUST_LOG=ironrdp=debug.
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).with_writer(std::io::stderr).init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let opts = Options { source: if flag("--mire") { display::Source::Pattern } else { display::Source::Screen }, noted: flag("--saisie-notee") };

    if let Some(url) = value("--relais") {
        let mut ui = Console { auto: flag("--accord-auto") };
        let any: SocketAddr = ([127, 0, 0, 1], 0).into();
        let local = tokio::task::LocalSet::new();
        return local.run_until(relay::run(&url, None, &mut ui, |control| server(&opts, any, control).expect("serveur RDP"))).await;
    }
    let addr: SocketAddr = value("--ecoute").unwrap_or_else(|| "127.0.0.1:13390".into()).parse().context("adresse d'écoute")?;
    eprintln!("Portunia Assist : serveur RDP d'essai sur {addr}");
    server(&opts, addr, true)?.run().await
}
