use std::{fs, process::Command};

use anyhow::{Context, Result};

use super::single_line;
use crate::connector::*;

/// Bureau à distance via le client intégré à Windows (mstsc) : rien à installer.
pub struct RdpConnector;

impl Connector for RdpConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "rdp".into(),
            name: "Bureau à distance (RDP)".into(),
            version: "0.1.0".into(),
            description: "S'appuie sur le client RDP de Windows. S'ouvre dans sa propre fenêtre.".into(),
            view: ViewKind::Desktop,
            builtin: true,
            file_browser: false,
            fields: vec![
                Field::new("host", "Hôte", FieldKind::Text).required(),
                Field::new("port", "Port", FieldKind::Number).default(3389),
                Field::new("username", "Utilisateur", FieldKind::Text)
                    .placeholder("DOMAINE\\utilisateur"),
                Field::new("fullscreen", "Plein écran", FieldKind::Bool).default(false),
                Field::new("multimon", "Utiliser tous les écrans", FieldKind::Bool).default(false),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let host = ctx.require("host", "Hôte")?;
        let port = ctx.port(3389)?;
        let username = ctx.str("username").unwrap_or_default();
        single_line(&host, "L'hôte")?;
        single_line(&username, "L'utilisateur")?;

        let mut lines = vec![
            format!("full address:s:{host}:{port}"),
            format!("screen mode id:i:{}", if ctx.bool("fullscreen") { 2 } else { 1 }),
            format!("use multimon:i:{}", ctx.bool("multimon") as u8),
            "prompt for credentials:i:0".into(),
            "authentication level:i:2".into(),
        ];
        if !username.is_empty() {
            lines.push(format!("username:s:{username}"));
        }

        // Fichier .rdp en UTF-16 avec BOM, comme ceux enregistrés par Windows.
        let dir = ctx.data_dir.join("rdp");
        fs::create_dir_all(&dir)?;
        let safe_name: String = ctx
            .session_name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        let path = dir.join(format!("{safe_name}.rdp"));
        let mut bytes = vec![0xFF, 0xFE];
        for unit in (lines.join("\r\n") + "\r\n").encode_utf16() {
            bytes.extend(unit.to_le_bytes());
        }
        fs::write(&path, bytes)?;

        Command::new("mstsc.exe")
            .arg(&path)
            .spawn()
            .context("Impossible de lancer le client Bureau à distance (mstsc.exe)")?;
        Ok(Outcome::Detached(format!("Bureau à distance ouvert vers {host}")))
    }
}
