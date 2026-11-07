//! Fenêtres de Portunia Assist (Windows), dessinées avec Direct2D :
//! - la fenêtre principale (code, accord, fin), dans le style de Windows 11 ;
//! - pendant la session, une barre flottante en haut de l'écran (qui, depuis quand, qualité,
//!   pause, contrôle, discussion, Arrêter), la fenêtre de discussion, et un cadre de couleur
//!   autour de l'écran. Les trois sont absents de l'image envoyée au dépanneur.
//! Échap trois fois de suite arrête aussi tout.

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use tokio::sync::mpsc::UnboundedSender;
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Direct2D::{
                Common::{D2D1_ALPHA_MODE_UNKNOWN, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_U},
                D2D1CreateFactory, ID2D1Factory, ID2D1HwndRenderTarget, ID2D1SolidColorBrush, D2D1_DRAW_TEXT_OPTIONS_CLIP,
                D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ELLIPSE, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_HWND_RENDER_TARGET_PROPERTIES,
                D2D1_PRESENT_OPTIONS_NONE, D2D1_RENDER_TARGET_PROPERTIES, D2D1_ROUNDED_RECT,
            },
            DirectWrite::{
                DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteTextFormat, DWRITE_FACTORY_TYPE_SHARED,
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT, DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
                DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_LEADING,
                DWRITE_TEXT_ALIGNMENT_TRAILING, DWRITE_TEXT_METRICS, DWRITE_WORD_WRAPPING_NO_WRAP, DWRITE_WORD_WRAPPING_WRAP,
            },
            Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE},
            Gdi::{BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect, ScreenToClient, PAINTSTRUCT},
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow},
            Input::KeyboardAndMouse::{GetKeyState, SetFocus, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT, VK_ESCAPE, VK_RETURN, VK_SHIFT, VK_SPACE, VK_TAB},
            WindowsAndMessaging::*,
        },
    },
};

use crate::relay::{Command, Event, Summary};

// ---------- État partagé avec la session ----------

/// Ce que montre la fenêtre principale.
#[derive(Clone)]
pub enum Screen {
    Connecting,
    Code { code: String, until: Option<Instant> },
    Consent { who: String, server: String, control: bool, deadline: Instant },
    Session,
    Ended(Summary),
    Error(String),
}

/// Session en cours, telle que la barre la montre.
#[derive(Clone)]
struct SessionView {
    who: String,
    control: bool,
    paused: bool,
    since: Instant,
    rtt: Option<Duration>,
    reconnecting: bool,
    asking: bool,
    /// (message de la personne ?, texte)
    messages: Vec<(bool, String)>,
    unread: bool,
}

struct Shared {
    screen: Mutex<Screen>,
    session: Mutex<SessionView>,
    consent: Mutex<Option<mpsc::Sender<Option<bool>>>>,
    commands: UnboundedSender<Command>,
    fr: bool,
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();
static MAIN: AtomicIsize = AtomicIsize::new(0);
static FRAME: AtomicIsize = AtomicIsize::new(0);
static BAR: AtomicIsize = AtomicIsize::new(0);
static CHAT: AtomicIsize = AtomicIsize::new(0);
static EDIT: AtomicIsize = AtomicIsize::new(0);
static DARK: AtomicBool = AtomicBool::new(false);
/// Démonstration : fenêtres photographiables (pas d'exclusion de la capture).
static DEMO: AtomicBool = AtomicBool::new(false);
const WM_APP_UPDATE: u32 = WM_APP + 1;
const WM_MOUSELEAVE: u32 = 0x02a3;
const EM_LIMITTEXT: u32 = 0x00c5;
const TIMER: usize = 1;

/// Largeur de la fenêtre principale et de la discussion (unités indépendantes de l'écran).
const MAIN_W: f32 = 440.0;
const CHAT_W: f32 = 340.0;
const CHAT_H: f32 = 400.0;
const BAR_H: f32 = 46.0;
const CONSENT_FOR: Duration = Duration::from_secs(60);

fn shared() -> &'static Arc<Shared> {
    SHARED.get().expect("fenêtre initialisée")
}

fn tr(en: &'static str, fr: &'static str) -> &'static str {
    if shared().fr {
        fr
    } else {
        en
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn hwnd(v: &AtomicIsize) -> Option<HWND> {
    let h = v.load(Ordering::Relaxed);
    (h != 0).then_some(HWND(h as *mut _))
}

fn post(slot: &AtomicIsize) {
    if let Some(h) = hwnd(slot) {
        // SAFETY : message posté à notre fenêtre, traité sur son fil.
        unsafe {
            let _ = PostMessageW(Some(h), WM_APP_UPDATE, WPARAM(0), LPARAM(0));
        }
    }
}

/// Langue de Windows : français ou anglais.
pub fn system_is_french() -> bool {
    // SAFETY : simple lecture du réglage de langue.
    let lang = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    lang & 0x3ff == 0x0c
}

/// Thème sombre de Windows pour les applications ?
fn system_is_dark() -> bool {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value = 1u32;
    let mut size = 4u32;
    // SAFETY : lecture d'une valeur DWORD dans un tampon de 4 octets.
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut size),
        )
    };
    ok.is_ok() && value == 0
}

// ---------- Interface vue de la session ----------

/// Côté session : ce qu'elle demande à la fenêtre (appelé depuis le fil de la session).
pub struct WindowUi;

fn set(screen: Screen) {
    *shared().screen.lock().unwrap() = screen;
    post(&MAIN);
}

impl crate::relay::Ui for WindowUi {
    fn code(&mut self, code: &str, valid: Option<Duration>) {
        set(Screen::Code { code: code.into(), until: valid.map(|v| Instant::now() + v) });
    }
    fn consent(&mut self, who: &str, server: &str) -> Option<bool> {
        let (tx, rx) = mpsc::channel();
        *shared().consent.lock().unwrap() = Some(tx);
        set(Screen::Consent { who: who.into(), server: server.into(), control: true, deadline: Instant::now() + CONSENT_FOR });
        rx.recv().ok().flatten()
    }
    fn connected(&mut self, who: &str, control: bool) {
        *shared().session.lock().unwrap() = SessionView {
            who: who.into(),
            control,
            paused: false,
            since: Instant::now(),
            rtt: None,
            reconnecting: false,
            asking: false,
            messages: Vec::new(),
            unread: false,
        };
        set(Screen::Session);
    }
    fn event(&mut self, event: Event) {
        {
            let mut s = shared().session.lock().unwrap();
            match event {
                Event::Message(text) => {
                    s.messages.push((false, text));
                    s.unread = hwnd(&CHAT).is_none();
                }
                Event::ControlRequested => s.asking = true,
                Event::Control(on) => {
                    s.control = on;
                    s.asking = false;
                }
                Event::Paused(on) => s.paused = on,
                Event::Reconnecting(on) => s.reconnecting = on,
                Event::Quality(rtt) => s.rtt = Some(rtt),
            }
        }
        post(&BAR);
        post(&CHAT);
        post(&MAIN);
    }
    fn ended(&mut self, summary: &Summary) {
        set(Screen::Ended(summary.clone()));
    }
}

/// Erreur avant ou pendant la session (relais injoignable, code faux trois fois…).
pub fn error(message: &str) {
    set(Screen::Error(message.into()));
}

fn command(c: Command) {
    let _ = shared().commands.send(c);
}

// ---------- Dessin ----------

#[derive(Clone, Copy)]
struct Palette {
    bg: u32,
    card: u32,
    line: u32,
    ink: u32,
    muted: u32,
    accent: u32,
    accent_ink: u32,
    accent_soft: u32,
    accent_strong: u32,
    warn_bg: u32,
    warn: u32,
    danger: u32,
    hover: u32,
}

const LIGHT: Palette = Palette {
    bg: 0xf3f4f6,
    card: 0xffffff,
    line: 0xe3e5e9,
    ink: 0x1b1b1b,
    muted: 0x5d6470,
    accent: 0x0f8f7a,
    accent_ink: 0xffffff,
    accent_soft: 0xd6f1ec,
    accent_strong: 0x0b7564,
    warn_bg: 0xfbead6,
    warn: 0x8f4e09,
    danger: 0xc23b3b,
    hover: 0xe9ebee,
};
const DARK_PALETTE: Palette = Palette {
    bg: 0x202226,
    card: 0x2c2e33,
    line: 0x3a3c42,
    ink: 0xf0f0f0,
    muted: 0xa3a7b0,
    accent: 0x3cc9b1,
    accent_ink: 0x06221d,
    accent_soft: 0x133a33,
    accent_strong: 0x5dd8c3,
    warn_bg: 0x3a2a14,
    warn: 0xf0a35b,
    danger: 0xd64545,
    hover: 0x33363c,
};

fn pal() -> Palette {
    if DARK.load(Ordering::Relaxed) {
        DARK_PALETTE
    } else {
        LIGHT
    }
}

fn color(rgb: u32, alpha: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r: ((rgb >> 16) & 0xff) as f32 / 255.0, g: ((rgb >> 8) & 0xff) as f32 / 255.0, b: (rgb & 0xff) as f32 / 255.0, a: alpha }
}

/// COLORREF (BGR) d'une couleur RVB.
fn colorref(rgb: u32) -> COLORREF {
    COLORREF(((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff))
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
struct R {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl R {
    fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }
    fn d2d(&self) -> D2D_RECT_F {
        D2D_RECT_F { left: self.x, top: self.y, right: self.x + self.w, bottom: self.y + self.h }
    }
    fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
    fn inset(&self, d: f32) -> Self {
        Self::new(self.x + d, self.y + d, self.w - 2.0 * d, self.h - 2.0 * d)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Act {
    Accept,
    Decline,
    View,
    Control,
    Copy,
    Close,
    Pause,
    Hand,
    Chat,
    Stop,
    Allow,
    Deny,
    Send,
    CloseChat,
}

#[derive(Clone, Copy, PartialEq)]
enum St {
    Title,
    Body,
    Strong,
    Muted,
    Small,
    Code,
    Icon,
    IconSmall,
}

#[derive(Clone, Copy, PartialEq)]
enum Al {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Primary,
    Secondary,
    Ghost,
    Danger,
    Tool,
    ToolOn,
}

enum Item {
    Text { r: R, text: String, st: St, color: u32, al: Al },
    Code { r: R, digits: String },
    Button { r: R, act: Act, label: String, kind: Kind, icon: Option<char> },
    Choice { r: R, act: Act, title: String, sub: String, selected: bool },
    Warn { r: R, text: String },
    Avatar { r: R, initials: String },
    Dot { r: R, color: u32 },
    Card { r: R },
    Signal { r: R, bars: u8 },
    Badge { r: R },
    Bubble { r: R, text: String, mine: bool },
    Sep { r: R },
}

impl Item {
    fn act(&self) -> Option<(Act, R)> {
        match self {
            Item::Button { r, act, .. } | Item::Choice { r, act, .. } => Some((*act, *r)),
            _ => None,
        }
    }
}

/// Glyphes de la police d'icônes de Windows (Segoe Fluent Icons / MDL2 Assets).
mod glyph {
    pub const PAUSE: char = '\u{E769}';
    pub const PLAY: char = '\u{E768}';
    pub const CHAT: char = '\u{E8BD}';
    pub const HAND: char = '\u{E7C9}';
    pub const LOCK: char = '\u{E72E}';
    pub const COPY: char = '\u{E8C8}';
    pub const CLOSE: char = '\u{E711}';
    pub const WARN: char = '\u{E7BA}';
    pub const SEND: char = '\u{E724}';
    pub const SYNC: char = '\u{E895}';
}

struct Gfx {
    d2d: ID2D1Factory,
    dw: IDWriteFactory,
    ui: Vec<u16>,
    title: Vec<u16>,
    mono: Vec<u16>,
    icons: Vec<u16>,
}

thread_local! {
    static GFX: RefCell<Option<Gfx>> = const { RefCell::new(None) };
    static TARGETS: RefCell<HashMap<isize, ID2D1HwndRenderTarget>> = RefCell::new(HashMap::new());
    /// Élément survolé, élément qui a le focus clavier (par fenêtre).
    static HOVER: RefCell<Option<(isize, Act)>> = const { RefCell::new(None) };
    static FOCUS: RefCell<HashMap<isize, usize>> = RefCell::new(HashMap::new());
}

/// Première police présente parmi `names`.
unsafe fn family(dw: &IDWriteFactory, names: &[&str]) -> Vec<u16> {
    let mut collection: Option<IDWriteFontCollection> = None;
    if dw.GetSystemFontCollection(&mut collection, false).is_ok() {
        if let Some(c) = collection {
            for n in names {
                let name = wide(n);
                let mut index = 0;
                let mut exists = windows::core::BOOL(0);
                if c.FindFamilyName(PCWSTR(name.as_ptr()), &mut index, &mut exists).is_ok() && exists.as_bool() {
                    return name;
                }
            }
        }
    }
    wide(names.last().copied().unwrap_or("Segoe UI"))
}

fn with_gfx<T>(f: impl FnOnce(&Gfx) -> T) -> T {
    GFX.with(|g| {
        let mut g = g.borrow_mut();
        if g.is_none() {
            // SAFETY : fabriques Direct2D et DirectWrite, gardées pour le fil de la fenêtre.
            unsafe {
                let d2d: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).expect("Direct2D");
                let dw: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).expect("DirectWrite");
                let ui = family(&dw, &["Segoe UI Variable Text", "Segoe UI"]);
                let title = family(&dw, &["Segoe UI Variable Display", "Segoe UI"]);
                let mono = family(&dw, &["Cascadia Mono", "Consolas"]);
                let icons = family(&dw, &["Segoe Fluent Icons", "Segoe MDL2 Assets"]);
                *g = Some(Gfx { d2d, dw, ui, title, mono, icons });
            }
        }
        f(g.as_ref().unwrap())
    })
}

fn style(st: St) -> (f32, DWRITE_FONT_WEIGHT) {
    match st {
        St::Title => (20.0, DWRITE_FONT_WEIGHT_SEMI_BOLD),
        St::Body => (13.5, DWRITE_FONT_WEIGHT_NORMAL),
        St::Strong => (14.0, DWRITE_FONT_WEIGHT_SEMI_BOLD),
        St::Muted => (13.0, DWRITE_FONT_WEIGHT_NORMAL),
        St::Small => (12.0, DWRITE_FONT_WEIGHT_NORMAL),
        St::Code => (27.0, DWRITE_FONT_WEIGHT_SEMI_BOLD),
        St::Icon => (16.0, DWRITE_FONT_WEIGHT_NORMAL),
        St::IconSmall => (13.0, DWRITE_FONT_WEIGHT_NORMAL),
    }
}

fn format(st: St, al: Al, wrap: bool, vcenter: bool) -> Option<IDWriteTextFormat> {
    with_gfx(|g| {
        let (size, weight) = style(st);
        let fam = match st {
            St::Title => &g.title,
            St::Code => &g.mono,
            St::Icon | St::IconSmall => &g.icons,
            _ => &g.ui,
        };
        // SAFETY : format de texte DirectWrite, paramètres valides.
        unsafe {
            let f = g.dw.CreateTextFormat(PCWSTR(fam.as_ptr()), None, weight, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, w!("")).ok()?;
            let _ = f.SetTextAlignment(match al {
                Al::Left => DWRITE_TEXT_ALIGNMENT_LEADING,
                Al::Center => DWRITE_TEXT_ALIGNMENT_CENTER,
                Al::Right => DWRITE_TEXT_ALIGNMENT_TRAILING,
            });
            let _ = f.SetParagraphAlignment(if vcenter { DWRITE_PARAGRAPH_ALIGNMENT_CENTER } else { DWRITE_PARAGRAPH_ALIGNMENT_NEAR });
            let _ = f.SetWordWrapping(if wrap { DWRITE_WORD_WRAPPING_WRAP } else { DWRITE_WORD_WRAPPING_NO_WRAP });
            Some(f)
        }
    })
}

/// Taille d'un texte (largeur, hauteur) dans une largeur donnée.
fn measure(text: &str, st: St, width: f32) -> (f32, f32) {
    let Some(f) = format(st, Al::Left, true, false) else { return (width, 20.0) };
    let t: Vec<u16> = text.encode_utf16().collect();
    with_gfx(|g| {
        // SAFETY : mise en page DirectWrite d'un texte borné.
        unsafe {
            let Ok(layout) = g.dw.CreateTextLayout(&t, &f, width, 10_000.0) else { return (width, 20.0) };
            let mut m = DWRITE_TEXT_METRICS::default();
            if layout.GetMetrics(&mut m).is_err() {
                return (width, 20.0);
            }
            (m.widthIncludingTrailingWhitespace.ceil(), m.height.ceil())
        }
    })
}

fn initials(who: &str) -> String {
    let name = who.split(['(', '\n', '@']).next().unwrap_or(who).trim();
    let mut parts = name.split([' ', '.', '-', '_']).filter(|p| !p.is_empty());
    let a = parts.next().and_then(|p| p.chars().next());
    let b = parts.last().and_then(|p| p.chars().next());
    match (a, b) {
        (Some(a), Some(b)) => format!("{}{}", a.to_uppercase(), b.to_uppercase()),
        (Some(a), None) => a.to_uppercase().collect(),
        _ => "?".into(),
    }
}

/// Nom court (sans le serveur ni le domaine) pour la barre.
fn short_name(who: &str) -> String {
    who.split(['(', '\n']).next().unwrap_or(who).trim().to_string()
}

fn clock(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

// ---------- Mise en page ----------

/// Rangée de boutons alignés à droite ; rend la place prise à gauche.
fn buttons(items: &mut Vec<Item>, right: f32, y: f32, list: &[(Act, &str, Kind)]) -> f32 {
    let mut x = right;
    for (act, label, kind) in list.iter().rev() {
        let w = (measure(label, St::Strong, 400.0).0 + 32.0).max(96.0);
        x -= w;
        items.push(Item::Button { r: R::new(x, y, w, 32.0), act: *act, label: (*label).into(), kind: *kind, icon: None });
        x -= 8.0;
    }
    x
}

/// Fenêtre principale : éléments et hauteur.
fn main_layout(screen: &Screen, pulse: bool) -> (Vec<Item>, f32) {
    let p = pal();
    let (pad, w) = (24.0, MAIN_W);
    let inner = w - 2.0 * pad;
    let mut items = Vec::new();
    let mut y = 18.0;
    let text = |items: &mut Vec<Item>, y: &mut f32, t: &str, st: St, color: u32, gap: f32| {
        let h = measure(t, st, inner).1;
        items.push(Item::Text { r: R::new(pad, *y, inner, h), text: t.into(), st, color, al: Al::Left });
        *y += h + gap;
    };
    match screen {
        Screen::Connecting | Screen::Session => {
            text(&mut items, &mut y, tr("Connecting to the assistance server…", "Connexion au serveur d'assistance…"), St::Title, p.ink, 14.0);
            items.push(Item::Dot { r: R::new(pad, y + 4.0, 8.0, 8.0), color: if pulse { p.accent } else { p.accent_soft } });
            text(&mut items, &mut y, "", St::Body, p.muted, 10.0);
        }
        Screen::Code { code, until } => {
            text(&mut items, &mut y, tr("Read these digits to the person helping you", "Lisez ces chiffres à la personne qui vous aide"), St::Title, p.ink, 4.0);
            text(&mut items, &mut y, tr("Nobody sees your screen until you accept.", "Personne ne voit votre écran tant que vous n'avez pas accepté."), St::Muted, p.muted, 16.0);
            items.push(Item::Card { r: R::new(pad, y, inner, 84.0) });
            items.push(Item::Code { r: R::new(pad, y + 16.0, inner, 52.0), digits: code.clone() });
            y += 84.0 + 14.0;
            items.push(Item::Dot { r: R::new(pad, y + 12.0, 8.0, 8.0), color: if pulse { p.accent } else { p.accent_soft } });
            let label = tr("Copy", "Copier");
            let bw = measure(label, St::Strong, 200.0).0 + 40.0;
            items.push(Item::Button { r: R::new(w - pad - bw, y, bw, 32.0), act: Act::Copy, label: label.into(), kind: Kind::Ghost, icon: Some(glyph::COPY) });
            items.push(Item::Text {
                r: R::new(pad + 18.0, y, inner - bw - 18.0, 32.0),
                text: tr("Waiting for the person helping you…", "En attente de la personne qui vous aide…").into(),
                st: St::Body,
                color: p.ink,
                al: Al::Left,
            });
            y += 32.0 + 6.0;
            let server = crate::relay_host();
            items.push(Item::Text { r: R::new(pad, y, 18.0, 22.0), text: glyph::LOCK.to_string(), st: St::IconSmall, color: p.accent, al: Al::Left });
            items.push(Item::Text { r: R::new(pad + 20.0, y, inner * 0.6, 22.0), text: server, st: St::Small, color: p.muted, al: Al::Left });
            if let Some(until) = until {
                let left = until.saturating_duration_since(Instant::now()).as_secs().div_ceil(60);
                let t = if shared().fr { format!("Valable encore {left} min") } else { format!("Valid for {left} more min") };
                items.push(Item::Text { r: R::new(pad, y, inner, 22.0), text: t, st: St::Small, color: p.muted, al: Al::Right });
            }
            y += 22.0 + 6.0;
        }
        Screen::Consent { who, server, control, deadline } => {
            items.push(Item::Avatar { r: R::new(pad, y, 44.0, 44.0), initials: initials(who) });
            let name_w = inner - 56.0;
            let nh = measure(who, St::Strong, name_w).1;
            items.push(Item::Text { r: R::new(pad + 56.0, y + 2.0, name_w, nh), text: who.clone(), st: St::Strong, color: p.ink, al: Al::Left });
            let sub = format!("{} ", tr("wants to help you, through", "veut vous aider, par le serveur"));
            let sw = measure(&sub, St::Muted, name_w).0;
            items.push(Item::Text { r: R::new(pad + 56.0, y + 4.0 + nh, sw, 20.0), text: sub, st: St::Muted, color: p.muted, al: Al::Left });
            items.push(Item::Text { r: R::new(pad + 56.0 + sw, y + 5.0 + nh, 16.0, 20.0), text: glyph::LOCK.to_string(), st: St::IconSmall, color: p.accent, al: Al::Left });
            items.push(Item::Text { r: R::new(pad + 74.0 + sw, y + 4.0 + nh, (name_w - sw - 18.0).max(40.0), 20.0), text: server.clone(), st: St::Strong, color: p.ink, al: Al::Left });
            y += (nh + 26.0).max(44.0) + 16.0;
            for (act, title, sub, selected) in [
                (Act::View, tr("View only", "Voir seulement"), tr("They see your screen; you keep the mouse and keyboard.", "Il voit votre écran, vous gardez la souris et le clavier."), !control),
                (
                    Act::Control,
                    tr("View and control", "Voir et contrôler"),
                    tr("They can use the mouse and keyboard. You can take back control at any time.", "Il peut utiliser la souris et le clavier. Vous pouvez reprendre la main à tout moment."),
                    *control,
                ),
            ] {
                let h = 14.0 + measure(title, St::Strong, inner - 54.0).1 + measure(sub, St::Small, inner - 54.0).1 + 14.0;
                items.push(Item::Choice { r: R::new(pad, y, inner, h), act, title: title.into(), sub: sub.into(), selected });
                y += h + 8.0;
            }
            y += 4.0;
            let warn = tr(
                "Don't know this person? Decline. Neither Microsoft, your bank nor the tax office will ever ask you this.",
                "Vous ne connaissez pas cette personne ? Refusez. Ni Microsoft, ni votre banque, ni les impôts ne vous demanderont jamais cela.",
            );
            let wh = measure(warn, St::Small, inner - 44.0).1 + 20.0;
            items.push(Item::Warn { r: R::new(pad, y, inner, wh), text: warn.into() });
            y += wh + 18.0;
            let left = deadline.saturating_duration_since(Instant::now()).as_secs();
            let t = if shared().fr { format!("Refus automatique dans {}", clock(Duration::from_secs(left))) } else { format!("Declined automatically in {}", clock(Duration::from_secs(left))) };
            let x = buttons(&mut items, w - pad, y, &[(Act::Decline, tr("Decline", "Refuser"), Kind::Secondary), (Act::Accept, tr("Accept", "Accepter"), Kind::Primary)]);
            items.push(Item::Text { r: R::new(pad, y, x - pad, 32.0), text: t, st: St::Small, color: p.muted, al: Al::Left });
            y += 32.0 + 4.0;
        }
        Screen::Ended(s) => {
            text(&mut items, &mut y, tr("The assistance has ended", "L'assistance est terminée"), St::Title, p.ink, 4.0);
            let sub = format!("{} {}", s.reason, tr("Nobody sees your screen any more.", "Personne ne voit plus votre écran."));
            text(&mut items, &mut y, &sub, St::Muted, p.muted, 16.0);
            if !s.who.is_empty() {
                let cw = (inner - 16.0) / 3.0;
                let stats = [
                    (clock(s.duration), tr("Duration", "Durée")),
                    (if s.control { tr("Yes", "Oui") } else { tr("No", "Non") }.to_string(), tr("Control given", "Contrôle donné")),
                    (s.messages.to_string(), tr("Messages", "Messages")),
                ];
                for (i, (value, label)) in stats.into_iter().enumerate() {
                    items.push(Item::Card { r: R::new(pad + i as f32 * (cw + 8.0), y, cw, 58.0) });
                    items.push(Item::Text { r: R::new(pad + i as f32 * (cw + 8.0) + 12.0, y + 9.0, cw - 24.0, 22.0), text: value, st: St::Strong, color: p.ink, al: Al::Left });
                    items.push(Item::Text { r: R::new(pad + i as f32 * (cw + 8.0) + 12.0, y + 32.0, cw - 24.0, 18.0), text: label.into(), st: St::Small, color: p.muted, al: Al::Left });
                }
                y += 58.0 + 16.0;
            }
            let x = buttons(&mut items, w - pad, y, &[(Act::Close, tr("Close", "Fermer"), Kind::Primary)]);
            items.push(Item::Text {
                r: R::new(pad, y - 4.0, x - pad, 40.0),
                text: tr("You can delete this program: nothing was installed.", "Vous pouvez supprimer ce programme : rien n'a été installé.").into(),
                st: St::Small,
                color: p.muted,
                al: Al::Left,
            });
            y += 32.0 + 4.0;
        }
        Screen::Error(msg) => {
            text(&mut items, &mut y, tr("Portunia Assistance cannot continue", "Portunia Assistance ne peut pas continuer"), St::Title, p.ink, 8.0);
            text(&mut items, &mut y, msg, St::Body, p.ink, 18.0);
            buttons(&mut items, w - pad, y, &[(Act::Close, tr("Close", "Fermer"), Kind::Primary)]);
            y += 32.0 + 4.0;
        }
    }
    (items, y + 20.0)
}

/// Barre de session : éléments et largeur.
fn bar_layout(s: &SessionView) -> (Vec<Item>, f32) {
    let p = pal();
    let mut items = Vec::new();
    let h = BAR_H;
    let mut x = 9.0;
    items.push(Item::Avatar { r: R::new(x, 9.0, 28.0, 28.0), initials: initials(&s.who) });
    x += 28.0 + 10.0;
    let name = short_name(&s.who);
    if s.asking {
        let t = if shared().fr { format!("{name} demande le contrôle") } else { format!("{name} asks for control") };
        let tw = measure(&t, St::Strong, 400.0).0;
        items.push(Item::Text { r: R::new(x, 0.0, tw, h), text: t, st: St::Strong, color: p.ink, al: Al::Left });
        x += tw + 12.0;
        for (act, label, kind) in [(Act::Allow, tr("Allow", "Accepter"), Kind::Primary), (Act::Deny, tr("Decline", "Refuser"), Kind::Secondary)] {
            let bw = measure(label, St::Strong, 200.0).0 + 28.0;
            items.push(Item::Button { r: R::new(x, 7.0, bw, 32.0), act, label: label.into(), kind, icon: None });
            x += bw + 6.0;
        }
        return (items, x + 4.0);
    }
    let (status, color) = if s.reconnecting {
        (tr("reconnecting…", "reconnexion…").to_string(), p.warn)
    } else if s.paused {
        (tr("paused", "en pause").to_string(), p.warn)
    } else if s.control {
        (format!("{} · {}", tr("controls", "contrôle"), clock(s.since.elapsed())), p.muted)
    } else {
        (format!("{} · {}", tr("views", "voit"), clock(s.since.elapsed())), p.muted)
    };
    let nw = measure(&name, St::Strong, 220.0).0.min(220.0);
    items.push(Item::Text { r: R::new(x, 0.0, nw, h), text: name, st: St::Strong, color: p.ink, al: Al::Left });
    x += nw + 6.0;
    let sw = measure(&status, St::Small, 200.0).0;
    items.push(Item::Text { r: R::new(x, 0.0, sw, h), text: status, st: St::Small, color, al: Al::Left });
    x += sw + 10.0;
    let bars = match s.rtt.map(|d| d.as_millis()) {
        _ if s.reconnecting => 0,
        None => 4,
        Some(ms) if ms < 80 => 4,
        Some(ms) if ms < 160 => 3,
        Some(ms) if ms < 350 => 2,
        _ => 1,
    };
    items.push(Item::Signal { r: R::new(x, 16.0, 16.0, 14.0), bars });
    x += 16.0 + 10.0;
    items.push(Item::Sep { r: R::new(x, 11.0, 1.0, h - 22.0) });
    x += 7.0;
    let tool = |on: bool| if on { Kind::ToolOn } else { Kind::Tool };
    for (act, icon, on) in [
        (Act::Pause, if s.paused { glyph::PLAY } else { glyph::PAUSE }, s.paused),
        (Act::Hand, glyph::HAND, s.control),
        (Act::Chat, glyph::CHAT, hwnd(&CHAT).is_some()),
    ] {
        items.push(Item::Button { r: R::new(x, 7.0, 36.0, 32.0), act, label: String::new(), kind: tool(on), icon: Some(icon) });
        if act == Act::Chat && s.unread {
            items.push(Item::Badge { r: R::new(x + 25.0, 10.0, 8.0, 8.0) });
        }
        x += 38.0;
    }
    let label = tr("Stop", "Arrêter");
    let bw = measure(label, St::Strong, 200.0).0 + 26.0;
    items.push(Item::Button { r: R::new(x + 4.0, 7.0, bw, 32.0), act: Act::Stop, label: label.into(), kind: Kind::Danger, icon: None });
    x += 4.0 + bw + 7.0;
    (items, x)
}

/// Fenêtre de discussion (la zone de saisie est un contrôle Windows posé en bas).
fn chat_layout(s: &SessionView) -> (Vec<Item>, f32) {
    let p = pal();
    let (w, h) = (CHAT_W, CHAT_H);
    let mut items = Vec::new();
    items.push(Item::Text { r: R::new(16.0, 0.0, 200.0, 44.0), text: tr("Chat", "Discussion").into(), st: St::Strong, color: p.ink, al: Al::Left });
    items.push(Item::Button { r: R::new(w - 44.0, 6.0, 36.0, 32.0), act: Act::CloseChat, label: String::new(), kind: Kind::Tool, icon: Some(glyph::CLOSE) });
    items.push(Item::Sep { r: R::new(0.0, 44.0, w, 1.0) });
    // Messages, du plus récent (en bas) au plus ancien, tant qu'il y a de la place.
    let mut y = h - 60.0;
    let max = w - 90.0;
    for (mine, text) in s.messages.iter().rev() {
        let (tw, th) = measure(text, St::Body, max);
        let (bw, bh) = (tw + 22.0, th + 14.0);
        y -= bh;
        if y < 52.0 {
            break;
        }
        let x = if *mine { w - 12.0 - bw } else { 12.0 };
        items.push(Item::Bubble { r: R::new(x, y, bw, bh), text: text.clone(), mine: *mine });
        y -= 8.0;
    }
    if s.messages.is_empty() {
        items.push(Item::Text {
            r: R::new(24.0, 120.0, w - 48.0, 60.0),
            text: tr("Messages are kept only during the assistance.", "Les messages ne sont gardés que pendant l'assistance.").into(),
            st: St::Small,
            color: p.muted,
            al: Al::Center,
        });
    }
    items.push(Item::Card { r: R::new(12.0, h - 48.0, w - 64.0, 36.0) });
    items.push(Item::Button { r: R::new(w - 48.0, h - 48.0, 36.0, 36.0), act: Act::Send, label: String::new(), kind: Kind::Primary, icon: Some(glyph::SEND) });
    (items, h)
}

unsafe fn draw(rt: &ID2D1HwndRenderTarget, items: &[Item], hover: Option<Act>, focus: Option<Act>, bg: u32) {
    let p = pal();
    let brush = |c: u32, a: f32| -> Option<ID2D1SolidColorBrush> { rt.CreateSolidColorBrush(&color(c, a), None).ok() };
    rt.Clear(Some(&color(bg, 1.0)));
    let round = |r: R, rad: f32| D2D1_ROUNDED_RECT { rect: r.d2d(), radiusX: rad, radiusY: rad };
    let text = |r: R, t: &str, st: St, c: u32, al: Al, vcenter: bool| {
        if let (Some(f), Some(b)) = (format(st, al, true, vcenter), brush(c, 1.0)) {
            let t: Vec<u16> = t.encode_utf16().collect();
            rt.DrawText(&t, &f, &r.d2d(), &b, D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
        }
    };
    for item in items {
        match item {
            Item::Text { r, text: t, st, color: c, al } => {
                let vcenter = matches!(st, St::Icon | St::IconSmall) || r.h >= 30.0;
                text(*r, t, *st, *c, *al, vcenter)
            }
            Item::Card { r } => {
                if let (Some(fill), Some(line)) = (brush(p.card, 1.0), brush(p.line, 1.0)) {
                    rt.FillRoundedRectangle(&round(*r, 8.0), &fill);
                    rt.DrawRoundedRectangle(&round(r.inset(0.5), 8.0), &line, 1.0, None);
                }
            }
            Item::Code { r, digits } => {
                // Trois groupes de chiffres dans des cases.
                let groups: Vec<&str> = digits.split(' ').collect();
                let (cw, gap, ggap) = (32.0, 4.0, 18.0);
                let total: f32 = groups.iter().map(|g| g.chars().count() as f32 * (cw + gap) - gap).sum::<f32>() + ggap * (groups.len().saturating_sub(1)) as f32;
                let mut x = r.x + (r.w - total) / 2.0;
                for g in groups {
                    for d in g.chars() {
                        let cell = R::new(x, r.y, cw, r.h);
                        if let Some(b) = brush(p.accent_soft, 1.0) {
                            rt.FillRoundedRectangle(&round(cell, 6.0), &b);
                        }
                        text(cell, &d.to_string(), St::Code, p.accent_strong, Al::Center, true);
                        x += cw + gap;
                    }
                    x += ggap - gap;
                }
            }
            Item::Button { r, act, label, kind, icon } => {
                let hovered = hover == Some(*act);
                let (fill, ink, line) = match kind {
                    Kind::Primary => (Some(if hovered { p.accent_strong } else { p.accent }), p.accent_ink, None),
                    Kind::Danger => (Some(p.danger), 0xffffff, None),
                    Kind::Secondary => (Some(if hovered { p.hover } else { p.card }), p.ink, Some(p.line)),
                    Kind::Ghost => (hovered.then_some(p.hover), p.accent_strong, None),
                    Kind::Tool => (hovered.then_some(p.hover), p.ink, None),
                    Kind::ToolOn => (Some(p.accent_soft), p.accent_strong, None),
                };
                if let Some(f) = fill.and_then(|c| brush(c, if *kind == Kind::Danger && hovered { 0.85 } else { 1.0 })) {
                    rt.FillRoundedRectangle(&round(*r, 6.0), &f);
                }
                if let Some(l) = line.and_then(|c| brush(c, 1.0)) {
                    rt.DrawRoundedRectangle(&round(r.inset(0.5), 6.0), &l, 1.0, None);
                }
                match (icon, label.is_empty()) {
                    (Some(i), true) => text(*r, &i.to_string(), St::Icon, ink, Al::Center, true),
                    (Some(i), false) => {
                        text(R::new(r.x + 10.0, r.y, 20.0, r.h), &i.to_string(), St::IconSmall, ink, Al::Center, true);
                        text(R::new(r.x + 30.0, r.y, r.w - 36.0, r.h), label, St::Strong, ink, Al::Left, true);
                    }
                    _ => text(*r, label, St::Strong, ink, Al::Center, true),
                }
                if focus == Some(*act) {
                    if let Some(b) = brush(p.ink, 0.9) {
                        rt.DrawRoundedRectangle(&round(r.inset(-2.5), 8.0), &b, 2.0, None);
                    }
                }
            }
            Item::Choice { r, act, title, sub, selected } => {
                let hovered = hover == Some(*act);
                if let Some(fill) = brush(if hovered && !selected { p.hover } else { p.card }, 1.0) {
                    rt.FillRoundedRectangle(&round(*r, 8.0), &fill);
                }
                if let Some(line) = brush(if *selected { p.accent } else { p.line }, 1.0) {
                    rt.DrawRoundedRectangle(&round(r.inset(if *selected { 1.0 } else { 0.5 }), 8.0), &line, if *selected { 2.0 } else { 1.0 }, None);
                }
                // Bouton radio.
                let c = windows_numerics::Vector2 { X: r.x + 22.0, Y: r.y + 23.0 };
                if let Some(b) = brush(if *selected { p.accent } else { p.muted }, 1.0) {
                    let e = D2D1_ELLIPSE { point: c, radiusX: 8.0, radiusY: 8.0 };
                    if *selected {
                        rt.FillEllipse(&e, &b);
                        if let Some(dot) = brush(p.card, 1.0) {
                            rt.FillEllipse(&D2D1_ELLIPSE { point: c, radiusX: 3.5, radiusY: 3.5 }, &dot);
                        }
                    } else {
                        rt.DrawEllipse(&e, &b, 1.5, None);
                    }
                }
                let th = measure(title, St::Strong, r.w - 54.0).1;
                text(R::new(r.x + 42.0, r.y + 13.0, r.w - 54.0, th), title, St::Strong, p.ink, Al::Left, false);
                text(R::new(r.x + 42.0, r.y + 13.0 + th + 1.0, r.w - 54.0, r.h), sub, St::Small, p.muted, Al::Left, false);
                if focus == Some(*act) {
                    if let Some(b) = brush(p.ink, 0.9) {
                        rt.DrawRoundedRectangle(&round(r.inset(-2.5), 10.0), &b, 2.0, None);
                    }
                }
            }
            Item::Warn { r, text: t } => {
                if let Some(b) = brush(p.warn_bg, 1.0) {
                    rt.FillRoundedRectangle(&round(*r, 8.0), &b);
                }
                text(R::new(r.x + 12.0, r.y + 10.0, 20.0, 20.0), &glyph::WARN.to_string(), St::IconSmall, p.warn, Al::Left, false);
                text(R::new(r.x + 34.0, r.y + 10.0, r.w - 44.0, r.h - 12.0), t, St::Small, p.warn, Al::Left, false);
            }
            Item::Avatar { r, initials } => {
                if let Some(b) = brush(p.accent, 1.0) {
                    rt.FillEllipse(&D2D1_ELLIPSE { point: windows_numerics::Vector2 { X: r.x + r.w / 2.0, Y: r.y + r.h / 2.0 }, radiusX: r.w / 2.0, radiusY: r.h / 2.0 }, &b);
                }
                text(*r, initials, if r.w > 36.0 { St::Strong } else { St::Small }, p.accent_ink, Al::Center, true);
            }
            Item::Dot { r, color: c } => {
                if let Some(b) = brush(*c, 1.0) {
                    rt.FillEllipse(&D2D1_ELLIPSE { point: windows_numerics::Vector2 { X: r.x + r.w / 2.0, Y: r.y + r.h / 2.0 }, radiusX: r.w / 2.0, radiusY: r.h / 2.0 }, &b);
                }
            }
            Item::Signal { r, bars } => {
                for i in 0..4u8 {
                    let bh = 4.0 + i as f32 * 3.3;
                    let bar = R::new(r.x + i as f32 * 4.0, r.y + r.h - bh, 3.0, bh);
                    let c = if i < *bars { if *bars <= 1 { p.warn } else { p.accent } } else { p.line };
                    if let Some(b) = brush(c, 1.0) {
                        rt.FillRoundedRectangle(&round(bar, 1.0), &b);
                    }
                }
            }
            Item::Badge { r } => {
                if let Some(b) = brush(p.danger, 1.0) {
                    rt.FillEllipse(&D2D1_ELLIPSE { point: windows_numerics::Vector2 { X: r.x + r.w / 2.0, Y: r.y + r.h / 2.0 }, radiusX: r.w / 2.0, radiusY: r.h / 2.0 }, &b);
                }
            }
            Item::Bubble { r, text: t, mine } => {
                if let Some(b) = brush(if *mine { p.accent } else { p.card }, 1.0) {
                    rt.FillRoundedRectangle(&round(*r, 10.0), &b);
                }
                if !mine {
                    if let Some(l) = brush(p.line, 1.0) {
                        rt.DrawRoundedRectangle(&round(r.inset(0.5), 10.0), &l, 1.0, None);
                    }
                }
                text(R::new(r.x + 11.0, r.y + 7.0, r.w - 20.0, r.h - 10.0), t, St::Body, if *mine { p.accent_ink } else { p.ink }, Al::Left, false);
            }
            Item::Sep { r } => {
                if let Some(b) = brush(p.line, 1.0) {
                    rt.FillRectangle(&r.d2d(), &b);
                }
            }
        }
    }
    let _ = D2D1_DRAW_TEXT_OPTIONS_CLIP;
}

/// Cible de dessin de la fenêtre, créée au premier dessin.
unsafe fn target(h: HWND) -> Option<ID2D1HwndRenderTarget> {
    let key = h.0 as isize;
    if let Some(t) = TARGETS.with(|m| m.borrow().get(&key).cloned()) {
        return Some(t);
    }
    let mut rc = RECT::default();
    GetClientRect(h, &mut rc).ok()?;
    let dpi = GetDpiForWindow(h) as f32;
    let props = D2D1_RENDER_TARGET_PROPERTIES {
        pixelFormat: D2D1_PIXEL_FORMAT { format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_UNKNOWN, alphaMode: D2D1_ALPHA_MODE_UNKNOWN },
        dpiX: dpi,
        dpiY: dpi,
        ..Default::default()
    };
    let hprops = D2D1_HWND_RENDER_TARGET_PROPERTIES {
        hwnd: h,
        pixelSize: D2D_SIZE_U { width: rc.right.max(1) as u32, height: rc.bottom.max(1) as u32 },
        presentOptions: D2D1_PRESENT_OPTIONS_NONE,
    };
    let t = with_gfx(|g| g.d2d.CreateHwndRenderTarget(&props, &hprops).ok())?;
    TARGETS.with(|m| m.borrow_mut().insert(key, t.clone()));
    Some(t)
}

fn forget_target(h: HWND) {
    TARGETS.with(|m| m.borrow_mut().remove(&(h.0 as isize)));
}

/// Mise à l'échelle de l'écran de la fenêtre (1.0 à 96 ppp).
unsafe fn scale(h: HWND) -> f32 {
    GetDpiForWindow(h).max(96) as f32 / 96.0
}

fn layout_for(h: HWND) -> (Vec<Item>, f32) {
    if Some(h) == hwnd(&BAR) {
        bar_layout(&shared().session.lock().unwrap())
    } else if Some(h) == hwnd(&CHAT) {
        chat_layout(&shared().session.lock().unwrap())
    } else {
        main_layout(&shared().screen.lock().unwrap(), PULSE.load(Ordering::Relaxed))
    }
}

static PULSE: AtomicBool = AtomicBool::new(false);

unsafe fn paint(h: HWND) {
    let mut ps = PAINTSTRUCT::default();
    BeginPaint(h, &mut ps);
    if let Some(rt) = target(h) {
        let (items, _) = layout_for(h);
        let key = h.0 as isize;
        let hover = HOVER.with(|v| v.borrow().filter(|(k, _)| *k == key).map(|(_, a)| a));
        let focus = FOCUS.with(|f| f.borrow().get(&key).copied()).and_then(|i| items.iter().filter_map(Item::act).nth(i)).map(|(a, _)| a);
        rt.BeginDraw();
        rt.SetTextAntialiasMode(windows::Win32::Graphics::Direct2D::D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        let p = pal();
        draw(&rt, &items, hover, focus, if Some(h) == hwnd(&BAR) || Some(h) == hwnd(&CHAT) { p.bg } else { p.bg });
        if rt.EndDraw(None, None).is_err() {
            forget_target(h);
        }
    }
    let _ = EndPaint(h, &ps);
}

/// Point de la souris en unités de mise en page.
unsafe fn cursor(h: HWND, lp: LPARAM) -> (f32, f32) {
    let s = scale(h);
    ((lp.0 & 0xffff) as i16 as f32 / s, ((lp.0 >> 16) & 0xffff) as i16 as f32 / s)
}

fn hit(h: HWND, x: f32, y: f32) -> Option<Act> {
    layout_for(h).0.iter().filter_map(Item::act).find(|(_, r)| r.contains(x, y)).map(|(a, _)| a)
}

// ---------- Actions ----------

unsafe fn act(h: HWND, a: Act) {
    let screen = shared().screen.lock().unwrap().clone();
    match a {
        Act::View | Act::Control => {
            if let Screen::Consent { who, server, deadline, .. } = screen {
                set(Screen::Consent { who, server, control: a == Act::Control, deadline });
            }
        }
        Act::Accept => {
            if let Screen::Consent { control, .. } = screen {
                answer(Some(control));
            }
        }
        Act::Decline => answer(None),
        Act::Copy => {
            if let Screen::Code { code, .. } = screen {
                copy_text(h, &code.replace(' ', ""));
            }
        }
        Act::Close => {
            if let Some(m) = hwnd(&MAIN) {
                let _ = DestroyWindow(m);
            }
        }
        Act::Pause => {
            let paused = shared().session.lock().unwrap().paused;
            command(Command::Pause(!paused));
        }
        Act::Hand => {
            let control = shared().session.lock().unwrap().control;
            command(Command::Control(!control));
        }
        Act::Allow | Act::Deny => {
            shared().session.lock().unwrap().asking = false;
            command(Command::Control(a == Act::Allow));
            post(&BAR);
        }
        Act::Chat => toggle_chat(),
        Act::CloseChat => {
            if let Some(c) = hwnd(&CHAT) {
                let _ = DestroyWindow(c);
            }
        }
        Act::Send => send_chat(),
        Act::Stop => command(Command::Stop),
    }
}

fn answer(choice: Option<bool>) {
    if let Some(tx) = shared().consent.lock().unwrap().take() {
        let _ = tx.send(choice);
    }
    if choice.is_none() {
        set(Screen::Connecting);
    }
}

/// Copie un texte dans le presse-papiers de Windows.
unsafe fn copy_text(h: HWND, text: &str) {
    use windows::Win32::{
        Foundation::HANDLE,
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        },
    };
    let data = wide(text);
    if OpenClipboard(Some(h)).is_err() {
        return;
    }
    let _ = EmptyClipboard();
    if let Ok(mem) = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2) {
        let ptr = GlobalLock(mem) as *mut u16;
        if !ptr.is_null() {
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
            let _ = GlobalUnlock(mem);
            // CF_UNICODETEXT = 13.
            let _ = SetClipboardData(13, Some(HANDLE(mem.0)));
        }
    }
    let _ = CloseClipboard();
}

// ---------- Fenêtres ----------

/// Crée les fenêtres et fait tourner la boucle de messages (fil principal).
pub fn run(commands: UnboundedSender<Command>) {
    let _ = SHARED.set(Arc::new(Shared {
        screen: Mutex::new(Screen::Connecting),
        session: Mutex::new(SessionView {
            who: String::new(),
            control: false,
            paused: false,
            since: Instant::now(),
            rtt: None,
            reconnecting: false,
            asking: false,
            messages: Vec::new(),
            unread: false,
        }),
        consent: Mutex::new(None),
        commands,
        fr: system_is_french(),
    }));
    DARK.store(system_is_dark(), Ordering::Relaxed);
    // SAFETY : création classique de fenêtres Win32 sur ce fil, qui garde la boucle de messages.
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        // Logo de Portunia (ressource 1, voir build.rs), aux tailles exactes de la barre des tâches et du titre.
        let logo = |metric_w, metric_h| {
            LoadImageW(Some(instance), PCWSTR(1 as _), IMAGE_ICON, GetSystemMetrics(metric_w), GetSystemMetrics(metric_h), LR_DEFAULTCOLOR)
                .map(|h| HICON(h.0))
                .or_else(|_| LoadIconW(None, IDI_APPLICATION))
                .unwrap_or_default()
        };
        let (icon, small) = (logo(SM_CXICON, SM_CYICON), logo(SM_CXSMICON, SM_CYSMICON));
        type Proc = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;
        for (name, proc_) in [
            (w!("PortuniaAssist"), main_proc as Proc),
            (w!("PortuniaAssistBar"), bar_proc as Proc),
            (w!("PortuniaAssistChat"), chat_proc as Proc),
            (w!("PortuniaAssistFrame"), frame_proc as Proc),
        ] {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(proc_),
                hInstance: instance,
                lpszClassName: name,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                hIcon: icon,
                hIconSm: small,
                ..Default::default()
            };
            RegisterClassExW(&class);
        }
        let main = CreateWindowExW(
            WS_EX_TOPMOST,
            w!("PortuniaAssist"),
            w!("Portunia Assistance"),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            480,
            360,
            None,
            None,
            Some(instance),
            None,
        )
        .expect("fenêtre principale");
        MAIN.store(main.0 as isize, Ordering::Relaxed);
        theme_caption(main);
        fit_main(main, true);
        let _ = ShowWindow(main, SW_SHOW);
        SetTimer(Some(main), TIMER, 500, None);
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(escape_hook), Some(instance), 0).ok();
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            // Entrée dans la zone de saisie de la discussion : envoyer.
            if msg.message == WM_KEYDOWN && msg.wParam.0 as u16 == VK_RETURN.0 && Some(msg.hwnd) == hwnd(&EDIT) {
                send_chat();
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if let Some(h) = hook {
            let _ = UnhookWindowsHookEx(h);
        }
    }
}

/// Barre de titre de la couleur de la fenêtre (Windows 11), sombre si le thème l'est.
unsafe fn theme_caption(h: HWND) {
    let dark: i32 = DARK.load(Ordering::Relaxed) as i32;
    let _ = DwmSetWindowAttribute(h, DWMWA_USE_IMMERSIVE_DARK_MODE, (&dark as *const i32).cast(), 4);
    let bg = colorref(pal().bg).0;
    let _ = DwmSetWindowAttribute(h, DWMWA_CAPTION_COLOR, (&bg as *const u32).cast(), 4);
    let ink = colorref(pal().ink).0;
    let _ = DwmSetWindowAttribute(h, DWMWA_TEXT_COLOR, (&ink as *const u32).cast(), 4);
}

/// Taille de la fenêtre principale ajustée à son contenu ; `center` : au milieu de l'écran.
unsafe fn fit_main(h: HWND, center: bool) {
    let s = scale(h);
    let (_, height) = main_layout(&shared().screen.lock().unwrap(), false);
    let dpi = GetDpiForWindow(h);
    let mut rc = RECT { left: 0, top: 0, right: (MAIN_W * s) as i32, bottom: (height * s) as i32 };
    let _ = AdjustWindowRectExForDpi(&mut rc, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, false, WS_EX_TOPMOST, dpi);
    let (w, ht) = (rc.right - rc.left, rc.bottom - rc.top);
    let mut cur = RECT::default();
    let _ = GetWindowRect(h, &mut cur);
    if !center && cur.right - cur.left == w && cur.bottom - cur.top == ht {
        return;
    }
    let (x, y) = if center {
        ((GetSystemMetrics(SM_CXSCREEN) - w) / 2, (GetSystemMetrics(SM_CYSCREEN) - ht) / 3)
    } else {
        (cur.left, cur.top)
    };
    let _ = SetWindowPos(h, None, x, y, w, ht, SWP_NOZORDER | SWP_NOACTIVATE);
}

fn stop_session() {
    command(Command::Stop);
}

/// Souris : survol et clics, communs aux trois fenêtres dessinées.
unsafe fn mouse(h: HWND, msg: u32, lp: LPARAM) -> bool {
    match msg {
        WM_MOUSEMOVE => {
            let (x, y) = cursor(h, lp);
            let now = hit(h, x, y).map(|a| (h.0 as isize, a));
            let changed = HOVER.with(|v| {
                let mut v = v.borrow_mut();
                let c = *v != now;
                *v = now;
                c
            });
            if changed {
                let _ = InvalidateRect(Some(h), None, false);
                SetCursor(LoadCursorW(None, if now.is_some() { IDC_HAND } else { IDC_ARROW }).ok());
            }
            let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: h, dwHoverTime: 0 };
            let _ = TrackMouseEvent(&mut t);
            true
        }
        WM_MOUSELEAVE => {
            HOVER.with(|v| *v.borrow_mut() = None);
            let _ = InvalidateRect(Some(h), None, false);
            true
        }
        WM_LBUTTONUP => {
            let (x, y) = cursor(h, lp);
            if let Some(a) = hit(h, x, y) {
                act(h, a);
            }
            true
        }
        _ => false,
    }
}

/// Clavier : Tab passe d'un bouton à l'autre, Entrée et Espace l'activent.
unsafe fn keys(h: HWND, wp: WPARAM) -> bool {
    let key = wp.0 as u16;
    let acts: Vec<Act> = layout_for(h).0.iter().filter_map(Item::act).map(|(a, _)| a).collect();
    if acts.is_empty() {
        return false;
    }
    let k = h.0 as isize;
    if key == VK_TAB.0 {
        let back = GetKeyState(VK_SHIFT.0 as i32) < 0;
        FOCUS.with(|f| {
            let mut f = f.borrow_mut();
            let cur = f.get(&k).copied();
            let next = match (cur, back) {
                (None, false) => 0,
                (None, true) => acts.len() - 1,
                (Some(i), false) => (i + 1) % acts.len(),
                (Some(i), true) => (i + acts.len() - 1) % acts.len(),
            };
            f.insert(k, next);
        });
        let _ = InvalidateRect(Some(h), None, false);
        return true;
    }
    if key == VK_RETURN.0 || key == VK_SPACE.0 {
        let focused = FOCUS.with(|f| f.borrow().get(&k).copied()).and_then(|i| acts.get(i).copied());
        // Sans focus : Entrée choisit le bouton principal (Accepter, Fermer).
        let chosen = focused.or_else(|| {
            (key == VK_RETURN.0).then(|| layout_for(h).0.iter().find_map(|i| match i {
                Item::Button { act, kind: Kind::Primary, .. } => Some(*act),
                _ => None,
            }))?
        });
        if let Some(a) = chosen {
            act(h, a);
            return true;
        }
    }
    false
}

unsafe extern "system" fn main_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if mouse(h, msg, lp) {
        return LRESULT(0);
    }
    match msg {
        WM_APP_UPDATE => {
            let screen = shared().screen.lock().unwrap().clone();
            FOCUS.with(|f| f.borrow_mut().remove(&(h.0 as isize)));
            match &screen {
                Screen::Session => {
                    let _ = ShowWindow(h, SW_HIDE);
                    let s = shared().session.lock().unwrap().clone();
                    overlays(&s);
                    post(&BAR);
                }
                _ => {
                    if matches!(screen, Screen::Ended(_) | Screen::Error(_)) {
                        remove_overlays();
                    }
                    fit_main(h, false);
                    if !IsWindowVisible(h).as_bool() {
                        let _ = ShowWindow(h, SW_SHOW);
                    }
                    if let Screen::Consent { .. } = screen {
                        let _ = SetForegroundWindow(h);
                        let _ = FlashWindow(h, true);
                    }
                    let _ = InvalidateRect(Some(h), None, false);
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            PULSE.store(!PULSE.load(Ordering::Relaxed), Ordering::Relaxed);
            let screen = shared().screen.lock().unwrap().clone();
            if let Screen::Consent { deadline, .. } = screen {
                if Instant::now() >= deadline {
                    answer(None);
                }
            }
            if !matches!(screen, Screen::Session) {
                let _ = InvalidateRect(Some(h), None, false);
            }
            LRESULT(0)
        }
        WM_PAINT => {
            paint(h);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_SIZE => {
            if let Some(t) = TARGETS.with(|m| m.borrow().get(&(h.0 as isize)).cloned()) {
                let _ = t.Resize(&D2D_SIZE_U { width: (lp.0 & 0xffff) as u32, height: ((lp.0 >> 16) & 0xffff) as u32 });
            }
            LRESULT(0)
        }
        WM_DPICHANGED => {
            forget_target(h);
            let r = &*(lp.0 as *const RECT);
            let _ = SetWindowPos(h, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
            fit_main(h, false);
            LRESULT(0)
        }
        WM_KEYDOWN => {
            if keys(h, wp) {
                return LRESULT(0);
            }
            DefWindowProcW(h, msg, wp, lp)
        }
        WM_CLOSE => {
            stop_session();
            answer(None);
            let _ = DestroyWindow(h);
            LRESULT(0)
        }
        WM_DESTROY => {
            remove_overlays();
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, msg, wp, lp),
    }
}

/// Fenêtres de la session : absentes de l'image envoyée (sauf en démonstration).
unsafe fn exclude(h: HWND) {
    if !DEMO.load(Ordering::Relaxed) {
        let _ = SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
    }
}

/// Cadre de couleur autour de l'écran et barre de session.
unsafe fn overlays(s: &SessionView) {
    if hwnd(&FRAME).is_none() {
        let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        if let Ok(frame) = CreateWindowExW(ex, w!("PortuniaAssistFrame"), w!(""), WS_POPUP | WS_VISIBLE, 0, 0, sw, sh, None, None, None, None) {
            // L'intérieur est transparent (couleur clé), seul le bord reste.
            let _ = SetLayeredWindowAttributes(frame, COLORREF(0x00ff00ff), 0, LWA_COLORKEY);
            exclude(frame);
            FRAME.store(frame.0 as isize, Ordering::Relaxed);
        }
    }
    if hwnd(&BAR).is_none() {
        let text = wide(&s.who);
        if let Ok(bar) = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("PortuniaAssistBar"),
            PCWSTR(text.as_ptr()),
            WS_POPUP,
            0,
            0,
            200,
            40,
            None,
            None,
            None,
            None,
        ) {
            let round: i32 = 2; // DWMWCP_ROUND
            let _ = DwmSetWindowAttribute(bar, DWMWA_WINDOW_CORNER_PREFERENCE, (&round as *const i32).cast(), 4);
            exclude(bar);
            BAR.store(bar.0 as isize, Ordering::Relaxed);
            place_bar(bar, true);
            let _ = ShowWindow(bar, SW_SHOWNOACTIVATE);
            SetTimer(Some(bar), TIMER, 1000, None);
        }
    }
}

/// Barre centrée en haut de l'écran principal à sa première apparition, puis là où la personne
/// l'a déplacée ; sa largeur suit son contenu.
unsafe fn place_bar(bar: HWND, first: bool) {
    let s = scale(bar);
    let (_, width) = bar_layout(&shared().session.lock().unwrap());
    let (w, h) = ((width * s) as i32, (BAR_H * s) as i32);
    let mut cur = RECT::default();
    let _ = GetWindowRect(bar, &mut cur);
    let (x, y) = if first {
        ((GetSystemMetrics(SM_CXSCREEN) - w) / 2, (12.0 * s) as i32)
    } else {
        // Garder le centre là où il est.
        ((cur.left + cur.right) / 2 - w / 2, cur.top)
    };
    if !first && cur.right - cur.left == w && cur.bottom - cur.top == h {
        return;
    }
    forget_target(bar);
    let _ = SetWindowPos(bar, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
    place_chat();
}

unsafe fn remove_overlays() {
    for slot in [&CHAT, &FRAME, &BAR] {
        if let Some(h) = hwnd(slot) {
            let _ = DestroyWindow(h);
            slot.store(0, Ordering::Relaxed);
        }
    }
}

unsafe extern "system" fn frame_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_PAINT {
        let mut ps = PAINTSTRUCT::default();
        let dc = BeginPaint(h, &mut ps);
        let mut rc = RECT::default();
        let _ = GetClientRect(h, &mut rc);
        let border = (4.0 * scale(h)) as i32;
        let edge = CreateSolidBrush(colorref(LIGHT.accent));
        FillRect(dc, &rc, edge);
        let _ = DeleteObject(edge.into());
        let inner = RECT { left: border, top: border, right: rc.right - border, bottom: rc.bottom - border };
        let key = CreateSolidBrush(COLORREF(0x00ff00ff));
        FillRect(dc, &inner, key);
        let _ = DeleteObject(key.into());
        let _ = EndPaint(h, &ps);
        return LRESULT(0);
    }
    if msg == WM_ERASEBKGND {
        return LRESULT(1);
    }
    DefWindowProcW(h, msg, wp, lp)
}

unsafe extern "system" fn bar_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if mouse(h, msg, lp) {
        return LRESULT(0);
    }
    match msg {
        WM_APP_UPDATE => {
            place_bar(h, false);
            let _ = InvalidateRect(Some(h), None, false);
            LRESULT(0)
        }
        WM_TIMER => {
            place_bar(h, false);
            let _ = InvalidateRect(Some(h), None, false);
            LRESULT(0)
        }
        // Hors des boutons, la barre se déplace à la souris.
        WM_NCHITTEST => {
            let mut pt = POINT { x: (lp.0 & 0xffff) as i16 as i32, y: ((lp.0 >> 16) & 0xffff) as i16 as i32 };
            let _ = ScreenToClient(h, &mut pt);
            let s = scale(h);
            if hit(h, pt.x as f32 / s, pt.y as f32 / s).is_some() {
                LRESULT(HTCLIENT as isize)
            } else {
                LRESULT(HTCAPTION as isize)
            }
        }
        WM_EXITSIZEMOVE => {
            place_chat();
            LRESULT(0)
        }
        #[cfg(feature = "essai")]
        WM_APP_OPEN_CHAT => {
            toggle_chat();
            LRESULT(0)
        }
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_PAINT => {
            paint(h);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_SIZE => {
            forget_target(h);
            LRESULT(0)
        }
        WM_DESTROY => {
            forget_target(h);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, msg, wp, lp),
    }
}

/// Discussion : sous la barre, alignée sur son bord droit.
unsafe fn place_chat() {
    let (Some(chat), Some(bar)) = (hwnd(&CHAT), hwnd(&BAR)) else { return };
    let s = scale(bar);
    let mut b = RECT::default();
    let _ = GetWindowRect(bar, &mut b);
    let (w, h) = ((CHAT_W * s) as i32, (CHAT_H * s) as i32);
    let x = (b.right - w).max(0);
    let _ = SetWindowPos(chat, Some(HWND_TOPMOST), x, b.bottom + (8.0 * s) as i32, w, h, SWP_NOACTIVATE);
    if let Some(edit) = hwnd(&EDIT) {
        let _ = SetWindowPos(edit, None, (22.0 * s) as i32, h - (42.0 * s) as i32, w - (84.0 * s) as i32, (24.0 * s) as i32, SWP_NOZORDER);
    }
}

unsafe fn toggle_chat() {
    if let Some(c) = hwnd(&CHAT) {
        let _ = DestroyWindow(c);
        return;
    }
    let Ok(chat) = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, w!("PortuniaAssistChat"), w!(""), WS_POPUP, 0, 0, 300, 300, None, None, None, None) else { return };
    let round: i32 = 2;
    let _ = DwmSetWindowAttribute(chat, DWMWA_WINDOW_CORNER_PREFERENCE, (&round as *const i32).cast(), 4);
    exclude(chat);
    CHAT.store(chat.0 as isize, Ordering::Relaxed);
    let s = scale(chat);
    let edit = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("EDIT"),
        w!(""),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
        0,
        0,
        10,
        10,
        Some(chat),
        None,
        None,
        None,
    )
    .unwrap_or_default();
    let font = windows::Win32::Graphics::Gdi::CreateFontW(
        -((13.5 * s) as i32),
        0,
        0,
        0,
        400,
        0,
        0,
        0,
        windows::Win32::Graphics::Gdi::FONT_CHARSET(1),
        windows::Win32::Graphics::Gdi::OUT_DEFAULT_PRECIS,
        windows::Win32::Graphics::Gdi::CLIP_DEFAULT_PRECIS,
        windows::Win32::Graphics::Gdi::CLEARTYPE_QUALITY,
        0,
        w!("Segoe UI"),
    );
    SendMessageW(edit, WM_SETFONT, Some(WPARAM(font.0 as usize)), Some(LPARAM(1)));
    SendMessageW(edit, EM_LIMITTEXT, Some(WPARAM(2000)), None);
    EDIT.store(edit.0 as isize, Ordering::Relaxed);
    shared().session.lock().unwrap().unread = false;
    place_chat();
    let _ = ShowWindow(chat, SW_SHOW);
    let _ = SetForegroundWindow(chat);
    let _ = SetFocus(Some(edit));
    post(&BAR);
}

unsafe fn send_chat() {
    let Some(edit) = hwnd(&EDIT) else { return };
    let mut buf = [0u16; 2001];
    let n = GetWindowTextW(edit, &mut buf) as usize;
    let text = String::from_utf16_lossy(&buf[..n]).trim().to_string();
    if text.is_empty() {
        return;
    }
    let _ = SetWindowTextW(edit, w!(""));
    shared().session.lock().unwrap().messages.push((true, text.clone()));
    command(Command::Message(text));
    post(&CHAT);
}

unsafe extern "system" fn chat_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if mouse(h, msg, lp) {
        return LRESULT(0);
    }
    match msg {
        WM_APP_UPDATE => {
            let _ = InvalidateRect(Some(h), None, false);
            LRESULT(0)
        }
        WM_PAINT => {
            paint(h);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_CTLCOLOREDIT => {
            let dc = windows::Win32::Graphics::Gdi::HDC(wp.0 as *mut _);
            windows::Win32::Graphics::Gdi::SetTextColor(dc, colorref(pal().ink));
            windows::Win32::Graphics::Gdi::SetBkColor(dc, colorref(pal().card));
            static CARD_BRUSH: AtomicIsize = AtomicIsize::new(0);
            if CARD_BRUSH.load(Ordering::Relaxed) == 0 {
                CARD_BRUSH.store(CreateSolidBrush(colorref(pal().card)).0 as isize, Ordering::Relaxed);
            }
            LRESULT(CARD_BRUSH.load(Ordering::Relaxed))
        }
        WM_SIZE => {
            forget_target(h);
            LRESULT(0)
        }
        WM_DESTROY => {
            forget_target(h);
            CHAT.store(0, Ordering::Relaxed);
            EDIT.store(0, Ordering::Relaxed);
            post(&BAR);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, msg, wp, lp),
    }
}

/// Échap trois fois en deux secondes sur ce PC (pas celles envoyées par le dépanneur) : arrêt.
unsafe extern "system" fn escape_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    static PRESSES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
    if code >= 0 && wp.0 as u32 == WM_KEYDOWN {
        let k = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
        let in_session = matches!(*shared().screen.lock().unwrap(), Screen::Session);
        if k.vkCode == VK_ESCAPE.0 as u32 && !injected && in_session {
            let mut p = PRESSES.lock().unwrap();
            p.retain(|t| t.elapsed().as_secs_f32() < 2.0);
            p.push(Instant::now());
            if p.len() >= 3 {
                p.clear();
                stop_session();
            }
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

// ---------- Démonstration (essais de mise en page) ----------

/// Chaque écran, photographié dans `dir` (fenêtres seules, jamais le reste de l'écran).
#[cfg(feature = "essai")]
pub fn demo(dir: &str) {
    use crate::relay::Ui;
    DEMO.store(true, Ordering::Relaxed);
    let wait = |ms| std::thread::sleep(Duration::from_millis(ms));
    wait(800);
    let mut ui = WindowUi;
    let shot = |name: &str, slot: &AtomicIsize| {
        wait(700);
        if let Some(h) = hwnd(slot) {
            if let Err(e) = save(h, &format!("{dir}/{name}.png")) {
                let _ = std::fs::write(format!("{dir}/{name}.erreur.txt"), format!("{e:#}"));
            }
        }
    };
    let dark = std::env::args().any(|a| a == "--sombre");
    DARK.store(dark, Ordering::Relaxed);
    if let Some(m) = hwnd(&MAIN) {
        // SAFETY : notre fenêtre.
        unsafe { theme_caption(m) };
    }
    ui.code("483 216 907", Some(Duration::from_secs(30 * 60)));
    shot("1-code", &MAIN);
    let (tx, _rx) = mpsc::channel();
    *shared().consent.lock().unwrap() = Some(tx);
    set(Screen::Consent { who: "Julien Piperault".into(), server: "acces.acme.fr".into(), control: true, deadline: Instant::now() + CONSENT_FOR });
    shot("2-accord", &MAIN);
    ui.connected("Julien Piperault", true);
    ui.event(Event::Quality(Duration::from_millis(42)));
    shot("3-barre", &BAR);
    ui.event(Event::Message("Je regarde les pilotes de l'imprimante, ne touchez à rien.".into()));
    shot("4-barre-message", &BAR);
    // SAFETY : notre fenêtre de discussion, ouverte comme par un clic.
    unsafe {
        shared().session.lock().unwrap().messages.push((true, "D'accord, merci !".into()));
        let tx = SendTx;
        tx.toggle();
    }
    ui.event(Event::Message("C'est installé. Vous pouvez essayer d'imprimer ?".into()));
    shot("5-discussion", &CHAT);
    ui.event(Event::ControlRequested);
    ui.event(Event::Control(false));
    shared().session.lock().unwrap().asking = true;
    post(&BAR);
    shot("6-demande", &BAR);
    shared().session.lock().unwrap().asking = false;
    ui.event(Event::Paused(true));
    shot("7-pause", &BAR);
    ui.event(Event::Paused(false));
    ui.event(Event::Reconnecting(true));
    shot("8-reconnexion", &BAR);
    ui.ended(&Summary { reason: "Terminée par la personne qui vous aide.".into(), who: "Julien Piperault".into(), duration: Duration::from_secs(18 * 60 + 4), control: true, messages: 3 });
    shot("9-fin", &MAIN);
    error("Portunia Assistance ne sait pas quel serveur utiliser. Téléchargez-le de nouveau depuis la page donnée par la personne qui vous aide.");
    shot("10-erreur", &MAIN);
    if let Some(h) = hwnd(&MAIN) {
        // SAFETY : message posté à notre fenêtre.
        unsafe {
            let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

/// Ouvre la discussion sur le fil de la fenêtre (démonstration).
#[cfg(feature = "essai")]
struct SendTx;
#[cfg(feature = "essai")]
impl SendTx {
    unsafe fn toggle(&self) {
        if let Some(b) = hwnd(&BAR) {
            let _ = PostMessageW(Some(b), WM_APP_OPEN_CHAT, WPARAM(0), LPARAM(0));
        }
    }
}
#[cfg(feature = "essai")]
const WM_APP_OPEN_CHAT: u32 = WM_APP + 2;

/// Photographie d'une de nos fenêtres (PrintWindow), en PNG.
#[cfg(feature = "essai")]
fn save(h: HWND, path: &str) -> anyhow::Result<()> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    // SAFETY : copie de notre propre fenêtre dans une image en mémoire.
    let (w, ht, mut buf) = unsafe {
        let mut rc = RECT::default();
        GetWindowRect(h, &mut rc)?;
        let (w, ht) = (rc.right - rc.left, rc.bottom - rc.top);
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, ht);
        let old = SelectObject(dc, bmp.into());
        let _ = windows::Win32::Storage::Xps::PrintWindow(h, dc, windows::Win32::Storage::Xps::PRINT_WINDOW_FLAGS(2));
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -ht, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * ht * 4) as usize];
        GetDIBits(dc, bmp, 0, ht as u32, Some(buf.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(dc, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        (w as u32, ht as u32, buf)
    };
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    xcap::image::RgbaImage::from_raw(w, ht, buf).ok_or_else(|| anyhow::anyhow!("image"))?.save(path)?;
    Ok(())
}
