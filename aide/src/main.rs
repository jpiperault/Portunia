#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Portunia Assist : le programme de la personne aidée.
//!
//! Sans option : fenêtre, relais trouvé dans le nom du fichier téléchargé.
//!   portunia-assistance --relais wss://acces.exemple.fr/assistance/relais   relais donné
//!   portunia-assistance --console --relais URL [--accord-auto]              essai sans fenêtre
//!   portunia-assistance --ecoute 127.0.0.1:13390                            essai : serveur RDP local direct
//! Options d'essai : --mire (mire au lieu de l'écran), --saisie-notee (souris et clavier notés,
//! pas rejoués).
//!
//! Les modes d'essai (--ecoute, --console, --accord-auto, --demo, --mire, --saisie-notee) n'existent
//! qu'avec la fonctionnalité Cargo « essai » : la version publiée ne peut pas être détournée en
//! serveur de prise en main sans accord (`cargo build --features essai` pour les essais).

mod display;
mod input;
mod relay;
mod ui;

use std::{net::SocketAddr, sync::Arc};

#[cfg(feature = "essai")]
use anyhow::Context;
use anyhow::Result;
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
    let cert = rcgen::generate_simple_self_signed(vec!["portunia-assistance".into()])?;
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
#[cfg(feature = "essai")]
struct Console {
    auto: bool,
}

#[cfg(feature = "essai")]
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

/// Texte dans la langue de Windows.
pub fn t(en: &'static str, fr: &'static str) -> &'static str {
    if ui::system_is_french() {
        fr
    } else {
        en
    }
}

/// Adresse du relais : donnée en option, sinon lue dans le nom du fichier téléchargé
/// (« Portunia Assist (acces.exemple.fr).exe », posé par la page de la Gate), sinon dans la
/// note de téléchargement que Windows garde sur le fichier (adresse d'origine).
fn relay_url(explicit: Option<String>) -> Option<String> {
    if explicit.is_some() {
        return explicit;
    }
    let exe = std::env::current_exe().ok()?;
    let name = exe.file_stem()?.to_string_lossy().to_string();
    let host = name
        .split(['(', ')'])
        .map(str::trim)
        .find(|part| part.contains('.') && part.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)))
        .map(String::from)
        .or_else(|| {
            // Flux NTFS « Zone.Identifier » : HostUrl=https://acces.exemple.fr/assistance/…
            let note = std::fs::read_to_string(format!("{}:Zone.Identifier", exe.display())).ok()?;
            let url = note.lines().find_map(|l| l.strip_prefix("HostUrl="))?;
            let rest = url.strip_prefix("https://")?;
            Some(rest.split('/').next()?.to_string())
        })?;
    Some(format!("wss://{host}/assistance/relais"))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let value = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    // Diagnostic : RUST_LOG=ironrdp=debug.
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).with_writer(std::io::stderr).init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let essai = cfg!(feature = "essai");
    let opts = Options { source: if essai && flag("--mire") { display::Source::Pattern } else { display::Source::Screen }, noted: essai && flag("--saisie-notee") };
    let any: SocketAddr = ([127, 0, 0, 1], 0).into();
    let runtime = || tokio::runtime::Builder::new_current_thread().enable_all().build();

    // Essai : serveur RDP local direct.
    #[cfg(feature = "essai")]
    if let Some(addr) = value("--ecoute") {
        let addr: SocketAddr = addr.parse().context("adresse d'écoute")?;
        eprintln!("Portunia Assistance : serveur RDP d'essai sur {addr}");
        return runtime()?.block_on(async { server(&opts, addr, true)?.run().await });
    }
    // Essai en ligne de commande, sans fenêtre.
    #[cfg(feature = "essai")]
    if flag("--console") {
        let url = value("--relais").context("--relais attendu")?;
        let mut ui = Console { auto: flag("--accord-auto") };
        let (_stop_tx, stop) = tokio::sync::watch::channel(false);
        let local = tokio::task::LocalSet::new();
        return runtime()?.block_on(local.run_until(relay::run(&url, None, &mut ui, |control| server(&opts, any, control).expect("serveur RDP"), stop)));
    }
    // Démonstration : les écrans à la suite, chacun photographié (fenêtre seule) dans le dossier donné.
    #[cfg(feature = "essai")]
    if let Some(dir) = value("--demo") {
        let (stop_tx, _stop) = tokio::sync::watch::channel(false);
        std::thread::spawn(move || ui::demo(&dir));
        ui::run(stop_tx);
        return Ok(());
    }
    // Fenêtre : la session tourne sur un fil à part, la fenêtre sur le fil principal.
    let (stop_tx, stop) = tokio::sync::watch::channel(false);
    let url = relay_url(value("--relais"));
    std::thread::spawn(move || {
        let Some(url) = url else {
            ui::error(t(
                "Portunia Assistance does not know which server to use. Download it again from the page given by the person helping you.",
                "Portunia Assistance ne sait pas quel serveur utiliser. Téléchargez-le de nouveau depuis la page donnée par la personne qui vous aide.",
            ));
            return;
        };
        let result = runtime().map_err(anyhow::Error::from).and_then(|rt| {
            let local = tokio::task::LocalSet::new();
            rt.block_on(local.run_until(relay::run(&url, None, &mut ui::WindowUi, |control| server(&opts, any, control).expect("serveur RDP"), stop)))
        });
        if let Err(e) = result {
            ui::error(&format!("{e:#}"));
        }
    });
    ui::run(stop_tx);
    Ok(())
}
