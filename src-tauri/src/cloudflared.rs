//! cloudflared sur le poste : accès à une Gate publiée par Cloudflare en TCP (Gate 0.41), depuis
//! l'extérieur. Pour chaque nom d'hôte publié (API, SSH, RDP natif), `cloudflared access tcp`
//! ouvre un port sur 127.0.0.1 et transporte la connexion dans un WebSocket jusqu'au tunnel de la
//! Gate. Le chiffrement reste celui de la Gate (TLS épinglé, SSH, TLS et NLA du RDP) : Cloudflare
//! ne voit que des octets chiffrés.
//!
//! cloudflared est téléchargé au premier besoin depuis la page officielle de Cloudflare, en
//! version fixée et vérifié par son empreinte SHA-256 publiée.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context, Result};

const VERSION: &str = "2026.10.7";

/// (système, architecture) → (fichier publié, empreinte SHA-256 donnée par GitHub).
const ASSETS: &[(&str, &str, &str, &str)] = &[
    ("windows", "x86_64", "cloudflared-windows-amd64.exe", "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343"),
    ("windows", "x86", "cloudflared-windows-386.exe", "88c6b972b410db0e26745f593510d772c825a13c5a2374819e3f13a05b333082"),
    ("macos", "x86_64", "cloudflared-darwin-amd64.tgz", "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848"),
    ("macos", "aarch64", "cloudflared-darwin-arm64.tgz", "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd"),
    ("linux", "x86_64", "cloudflared-linux-amd64", "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872"),
    ("linux", "aarch64", "cloudflared-linux-arm64", "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775"),
];

/// Un relais local inutilisé aussi longtemps est arrêté au prochain besoin d'un autre.
const IDLE: Duration = Duration::from_secs(30 * 60);

struct Forward {
    child: Child,
    port: u16,
    used: Instant,
}

static FORWARDS: Mutex<Option<HashMap<String, Forward>>> = Mutex::new(None);
/// Un seul téléchargement à la fois.
static DOWNLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn exe_name() -> String {
    if cfg!(windows) {
        format!("cloudflared-{VERSION}.exe")
    } else {
        format!("cloudflared-{VERSION}")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// cloudflared prêt à lancer : téléchargé au premier besoin, empreinte vérifiée.
async fn binary(data_dir: &Path) -> Result<PathBuf> {
    let dir = data_dir.join("cloudflared");
    let dest = dir.join(exe_name());
    if dest.exists() {
        return Ok(dest);
    }
    let _one = DOWNLOAD.lock().await;
    if dest.exists() {
        return Ok(dest);
    }
    let (_, _, name, sum) = ASSETS
        .iter()
        .find(|(os, arch, _, _)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH)
        .ok_or_else(|| anyhow!(t!("cloudflared is not available for this system", "cloudflared n'existe pas pour ce système")))?;
    let url = format!("https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{name}");
    let http = reqwest::Client::builder().timeout(Duration::from_secs(300)).user_agent(concat!("Portunia/", env!("CARGO_PKG_VERSION"))).build()?;
    let bytes = http
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .context(t!("cannot download cloudflared from GitHub", "téléchargement de cloudflared depuis GitHub impossible"))?
        .bytes()
        .await?;
    if sha256_hex(&bytes) != *sum {
        bail!(t!("the downloaded cloudflared does not have the expected fingerprint", "le cloudflared téléchargé n'a pas l'empreinte attendue"));
    }
    std::fs::create_dir_all(&dir)?;
    // Anciennes versions : retirées.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("cloudflared-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if name.ends_with(".tgz") {
        // macOS : archive avec le seul exécutable « cloudflared », extraite par tar du système.
        let archive = dir.join(name);
        std::fs::write(&archive, &bytes)?;
        let out = Command::new("tar").arg("-xzf").arg(&archive).arg("-C").arg(&dir).arg("cloudflared").output()?;
        let _ = std::fs::remove_file(&archive);
        if !out.status.success() {
            bail!("tar : {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        std::fs::rename(dir.join("cloudflared"), &dest)?;
    } else {
        let part = dir.join(format!("{}.part", exe_name()));
        std::fs::write(&part, &bytes)?;
        std::fs::rename(&part, &dest)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dest)
}

/// Port local qui mène à `hostname` par Cloudflare. Le relais est lancé au premier besoin et
/// réutilisé ensuite ; il s'arrête avec Portunia.
pub async fn forward(data_dir: &Path, hostname: &str) -> Result<u16> {
    let hostname = hostname.trim().to_ascii_lowercase();
    if hostname.is_empty() || !hostname.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        bail!("{} {hostname}", t!("Invalid Cloudflare host name:", "Nom d'hôte Cloudflare invalide :"));
    }
    {
        let mut guard = FORWARDS.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        // Relais arrêtés (cloudflared tombé) ou inutilisés depuis longtemps : retirés.
        map.retain(|h, f| {
            let alive = matches!(f.child.try_wait(), Ok(None));
            let keep = alive && (h == &hostname || f.used.elapsed() < IDLE);
            if !keep {
                let _ = f.child.kill();
            }
            keep
        });
        if let Some(f) = map.get_mut(&hostname) {
            f.used = Instant::now();
            return Ok(f.port);
        }
    }
    let exe = binary(data_dir).await?;
    let port = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?.local_addr()?.port();
    let mut command = Command::new(&exe);
    command
        .args(["access", "tcp", "--hostname", &hostname, "--url", &format!("127.0.0.1:{port}"), "--loglevel", "error"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().context(t!("Cannot start cloudflared", "Impossible de lancer cloudflared"))?;
    // Prêt quand le port local accepte les connexions.
    let start = Instant::now();
    loop {
        if tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await.is_ok() {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            bail!("{} ({status})", t!("cloudflared stopped at once", "cloudflared s'est arrêté aussitôt"));
        }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            bail!(t!("cloudflared does not open its local port", "cloudflared n'ouvre pas son port local"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    FORWARDS.lock().unwrap().get_or_insert_with(HashMap::new).insert(hostname, Forward { child, port, used: Instant::now() });
    Ok(port)
}

/// Arrête tous les relais (fermeture de Portunia).
pub fn stop_all() {
    if let Some(map) = FORWARDS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        for (_, mut f) in map.drain() {
            let _ = f.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_fichier_par_systeme() {
        for (os, arch) in [("windows", "x86_64"), ("macos", "aarch64"), ("macos", "x86_64"), ("linux", "x86_64")] {
            let found = ASSETS.iter().filter(|(o, a, _, _)| *o == os && *a == arch).count();
            assert_eq!(found, 1, "{os} {arch}");
        }
        assert!(ASSETS.iter().all(|(_, _, _, sum)| sum.len() == 64 && sum.chars().all(|c| c.is_ascii_hexdigit())));
    }
}
