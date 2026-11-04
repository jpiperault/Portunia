//! Écran du téléphone envoyé au dépanneur. L'appli pousse chaque image de la capture
//! (MediaProjection) ; on en envoie au plus dix par seconde, et seules les zones qui ont changé
//! partent (carrés de 64 pixels, même découpage que `aide/src/display.rs`).

use std::{
    num::{NonZeroU16, NonZeroUsize},
    sync::{Condvar, Mutex},
    time::Duration,
};

use anyhow::Result;
use bytes::Bytes;
use ironrdp_server::{BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServerDisplay, RdpServerDisplayUpdates};
use tokio::sync::mpsc;

const TILE: usize = 64;
const INTERVAL: Duration = Duration::from_millis(100);
/// Attente de la première image après l'accord (le temps que la capture démarre).
const FIRST_FRAME: Duration = Duration::from_secs(5);

/// Dernière image reçue de l'appli, en RGBA sans marge de fin de ligne.
struct Frame {
    seq: u64,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
}

static LATEST: Mutex<Frame> = Mutex::new(Frame { seq: 0, width: 0, height: 0, rgba: Vec::new() });
static ARRIVED: Condvar = Condvar::new();

/// Nouvelle session : on oublie l'image de la précédente.
pub fn reset() {
    let mut f = LATEST.lock().unwrap();
    *f = Frame { seq: 0, width: 0, height: 0, rgba: Vec::new() };
}

/// Image de la capture : `stride` octets par ligne (la ligne utile en fait `width * 4`).
pub fn push(data: &[u8], width: usize, height: usize, stride: usize) {
    if width == 0 || height == 0 || stride < width * 4 || data.len() < stride * (height - 1) + width * 4 {
        return;
    }
    let mut f = LATEST.lock().unwrap();
    f.rgba.clear();
    for y in 0..height {
        f.rgba.extend_from_slice(&data[y * stride..y * stride + width * 4]);
    }
    f.width = width;
    f.height = height;
    f.seq += 1;
    ARRIVED.notify_all();
}

/// Zones carrées qui diffèrent entre deux images de même taille.
fn dirty(previous: &[u8], current: &[u8], w: usize, h: usize) -> Vec<(usize, usize, usize, usize)> {
    let mut out = Vec::new();
    for ty in (0..h).step_by(TILE) {
        for tx in (0..w).step_by(TILE) {
            let tw = TILE.min(w - tx);
            let th = TILE.min(h - ty);
            let changed = previous.len() != current.len()
                || (ty..ty + th).any(|y| {
                    let row = (y * w + tx) * 4;
                    previous[row..row + tw * 4] != current[row..row + tw * 4]
                });
            if changed {
                out.push((tx, ty, tw, th));
            }
        }
    }
    out
}

fn bitmap(rgba: &[u8], width: usize, (x, y, w, h): (usize, usize, usize, usize)) -> Option<BitmapUpdate> {
    let mut data = Vec::with_capacity(w * h * 4);
    for row in y..y + h {
        let start = (row * width + x) * 4;
        data.extend_from_slice(&rgba[start..start + w * 4]);
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
    size: DesktopSize,
}

impl Display {
    /// Taille annoncée : celle de la première image (portrait par défaut si la capture tarde).
    pub fn new() -> Self {
        let f = LATEST.lock().unwrap();
        let (f, _) = ARRIVED.wait_timeout_while(f, FIRST_FRAME, |f| f.seq == 0).unwrap();
        let (width, height) = if f.seq == 0 { (720, 1280) } else { (f.width as u16, f.height as u16) };
        Self { size: DesktopSize { width, height } }
    }
}

#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> Result<Box<dyn RdpServerDisplayUpdates>> {
        let (tx, rx) = mpsc::channel(64);
        let known = (self.size.width as usize, self.size.height as usize);
        std::thread::spawn(move || {
            let mut previous: Vec<u8> = Vec::new();
            let mut size = known;
            let mut seen = 0u64;
            while !tx.is_closed() {
                let started = std::time::Instant::now();
                let frame = {
                    let f = LATEST.lock().unwrap();
                    (f.seq != seen && f.seq != 0).then(|| (f.seq, f.width, f.height, f.rgba.clone()))
                };
                if let Some((seq, width, height, rgba)) = frame {
                    seen = seq;
                    // Rotation du téléphone : nouvelle taille annoncée au dépanneur.
                    if (width, height) != size {
                        size = (width, height);
                        previous.clear();
                        if tx.blocking_send(DisplayUpdate::Resize(DesktopSize { width: width as u16, height: height as u16 })).is_err() {
                            return;
                        }
                    }
                    for rect in dirty(&previous, &rgba, width, height) {
                        if let Some(b) = bitmap(&rgba, width, rect) {
                            if tx.blocking_send(DisplayUpdate::Bitmap(b)).is_err() {
                                return;
                            }
                        }
                    }
                    previous = rgba;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marge_de_fin_de_ligne_retiree() {
        reset();
        // 2 × 2 pixels, lignes de 12 octets (4 de marge).
        let data: Vec<u8> = (0..24).collect();
        push(&data, 2, 2, 12);
        let f = LATEST.lock().unwrap();
        assert_eq!(f.rgba, [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19]);
        assert_eq!((f.width, f.height, f.seq), (2, 2, 1));
    }

    #[test]
    fn zones_changees() {
        let a = vec![0u8; 100 * 70 * 4];
        let mut b = a.clone();
        b[(65 * 100 + 70) * 4] = 9;
        assert_eq!(dirty(&a, &b, 100, 70), vec![(64, 64, 36, 6)]);
        assert_eq!(dirty(&[], &b, 100, 70).len(), 4);
    }
}
