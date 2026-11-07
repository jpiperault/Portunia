//! Écran envoyé au dépanneur.
//!
//! Capture : duplication du bureau de Windows (DXGI), qui donne elle-même les zones changées et
//! la forme du pointeur ; si elle n'est pas possible (session distante, vieux pilote), capture
//! GDI comparée par carrés de 64 pixels.
//!
//! Envoi : les zones changées s'accumulent dans une grille de carrés, et la connexion les prend
//! quand elle peut envoyer. Réseau lent : les images intermédiaires sont sautées, seule la plus
//! récente part, et le retard ne s'accumule pas.

use std::{
    collections::VecDeque,
    num::{NonZeroU16, NonZeroUsize},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use ironrdp_server::{BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RGBAPointer, RdpServerDisplay, RdpServerDisplayUpdates};
use tokio::sync::Notify;

const TILE: usize = 64;
/// 30 images par seconde au plus.
const MIN_FRAME: Duration = Duration::from_millis(33);
/// Capture GDI : cadence quand l'écran bouge, et quand il est calme.
const GDI_FAST: Duration = Duration::from_millis(66);
const GDI_IDLE: Duration = Duration::from_millis(250);

/// D'où vient l'image.
#[derive(Clone, Copy)]
pub enum Source {
    /// Écran principal du PC.
    Screen,
    /// Mire de test (essais : rien de l'écran réel ne sort).
    Pattern,
}

/// Image courante (BGRX, comme Windows la donne) et carrés changés depuis le dernier envoi.
struct Canvas {
    width: usize,
    height: usize,
    bgrx: Vec<u8>,
    cols: usize,
    dirty: Vec<bool>,
}

impl Canvas {
    fn new(width: usize, height: usize) -> Self {
        let cols = width.div_ceil(TILE);
        Self { width, height, bgrx: vec![0; width * height * 4], cols, dirty: vec![true; cols * height.div_ceil(TILE)] }
    }

    /// Marque les carrés touchés par une zone.
    fn mark(&mut self, x: usize, y: usize, w: usize, h: usize) {
        if w == 0 || h == 0 || x >= self.width || y >= self.height {
            return;
        }
        let (x1, y1) = ((x + w).min(self.width), (y + h).min(self.height));
        for ty in y / TILE..y1.div_ceil(TILE) {
            for tx in x / TILE..x1.div_ceil(TILE) {
                self.dirty[ty * self.cols + tx] = true;
            }
        }
    }

    fn mark_all(&mut self) {
        self.dirty.iter_mut().for_each(|d| *d = true);
    }

    /// Zones à envoyer : carrés voisins réunis en rectangles, puis grille remise à zéro.
    fn take_rects(&mut self) -> Vec<(usize, usize, usize, usize)> {
        let rows = self.dirty.len() / self.cols.max(1);
        let count = self.dirty.iter().filter(|d| **d).count();
        if count == 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        if count * 2 > self.dirty.len() {
            // Plus de la moitié de l'écran : une seule zone.
            out.push((0, 0, self.width, self.height));
        } else {
            // Rangée par rangée, les suites de carrés ; une suite identique à celle de la rangée
            // du dessus prolonge son rectangle.
            let mut open: Vec<(usize, usize, usize, usize)> = Vec::new(); // (c0, c1, rangée de départ, hauteur en carrés)
            for ty in 0..rows {
                let mut spans = Vec::new();
                let mut tx = 0;
                while tx < self.cols {
                    if self.dirty[ty * self.cols + tx] {
                        let start = tx;
                        while tx < self.cols && self.dirty[ty * self.cols + tx] {
                            tx += 1;
                        }
                        spans.push((start, tx));
                    } else {
                        tx += 1;
                    }
                }
                let mut next = Vec::new();
                for (c0, c1) in spans {
                    if let Some(i) = open.iter().position(|o| o.0 == c0 && o.1 == c1) {
                        let mut o = open.swap_remove(i);
                        o.3 += 1;
                        next.push(o);
                    } else {
                        next.push((c0, c1, ty, 1));
                    }
                }
                for o in open.drain(..) {
                    out.push(self.pixels(o));
                }
                open = next;
            }
            for o in open {
                out.push(self.pixels(o));
            }
        }
        self.dirty.iter_mut().for_each(|d| *d = false);
        out
    }

    fn pixels(&self, (c0, c1, r0, n): (usize, usize, usize, usize)) -> (usize, usize, usize, usize) {
        let (x, y) = (c0 * TILE, r0 * TILE);
        (x, y, (c1 * TILE).min(self.width) - x, ((r0 + n) * TILE).min(self.height) - y)
    }

    fn bitmap(&self, (x, y, w, h): (usize, usize, usize, usize)) -> Option<BitmapUpdate> {
        let mut data = Vec::with_capacity(w * h * 4);
        for row in y..y + h {
            let start = (row * self.width + x) * 4;
            data.extend_from_slice(&self.bgrx[start..start + w * 4]);
        }
        Some(BitmapUpdate {
            x: x as u16,
            y: y as u16,
            width: NonZeroU16::new(w as u16)?,
            height: NonZeroU16::new(h as u16)?,
            format: PixelFormat::BgrX32,
            data: Bytes::from(data),
            stride: NonZeroUsize::new(w * 4)?,
        })
    }
}

/// Pointeur de la souris : forme et position, envoyées à part de l'image.
#[derive(Default)]
struct Pointer {
    shape: Option<RGBAPointer>,
    shape_changed: bool,
    position: Option<(u16, u16)>,
    position_changed: bool,
    visible: bool,
    visibility_changed: bool,
}

/// Ce que la capture prépare et que la connexion prend.
struct Pending {
    canvas: Canvas,
    resized: bool,
    pointer: Pointer,
}

struct Shared {
    pending: Mutex<Pending>,
    ready: Notify,
    stop: AtomicBool,
}

/// Session en pause : rien n'est capturé ni envoyé ; à la reprise, tout l'écran repart.
pub static PAUSED: AtomicBool = AtomicBool::new(false);

// ---------- Capture ----------

/// Résultat d'une capture : écran redessiné dans `canvas` (zones marquées), pointeur à jour.
trait Grabber {
    /// Attend au plus `wait` un changement, puis met `pending` à jour. Erreur : capture perdue.
    fn grab(&mut self, pending: &Mutex<Pending>, wait: Duration) -> Result<bool>;
    fn size(&self) -> (usize, usize);
}

struct Pattern {
    tick: u64,
}

impl Grabber for Pattern {
    fn grab(&mut self, pending: &Mutex<Pending>, wait: Duration) -> Result<bool> {
        let _ = wait;
        std::thread::sleep(Duration::from_millis(33));
        self.tick += 1;
        let mut p = pending.lock().unwrap();
        let c = &mut p.canvas;
        let (w, h) = (c.width, c.height);
        if self.tick == 1 {
            // Bandes de couleur fixes.
            let colors = [[40, 40, 220], [70, 180, 40], [220, 90, 40], [235, 235, 235]];
            for y in 0..h {
                for x in 0..w {
                    let col = colors[x * colors.len() / w];
                    let i = (y * w + x) * 4;
                    c.bgrx[i..i + 4].copy_from_slice(&[col[0], col[1], col[2], 255]);
                }
            }
            c.mark_all();
        }
        // Un carré qui avance : de quoi mesurer le mouvement.
        let left = (self.tick as usize * 8) % (w - 100);
        let prev = (left + w - 100 - 8) % (w - 100);
        for (x0, color) in [(prev, None), (left, Some([0u8, 210, 255]))] {
            for y in 600..700 {
                for x in x0..x0 + 100 {
                    let i = (y * w + x) * 4;
                    let col = color.unwrap_or_else(|| {
                        let colors = [[40, 40, 220], [70, 180, 40], [220, 90, 40], [235, 235, 235]];
                        colors[x * colors.len() / w]
                    });
                    c.bgrx[i..i + 4].copy_from_slice(&[col[0], col[1], col[2], 255]);
                }
            }
            c.mark(x0, 600, 100, 100);
        }
        Ok(true)
    }
    fn size(&self) -> (usize, usize) {
        (1024, 768)
    }
}

/// Capture GDI (repli) : écran principal entier, comparé par carrés.
struct Gdi {
    monitor: xcap::Monitor,
    size: (usize, usize),
    previous: Vec<u8>,
    calm: u32,
}

impl Gdi {
    fn new() -> Result<Self> {
        let monitors = xcap::Monitor::all()?;
        let monitor = monitors.iter().find(|m| m.is_primary().unwrap_or(false)).or(monitors.first()).cloned().ok_or_else(|| anyhow!("aucun écran"))?;
        let size = (monitor.width()? as usize, monitor.height()? as usize);
        Ok(Self { monitor, size, previous: Vec::new(), calm: 0 })
    }
}

impl Grabber for Gdi {
    fn grab(&mut self, pending: &Mutex<Pending>, _wait: Duration) -> Result<bool> {
        std::thread::sleep(if self.calm > 10 { GDI_IDLE } else { GDI_FAST });
        let img = self.monitor.capture_image()?;
        let (w, h) = (img.width() as usize, img.height() as usize);
        if (w, h) != self.size {
            return Err(anyhow!("taille de l'écran changée"));
        }
        let mut rgba = img.into_raw();
        // RGBA → BGRX, comme la duplication du bureau.
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let mut p = pending.lock().unwrap();
        let mut changed = false;
        for ty in (0..h).step_by(TILE) {
            for tx in (0..w).step_by(TILE) {
                let (tw, th) = (TILE.min(w - tx), TILE.min(h - ty));
                let differs = self.previous.len() != rgba.len()
                    || (ty..ty + th).any(|y| {
                        let row = (y * w + tx) * 4;
                        self.previous[row..row + tw * 4] != rgba[row..row + tw * 4]
                    });
                if differs {
                    for y in ty..ty + th {
                        let row = (y * w + tx) * 4;
                        p.canvas.bgrx[row..row + tw * 4].copy_from_slice(&rgba[row..row + tw * 4]);
                    }
                    p.canvas.mark(tx, ty, tw, th);
                    changed = true;
                }
            }
        }
        #[cfg(windows)]
        if let Some(pos) = win_cursor() {
            if p.pointer.position != Some(pos) {
                p.pointer.position = Some(pos);
                p.pointer.position_changed = true;
            }
        }
        drop(p);
        self.calm = if changed { 0 } else { self.calm + 1 };
        self.previous = rgba;
        Ok(changed)
    }
    fn size(&self) -> (usize, usize) {
        self.size
    }
}

/// Position du pointeur sur l'écran principal (capture GDI).
#[cfg(windows)]
fn win_cursor() -> Option<(u16, u16)> {
    use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
    let mut p = POINT::default();
    // SAFETY : simple lecture de la position du pointeur.
    unsafe { GetCursorPos(&mut p).ok()? };
    (p.x >= 0 && p.y >= 0).then_some((p.x as u16, p.y as u16))
}

#[cfg(windows)]
mod dxgi {
    //! Duplication du bureau : Windows donne les zones changées, les fenêtres déplacées et la
    //! forme du pointeur ; la carte graphique copie l'image.

    use std::{sync::Mutex, time::Duration};

    use anyhow::{anyhow, Result};
    use ironrdp_server::RGBAPointer;
    use windows::{
        core::Interface,
        Win32::{
            Foundation::{HMODULE, RECT},
            Graphics::{
                Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                Direct3D11::{
                    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_SINGLETHREADED, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
                    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
                },
                Dxgi::{
                    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
                    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_MOVE_RECT, DXGI_OUTDUPL_POINTER_SHAPE_INFO,
                    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR,
                    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME,
                },
            },
        },
    };

    use super::{Grabber, Pending};

    pub struct Duplication {
        context: ID3D11DeviceContext,
        device: ID3D11Device,
        dup: IDXGIOutputDuplication,
        staging: Option<ID3D11Texture2D>,
        size: (usize, usize),
        moves: Vec<DXGI_OUTDUPL_MOVE_RECT>,
        dirty: Vec<RECT>,
        shape: Vec<u8>,
        pointer_index: u16,
    }

    impl Duplication {
        /// Écran principal (celui qui contient le point 0,0).
        pub fn new() -> Result<Self> {
            // SAFETY : appels COM classiques ; les objets rendus sont gardés par leurs interfaces.
            unsafe {
                let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
                let mut i = 0;
                while let Ok(adapter) = factory.EnumAdapters1(i) {
                    i += 1;
                    let mut j = 0;
                    while let Ok(output) = adapter.EnumOutputs(j) {
                        j += 1;
                        let desc = output.GetDesc()?;
                        let r = desc.DesktopCoordinates;
                        if !desc.AttachedToDesktop.as_bool() || r.left != 0 || r.top != 0 {
                            continue;
                        }
                        let mut device = None;
                        let mut context = None;
                        D3D11CreateDevice(
                            &adapter.cast::<IDXGIAdapter>()?,
                            D3D_DRIVER_TYPE_UNKNOWN,
                            HMODULE::default(),
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_SINGLETHREADED,
                            None,
                            D3D11_SDK_VERSION,
                            Some(&mut device),
                            None,
                            Some(&mut context),
                        )?;
                        let device: ID3D11Device = device.ok_or_else(|| anyhow!("D3D11"))?;
                        let dup = output.cast::<IDXGIOutput1>()?.DuplicateOutput(&device)?;
                        let size = ((r.right - r.left) as usize, (r.bottom - r.top) as usize);
                        return Ok(Self {
                            context: context.ok_or_else(|| anyhow!("D3D11"))?,
                            device,
                            dup,
                            staging: None,
                            size,
                            moves: Vec::new(),
                            dirty: Vec::new(),
                            shape: Vec::new(),
                            pointer_index: 0,
                        });
                    }
                }
                Err(anyhow!("aucun écran principal pour la duplication du bureau"))
            }
        }

        /// Copie lisible par le processeur, créée une fois.
        unsafe fn staging(&mut self, src: &ID3D11Texture2D) -> Result<ID3D11Texture2D> {
            if let Some(s) = &self.staging {
                return Ok(s.clone());
            }
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            src.GetDesc(&mut desc);
            desc.BindFlags = 0;
            desc.MiscFlags = 0;
            desc.Usage = D3D11_USAGE_STAGING;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            let mut staging = None;
            self.device.CreateTexture2D(&desc, None, Some(&mut staging))?;
            let s = staging.ok_or_else(|| anyhow!("texture"))?;
            self.staging = Some(s.clone());
            Ok(s)
        }

        unsafe fn frame(&mut self, pending: &Mutex<Pending>, info: &DXGI_OUTDUPL_FRAME_INFO, resource: IDXGIResource) -> Result<bool> {
            let mut changed = false;
            // Pointeur : position et forme.
            let mut p = pending.lock().unwrap();
            if info.LastMouseUpdateTime != 0 {
                let visible = info.PointerPosition.Visible.as_bool();
                if visible != p.pointer.visible {
                    p.pointer.visible = visible;
                    p.pointer.visibility_changed = true;
                }
                let pos = info.PointerPosition.Position;
                let pos = (pos.x.max(0) as u16, pos.y.max(0) as u16);
                if visible && p.pointer.position != Some(pos) {
                    p.pointer.position = Some(pos);
                    p.pointer.position_changed = true;
                }
            }
            if info.PointerShapeBufferSize > 0 {
                self.shape.resize(info.PointerShapeBufferSize as usize, 0);
                let mut needed = 0;
                let mut shape_info = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                if self.dup.GetFramePointerShape(self.shape.len() as u32, self.shape.as_mut_ptr().cast(), &mut needed, &mut shape_info).is_ok() {
                    self.pointer_index = (self.pointer_index + 1) % 16;
                    if let Some(shape) = pointer_shape(&self.shape, &shape_info, self.pointer_index) {
                        p.pointer.shape = Some(shape);
                        p.pointer.shape_changed = true;
                    }
                }
            }
            drop(p);
            if info.LastPresentTime == 0 {
                // Seul le pointeur a bougé.
                return Ok(false);
            }
            // Zones déplacées et zones changées.
            let mut size = 0u32;
            self.moves.resize(64, DXGI_OUTDUPL_MOVE_RECT::default());
            loop {
                let bytes = (self.moves.len() * std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>()) as u32;
                match self.dup.GetFrameMoveRects(bytes, self.moves.as_mut_ptr(), &mut size) {
                    Ok(()) => break,
                    Err(_) if size > bytes => self.moves.resize(size as usize / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>() + 1, DXGI_OUTDUPL_MOVE_RECT::default()),
                    Err(e) => return Err(e.into()),
                }
            }
            let move_count = size as usize / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>();
            self.dirty.resize(64, RECT::default());
            loop {
                let bytes = (self.dirty.len() * std::mem::size_of::<RECT>()) as u32;
                match self.dup.GetFrameDirtyRects(bytes, self.dirty.as_mut_ptr(), &mut size) {
                    Ok(()) => break,
                    Err(_) if size > bytes => self.dirty.resize(size as usize / std::mem::size_of::<RECT>() + 1, RECT::default()),
                    Err(e) => return Err(e.into()),
                }
            }
            let dirty_count = size as usize / std::mem::size_of::<RECT>();
            let mut zones: Vec<RECT> = self.dirty[..dirty_count].to_vec();
            // Une fenêtre déplacée : sa nouvelle place est à renvoyer.
            for m in &self.moves[..move_count] {
                zones.push(m.DestinationRect);
            }
            if zones.is_empty() {
                return Ok(false);
            }
            let texture: ID3D11Texture2D = resource.cast()?;
            let staging = self.staging(&texture)?;
            self.context.CopyResource(&staging, &texture);
            let res: ID3D11Resource = staging.cast()?;
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context.Map(&res, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let pitch = mapped.RowPitch as usize;
            let src = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * self.size.1);
            let mut p = pending.lock().unwrap();
            let (w, h) = (p.canvas.width, p.canvas.height);
            for r in zones {
                let (x0, y0) = (r.left.max(0) as usize, r.top.max(0) as usize);
                let (x1, y1) = ((r.right.max(0) as usize).min(w), (r.bottom.max(0) as usize).min(h));
                if x1 <= x0 || y1 <= y0 {
                    continue;
                }
                for y in y0..y1 {
                    let s = y * pitch + x0 * 4;
                    let d = (y * w + x0) * 4;
                    p.canvas.bgrx[d..d + (x1 - x0) * 4].copy_from_slice(&src[s..s + (x1 - x0) * 4]);
                }
                p.canvas.mark(x0, y0, x1 - x0, y1 - y0);
                changed = true;
            }
            drop(p);
            self.context.Unmap(&res, 0);
            Ok(changed)
        }
    }

    impl Grabber for Duplication {
        fn grab(&mut self, pending: &Mutex<Pending>, wait: Duration) -> Result<bool> {
            // SAFETY : une image prise par AcquireNextFrame est toujours rendue par ReleaseFrame.
            unsafe {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;
                match self.dup.AcquireNextFrame(wait.as_millis() as u32, &mut info, &mut resource) {
                    Ok(()) => {}
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(false),
                    // Bureau changé (UAC, verrouillage, résolution) : la duplication est à refaire.
                    Err(e) => return Err(e.into()),
                }
                let result = match resource {
                    Some(r) => self.frame(pending, &info, r),
                    None => Ok(false),
                };
                let _ = self.dup.ReleaseFrame();
                result
            }
        }
        fn size(&self) -> (usize, usize) {
            self.size
        }
    }

    /// Forme du pointeur en BGRA, de bas en haut (format RDP des pointeurs 32 bits).
    fn pointer_shape(buf: &[u8], info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO, index: u16) -> Option<RGBAPointer> {
        let (w, pitch) = (info.Width as usize, info.Pitch as usize);
        let kind = info.Type as i32;
        // Monochrome : deux masques d'un bit (ET puis OU exclusif), hauteur doublée.
        let h = if kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 { info.Height as usize / 2 } else { info.Height as usize };
        if w == 0 || h == 0 || w > 256 || h > 256 {
            return None;
        }
        let mut top_down = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let out = &mut top_down[(y * w + x) * 4..(y * w + x) * 4 + 4];
                if kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 {
                    let bit = |row: usize| buf.get(row * pitch + x / 8).map(|b| (b >> (7 - x % 8)) & 1 == 1);
                    let (and, xor) = (bit(y)?, bit(y + h)?);
                    out.copy_from_slice(match (and, xor) {
                        (false, false) => &[0, 0, 0, 255],
                        (false, true) => &[255, 255, 255, 255],
                        (true, false) => &[0, 0, 0, 0],
                        // Inversé : noir, bien visible sur un fond clair.
                        (true, true) => &[0, 0, 0, 255],
                    });
                } else {
                    let s = y * pitch + x * 4;
                    let px = buf.get(s..s + 4)?;
                    if kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 {
                        out.copy_from_slice(px);
                    } else if kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 {
                        // Masque à 0 : couleur opaque ; à 1 : ou exclusif avec l'écran, rendu en noir
                        // si la couleur n'est pas nulle, transparent sinon.
                        let xor_mode = px[3] != 0;
                        let blank = px[0] == 0 && px[1] == 0 && px[2] == 0;
                        out.copy_from_slice(&if !xor_mode {
                            [px[0], px[1], px[2], 255]
                        } else if blank {
                            [0, 0, 0, 0]
                        } else {
                            [0, 0, 0, 255]
                        });
                    } else {
                        return None;
                    }
                }
            }
        }
        let mut data = Vec::with_capacity(top_down.len());
        for y in (0..h).rev() {
            data.extend_from_slice(&top_down[y * w * 4..(y + 1) * w * 4]);
        }
        Some(RGBAPointer {
            cache_index: index,
            width: w as u16,
            height: h as u16,
            hot_x: info.HotSpot.x.max(0) as u16,
            hot_y: info.HotSpot.y.max(0) as u16,
            data,
        })
    }
}

/// Meilleure capture possible, de la plus rapide à la plus simple.
fn grabber(source: Source) -> Result<Box<dyn Grabber>> {
    if let Source::Pattern = source {
        return Ok(Box::new(Pattern { tick: 0 }));
    }
    #[cfg(windows)]
    match dxgi::Duplication::new() {
        Ok(d) => return Ok(Box::new(d)),
        Err(e) => tracing::info!("duplication du bureau impossible, capture GDI : {e:#}"),
    }
    Ok(Box::new(Gdi::new()?))
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
        let (w, h) = grabber(source)?.size();
        Ok(Self { source, size: DesktopSize { width: w as u16, height: h as u16 } })
    }
}

/// Fil de capture : prend les changements tant que la connexion est ouverte.
fn capture(source: Source, shared: Arc<Shared>) {
    let mut grab: Option<Box<dyn Grabber>> = None;
    let mut failures = 0u32;
    let mut was_paused = false;
    let mut last = Instant::now() - MIN_FRAME;
    while !shared.stop.load(Ordering::Relaxed) {
        if PAUSED.load(Ordering::Relaxed) {
            was_paused = true;
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let g = match grab.as_mut() {
            Some(g) => g,
            None => match grabber(source) {
                Ok(g) => {
                    let size = g.size();
                    let mut p = shared.pending.lock().unwrap();
                    if (p.canvas.width, p.canvas.height) != size {
                        p.canvas = Canvas::new(size.0, size.1);
                        p.resized = true;
                    }
                    p.canvas.mark_all();
                    drop(p);
                    grab.insert(g)
                }
                Err(e) => {
                    // Bureau sécurisé (UAC, verrouillage) : rien à capturer pour l'instant.
                    failures += 1;
                    if failures % 20 == 1 {
                        tracing::info!("capture impossible : {e:#}");
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
            },
        };
        if was_paused {
            was_paused = false;
            shared.pending.lock().unwrap().canvas.mark_all();
            shared.ready.notify_one();
        }
        // Pas plus de 30 images par seconde : les changements s'accumulent entre-temps.
        let since = last.elapsed();
        if since < MIN_FRAME {
            std::thread::sleep(MIN_FRAME - since);
        }
        match g.grab(&shared.pending, Duration::from_millis(250)) {
            Ok(changed) => {
                failures = 0;
                if changed {
                    last = Instant::now();
                }
                let p = shared.pending.lock().unwrap();
                let pointer = p.pointer.shape_changed || p.pointer.position_changed || p.pointer.visibility_changed;
                drop(p);
                if changed || pointer {
                    shared.ready.notify_one();
                }
            }
            Err(e) => {
                tracing::info!("capture perdue, reprise : {e:#}");
                grab = None;
            }
        }
    }
}

#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> Result<Box<dyn RdpServerDisplayUpdates>> {
        let (w, h) = (self.size.width as usize, self.size.height as usize);
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending { canvas: Canvas::new(w, h), resized: false, pointer: Pointer::default() }),
            ready: Notify::new(),
            stop: AtomicBool::new(false),
        });
        let source = self.source;
        let s = shared.clone();
        // La capture bloque : un fil à part, arrêté quand la connexion se ferme.
        std::thread::spawn(move || capture(source, s));
        Ok(Box::new(Updates { shared, queue: VecDeque::new() }))
    }
}

struct Updates {
    shared: Arc<Shared>,
    queue: VecDeque<DisplayUpdate>,
}

impl Drop for Updates {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

impl Updates {
    /// Prend tout ce qui a changé : taille, pointeur, puis les zones de l'image la plus récente.
    fn collect(&mut self) {
        let mut p = self.shared.pending.lock().unwrap();
        if p.resized {
            p.resized = false;
            self.queue.push_back(DisplayUpdate::Resize(DesktopSize { width: p.canvas.width as u16, height: p.canvas.height as u16 }));
        }
        for rect in p.canvas.take_rects() {
            if let Some(b) = p.canvas.bitmap(rect) {
                self.queue.push_back(DisplayUpdate::Bitmap(b));
            }
        }
        let ptr = &mut p.pointer;
        if ptr.visibility_changed {
            ptr.visibility_changed = false;
            if !ptr.visible {
                self.queue.push_back(DisplayUpdate::HidePointer);
            } else if let Some(s) = &ptr.shape {
                ptr.shape_changed = false;
                self.queue.push_back(DisplayUpdate::RGBAPointer(s.clone()));
            }
        }
        if ptr.shape_changed && ptr.visible {
            ptr.shape_changed = false;
            if let Some(s) = &ptr.shape {
                self.queue.push_back(DisplayUpdate::RGBAPointer(s.clone()));
            }
        }
        if ptr.position_changed {
            ptr.position_changed = false;
            if let Some((x, y)) = ptr.position {
                self.queue.push_back(DisplayUpdate::PointerPosition(ironrdp_pdu::pointer::PointerPositionAttribute { x, y }));
            }
        }
    }
}

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for Updates {
    async fn next_update(&mut self) -> Result<Option<DisplayUpdate>> {
        loop {
            if let Some(u) = self.queue.pop_front() {
                return Ok(Some(u));
            }
            self.collect();
            if self.queue.is_empty() {
                self.shared.ready.notified().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Canvas;

    #[test]
    fn zones_fusionnees() {
        let mut c = Canvas::new(640, 480);
        c.take_rects();
        // Une fenêtre de 200 × 130 déplacée : un seul rectangle.
        c.mark(100, 100, 200, 130);
        let r = c.take_rects();
        assert_eq!(r, vec![(64, 64, 256, 192)]);
        // Deux zones éloignées : deux rectangles ; rien ensuite.
        c.mark(0, 0, 10, 10);
        c.mark(600, 400, 10, 10);
        assert_eq!(c.take_rects().len(), 2);
        assert!(c.take_rects().is_empty());
        // Plus de la moitié de l'écran : tout l'écran.
        c.mark(0, 0, 640, 300);
        assert_eq!(c.take_rects(), vec![(0, 0, 640, 480)]);
        // Bord de l'écran : rectangle coupé à la taille réelle.
        let mut c = Canvas::new(100, 70);
        c.take_rects();
        c.mark(90, 60, 50, 50);
        assert_eq!(c.take_rects(), vec![(64, 0, 36, 70)]);
    }
}
