//! Informations du PC (lot B) : ce que la personne accepte d'envoyer au dépanneur, montré avant
//! l'envoi. Rien n'est lu ni envoyé sans son accord, et rien de personnel (fichiers, comptes,
//! historique) n'en fait partie.

/// Liste (libellé, valeur), dans l'ordre d'affichage.
pub fn collect() -> Vec<(String, String)> {
    let fr = crate::ui::system_is_french();
    let l = |en: &str, f: &str| if fr { f.to_string() } else { en.to_string() };
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        let os = win::windows_version();
        if !os.is_empty() {
            out.push((l("Windows", "Windows"), os));
        }
        if let Some(cpu) = win::registry_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString") {
            let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
            out.push((l("Processor", "Processeur"), format!("{} · {cores} {}", cpu.trim(), l("threads", "fils"))));
        }
        if let Some((total, free)) = win::memory() {
            out.push((l("Memory", "Mémoire"), format!("{} ({} {})", gib(total), gib(free), l("free", "libres"))));
        }
        if let Some((total, free)) = win::disk("C:\\") {
            out.push((l("Disk C", "Disque C"), format!("{} ({} {})", gib(total), gib(free), l("free", "libres"))));
        }
        out.push((l("Up since", "Allumé depuis"), duration(win::uptime_secs(), fr)));
    }
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        out.push((l("Computer name", "Nom du PC"), name));
    }
    let screens = crate::display::screens();
    if !screens.is_empty() {
        let list: Vec<String> = screens.iter().map(|s| format!("{}×{}", s.width, s.height)).collect();
        out.push((l("Screens", "Écrans"), list.join(", ")));
    }
    if let Some(ip) = local_ip() {
        out.push((l("Local address", "Adresse locale"), ip));
    }
    out
}

fn gib(bytes: u64) -> String {
    let n = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    if crate::ui::system_is_french() {
        format!("{n:.1} Go").replace('.', ",")
    } else {
        format!("{n:.1} GB")
    }
}

fn duration(secs: u64, fr: bool) -> String {
    let (d, h, m) = (secs / 86_400, secs % 86_400 / 3600, secs % 3600 / 60);
    match (d, fr) {
        (0, _) => format!("{h} h {m:02}"),
        (_, true) => format!("{d} j {h} h"),
        (_, false) => format!("{d} d {h} h"),
    }
}

/// Adresse de la carte réseau par laquelle sort le PC (sans rien envoyer).
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

#[cfg(windows)]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn registry_string(key: &str, value: &str) -> Option<String> {
        let (k, v) = (wide(key), wide(value));
        let mut buf = vec![0u16; 512];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY : tampon de taille donnée, lecture seule du registre.
        let r = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, PCWSTR(k.as_ptr()), PCWSTR(v.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
        if r.is_err() {
            return None;
        }
        let n = (size as usize / 2).saturating_sub(1).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }

    fn registry_dword(key: &str, value: &str) -> Option<u32> {
        let (k, v) = (wide(key), wide(value));
        let mut d = 0u32;
        let mut size = 4u32;
        // SAFETY : lecture d'un entier de 4 octets.
        let r = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, PCWSTR(k.as_ptr()), PCWSTR(v.as_ptr()), RRF_RT_REG_DWORD, None, Some((&mut d as *mut u32).cast()), Some(&mut size)) };
        r.is_ok().then_some(d)
    }

    /// « Windows 11 Pro 24H2 (26100.2605) » : Windows 11 se déclare encore « 10 » dans le nom.
    pub fn windows_version() -> String {
        const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let mut name = registry_string(KEY, "ProductName").unwrap_or_default();
        let build = registry_string(KEY, "CurrentBuild").unwrap_or_default();
        if build.parse::<u32>().is_ok_and(|b| b >= 22000) {
            name = name.replace("Windows 10", "Windows 11");
        }
        let display = registry_string(KEY, "DisplayVersion").unwrap_or_default();
        let ubr = registry_dword(KEY, "UBR").map(|u| format!(".{u}")).unwrap_or_default();
        format!("{name} {display} ({build}{ubr})").replace("  ", " ").trim().to_string()
    }

    pub fn memory() -> Option<(u64, u64)> {
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        // SAFETY : structure initialisée avec sa taille.
        unsafe { GlobalMemoryStatusEx(&mut m).ok()? };
        Some((m.ullTotalPhys, m.ullAvailPhys))
    }

    pub fn disk(root: &str) -> Option<(u64, u64)> {
        let r = wide(root);
        let (mut free, mut total) = (0u64, 0u64);
        // SAFETY : lecture des tailles d'un volume.
        unsafe { GetDiskFreeSpaceExW(PCWSTR(r.as_ptr()), Some(&mut free), Some(&mut total), None).ok()? };
        Some((total, free))
    }

    pub fn uptime_secs() -> u64 {
        // SAFETY : sans effet de bord.
        unsafe { GetTickCount64() / 1000 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lecture réelle (registre, mémoire, disque) : cargo test --features essai lecture_reelle -- --ignored --nocapture
    #[test]
    #[ignore]
    fn lecture_reelle() {
        for (k, v) in collect() {
            println!("{k} : {v}");
        }
    }

    #[test]
    fn durees_lisibles() {
        assert_eq!(duration(3 * 3600 + 5 * 60, true), "3 h 05");
        assert_eq!(duration(2 * 86_400 + 4 * 3600, true), "2 j 4 h");
        assert!(gib(8 * 1024 * 1024 * 1024).starts_with("8"));
    }
}
