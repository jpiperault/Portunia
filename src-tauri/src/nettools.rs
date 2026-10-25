//! Outils réseau : ping et traceroute (API ICMP de Windows, sans droits
//! administrateur), test de ports TCP, résolution DNS, Wake-on-LAN.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket},
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

/// Adresses d'un nom d'hôte (ou l'adresse elle-même).
pub fn resolve(host: &str) -> Result<Vec<IpAddr>> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        bail!("Indiquez un hôte");
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    let mut ips: Vec<IpAddr> = (host, 0)
        .to_socket_addrs()
        .map_err(|e| anyhow!("Nom introuvable : {host} ({e})"))?
        .map(|a| a.ip())
        .collect();
    ips.dedup();
    if ips.is_empty() {
        bail!("Nom introuvable : {host}");
    }
    Ok(ips)
}

/// Première adresse IPv4 (ping et traceroute passent par l'API ICMP IPv4).
pub fn resolve_v4(host: &str) -> Result<Ipv4Addr> {
    resolve(host)?
        .into_iter()
        .find_map(|ip| match ip {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| anyhow!("{host} n'a qu'une adresse IPv6 : ping et traceroute ne gèrent que l'IPv4 pour l'instant"))
}

/// Réponse à une requête d'écho.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Echo {
    /// La cible a répondu.
    Reply { from: String, rtt: u32, ttl: u8 },
    /// Un routeur intermédiaire a signalé la fin de vie du paquet (traceroute).
    TtlExpired { from: String, rtt: u32 },
    Timeout,
    /// Hôte ou réseau injoignable, autre erreur ICMP.
    Unreachable { from: String, reason: String },
}

#[cfg(windows)]
mod icmp {
    use super::*;
    use windows::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION,
    };

    const IP_SUCCESS: u32 = 0;
    const IP_DEST_NET_UNREACHABLE: u32 = 11002;
    const IP_DEST_HOST_UNREACHABLE: u32 = 11003;
    const IP_DEST_PROT_UNREACHABLE: u32 = 11004;
    const IP_DEST_PORT_UNREACHABLE: u32 = 11005;
    const IP_REQ_TIMED_OUT: u32 = 11010;
    const IP_TTL_EXPIRED_TRANSIT: u32 = 11013;

    pub fn echo(target: Ipv4Addr, ttl: u8, timeout: Duration) -> Result<Echo> {
        let payload = *b"Termoria ping....................";
        // Réponse + données renvoyées + marge pour un message d'erreur ICMP.
        let mut buffer = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 64];
        let options = IP_OPTION_INFORMATION { Ttl: ttl, ..Default::default() };
        unsafe {
            let handle = IcmpCreateFile().map_err(|e| anyhow!("ICMP indisponible : {e}"))?;
            let count = IcmpSendEcho(
                handle,
                u32::from_ne_bytes(target.octets()),
                payload.as_ptr().cast(),
                payload.len() as u16,
                Some(&options),
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                timeout.as_millis().clamp(1, 60_000) as u32,
            );
            let last = windows::Win32::Foundation::GetLastError().0;
            let _ = IcmpCloseHandle(handle);
            if count == 0 {
                return Ok(match last {
                    IP_REQ_TIMED_OUT => Echo::Timeout,
                    code => Echo::Unreachable { from: String::new(), reason: reason(code) },
                });
            }
            let reply = std::ptr::read_unaligned(buffer.as_ptr().cast::<ICMP_ECHO_REPLY>());
            let from = Ipv4Addr::from(reply.Address.to_ne_bytes()).to_string();
            Ok(match reply.Status {
                IP_SUCCESS => Echo::Reply { from, rtt: reply.RoundTripTime, ttl: reply.Options.Ttl },
                IP_TTL_EXPIRED_TRANSIT => Echo::TtlExpired { from, rtt: reply.RoundTripTime },
                IP_REQ_TIMED_OUT => Echo::Timeout,
                code => Echo::Unreachable { from, reason: reason(code) },
            })
        }
    }

    fn reason(code: u32) -> String {
        match code {
            IP_DEST_NET_UNREACHABLE => "réseau injoignable".into(),
            IP_DEST_HOST_UNREACHABLE => "hôte injoignable".into(),
            IP_DEST_PROT_UNREACHABLE => "protocole injoignable".into(),
            IP_DEST_PORT_UNREACHABLE => "port injoignable".into(),
            other => format!("erreur ICMP {other}"),
        }
    }
}

#[cfg(windows)]
pub use icmp::echo;

#[cfg(not(windows))]
pub fn echo(_target: Ipv4Addr, _ttl: u8, _timeout: Duration) -> Result<Echo> {
    bail!("Ping disponible uniquement sous Windows")
}

// ---------- Ports TCP ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    pub port: u16,
    /// open, closed (refusé), filtered (pas de réponse)
    pub state: &'static str,
    pub ms: Option<u32>,
    pub service: &'static str,
}

/// « 22,80,443,8000-8010 » → liste de ports (au plus 1024).
pub fn parse_ports(spec: &str) -> Result<Vec<u16>> {
    let mut ports = Vec::new();
    for part in spec.split([',', ' ', ';']).map(str::trim).filter(|p| !p.is_empty()) {
        let (a, b) = part.split_once('-').unwrap_or((part, part));
        let a: u16 = a.trim().parse().map_err(|_| anyhow!("Port invalide : {part}"))?;
        let b: u16 = b.trim().parse().map_err(|_| anyhow!("Port invalide : {part}"))?;
        if a == 0 || b < a {
            bail!("Plage invalide : {part}");
        }
        ports.extend(a..=b);
        if ports.len() > 1024 {
            bail!("1024 ports au plus par test");
        }
    }
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        bail!("Indiquez au moins un port");
    }
    Ok(ports)
}

pub fn service_name(port: u16) -> &'static str {
    match port {
        20 | 21 => "FTP",
        22 => "SSH",
        23 => "Telnet",
        25 | 587 => "SMTP",
        53 => "DNS",
        80 | 8080 => "HTTP",
        110 => "POP3",
        143 => "IMAP",
        389 => "LDAP",
        443 | 8443 => "HTTPS",
        445 => "SMB",
        636 => "LDAPS",
        993 => "IMAPS",
        1433 => "SQL Server",
        3306 => "MySQL",
        3389 => "RDP",
        5432 => "PostgreSQL",
        5900..=5909 => "VNC",
        5985 | 5986 => "WinRM",
        6379 => "Redis",
        _ => "",
    }
}

/// Windows signale un refus de connexion après ~2 s (nouvelles tentatives) : délai d'au moins 3 s.
pub async fn check_port(ip: IpAddr, port: u16, timeout: Duration) -> PortResult {
    let start = Instant::now();
    let attempt = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(SocketAddr::new(ip, port))).await;
    let (state, ms) = match attempt {
        Ok(Ok(_)) => ("open", Some(start.elapsed().as_millis() as u32)),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => ("closed", Some(start.elapsed().as_millis() as u32)),
        _ => ("filtered", None),
    };
    PortResult { port, state, ms, service: service_name(port) }
}

// ---------- Wake-on-LAN ----------

/// « AA:BB:CC:DD:EE:FF », « aa-bb-… » ou « aabbccddeeff ».
pub fn parse_mac(text: &str) -> Result<[u8; 6]> {
    let hex: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let separators_ok = text.chars().all(|c| c.is_ascii_hexdigit() || ":-. ".contains(c));
    if hex.len() != 12 || !separators_ok {
        bail!("Adresse MAC invalide : {text} (attendu AA:BB:CC:DD:EE:FF)");
    }
    let mut mac = [0u8; 6];
    for (i, byte) in mac.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)?;
    }
    Ok(mac)
}

pub fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut packet = vec![0xFF; 6];
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    packet
}

/// Envoie le « paquet magique » en diffusion (UDP 9), par défaut sur 255.255.255.255.
pub fn wake(mac: &str, broadcast: Option<&str>) -> Result<String> {
    let mac = parse_mac(mac)?;
    let target: Ipv4Addr = match broadcast.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.parse().map_err(|_| anyhow!("Adresse de diffusion invalide : {b}"))?,
        None => Ipv4Addr::BROADCAST,
    };
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.set_broadcast(true)?;
    let packet = magic_packet(mac);
    // Envoyé trois fois : un paquet UDP peut se perdre.
    for _ in 0..3 {
        socket.send_to(&packet, (target, 9))?;
    }
    Ok(target.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_et_plages() {
        assert_eq!(parse_ports("443, 22,80-82,22").unwrap(), vec![22, 80, 81, 82, 443]);
        assert!(parse_ports("0").is_err());
        assert!(parse_ports("90-80").is_err());
        assert!(parse_ports("1-2000").is_err());
        assert!(parse_ports("ssh").is_err());
    }

    #[test]
    fn mac_et_paquet_magique() {
        let mac = parse_mac("aa-BB-cc:dd.ee ff").unwrap();
        assert_eq!(mac, [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
        assert!(parse_mac("aa:bb:cc").is_err());
        assert!(parse_mac("aa:bb:cc:dd:ee:gg").is_err());
        let p = magic_packet(mac);
        assert_eq!(p.len(), 102);
        assert_eq!(&p[..6], &[0xFF; 6]);
        assert_eq!(&p[96..], &mac);
    }

    #[test]
    fn ping_de_la_boucle_locale() {
        let echo = echo(Ipv4Addr::LOCALHOST, 64, Duration::from_secs(2)).unwrap();
        assert!(matches!(echo, Echo::Reply { ref from, .. } if from == "127.0.0.1"), "{echo:?}");
    }

    #[tokio::test]
    async fn port_ferme_et_ouvert() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let open = check_port(IpAddr::V4(Ipv4Addr::LOCALHOST), port, Duration::from_secs(4)).await;
        assert_eq!(open.state, "open");
        drop(listener);
        let closed = check_port(IpAddr::V4(Ipv4Addr::LOCALHOST), port, Duration::from_secs(4)).await;
        assert_eq!(closed.state, "closed");
    }
}
