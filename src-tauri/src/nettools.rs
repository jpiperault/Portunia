//! Outils réseau : ping et traceroute (API ICMP de Windows, socket ICMP datagramme
//! sous Unix, sans droits administrateur), test de ports TCP, résolution DNS, Wake-on-LAN.

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
        bail!(t!("Give a host", "Indiquez un hôte"));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    let mut ips: Vec<IpAddr> = (host, 0)
        .to_socket_addrs()
        .map_err(|e| anyhow!("{}", t!(format!("Name not found: {host} ({e})"), format!("Nom introuvable : {host} ({e})"))))?
        .map(|a| a.ip())
        .collect();
    ips.dedup();
    if ips.is_empty() {
        bail!("{}", t!(format!("Name not found: {host}"), format!("Nom introuvable : {host}")));
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
        .ok_or_else(|| anyhow!("{}", t!(format!("{host} only has an IPv6 address: ping and traceroute only handle IPv4 for now"), format!("{host} n'a qu'une adresse IPv6 : ping et traceroute ne gèrent que l'IPv4 pour l'instant"))))
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
        let payload = *b"Portunia ping....................";
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
            IP_DEST_NET_UNREACHABLE => t!("network unreachable", "réseau injoignable").into(),
            IP_DEST_HOST_UNREACHABLE => t!("host unreachable", "hôte injoignable").into(),
            IP_DEST_PROT_UNREACHABLE => "protocole injoignable".into(),
            IP_DEST_PORT_UNREACHABLE => "port injoignable".into(),
            other => format!("erreur ICMP {other}"),
        }
    }
}

#[cfg(windows)]
pub use icmp::echo;

/// ICMP Unix : socket datagramme (`SOCK_DGRAM` + `IPPROTO_ICMP`), autorisée sans root par macOS
/// et par Linux (selon `ping_group_range`). Le noyau réécrit l'identifiant ICMP : les réponses
/// sont donc reconnues par leur numéro de séquence.
#[cfg(unix)]
mod icmp_unix {
    use super::*;
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::{
        mem::MaybeUninit,
        sync::atomic::{AtomicU16, Ordering},
    };

    const PAYLOAD: &[u8; 32] = b"Portunia ping...................";
    /// Repli si le générateur aléatoire du système échoue.
    static FALLBACK_SEQ: AtomicU16 = AtomicU16::new(1);

    /// Numéro de séquence imprévisible : un tiers ne peut pas deviner quelle réponse accepter.
    fn next_seq() -> u16 {
        use ring::rand::SecureRandom;
        let mut bytes = [0u8; 2];
        match ring::rand::SystemRandom::new().fill(&mut bytes) {
            Ok(()) => u16::from_be_bytes(bytes),
            Err(_) => FALLBACK_SEQ.fetch_add(1, Ordering::Relaxed),
        }
    }

    /// Somme de contrôle Internet (RFC 1071).
    pub fn checksum(data: &[u8]) -> u16 {
        let mut sum: u32 = data
            .chunks(2)
            .map(|c| u32::from(u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])))
            .sum();
        while sum > 0xFFFF {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        !(sum as u16)
    }

    /// Requête d'écho : type 8 (IPv4) ou 128 (IPv6), identifiant laissé au noyau.
    /// En IPv6 la somme de contrôle (pseudo-en-tête) est calculée par le noyau.
    pub fn build_echo_request(seq: u16, v6: bool) -> Vec<u8> {
        let mut packet = vec![if v6 { 128 } else { 8 }, 0, 0, 0, 0, 0];
        packet.extend_from_slice(&seq.to_be_bytes());
        packet.extend_from_slice(PAYLOAD);
        if !v6 {
            let sum = checksum(&packet);
            packet[2..4].copy_from_slice(&sum.to_be_bytes());
        }
        packet
    }

    #[derive(Debug, PartialEq)]
    pub enum Message {
        EchoReply { seq: u16, ttl: Option<u8> },
        TimeExceeded { seq: Option<u16> },
        Unreachable { code: u8, seq: Option<u16> },
        Other,
    }

    /// Retire l'en-tête IPv4 que macOS laisse devant les messages ICMP reçus (Linux n'en laisse pas).
    fn strip_ipv4_header(buf: &[u8]) -> (&[u8], Option<u8>) {
        if buf.len() >= 20 && buf[0] >> 4 == 4 {
            let len = usize::from(buf[0] & 0x0F) * 4;
            if len >= 20 && buf.len() > len {
                return (&buf[len..], Some(buf[8]));
            }
        }
        (buf, None)
    }

    /// Numéro de séquence de la requête citée dans un message d'erreur.
    fn quoted_seq(body: &[u8], v6: bool) -> Option<u16> {
        let (inner, offset) = if v6 {
            (body.get(8..)?, 40)
        } else {
            let inner = body.get(8..)?;
            (inner, usize::from(inner.first()? & 0x0F) * 4)
        };
        let seq = inner.get(offset + 6..offset + 8)?;
        Some(u16::from_be_bytes([seq[0], seq[1]]))
    }

    /// Analyse un message ICMP reçu.
    pub fn parse_message(buf: &[u8], v6: bool) -> Message {
        let (icmp, ttl) = if v6 { (buf, None) } else { strip_ipv4_header(buf) };
        let Some(&kind) = icmp.first() else { return Message::Other };
        let code = icmp.get(1).copied().unwrap_or(0);
        let (reply, exceeded, unreachable) = if v6 { (129, 3, 1) } else { (0, 11, 3) };
        match kind {
            k if k == reply && icmp.len() >= 8 => Message::EchoReply { seq: u16::from_be_bytes([icmp[6], icmp[7]]), ttl },
            k if k == exceeded => Message::TimeExceeded { seq: quoted_seq(icmp, v6) },
            k if k == unreachable => Message::Unreachable { code, seq: quoted_seq(icmp, v6) },
            _ => Message::Other,
        }
    }

    /// Ce qu'une réponse reçue signifie pour notre requête.
    #[derive(Debug, PartialEq)]
    pub enum Verdict {
        Reply { ttl: u8 },
        Expired,
        Unreachable { code: u8 },
    }

    /// Décide si `message`, reçu de `from`, répond bien à notre requête (`seq`, vers `target`) :
    /// - un écho doit venir de la cible elle-même et porter notre séquence ;
    /// - une erreur (TTL expiré, injoignable) vient d'un routeur, mais doit citer notre séquence ;
    ///   une erreur sans séquence lisible est ignorée.
    pub fn verdict(message: &Message, from: Option<IpAddr>, target: IpAddr, seq: u16) -> Option<Verdict> {
        match *message {
            Message::EchoReply { seq: s, ttl } if s == seq && from == Some(target) => Some(Verdict::Reply { ttl: ttl.unwrap_or(0) }),
            Message::TimeExceeded { seq: Some(s) } if s == seq => Some(Verdict::Expired),
            Message::Unreachable { code, seq: Some(s) } if s == seq => Some(Verdict::Unreachable { code }),
            _ => None,
        }
    }

    fn unreachable_reason(code: u8, v6: bool) -> String {
        match (v6, code) {
            (false, 0) | (true, 0) => t!("network unreachable", "réseau injoignable").into(),
            (false, 1) | (true, 3) => t!("host unreachable", "hôte injoignable").into(),
            (false, 2) => "protocole injoignable".into(),
            (false, 3) | (true, 4) => "port injoignable".into(),
            (_, other) => format!("erreur ICMP {other}"),
        }
    }

    fn sender_ip(addr: &SockAddr) -> String {
        addr.as_socket().map(|a| a.ip().to_string()).unwrap_or_default()
    }

    /// Un écho vers `target` avec ce TTL, en attendant au plus `timeout`.
    pub fn echo_ip(target: IpAddr, ttl: u8, timeout: Duration) -> Result<Echo> {
        let v6 = target.is_ipv6();
        let socket = if v6 {
            Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::ICMPV6))
        } else {
            Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))
        }
        .map_err(|e| anyhow!("{}", t!(format!("ICMP unavailable: {e}"), format!("ICMP indisponible : {e}"))))?;
        if v6 {
            socket.set_unicast_hops_v6(u32::from(ttl))?;
        } else {
            socket.set_ttl_v4(u32::from(ttl))?;
        }
        let seq = next_seq();
        let start = Instant::now();
        socket.send_to(&build_echo_request(seq, v6), &SockAddr::from(SocketAddr::new(target, 0)))?;

        let mut buf = [MaybeUninit::<u8>::uninit(); 1500];
        loop {
            let Some(left) = timeout.checked_sub(start.elapsed()).filter(|d| !d.is_zero()) else {
                return Ok(Echo::Timeout);
            };
            socket.set_read_timeout(Some(left))?;
            let (len, from) = match socket.recv_from(&mut buf) {
                Ok(received) => received,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Ok(Echo::Timeout),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            };
            // SAFETY: `recv_from` a initialisé les `len` premiers octets du tampon.
            let data: Vec<u8> = buf[..len].iter().map(|b| unsafe { b.assume_init() }).collect();
            let rtt = start.elapsed().as_millis() as u32;
            let from_ip = sender_ip(&from);
            match verdict(&parse_message(&data, v6), from.as_socket().map(|a| a.ip()), target, seq) {
                Some(Verdict::Reply { ttl }) => return Ok(Echo::Reply { from: from_ip, rtt, ttl }),
                Some(Verdict::Expired) => return Ok(Echo::TtlExpired { from: from_ip, rtt }),
                Some(Verdict::Unreachable { code }) => return Ok(Echo::Unreachable { from: from_ip, reason: unreachable_reason(code, v6) }),
                // Réponse destinée à un autre ping, d'une autre adresse, ou sans rapport : on attend la suite.
                None => {}
            }
        }
    }
}

#[cfg(unix)]
pub fn echo(target: Ipv4Addr, ttl: u8, timeout: Duration) -> Result<Echo> {
    icmp_unix::echo_ip(IpAddr::V4(target), ttl, timeout)
}

/// Écho vers une adresse IPv4 ou IPv6 (ICMPv6 pour cette dernière).
#[cfg(unix)]
#[allow(dead_code)] // les commandes ping/traceroute (commands.rs) n'envoient encore que de l'IPv4
pub fn echo_ip(target: IpAddr, ttl: u8, timeout: Duration) -> Result<Echo> {
    icmp_unix::echo_ip(target, ttl, timeout)
}

#[cfg(unix)]
#[cfg(test)]
mod icmp_unix_tests {
    use super::icmp_unix::*;

    #[test]
    fn somme_de_controle_rfc1071() {
        // Exemple de la RFC 1071 : 00 01 f2 03 f4 f5 f6 f7 → somme 0xddf2, complément 0x220d.
        assert_eq!(checksum(&[0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]), 0x220d);
        // Longueur impaire : l'octet final est complété par un zéro.
        assert_eq!(checksum(&[0x01]), !0x0100);
    }

    #[test]
    fn requete_d_echo_v4_valide() {
        let packet = build_echo_request(0x1234, false);
        assert_eq!(&packet[..2], &[8, 0]);
        assert_eq!(&packet[6..8], &[0x12, 0x34]);
        assert_eq!(packet.len(), 8 + 32);
        // Un paquet portant sa somme de contrôle se vérifie à zéro.
        assert_eq!(checksum(&packet), 0);
    }

    #[test]
    fn requete_d_echo_v6_laisse_la_somme_au_noyau() {
        let packet = build_echo_request(7, true);
        assert_eq!(&packet[..4], &[128, 0, 0, 0]);
        assert_eq!(&packet[6..8], &[0, 7]);
    }

    /// En-tête IPv4 minimal de 20 octets avec ce TTL.
    fn ipv4_header(ttl: u8) -> Vec<u8> {
        let mut h = vec![0x45, 0, 0, 0, 0, 0, 0, 0, ttl, 1];
        h.resize(20, 0);
        h
    }

    #[test]
    fn reponse_d_echo_avec_ou_sans_en_tete_ip() {
        let icmp = [0, 0, 0, 0, 0xab, 0xcd, 0x00, 0x2a, 1, 2, 3];
        let mut with_header = ipv4_header(57);
        with_header.extend_from_slice(&icmp);
        assert_eq!(parse_message(&with_header, false), Message::EchoReply { seq: 42, ttl: Some(57) });
        assert_eq!(parse_message(&icmp, false), Message::EchoReply { seq: 42, ttl: None });
    }

    #[test]
    fn ttl_expire_cite_la_sequence_de_la_requete() {
        // Type 11, puis 4 octets inutilisés, l'en-tête IP cité et 8 octets de la requête (seq = 9).
        let mut message = ipv4_header(250);
        message.extend_from_slice(&[11, 0, 0, 0, 0, 0, 0, 0]);
        message.extend_from_slice(&ipv4_header(1));
        message.extend_from_slice(&[8, 0, 0, 0, 0x11, 0x22, 0x00, 0x09]);
        assert_eq!(parse_message(&message, false), Message::TimeExceeded { seq: Some(9) });
    }

    #[test]
    fn destination_injoignable_et_troncature() {
        let mut message = vec![3, 1, 0, 0, 0, 0, 0, 0];
        message.extend_from_slice(&ipv4_header(1));
        message.extend_from_slice(&[8, 0, 0, 0, 0, 0, 0x01, 0x00]);
        assert_eq!(parse_message(&message, false), Message::Unreachable { code: 1, seq: Some(256) });
        // Citation tronquée : la séquence est inconnue, pas de panique.
        assert_eq!(parse_message(&message[..12], false), Message::Unreachable { code: 1, seq: None });
        assert_eq!(parse_message(&[], false), Message::Other);
        assert_eq!(parse_message(&[0, 0, 0], false), Message::Other);
    }

    #[test]
    fn une_reponse_d_une_autre_adresse_est_ignoree() {
        use std::net::IpAddr;
        let target: IpAddr = "192.0.2.10".parse().unwrap();
        let other: IpAddr = "192.0.2.99".parse().unwrap();
        let reply = Message::EchoReply { seq: 5, ttl: Some(60) };
        assert_eq!(verdict(&reply, Some(target), target, 5), Some(Verdict::Reply { ttl: 60 }));
        assert_eq!(verdict(&reply, Some(other), target, 5), None);
        assert_eq!(verdict(&reply, None, target, 5), None);
        assert_eq!(verdict(&reply, Some(target), target, 6), None);
    }

    #[test]
    fn une_erreur_sans_sequence_ou_avec_une_autre_est_ignoree() {
        use std::net::IpAddr;
        let target: IpAddr = "192.0.2.10".parse().unwrap();
        let router: IpAddr = "192.0.2.1".parse().unwrap();
        assert_eq!(verdict(&Message::TimeExceeded { seq: Some(5) }, Some(router), target, 5), Some(Verdict::Expired));
        assert_eq!(verdict(&Message::TimeExceeded { seq: None }, Some(router), target, 5), None);
        assert_eq!(verdict(&Message::TimeExceeded { seq: Some(4) }, Some(router), target, 5), None);
        assert_eq!(verdict(&Message::Unreachable { code: 1, seq: None }, Some(router), target, 5), None);
        assert_eq!(verdict(&Message::Unreachable { code: 1, seq: Some(5) }, Some(router), target, 5), Some(Verdict::Unreachable { code: 1 }));
        assert_eq!(verdict(&Message::Other, Some(router), target, 5), None);
    }

    #[test]
    fn citation_icmpv6_tronquee() {
        let mut exceeded = vec![3, 0, 0, 0, 0, 0, 0, 0];
        exceeded.extend_from_slice(&[0x60; 40]);
        // Moins de 8 octets du message cité : séquence inconnue, donc pas de panique ni d'acceptation.
        exceeded.extend_from_slice(&[128, 0, 0, 0, 0, 1]);
        assert_eq!(parse_message(&exceeded, true), Message::TimeExceeded { seq: None });
        assert_eq!(parse_message(&exceeded[..20], true), Message::TimeExceeded { seq: None });
    }

    #[test]
    fn messages_icmpv6() {
        assert_eq!(parse_message(&[129, 0, 0, 0, 0, 1, 0, 5], true), Message::EchoReply { seq: 5, ttl: None });
        let mut exceeded = vec![3, 0, 0, 0, 0, 0, 0, 0];
        exceeded.extend_from_slice(&[0x60; 40]);
        exceeded.extend_from_slice(&[128, 0, 0, 0, 0, 1, 0, 8]);
        assert_eq!(parse_message(&exceeded, true), Message::TimeExceeded { seq: Some(8) });
    }
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
        let a: u16 = a.trim().parse().map_err(|_| anyhow!("{}", t!(format!("Invalid port: {part}"), format!("Port invalide : {part}"))))?;
        let b: u16 = b.trim().parse().map_err(|_| anyhow!("{}", t!(format!("Invalid port: {part}"), format!("Port invalide : {part}"))))?;
        if a == 0 || b < a {
            bail!("{}", t!(format!("Invalid range: {part}"), format!("Plage invalide : {part}")));
        }
        ports.extend(a..=b);
        if ports.len() > 1024 {
            bail!(t!("1024 ports at most per test", "1024 ports au plus par test"));
        }
    }
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        bail!(t!("Give at least one port", "Indiquez au moins un port"));
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
        bail!("{}", t!(format!("Invalid MAC address: {text} (expected AA:BB:CC:DD:EE:FF)"), format!("Adresse MAC invalide : {text} (attendu AA:BB:CC:DD:EE:FF)")));
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
        Some(b) => b.parse().map_err(|_| anyhow!("{}", t!(format!("Invalid broadcast address: {b}"), format!("Adresse de diffusion invalide : {b}"))))?,
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

    /// Ping réel de la boucle locale, à lancer à la main : `cargo test -- --ignored ping_localhost`.
    /// macOS autorise l'ICMP en datagramme : un échec ici est un vrai bug.
    #[cfg(unix)]
    #[test]
    #[ignore = "envoie un vrai paquet ICMP"]
    fn ping_localhost() {
        let echo = echo(Ipv4Addr::LOCALHOST, 64, Duration::from_secs(2)).unwrap();
        assert!(matches!(echo, Echo::Reply { ref from, .. } if from == "127.0.0.1"), "{echo:?}");
    }

    /// Traceroute : avec un TTL de 1, la passerelle doit signaler « Time Exceeded » (réseau requis) :
    /// `cargo test -- --ignored ttl_expire_vers_internet`.
    #[cfg(unix)]
    #[test]
    #[ignore = "exige un accès réseau"]
    fn ttl_expire_vers_internet() {
        let echo = echo(Ipv4Addr::new(8, 8, 8, 8), 1, Duration::from_secs(3)).unwrap();
        assert!(matches!(echo, Echo::TtlExpired { .. }), "{echo:?}");
    }

    #[cfg(windows)]
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
