//! VNC (RFB) affiché dans un onglet, grâce au moteur vnc-rs.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tokio::{
    net::TcpStream,
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
};
use vnc::{PixelFormat, VncClient, VncConnector as Rfb, VncEncoding, VncEvent, X11Event};

use crate::connector::*;

pub struct VncConnector;

impl Connector for VncConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "vnc".into(),
            name: "VNC".into(),
            version: "0.1.0".into(),
            description: t!("Remote screen (Linux, macOS, Raspberry Pi…) shown in a tab.", "Écran distant (Linux, macOS, Raspberry Pi…) affiché dans un onglet.").into(),
            view: ViewKind::Screen,
            builtin: true,
            file_browser: false,
            port_forwarding: false,
            fields: vec![
                Field::new("host", t!("Host", "Hôte"), FieldKind::Text).required(),
                Field::new("port", "Port", FieldKind::Number).default(5900),
                Field::new("credential", t!("Shared credentials", "Identifiants partagés"), FieldKind::Suggest { source: "credentials".into() })
                    .placeholder(t!("Empty = this session's own credentials", "Vide = identifiants propres à cette session")),
                Field::new("password", t!("VNC password", "Mot de passe VNC"), FieldKind::Secret).hidden_by("credential"),
                Field::new("viewOnly", t!("View only (no keyboard or mouse)", "Lecture seule (ni clavier ni souris)"), FieldKind::Bool).default(false),
                Field::new("mac", t!("MAC address (Wake-on-LAN)", "Adresse MAC (Wake-on-LAN)"), FieldKind::Text)
                    .placeholder(t!("Optional: AA:BB:CC:DD:EE:FF, to wake the machine up", "Facultatif : AA:BB:CC:DD:EE:FF, pour réveiller la machine")),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let host = ctx.require("host", t!("Host", "Hôte"))?;
        let port = ctx.port(5900)?;
        let password = ctx.raw("password").unwrap_or_default();
        let view_only = ctx.bool("viewOnly");

        let client = tauri::async_runtime::block_on(async {
            let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| anyhow!("{}", t!(format!("No answer from {host}:{port} (timed out)"), format!("Pas de réponse de {host}:{port} (délai dépassé)"))))?
                .with_context(|| format!("Connexion impossible à {host}:{port}"))?;
            let handshake = Rfb::new(tcp)
                .set_auth_method(async move { Ok(password) })
                .add_encoding(VncEncoding::Tight)
                .add_encoding(VncEncoding::Zrle)
                .add_encoding(VncEncoding::CopyRect)
                .add_encoding(VncEncoding::Raw)
                .add_encoding(VncEncoding::DesktopSizePseudo)
                .allow_shared(true)
                .set_pixel_format(PixelFormat::rgba())
                .build()
                .map_err(|e| anyhow!("{e}"))?
                .try_start();
            let client = tokio::time::timeout(Duration::from_secs(20), handshake)
                .await
                .map_err(|_| anyhow!(t!("The VNC server is not answering", "Le serveur VNC ne répond pas")))?
                .map_err(|e| anyhow!("{}", t!(format!("VNC connection failed: {e}"), format!("Échec de la connexion VNC : {e}"))))?
                .finish()
                .map_err(|e| anyhow!("{e}"))?;
            Ok::<VncClient, anyhow::Error>(client)
        })?;

        let (tx, rx) = unbounded_channel();
        let sink = ctx.sink.clone();
        tauri::async_runtime::spawn(async move {
            let result = pump(&client, rx, sink.as_ref()).await;
            let _ = client.close().await;
            sink.closed(result.err().map(|e| format!("{e:#}")));
        });
        Ok(Outcome::Terminal(Box::new(VncSession { tx, view_only })))
    }
}

enum Msg {
    Input(InputEvent),
    Close,
}

struct VncSession {
    tx: UnboundedSender<Msg>,
    view_only: bool,
}

impl TerminalConnection for VncSession {
    fn write(&self, _data: &[u8]) -> Result<()> {
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }

    fn close(&self) {
        let _ = self.tx.send(Msg::Close);
    }

    fn input(&self, event: InputEvent) -> Result<()> {
        if self.view_only && !matches!(event, InputEvent::Clipboard { .. }) {
            return Ok(());
        }
        // Le serveur VNC garde sa propre résolution.
        if matches!(event, InputEvent::Resize { .. }) {
            return Ok(());
        }
        self.tx.send(Msg::Input(event)).map_err(|_| anyhow!(t!("Session closed", "Session fermée")))
    }
}

/// Relaie les images du serveur et la saisie de l'interface.
async fn pump(client: &VncClient, mut rx: UnboundedReceiver<Msg>, sink: &dyn Sink) -> Result<()> {
    // Le serveur n'envoie une nouvelle image que si on la demande : environ 25 fois par seconde.
    let mut refresh = tokio::time::interval(Duration::from_millis(40));
    loop {
        tokio::select! {
            event = client.recv_event() => {
                let event = event.map_err(|e| anyhow!("{e}"))?;
                if let Some(screen) = to_screen(event)? {
                    sink.screen(screen);
                }
            }
            msg = rx.recv() => match msg {
                Some(Msg::Input(input)) => client.input(to_x11(input)).await.map_err(|e| anyhow!("{e}"))?,
                Some(Msg::Close) | None => return Ok(()),
            },
            _ = refresh.tick() => client.input(X11Event::Refresh).await.map_err(|e| anyhow!("{e}"))?,
        }
    }
}

fn to_screen(event: VncEvent) -> Result<Option<ScreenEvent>> {
    Ok(Some(match event {
        VncEvent::SetResolution(screen) => ScreenEvent::Resize { width: screen.width, height: screen.height },
        VncEvent::RawImage(rect, mut data) => {
            // Certains serveurs laissent l'octet alpha à 0 : on rend l'image opaque.
            for pixel in data.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            ScreenEvent::Image { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rgba: B64.encode(&data) }
        }
        VncEvent::JpegImage(rect, data) => {
            ScreenEvent::Jpeg { x: rect.x, y: rect.y, width: rect.width, height: rect.height, data: B64.encode(&data) }
        }
        VncEvent::Copy(dst, src) => ScreenEvent::Copy {
            x: dst.x,
            y: dst.y,
            width: dst.width,
            height: dst.height,
            src_x: src.x,
            src_y: src.y,
        },
        VncEvent::Bell => ScreenEvent::Bell,
        VncEvent::Text(text) => ScreenEvent::Clipboard { text },
        VncEvent::Error(message) => bail!("{message}"),
        _ => return Ok(None),
    }))
}

fn to_x11(input: InputEvent) -> X11Event {
    match input {
        InputEvent::Key { keysym, down, .. } => X11Event::KeyEvent((keysym, down).into()),
        InputEvent::Pointer { x, y, buttons } => X11Event::PointerEvent((x, y, buttons).into()),
        InputEvent::Clipboard { text } => X11Event::CopyText(text),
        InputEvent::Resize { .. } => X11Event::Refresh,
    }
}

