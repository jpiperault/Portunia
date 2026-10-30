//! Relecture d'une session Bureau à distance enregistrée par un bastion Heimdia.
//!
//! Le bastion fournit les messages du serveur, dans l'ordre et avec leur temps (fichier :
//! temps f64, longueur u32, message, à la suite). Ils sont rejoués dans IronRDP comme si le
//! serveur les envoyait : la séquence de connexion d'abord (négociation simulée en TLS simple,
//! l'authentification NLA n'étant pas enregistrée), puis l'image. Ce qu'IronRDP voudrait
//! répondre au serveur est ignoré.
//!
//! Commandes (une ligne JSON) : { "type": "seek", "t": secondes } décode jusqu'à ce temps et
//! envoie les zones changées ; { "type": "close" }. Revenir en arrière redécode depuis le début.

use std::net::{Ipv4Addr, SocketAddr};

use anyhow::{Context, Result};
use ironrdp_connector::{
    connection_activation::{ConnectionActivationSequence, ConnectionActivationState},
    BitmapConfig, ClientConnector, ClientConnectorState, ConnectionResult, Credentials, DesktopSize, Sequence,
};
use ironrdp_core::WriteBuf;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::{
    gcc::KeyboardType,
    nego::{ConnectionConfirm, ResponseFlags, SecurityProtocol},
    rdp::{
        capability_sets::{client_codecs_capabilities, MajorPlatformType},
        client_info::{CompressionType, PerformanceFlags, TimezoneInfo},
    },
    x224::X224,
    Action,
};
use ironrdp_session::{fast_path, image::DecodedImage, ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use serde::Deserialize;
use tokio::io::BufReader;

use crate::{emit, Output};

/// Messages du serveur avec leur temps.
fn load(path: &str) -> Result<Vec<(f64, Vec<u8>)>> {
    let raw = std::fs::read(path).context("lecture de l'enregistrement")?;
    let mut frames = Vec::new();
    let mut at = 0;
    while at + 12 <= raw.len() {
        let t = f64::from_be_bytes(raw[at..at + 8].try_into()?);
        let len = u32::from_be_bytes(raw[at + 8..at + 12].try_into()?) as usize;
        let Some(bytes) = raw.get(at + 12..at + 12 + len) else { break };
        frames.push((t, bytes.to_vec()));
        at += 12 + len;
    }
    Ok(frames)
}

/// Configuration du client rejoué : celle de Portunia (compression MPPC 64 Ko, codecs
/// par défaut), sans NLA.
fn config() -> Result<ironrdp_connector::Config> {
    let codecs = client_codecs_capabilities(&[]).map_err(|e| anyhow::anyhow!(e))?;
    Ok(ironrdp_connector::Config {
        credentials: Credentials::UsernamePassword { username: String::new(), password: String::new() },
        domain: None,
        enable_tls: true,
        enable_credssp: false,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize { width: 1280, height: 720 },
        desktop_scale_factor: 0,
        bitmap: Some(BitmapConfig { color_depth: 32, lossy_compression: true, codecs }),
        client_build: 0,
        client_name: "Portunia".into(),
        client_dir: String::new(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        license_cache: None,
        enable_server_pointer: true,
        autologon: false,
        enable_audio_playback: false,
        request_data: None,
        pointer_software_rendering: false,
        multitransport_flags: None,
        compression_type: Some(CompressionType::K64),
        performance_flags: PerformanceFlags::default(),
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    })
}

/// État du décodage.
enum Stage {
    /// Séquence de connexion en cours.
    Connecting(Box<ClientConnector>),
    /// Session : image décodée au fil des messages.
    Active { stage: Box<ActiveStage>, image: DecodedImage, result: Box<ConnectionResult> },
    /// Redimensionnement côté serveur : nouvelle séquence d'activation.
    Reactivating { stage: Box<ActiveStage>, image: DecodedImage, result: Box<ConnectionResult>, seq: Box<ConnectionActivationSequence> },
}

struct Decoder {
    stage: Option<Stage>,
    buf: WriteBuf,
}

impl Decoder {
    fn new() -> Result<Self> {
        let mut connector = ClientConnector::new(config()?, SocketAddr::from((Ipv4Addr::LOCALHOST, 0)));
        let mut buf = WriteBuf::new();
        // Demande X.224 (ignorée), puis la réponse du serveur simulée : TLS sans NLA.
        connector.step_no_input(&mut buf)?;
        let confirm = X224(ConnectionConfirm::Response { flags: ResponseFlags::empty(), protocol: SecurityProtocol::SSL });
        let confirm = ironrdp_core::encode_vec(&confirm).map_err(|e| anyhow::anyhow!("{e}"))?;
        buf.clear();
        connector.step(&confirm, &mut buf)?;
        connector.mark_security_upgrade_as_done();
        let mut d = Self { stage: Some(Stage::Connecting(Box::new(connector))), buf };
        d.advance()?;
        Ok(d)
    }

    /// Fait les étapes qui n'attendent rien du serveur.
    fn advance(&mut self) -> Result<()> {
        if let Some(Stage::Connecting(c)) = &mut self.stage {
            while c.next_pdu_hint().is_none() && !matches!(c.state, ClientConnectorState::Connected { .. }) {
                self.buf.clear();
                c.step_no_input(&mut self.buf)?;
            }
            if matches!(c.state, ClientConnectorState::Connected { .. }) {
                let Some(Stage::Connecting(c)) = self.stage.take() else { unreachable!() };
                let ClientConnectorState::Connected { mut result } = c.state else { unreachable!() };
                let stage = ActiveStageBuilder {
                    static_channels: std::mem::take(&mut result.static_channels),
                    user_channel_id: result.user_channel_id,
                    io_channel_id: result.io_channel_id,
                    message_channel_id: result.message_channel_id,
                    share_id: result.share_id,
                    compression_type: result.compression_type,
                    enable_server_pointer: result.enable_server_pointer,
                    pointer_software_rendering: true,
                }
                .build();
                let image = DecodedImage::new(PixelFormat::RgbA32, result.desktop_size.width, result.desktop_size.height);
                self.stage = Some(Stage::Active { stage: Box::new(stage), image, result: Box::new(result) });
            }
        }
        if let Some(Stage::Reactivating { seq, .. }) = &mut self.stage {
            while seq.next_pdu_hint().is_none() && !matches!(seq.connection_activation_state(), ConnectionActivationState::Finalized { .. }) {
                self.buf.clear();
                seq.step_no_input(&mut self.buf)?;
            }
            if let ConnectionActivationState::Finalized { desktop_size, share_id, enable_server_pointer, .. } = seq.connection_activation_state() {
                let Some(Stage::Reactivating { mut stage, result, seq, .. }) = self.stage.take() else { unreachable!() };
                let bulk = result
                    .compression_type
                    .and_then(|ct| ironrdp_bulk::BulkCompressor::new(bulk_type(ct)).ok());
                stage.set_fastpath_processor(
                    fast_path::ProcessorBuilder {
                        io_channel_id: seq.io_channel_id(),
                        user_channel_id: seq.user_channel_id(),
                        share_id,
                        enable_server_pointer,
                        pointer_software_rendering: true,
                        bulk_decompressor: bulk,
                    }
                    .build(),
                );
                stage.set_share_id(share_id);
                stage.set_enable_server_pointer(enable_server_pointer);
                let image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                self.stage = Some(Stage::Active { stage, image, result });
            }
        }
        Ok(())
    }

    /// Un message du serveur. Une erreur n'arrête pas la relecture : le message est sauté.
    fn feed(&mut self, frame: &[u8]) {
        if let Err(e) = self.try_feed(frame) {
            // Diagnostic : PORTUNIA_RDP_DEBUG=1 affiche les messages sautés.
            if std::env::var_os("PORTUNIA_RDP_DEBUG").is_some() {
                let head: String = frame.iter().take(16).map(|b| format!("{b:02x}")).collect();
                eprintln!("message sauté ({} octets, {head}) : {e:#}", frame.len());
            }
        }
    }

    fn try_feed(&mut self, frame: &[u8]) -> Result<()> {
        self.buf.clear();
        match self.stage.as_mut() {
            Some(Stage::Connecting(c)) => {
                c.step(frame, &mut self.buf)?;
            }
            Some(Stage::Reactivating { seq, .. }) => {
                seq.step(frame, &mut self.buf)?;
            }
            Some(Stage::Active { stage, image, result }) => {
                let action = if frame.first() == Some(&0x03) { Action::X224 } else { Action::FastPath };
                for out in stage.process(image, action, frame)? {
                    if let ActiveStageOutput::DeactivateAll = out {
                        let seq = result.activation_factory.create();
                        let Some(Stage::Active { stage, image, result }) = self.stage.take() else { unreachable!() };
                        self.stage = Some(Stage::Reactivating { stage, image, result, seq: Box::new(seq) });
                        break;
                    }
                }
            }
            None => {}
        }
        self.advance()
    }

    fn image(&self) -> Option<&DecodedImage> {
        match &self.stage {
            Some(Stage::Active { image, .. }) | Some(Stage::Reactivating { image, .. }) => Some(image),
            _ => None,
        }
    }
}

fn bulk_type(ct: CompressionType) -> ironrdp_bulk::CompressionType {
    match ct {
        CompressionType::K8 => ironrdp_bulk::CompressionType::Rdp4,
        CompressionType::K64 => ironrdp_bulk::CompressionType::Rdp5,
        CompressionType::Rdp6 => ironrdp_bulk::CompressionType::Rdp6,
        _ => ironrdp_bulk::CompressionType::Rdp61,
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Command {
    Seek { t: f64 },
    Close,
    #[serde(other)]
    Other,
}

/// Lecteur : décode jusqu'au temps demandé et envoie ce qui a changé à l'écran.
pub async fn run(path: &str, mut lines: tokio::io::Lines<BufReader<tokio::io::Stdin>>) -> Result<()> {
    let frames = load(path)?;
    let duration = frames.last().map(|f| f.0).unwrap_or(0.0);
    emit(&Output::Ready { duration, frames: frames.len() });
    let mut decoder = Decoder::new()?;
    let mut next = 0usize;
    let mut position = 0.0f64;
    let mut previous: Vec<u8> = Vec::new();
    let (mut width, mut height) = (0u16, 0u16);
    while let Ok(Some(line)) = lines.next_line().await {
        let target = match serde_json::from_str::<Command>(&line) {
            Ok(Command::Seek { t }) => t.max(0.0),
            Ok(Command::Close) => break,
            _ => continue,
        };
        // En arrière : on redécode depuis le début.
        if target < position {
            decoder = Decoder::new()?;
            next = 0;
            previous.clear();
        }
        while next < frames.len() && frames[next].0 <= target {
            decoder.feed(&frames[next].1);
            next += 1;
        }
        position = target;
        // Connexion pas encore rejouée, donc pas d'image : la position répond quand même, sinon
        // le lecteur attend indéfiniment sur son « Chargement ».
        let Some(image) = decoder.image() else {
            emit(&Output::Position { t: position });
            continue;
        };
        let (w, h) = (image.width(), image.height());
        if (w, h) != (width, height) || previous.len() != image.data().len() {
            width = w;
            height = h;
            previous = vec![0; image.data().len()];
            emit(&Output::Resize { width, height });
            crate::send_rgba_changes(&[], image.data(), width, height);
        } else {
            crate::send_rgba_changes(&previous, image.data(), width, height);
        }
        previous.clear();
        previous.extend_from_slice(image.data());
        emit(&Output::Position { t: position });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_pdu::{
        bitmap::{BitmapData, BitmapUpdateData, Compression},
        fast_path::{EncryptionFlags, FastPathHeader, FastPathUpdatePdu, Fragmentation, UpdateCode},
        geometry::InclusiveRectangle,
    };

    /// Image non compressée (32 bits, lignes de bas en haut) d'une couleur, en message fast-path.
    fn bitmap(x: u16, y: u16, w: u16, h: u16, bgra: [u8; 4]) -> Vec<u8> {
        let pixels: Vec<u8> = std::iter::repeat_n(bgra, w as usize * h as usize).flatten().collect();
        let update = BitmapUpdateData {
            rectangles: vec![BitmapData {
                rectangle: InclusiveRectangle { left: x, top: y, right: x + w - 1, bottom: y + h - 1 },
                width: w,
                height: h,
                bits_per_pixel: 32,
                compression_flags: Compression::empty(),
                compressed_data_header: None,
                bitmap_data: &pixels,
            }],
        };
        let data = ironrdp_core::encode_vec(&update).unwrap();
        let pdu = FastPathUpdatePdu { fragmentation: Fragmentation::Single, update_code: UpdateCode::Bitmap, compression_flags: None, compression_type: None, data: &data };
        let body = ironrdp_core::encode_vec(&pdu).unwrap();
        let mut out = ironrdp_core::encode_vec(&FastPathHeader::new(EncryptionFlags::empty(), body.len())).unwrap();
        out.extend_from_slice(&body);
        out
    }

    fn pixel(d: &Decoder, x: usize, y: usize) -> [u8; 3] {
        let img = d.image().expect("image");
        let i = (y * img.width() as usize + x) * 4;
        [img.data()[i], img.data()[i + 1], img.data()[i + 2]]
    }

    /// Séquence de connexion réelle (serveur xrdp, enregistrée par Heimdia), puis des images
    /// au format qu'envoie Windows : la relecture redonne les bons pixels, et un retour en
    /// arrière (nouveau décodage) aussi.
    #[test]
    fn relecture_d_images() {
        let file = std::env::temp_dir().join("portunia-essai-relecture.flux");
        let mut raw = include_bytes!("essai-connexion.flux").to_vec();
        for (t, frame) in [(1.0f64, bitmap(100, 100, 64, 64, [0, 0, 255, 255])), (2.0, bitmap(0, 700, 512, 20, [0, 255, 0, 255]))] {
            raw.extend_from_slice(&t.to_be_bytes());
            raw.extend_from_slice(&(frame.len() as u32).to_be_bytes());
            raw.extend_from_slice(&frame);
        }
        std::fs::write(&file, &raw).unwrap();
        let frames = load(file.to_str().unwrap()).unwrap();
        if std::env::var_os("PORTUNIA_GARDER_ESSAI").is_none() {
            std::fs::remove_file(&file).ok();
        }
        assert_eq!(frames.len(), 15);

        let mut d = Decoder::new().unwrap();
        for (t, f) in frames.iter().filter(|f| f.0 <= 1.5) {
            let _ = t;
            d.feed(f);
        }
        assert!(matches!(d.stage, Some(Stage::Active { .. })), "connexion rejouée");
        assert_eq!(d.image().unwrap().width(), 1024);
        assert_eq!(pixel(&d, 130, 130), [255, 0, 0], "carré rouge à 1 s");
        assert_eq!(pixel(&d, 10, 710), [0, 0, 0], "pas encore de bande verte");
        for (_, f) in frames.iter().filter(|f| f.0 > 1.5) {
            d.feed(f);
        }
        assert_eq!(pixel(&d, 10, 710), [0, 255, 0], "bande verte à 2 s");
    }
}
