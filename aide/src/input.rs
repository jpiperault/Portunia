//! Souris et clavier du dépanneur, rejoués sur ce PC (SendInput), ou seulement notés
//! (essais : rien n'est tapé ni cliqué).

use ironrdp_server::{KeyboardEvent, MouseEvent, RdpServerInputHandler};

pub struct Input {
    /// Essais : noter les événements au lieu de les rejouer.
    pub dry_run: bool,
    /// Vue seule (contrôle non accordé) : tout est ignoré.
    pub ignore: bool,
    /// Taille de l'écran envoyé, pour convertir la position de la souris.
    pub width: u16,
    pub height: u16,
    pub log: Vec<String>,
}

impl RdpServerInputHandler for Input {
    fn keyboard(&mut self, event: KeyboardEvent) {
        if self.ignore {
            return;
        }
        if self.dry_run {
            self.note(format!("{event:?}"));
            return;
        }
        #[cfg(windows)]
        win::keyboard(&event);
    }

    fn mouse(&mut self, event: MouseEvent) {
        if self.ignore {
            return;
        }
        if self.dry_run {
            // Les déplacements sont nombreux : seuls les clics et la molette sont notés.
            if !matches!(event, MouseEvent::Move { .. }) {
                self.note(format!("{event:?}"));
            }
            return;
        }
        #[cfg(windows)]
        win::mouse(&event, self.width, self.height);
    }
}

impl Input {
    fn note(&mut self, line: String) {
        eprintln!("saisie (non rejouée) : {line}");
        self.log.push(line);
    }
}

#[cfg(windows)]
mod win {
    use ironrdp_server::{KeyboardEvent, MouseEvent};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };

    fn send(input: INPUT) {
        // SAFETY : un seul INPUT bien formé, taille passée par l'appel.
        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn key(scan: u16, flags: KEYBD_EVENT_FLAGS) {
        send(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        });
    }

    pub fn keyboard(event: &KeyboardEvent) {
        match *event {
            KeyboardEvent::Pressed { code, extended } => {
                key(code as u16, KEYEVENTF_SCANCODE | if extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) })
            }
            KeyboardEvent::Released { code, extended } => key(
                code as u16,
                KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP | if extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
            ),
            KeyboardEvent::UnicodePressed(u) => key(u, KEYEVENTF_UNICODE),
            KeyboardEvent::UnicodeReleased(u) => key(u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            KeyboardEvent::Synchronize(_) => {}
        }
    }

    fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) {
        send(INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        });
    }

    pub fn mouse(event: &MouseEvent, width: u16, height: u16) {
        match *event {
            MouseEvent::Move { x, y } => {
                // Coordonnées absolues de l'écran principal, sur 0..65535.
                let ax = (x as i32 * 65535) / (width.max(2) as i32 - 1);
                let ay = (y as i32 * 65535) / (height.max(2) as i32 - 1);
                mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0);
            }
            MouseEvent::LeftPressed => mouse_input(MOUSEEVENTF_LEFTDOWN, 0, 0, 0),
            MouseEvent::LeftReleased => mouse_input(MOUSEEVENTF_LEFTUP, 0, 0, 0),
            MouseEvent::RightPressed => mouse_input(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0),
            MouseEvent::RightReleased => mouse_input(MOUSEEVENTF_RIGHTUP, 0, 0, 0),
            MouseEvent::MiddlePressed => mouse_input(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0),
            MouseEvent::MiddleReleased => mouse_input(MOUSEEVENTF_MIDDLEUP, 0, 0, 0),
            MouseEvent::Button4Pressed => mouse_input(MOUSEEVENTF_XDOWN, 0, 0, 1),
            MouseEvent::Button4Released => mouse_input(MOUSEEVENTF_XUP, 0, 0, 1),
            MouseEvent::Button5Pressed => mouse_input(MOUSEEVENTF_XDOWN, 0, 0, 2),
            MouseEvent::Button5Released => mouse_input(MOUSEEVENTF_XUP, 0, 0, 2),
            MouseEvent::VerticalScroll { value } => mouse_input(MOUSEEVENTF_WHEEL, 0, 0, value as i32),
            MouseEvent::Scroll { x, y } => {
                if y != 0 {
                    mouse_input(MOUSEEVENTF_WHEEL, 0, 0, y);
                }
                if x != 0 {
                    mouse_input(MOUSEEVENTF_HWHEEL, 0, 0, x);
                }
            }
            MouseEvent::RelMove { x, y } => mouse_input(MOUSEEVENTF_MOVE, x, y, 0),
        }
    }
}
