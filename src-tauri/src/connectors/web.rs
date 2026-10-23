use anyhow::{bail, Context, Result};
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

use crate::connector::*;

/// Consoles d'administration web (NAS, routeur, hyperviseur…).
pub struct WebConnector;

impl Connector for WebConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "web".into(),
            name: "Interface web".into(),
            version: "0.1.0".into(),
            description: "Ouvre une console d'administration dans une fenêtre dédiée, isolée de l'application.".into(),
            view: ViewKind::Web,
            builtin: true,
            fields: vec![Field::new("url", "Adresse", FieldKind::Text)
                .required()
                .placeholder("https://192.168.1.10:5001")],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let raw = ctx.require("url", "Adresse")?;
        let url = Url::parse(&raw).with_context(|| format!("Adresse invalide : {raw}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("Seules les adresses http:// et https:// sont acceptées");
        }

        let label = format!("web-{}", uuid::Uuid::new_v4().simple());
        WebviewWindowBuilder::new(&ctx.app, label, WebviewUrl::External(url))
            .title(format!("{} — Termoria", ctx.session_name))
            .inner_size(1200.0, 800.0)
            .build()?;
        Ok(Outcome::Detached(format!("{} ouvert dans une nouvelle fenêtre", ctx.session_name)))
    }
}
