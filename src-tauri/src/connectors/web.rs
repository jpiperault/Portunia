use anyhow::{bail, Context, Result};
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

use crate::connector::*;

/// Consoles d'administration web (NAS, routeur, hyperviseur…).
pub struct WebConnector;

impl Connector for WebConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "web".into(),
            name: t!("Web interface", "Interface web").into(),
            version: "0.1.0".into(),
            description: t!("Opens an administration console in a dedicated window, isolated from the app.", "Ouvre une console d'administration dans une fenêtre dédiée, isolée de l'application.").into(),
            view: ViewKind::Web,
            builtin: true,
            catalog: false,
            file_browser: false,
            port_forwarding: false,
            fields: vec![Field::new("url", t!("Address", "Adresse"), FieldKind::Text)
                .required()
                .placeholder("https://192.168.1.10:5001")],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let raw = ctx.require("url", t!("Address", "Adresse"))?;
        let url = Url::parse(&raw).with_context(|| format!("Adresse invalide : {raw}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!(t!("Only http:// and https:// addresses are accepted", "Seules les adresses http:// et https:// sont acceptées"));
        }

        let label = format!("web-{}", uuid::Uuid::new_v4().simple());
        WebviewWindowBuilder::new(&ctx.app, label, WebviewUrl::External(url))
            .title(format!("{} — Portunia", ctx.session_name))
            .inner_size(1200.0, 800.0)
            .build()?;
        Ok(Outcome::Detached(format!("{} ouvert dans une nouvelle fenêtre", ctx.session_name)))
    }
}
