//! Écran envoyé au dépanneur : capture de l'écran principal à intervalle régulier, et seules
//! les zones qui ont changé partent (carrés de 64 pixels).

use std::{
    num::{NonZeroU16, NonZeroUsize},
    time::Duration,
};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use ironrdp_server::{BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServerDisplay, RdpServerDisplayUpdates};
use tokio::sync::mpsc;

const TILE: usize = 64;
/// Images par seconde au plus (dépannage : la fluidité compte moins que la légèreté).
const INTERVAL: Duration = Duration::from_millis(100);

/// D'où vient l'image.
#[derive(Clone, Copy)]
pub enum Source {
    /// Écran principal du PC.
    Screen,
    /// Mire de test (essais : rien de l'écran réel ne sort).
    Pattern,
}

/// Une image complète, en RGBA.
struct Frame {
    width: usize,
    height: usize,
    rgba: Vec<u8>,
}

fn grab(source: Source, tick: u64) -> Result<Frame> {
    match source {
        Source::Screen => {
            let monitors = xcap::Monitor::all()?;
            let monitor = monitors
                .iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or(monitors.first())
                .ok_or_else(|| anyhow!("aucun écran"))?;
            let img = monitor.capture_image()?;
            Ok(Frame { width: img.width() as usize, height: img.height() as usize, rgba: img.into_raw() })
        }
        Source::Pattern => {
            // Bandes de couleur fixes et un carré qui avance : de quoi vérifier l'image et son mouvement.
            let (w, h) = (1024usize, 768usize);
            let mut rgba = vec![0u8; w * h * 4];
            let colors = [[220, 40, 40], [40, 180, 70], [40, 90, 220], [235, 235, 235]];
            for y in 0..h {
                for x in 0..w {
                    let c = colors[x * colors.len() / w];
                    let i = (y * w + x) * 4;
                    rgba[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
                }
            }
            let left = (tick as usize * 16) % (w - 100);
            for y in 600..700 {
                for x in left..left + 100 {
                    let i = (y * w + x) * 4;
                    rgba[i..i + 4].copy_from_slice(&[255, 210, 0, 255]);
                }
            }
            Ok(Frame { width: w, height: h, rgba })
        }
    }
}

/// Zones carrées qui diffèrent entre deux images de même taille.
fn dirty(previous: &[u8], current: &Frame) -> Vec<(usize, usize, usize, usize)> {
    let (w, h) = (current.width, current.height);
    let mut out = Vec::new();
    for ty in (0..h).step_by(TILE) {
        for tx in (0..w).step_by(TILE) {
            let tw = TILE.min(w - tx);
            let th = TILE.min(h - ty);
            let changed = previous.len() != current.rgba.len()
                || (ty..ty + th).any(|y| {
                    let row = (y * w + tx) * 4;
                    previous[row..row + tw * 4] != current.rgba[row..row + tw * 4]
                });
            if changed {
                out.push((tx, ty, tw, th));
            }
        }
    }
    out
}

fn bitmap(frame: &Frame, (x, y, w, h): (usize, usize, usize, usize)) -> Option<BitmapUpdate> {
    let mut data = Vec::with_capacity(w * h * 4);
    for row in y..y + h {
        let start = (row * frame.width + x) * 4;
        data.extend_from_slice(&frame.rgba[start..start + w * 4]);
    }
    Some(BitmapUpdate {
        x: x as u16,
        y: y as u16,
        width: NonZeroU16::new(w as u16)?,
        height: NonZeroU16::new(h as u16)?,
        format: PixelFormat::RgbA32,
        data: Bytes::from(data),
        stride: NonZeroUsize::new(w * 4)?,
    })
}

pub struct Display {
    source: Source,
    size: DesktopSize,
}

impl Display {
    /// Taille de l'écran envoyé.
    pub fn desktop(&self) -> (u16, u16) {
        (self.size.width, self.size.height)
    }

    pub fn new(source: Source) -> Result<Self> {
        let f = grab(source, 0)?;
        Ok(Self { source, size: DesktopSize { width: f.width as u16, height: f.height as u16 } })
    }
}

#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> Result<Box<dyn RdpServerDisplayUpdates>> {
        let (tx, rx) = mpsc::channel(64);
        let source = self.source;
        // Taille déjà annoncée au client : un changement seulement provoque une réactivation.
        let known = (self.size.width as usize, self.size.height as usize);
        // La capture bloque : un fil à part, qui s'arrête quand la connexion se ferme.
        std::thread::spawn(move || {
            let mut previous: Vec<u8> = Vec::new();
            let mut size = known;
            for tick in 0u64.. {
                let started = std::time::Instant::now();
                if let Ok(frame) = grab(source, tick) {
                    if (frame.width, frame.height) != size {
                        size = (frame.width, frame.height);
                        previous.clear();
                        let resize = DisplayUpdate::Resize(DesktopSize { width: frame.width as u16, height: frame.height as u16 });
                        if tx.blocking_send(resize).is_err() {
                            return;
                        }
                    }
                    for rect in dirty(&previous, &frame) {
                        if let Some(b) = bitmap(&frame, rect) {
                            if tx.blocking_send(DisplayUpdate::Bitmap(b)).is_err() {
                                return;
                            }
                        }
                    }
                    previous = frame.rgba;
                }
                std::thread::sleep(INTERVAL.saturating_sub(started.elapsed()));
            }
        });
        Ok(Box::new(Updates { rx }))
    }
}

struct Updates {
    rx: mpsc::Receiver<DisplayUpdate>,
}

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for Updates {
    async fn next_update(&mut self) -> Result<Option<DisplayUpdate>> {
        Ok(self.rx.recv().await)
    }
}
