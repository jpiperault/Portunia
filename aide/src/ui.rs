//! Fenêtres de Portunia Assist (Windows) : la fenêtre principale (code, accord, session, fin),
//! et pendant la session un cadre de couleur autour de l'écran et un bandeau « Arrêter »,
//! toujours au premier plan et absents de l'image envoyée au dépanneur.
//! Échap trois fois de suite arrête aussi tout.

use std::sync::{
    atomic::{AtomicBool, AtomicIsize, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};

use windows::{
    core::{w, PCWSTR},
    Win32::System::SystemServices::{SS_CENTER, SS_CENTERIMAGE},
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, GetDC, GetDeviceCaps, InvalidateRect,
            ReleaseDC, SetBkMode, SetTextColor, GetSysColorBrush, COLOR_WINDOW, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, OUT_DEFAULT_PRECIS, DT_CENTER, DT_SINGLELINE, DT_VCENTER, FONT_CHARSET, FW_BOLD, FW_NORMAL, HBRUSH, HDC,
            HFONT, LOGPIXELSY, PAINTSTRUCT, TRANSPARENT,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Input::KeyboardAndMouse::VK_ESCAPE,
            WindowsAndMessaging::*,
        },
    },
};

/// Ce que montre la fenêtre principale.
#[derive(Clone)]
pub enum Screen {
    Connecting,
    Code(String),
    Consent(String),
    Session { who: String, control: bool },
    Ended(String),
    Error(String),
}

struct Shared {
    screen: Mutex<Screen>,
    consent: Mutex<Option<mpsc::Sender<Option<bool>>>>,
    stop: tokio::sync::watch::Sender<bool>,
    fr: bool,
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();
static MAIN: AtomicIsize = AtomicIsize::new(0);
static FRAME: AtomicIsize = AtomicIsize::new(0);
static BAR: AtomicIsize = AtomicIsize::new(0);
static SCALE: AtomicIsize = AtomicIsize::new(96);
const WM_APP_UPDATE: u32 = WM_APP + 1;

const ID_MESSAGE: i32 = 2;
const ID_CODE: i32 = 3;
const ID_CONTROL: i32 = 4;
const ID_PRIMARY: i32 = 10;
const ID_SECONDARY: i32 = 11;
const ID_BAR_STOP: i32 = 20;

/// Vert « assistance », celui de la maquette.
const ACCENT: COLORREF = COLORREF(0x007a8f0f); // RVB (15, 143, 122) en BGR
const WHITE: COLORREF = COLORREF(0x00ffffff);

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

fn px(v: i32) -> i32 {
    v * SCALE.load(Ordering::Relaxed) as i32 / 96
}

fn hwnd(v: &AtomicIsize) -> Option<HWND> {
    let h = v.load(Ordering::Relaxed);
    (h != 0).then_some(HWND(h as *mut _))
}

/// Langue de Windows : français ou anglais.
pub fn system_is_french() -> bool {
    // SAFETY : simple lecture du réglage de langue.
    let lang = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    lang & 0x3ff == 0x0c
}

// ---------- Interface vue du relais ----------

/// Côté relais : ce que la session demande à la fenêtre (appelé depuis le fil du relais).
pub struct WindowUi;

fn set(screen: Screen) {
    *shared().screen.lock().unwrap() = screen;
    if let Some(h) = hwnd(&MAIN) {
        // SAFETY : message posté à notre fenêtre, traité sur son fil.
        unsafe {
            let _ = PostMessageW(Some(h), WM_APP_UPDATE, WPARAM(0), LPARAM(0));
        }
    }
}

impl crate::relay::Ui for WindowUi {
    fn code(&mut self, code: &str) {
        set(Screen::Code(code.into()));
    }
    fn consent(&mut self, who: &str) -> Option<bool> {
        let (tx, rx) = mpsc::channel();
        *shared().consent.lock().unwrap() = Some(tx);
        set(Screen::Consent(who.into()));
        rx.recv().ok().flatten()
    }
    fn connected(&mut self, who: &str, control: bool) {
        set(Screen::Session { who: who.into(), control });
    }
    fn ended(&mut self, reason: &str) {
        set(Screen::Ended(reason.into()));
    }
}

/// Erreur avant ou pendant la session (relais injoignable, code faux trois fois…).
pub fn error(message: &str) {
    set(Screen::Error(message.into()));
}

// ---------- Fenêtres ----------

/// Crée les fenêtres et fait tourner la boucle de messages (fil principal).
/// `stop` arrête la session quand la personne clique « Arrêter » ou ferme la fenêtre.
pub fn run(stop: tokio::sync::watch::Sender<bool>) {
    let _ = SHARED.set(Arc::new(Shared { screen: Mutex::new(Screen::Connecting), consent: Mutex::new(None), stop, fr: system_is_french() }));
    // SAFETY : création classique de fenêtres Win32 sur ce fil, qui garde la boucle de messages.
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let dc = GetDC(None);
        SCALE.store(GetDeviceCaps(Some(dc), LOGPIXELSY) as isize, Ordering::Relaxed);
        ReleaseDC(None, dc);
        let instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let icon = LoadIconW(None, IDI_APPLICATION).unwrap_or_default();
        for (name, proc_, brush) in [
            (w!("PortuniaAssist"), Some(main_proc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT), HBRUSH((COLOR_WINDOW.0 + 1) as isize as *mut _)),
            (w!("PortuniaAssistFrame"), Some(frame_proc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT), CreateSolidBrush(ACCENT)),
            (w!("PortuniaAssistBar"), Some(bar_proc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT), CreateSolidBrush(ACCENT)),
        ] {
            let class = WNDCLASSW {
                lpfnWndProc: proc_,
                hInstance: instance,
                lpszClassName: name,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                hIcon: icon,
                hbrBackground: brush,
                ..Default::default()
            };
            RegisterClassW(&class);
        }
        let (w, h) = (px(420), px(340));
        let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 3;
        let main = CreateWindowExW(
            WS_EX_TOPMOST,
            w!("PortuniaAssist"),
            w!("Portunia Assist"),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE,
            x,
            y,
            w,
            h,
            None,
            None,
            Some(instance),
            None,
        )
        .expect("fenêtre principale");
        MAIN.store(main.0 as isize, Ordering::Relaxed);
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(escape_hook), Some(instance), 0).ok();
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if !IsDialogMessageW(main, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if let Some(h) = hook {
            let _ = UnhookWindowsHookEx(h);
        }
    }
}

unsafe fn font(size: i32, bold: bool, mono: bool) -> HFONT {
    let face = if mono { w!("Cascadia Mono") } else { w!("Segoe UI") };
    CreateFontW(-px(size), 0, 0, 0, if bold { FW_BOLD.0 as i32 } else { FW_NORMAL.0 as i32 }, 0, 0, 0, FONT_CHARSET(1), OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, face)
}

unsafe fn child(parent: HWND, class: PCWSTR, style: WINDOW_STYLE, id: i32, f: HFONT) -> HWND {
    let h = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!(""), WS_CHILD | style, 0, 0, 0, 0, Some(parent), Some(HMENU(id as isize as *mut _)), None, None)
        .unwrap_or_default();
    SendMessageW(h, WM_SETFONT, Some(WPARAM(f.0 as usize)), Some(LPARAM(1)));
    h
}

unsafe fn item(parent: HWND, id: i32) -> HWND {
    GetDlgItem(Some(parent), id).unwrap_or_default()
}

unsafe fn set_text(h: HWND, text: &str) {
    let t = wide(text);
    let _ = SetWindowTextW(h, PCWSTR(t.as_ptr()));
}

unsafe fn show(h: HWND, visible: bool) {
    let _ = ShowWindow(h, if visible { SW_SHOW } else { SW_HIDE });
}

/// Place et remplit les contrôles selon l'écran courant.
unsafe fn render(main: HWND) {
    let screen = shared().screen.lock().unwrap().clone();
    let (msg, code, check, primary, secondary) = (item(main, ID_MESSAGE), item(main, ID_CODE), item(main, ID_CONTROL), item(main, ID_PRIMARY), item(main, ID_SECONDARY));
    let mut rc = RECT::default();
    let _ = GetClientRect(main, &mut rc);
    let (w, h) = (rc.right, rc.bottom);
    let m = px(20);
    let top = px(56);
    let _ = MoveWindow(msg, m, top, w - 2 * m, px(64), true);
    let _ = MoveWindow(code, m, top + px(70), w - 2 * m, px(56), true);
    let _ = MoveWindow(check, m, top + px(80), w - 2 * m, px(40), true);
    let (bw, bh) = (px(120), px(32));
    let _ = MoveWindow(primary, w - m - bw, h - m - bh, bw, bh, true);
    let _ = MoveWindow(secondary, w - m - 2 * bw - px(10), h - m - bh, bw, bh, true);
    for c in [code, check, primary, secondary] {
        show(c, false);
    }
    match &screen {
        Screen::Connecting => set_text(msg, tr("Connecting to the assistance server…", "Connexion au serveur d'assistance…")),
        Screen::Code(c) => {
            set_text(msg, tr("Give this code to the person helping you:", "Donnez ce code à la personne qui vous aide :"));
            set_text(code, c);
            show(code, true);
            set_text(secondary, tr("Close", "Fermer"));
            show(secondary, false);
            set_text(primary, tr("Close", "Fermer"));
            show(primary, true);
        }
        Screen::Consent(who) => {
            set_text(msg, &format!("{who}\n{}", tr("wants to help you. Nobody sees your screen until you accept.", "veut vous aider. Personne ne voit votre écran avant que vous acceptiez.")));
            set_text(check, tr("Let them use the mouse and keyboard (otherwise they only see the screen)", "Lui laisser utiliser la souris et le clavier (sinon, il voit seulement l'écran)"));
            SendMessageW(check, BM_SETCHECK, Some(WPARAM(1)), None);
            show(check, true);
            set_text(primary, tr("Accept", "Accepter"));
            set_text(secondary, tr("Decline", "Refuser"));
            show(primary, true);
            show(secondary, true);
            let _ = SetForegroundWindow(main);
            let _ = FlashWindow(main, true);
        }
        Screen::Session { who, control } => {
            let what = if *control { tr("sees and controls your screen.", "voit et contrôle votre écran.") } else { tr("sees your screen.", "voit votre écran.") };
            set_text(msg, &format!("{who}\n{what} {}", tr("Esc three times also stops everything.", "Échap trois fois arrête aussi tout.")));
            set_text(primary, tr("Stop", "Arrêter"));
            show(primary, true);
            overlays(who, *control);
        }
        Screen::Ended(reason) => {
            remove_overlays();
            set_text(msg, &format!("{}\n{reason}", tr("The assistance has ended.", "L'assistance est terminée.")));
            set_text(primary, tr("Close", "Fermer"));
            show(primary, true);
        }
        Screen::Error(text) => {
            remove_overlays();
            set_text(msg, text);
            set_text(primary, tr("Close", "Fermer"));
            show(primary, true);
        }
    }
    let _ = InvalidateRect(Some(main), None, true);
}

fn stop_session() {
    let _ = shared().stop.send(true);
}

unsafe extern "system" fn main_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_CREATE => {
            let normal = font(10, false, false);
            child(h, w!("STATIC"), WS_VISIBLE, ID_MESSAGE, normal);
            child(h, w!("STATIC"), WINDOW_STYLE(SS_CENTER.0 | SS_CENTERIMAGE.0), ID_CODE, font(26, true, true));
            child(h, w!("BUTTON"), WS_TABSTOP | WINDOW_STYLE(BS_AUTOCHECKBOX as u32 | BS_MULTILINE as u32), ID_CONTROL, normal);
            child(h, w!("BUTTON"), WS_TABSTOP | WINDOW_STYLE(BS_DEFPUSHBUTTON as u32), ID_PRIMARY, normal);
            child(h, w!("BUTTON"), WS_TABSTOP | WINDOW_STYLE(BS_PUSHBUTTON as u32), ID_SECONDARY, normal);
            let _ = PostMessageW(Some(h), WM_APP_UPDATE, WPARAM(0), LPARAM(0));
            LRESULT(0)
        }
        WM_APP_UPDATE => {
            render(h);
            LRESULT(0)
        }
        WM_PAINT => {
            // Bandeau de titre vert.
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(h, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(h, &mut rc);
            let band = RECT { left: 0, top: 0, right: rc.right, bottom: px(40) };
            let brush = CreateSolidBrush(ACCENT);
            FillRect(dc, &band, brush);
            let _ = DeleteObject(brush.into());
            title(dc, band, "Portunia Assist");
            let _ = EndPaint(h, &ps);
            LRESULT(0)
        }
        WM_CTLCOLORSTATIC => {
            let dc = HDC(wp.0 as *mut _);
            // Couleur fixée pour chaque texte : le contexte de dessin peut garder la précédente.
            SetTextColor(dc, if lp.0 == item(h, ID_CODE).0 as isize { ACCENT } else { COLORREF(windows::Win32::Graphics::Gdi::GetSysColor(windows::Win32::Graphics::Gdi::COLOR_WINDOWTEXT)) });
            SetBkMode(dc, TRANSPARENT);
            LRESULT(GetSysColorBrush(COLOR_WINDOW).0 as isize)
        }
        WM_COMMAND => {
            let id = (wp.0 & 0xffff) as i32;
            let screen = shared().screen.lock().unwrap().clone();
            match (&screen, id) {
                (Screen::Consent(_), ID_PRIMARY) => {
                    let control = SendMessageW(item(h, ID_CONTROL), BM_GETCHECK, None, None).0 == 1;
                    if let Some(tx) = shared().consent.lock().unwrap().take() {
                        let _ = tx.send(Some(control));
                    }
                }
                (Screen::Consent(_), ID_SECONDARY) => {
                    if let Some(tx) = shared().consent.lock().unwrap().take() {
                        let _ = tx.send(None);
                    }
                }
                (Screen::Session { .. }, ID_PRIMARY) => stop_session(),
                (_, ID_PRIMARY) => {
                    let _ = DestroyWindow(h);
                }
                _ => {}
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            stop_session();
            if let Some(tx) = shared().consent.lock().unwrap().take() {
                let _ = tx.send(None);
            }
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

unsafe fn title(dc: HDC, mut rc: RECT, text: &str) {
    let f = font(11, true, false);
    let old = windows::Win32::Graphics::Gdi::SelectObject(dc, f.into());
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, WHITE);
    rc.left += px(16);
    let mut t: Vec<u16> = text.encode_utf16().collect();
    DrawTextW(dc, &mut t, &mut rc, DT_SINGLELINE | DT_VCENTER);
    windows::Win32::Graphics::Gdi::SelectObject(dc, old);
    let _ = DeleteObject(f.into());
}

/// Cadre de couleur autour de l'écran et bandeau en haut, absents de la capture.
unsafe fn overlays(who: &str, control: bool) {
    if hwnd(&FRAME).is_some() {
        return;
    }
    let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    if let Ok(frame) = CreateWindowExW(ex, w!("PortuniaAssistFrame"), w!(""), WS_POPUP | WS_VISIBLE, 0, 0, sw, sh, None, None, None, None) {
        // L'intérieur est transparent (couleur clé), seul le bord de 5 pixels reste.
        let _ = SetLayeredWindowAttributes(frame, COLORREF(0x00ff00ff), 0, LWA_COLORKEY);
        let _ = SetWindowDisplayAffinity(frame, WDA_EXCLUDEFROMCAPTURE);
        FRAME.store(frame.0 as isize, Ordering::Relaxed);
    }
    let (bw, bh) = (px(520), px(38));
    let label = if control { tr("sees and controls your screen", "voit et contrôle votre écran") } else { tr("sees your screen", "voit votre écran") };
    let text = wide(&format!("{who} {label}"));
    if let Ok(bar) = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        w!("PortuniaAssistBar"),
        PCWSTR(text.as_ptr()),
        WS_POPUP | WS_VISIBLE,
        (sw - bw) / 2,
        0,
        bw,
        bh,
        None,
        None,
        None,
        None,
    ) {
        let _ = SetWindowDisplayAffinity(bar, WDA_EXCLUDEFROMCAPTURE);
        let stop = child(bar, w!("BUTTON"), WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32), ID_BAR_STOP, font(9, true, false));
        set_text(stop, tr("Stop", "Arrêter"));
        let _ = MoveWindow(stop, bw - px(100), px(5), px(90), bh - px(10), true);
        BAR.store(bar.0 as isize, Ordering::Relaxed);
    }
}

unsafe fn remove_overlays() {
    for slot in [&FRAME, &BAR] {
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
        let border = px(5);
        let inner = RECT { left: border, top: border, right: rc.right - border, bottom: rc.bottom - border };
        let key = CreateSolidBrush(COLORREF(0x00ff00ff));
        FillRect(dc, &inner, key);
        let _ = DeleteObject(key.into());
        let _ = EndPaint(h, &ps);
        return LRESULT(0);
    }
    DefWindowProcW(h, msg, wp, lp)
}

unsafe extern "system" fn bar_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(h, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(h, &mut rc);
            rc.right -= px(110);
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(h, &mut buf) as usize;
            let f = font(10, true, false);
            let old = windows::Win32::Graphics::Gdi::SelectObject(dc, f.into());
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, WHITE);
            let mut t = buf[..n].to_vec();
            DrawTextW(dc, &mut t, &mut rc, DT_SINGLELINE | DT_VCENTER | DT_CENTER);
            windows::Win32::Graphics::Gdi::SelectObject(dc, old);
            let _ = DeleteObject(f.into());
            let _ = EndPaint(h, &ps);
            LRESULT(0)
        }
        WM_COMMAND if (wp.0 & 0xffff) as i32 == ID_BAR_STOP => {
            stop_session();
            LRESULT(0)
        }
        _ => DefWindowProcW(h, msg, wp, lp),
    }
}

/// Échap trois fois en deux secondes sur ce PC (pas celles envoyées par le dépanneur) : arrêt.
unsafe extern "system" fn escape_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    static PRESSES: Mutex<Vec<std::time::Instant>> = Mutex::new(Vec::new());
    static IN_SESSION: AtomicBool = AtomicBool::new(false);
    if code >= 0 && wp.0 as u32 == WM_KEYDOWN {
        let k = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
        IN_SESSION.store(matches!(*shared().screen.lock().unwrap(), Screen::Session { .. }), Ordering::Relaxed);
        if k.vkCode == VK_ESCAPE.0 as u32 && !injected && IN_SESSION.load(Ordering::Relaxed) {
            let mut p = PRESSES.lock().unwrap();
            p.retain(|t| t.elapsed().as_secs_f32() < 2.0);
            p.push(std::time::Instant::now());
            if p.len() >= 3 {
                p.clear();
                stop_session();
            }
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

/// Démonstration (essais de mise en page) : chaque écran, photographié dans `dir`.
pub fn demo(dir: &str) {
    let shots: [(&str, Screen); 5] = [
        ("1-code", Screen::Code("483 216 907".into())),
        ("2-accord", Screen::Consent("julien (Bastion ACME)".into())),
        ("3-session", Screen::Session { who: "julien (Bastion ACME)".into(), control: true }),
        ("4-fin", Screen::Ended("Terminée par la personne qui vous aide.".into())),
        ("5-erreur", Screen::Error("Portunia Assist ne sait pas quel serveur utiliser.".into())),
    ];
    std::thread::sleep(std::time::Duration::from_millis(800));
    for (name, screen) in shots {
        set(screen);
        std::thread::sleep(std::time::Duration::from_millis(900));
        let result = (|| -> anyhow::Result<()> {
            let h = hwnd(&MAIN).ok_or_else(|| anyhow::anyhow!("fenêtre introuvable"))?;
            // SAFETY : photographie de notre propre fenêtre (PrintWindow), rien d'autre de l'écran.
            let (w, ht, bgra) = unsafe { snapshot(h)? };
            let mut rgba = bgra;
            for px in rgba.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }
            xcap::image::RgbaImage::from_raw(w, ht, rgba).ok_or_else(|| anyhow::anyhow!("image"))?.save(format!("{dir}/{name}.png"))?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = std::fs::write(format!("{dir}/{name}.erreur.txt"), format!("{e:#}"));
        }
    }
    if let Some(h) = hwnd(&MAIN) {
        // SAFETY : message posté à notre fenêtre.
        unsafe {
            let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

/// Contenu de notre fenêtre (BGRA, de haut en bas).
unsafe fn snapshot(h: HWND) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, GetDIBits, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
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
    Ok((w as u32, ht as u32, buf))
}
