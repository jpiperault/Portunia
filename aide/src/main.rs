//! Portunia Assist : le programme de la personne aidée.
//!
//! Essai (étape 1) : serveur RDP sur une adresse locale, connecté directement par le moteur
//! RDP de Portunia. Viendront ensuite le relais chiffré, le code et la fenêtre d'accord.
//!
//!   portunia-assist --ecoute 127.0.0.1:13390 [--mire] [--saisie-notee]

mod display;
mod input;

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

/// Certificat TLS jetable, créé à chaque lancement.
fn tls() -> Result<TlsAcceptor> {
    let cert = rcgen::generate_simple_self_signed(vec!["portunia-assist".into()])?;
    let der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![der], key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let value = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let addr: SocketAddr = value("--ecoute").unwrap_or_else(|| "127.0.0.1:13390".into()).parse().context("adresse d'écoute")?;
    let source = if flag("--mire") { display::Source::Pattern } else { display::Source::Screen };

    // Diagnostic : RUST_LOG=ironrdp=debug.
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).with_writer(std::io::stderr).init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let display = display::Display::new(source)?;
    let (width, height) = display.desktop();
    let input = input::Input { dry_run: flag("--saisie-notee"), width, height, log: Vec::new() };
    let mut server = RdpServer::builder()
        .with_addr(addr)
        .with_tls(tls()?)
        .with_input_handler(input)
        .with_display_handler(display)
        .build();
    eprintln!("Portunia Assist : serveur RDP d'essai sur {addr}");
    server.run().await
}
