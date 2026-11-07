//! Tableau de bord d'un serveur Linux : un seul script POSIX lancé par la
//! connexion SSH ouverte (canal séparé), sa sortie analysée ici.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connector::{BoxFuture, RemoteExec};
use crate::extension::{self, ExtManifest, Extension, Host};
use crate::license::Feature;

/// Sections séparées par « @@nom ». Deux relevés de /proc/stat à 1 s d'écart
/// donnent l'occupation du processeur.
const SCRIPT: &str = r#"export LC_ALL=C
echo @@os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s
echo @@kernel; uname -r
echo @@host; hostname
echo @@uptime; cat /proc/uptime
echo @@load; cat /proc/loadavg
echo @@cpus; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@stat1; head -1 /proc/stat
sleep 1
echo @@stat2; head -1 /proc/stat
echo @@mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo @@disks; df -PkT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2
echo @@procs; ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -8
echo @@failed; systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | head -10
echo @@end"#;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub fs: String,
    pub total_kb: u64,
    pub used_kb: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub cpu: f32,
    pub mem: f32,
    pub name: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub os: String,
    pub kernel: String,
    pub hostname: String,
    pub uptime_secs: u64,
    pub load: [f32; 3],
    pub cpus: u32,
    /// Occupation du processeur sur la dernière seconde, en %.
    pub cpu_percent: f32,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub disks: Vec<Disk>,
    pub processes: Vec<Process>,
    /// Services systemd en échec.
    pub failed_services: Vec<String>,
}

fn sections(text: &str) -> Vec<(&str, Vec<&str>)> {
    let mut out: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            out.push((name.trim(), Vec::new()));
        } else if let Some((_, lines)) = out.last_mut() {
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
    }
    out
}

/// (inactif, total) d'une ligne « cpu » de /proc/stat.
fn cpu_times(line: &str) -> Option<(u64, u64)> {
    let values: Vec<u64> = line.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    // idle + iowait
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    // guest et guest_nice sont déjà comptés dans user et nice.
    let total = values.iter().take(8).sum();
    Some((idle, total))
}

pub fn parse(text: &str) -> Result<ServerStats> {
    let parts = sections(text);
    if !parts.iter().any(|(n, _)| *n == "end") || !parts.iter().any(|(n, l)| *n == "uptime" && !l.is_empty()) {
        bail!(t!("This server does not look like Linux (no /proc): dashboard unavailable", "Ce serveur ne ressemble pas à un Linux (pas de /proc) : tableau de bord indisponible"));
    }
    let first = |name: &str| parts.iter().find(|(n, _)| *n == name).and_then(|(_, l)| l.first().copied()).unwrap_or("").trim();
    let lines = |name: &str| parts.iter().find(|(n, _)| *n == name).map(|(_, l)| l.clone()).unwrap_or_default();

    let mut s = ServerStats {
        os: first("os").to_string(),
        kernel: first("kernel").to_string(),
        hostname: first("host").to_string(),
        uptime_secs: first("uptime").split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u64,
        cpus: first("cpus").parse().unwrap_or(1).max(1),
        ..Default::default()
    };
    for (i, v) in first("load").split_whitespace().take(3).enumerate() {
        s.load[i] = v.parse().unwrap_or(0.0);
    }
    if let (Some((i1, t1)), Some((i2, t2))) = (cpu_times(first("stat1")), cpu_times(first("stat2"))) {
        let total = t2.saturating_sub(t1);
        if total > 0 {
            s.cpu_percent = (100.0 * (1.0 - i2.saturating_sub(i1) as f32 / total as f32)).clamp(0.0, 100.0);
        }
    }
    for line in lines("mem") {
        let mut it = line.split_whitespace();
        let (Some(key), Some(value)) = (it.next(), it.next().and_then(|v| v.parse::<u64>().ok())) else { continue };
        match key {
            "MemTotal:" => s.mem_total_kb = value,
            "MemAvailable:" => s.mem_available_kb = value,
            "SwapTotal:" => s.swap_total_kb = value,
            "SwapFree:" => s.swap_free_kb = value,
            _ => {}
        }
    }
    for line in lines("disks") {
        // Système de fichiers, type, blocs 1K, utilisé, disponible, %, point de montage (peut contenir des espaces)
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 7 {
            continue;
        }
        let (Ok(total), Ok(used)) = (cols[2].parse::<u64>(), cols[3].parse::<u64>()) else { continue };
        if total == 0 {
            continue;
        }
        s.disks.push(Disk { mount: cols[6..].join(" "), fs: cols[1].to_string(), total_kb: total, used_kb: used });
    }
    for line in lines("procs") {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        let (Ok(pid), Ok(cpu), Ok(mem)) = (cols[0].parse(), cols[1].parse(), cols[2].parse()) else { continue };
        s.processes.push(Process { pid, cpu, mem, name: cols[3..].join(" ") });
    }
    s.failed_services = lines("failed").into_iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    Ok(s)
}

pub async fn collect(exec: &dyn RemoteExec) -> Result<ServerStats> {
    let out = exec.run(SCRIPT.to_string()).await?;
    parse(&out.stdout)
}

/// Extension « Tableau de bord » (Pro) : méthode `stats`.
pub struct Dashboard;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnConnection {
    connection_id: String,
}

impl Extension for Dashboard {
    fn manifest(&self) -> ExtManifest {
        ExtManifest { id: "dashboard", name: t!("Server dashboard", "Tableau de bord du serveur").into(), feature: Some(Feature::ServerDashboard), free: &[] }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, args: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "stats" => {
                    let a: OnConnection = extension::args(args)?;
                    let exec = host.exec(&a.connection_id)?;
                    extension::reply(collect(exec.as_ref()).await?)
                }
                _ => Err(extension::unknown("dashboard", method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@os\nDebian GNU/Linux 13 (trixie)\n@@kernel\n6.12.48-amd64\n@@host\nsrv-web-01\n@@uptime\n51322.45 98012.11\n@@load\n0.42 0.31 0.25 2/321 12345\n@@cpus\n4\n@@stat1\ncpu  1000 0 500 8000 100 0 0 0 0 0\n@@stat2\ncpu  1060 0 520 8300 120 0 0 0 0 0\n@@mem\nMemTotal:        8042512 kB\nMemAvailable:    5120000 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n@@disks\n/dev/sda2     ext4  41152736 18245600 20788824  47% /\n/dev/sdb1     xfs   1000000   900000   100000  90% /srv/mes données\n@@procs\n 1184  12.5  1.2 nginx\n  901   3.0  4.8 php-fpm8.4\n@@failed\nbackup.service\n@@end\n";

    #[test]
    fn analyse_un_releve() {
        let s = parse(SAMPLE).unwrap();
        assert_eq!(s.os, "Debian GNU/Linux 13 (trixie)");
        assert_eq!(s.hostname, "srv-web-01");
        assert_eq!(s.uptime_secs, 51322);
        assert_eq!(s.cpus, 4);
        assert_eq!(s.load, [0.42, 0.31, 0.25]);
        // 400 jiffies écoulés dont 320 inactifs (300 idle + 20 iowait) → 20 %
        assert!((s.cpu_percent - 20.0).abs() < 0.01, "{}", s.cpu_percent);
        assert_eq!(s.mem_total_kb, 8042512);
        assert_eq!(s.mem_available_kb, 5120000);
        assert_eq!(s.disks.len(), 2);
        assert_eq!(s.disks[1].mount, "/srv/mes données");
        assert_eq!(s.processes[0], Process { pid: 1184, cpu: 12.5, mem: 1.2, name: "nginx".into() });
        assert_eq!(s.failed_services, vec!["backup.service".to_string()]);
    }

    #[test]
    fn refuse_un_serveur_sans_proc() {
        assert!(parse("@@os\nWindows\n@@uptime\n@@end\n").is_err());
        assert!(parse("'echo' n'est pas reconnu…").is_err());
    }
}
