//! Shell local (PowerShell, Invite de commandes, WSL, Git Bash…) dans un onglet,
//! via la console pseudo-terminal de Windows (ConPTY), comme Windows Terminal.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{anyhow, bail, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::connector::*;

/// Un shell lançable : détecté sur le PC ou ajouté par l'utilisateur.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Dossier de départ (vide : dossier personnel).
    #[serde(default)]
    pub cwd: String,
    /// Icône : pwsh, powershell, cmd, wsl, git, custom.
    #[serde(default)]
    pub icon: String,
}

fn spec(id: &str, name: &str, command: PathBuf, args: &[&str], icon: &str) -> ShellSpec {
    ShellSpec {
        id: id.into(),
        name: name.into(),
        command: command.display().to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        cwd: String::new(),
        icon: icon.into(),
    }
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

/// Cherche un exécutable dans le PATH.
fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|p| p.join(name)).find(|p| p.is_file()))
}

/// Distributions WSL installées (`wsl.exe -l -q` écrit en UTF-16).
#[cfg(windows)]
fn wsl_distributions() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = Command::new("wsl.exe").args(["-l", "-q"]).creation_flags(CREATE_NO_WINDOW).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let units: Vec<u16> = out.stdout.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim().trim_matches('\0').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

#[cfg(not(windows))]
fn wsl_distributions() -> Vec<String> {
    Vec::new()
}

/// Shells présents sur ce PC, dans l'ordre d'affichage.
pub fn detect() -> Vec<ShellSpec> {
    let mut out = Vec::new();
    let program_files = env_path("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let pwsh = which("pwsh.exe").or_else(|| Some(program_files.join(r"PowerShell\7\pwsh.exe")).filter(|p| p.is_file()));
    if let Some(p) = pwsh {
        out.push(spec("pwsh", "PowerShell 7", p, &["-NoLogo"], "pwsh"));
    }
    let system = env_path("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32");
    let powershell = system.join(r"WindowsPowerShell\v1.0\powershell.exe");
    if powershell.is_file() {
        out.push(spec("powershell", "Windows PowerShell", powershell, &["-NoLogo"], "powershell"));
    }
    let cmd = env_path("ComSpec").unwrap_or_else(|| system.join("cmd.exe"));
    if cmd.is_file() {
        out.push(spec("cmd", "Invite de commandes", cmd, &[], "cmd"));
    }
    if let Some(wsl) = Some(system.join("wsl.exe")).filter(|p| p.is_file()) {
        for distro in wsl_distributions() {
            out.push(spec(&format!("wsl:{distro}"), &format!("{distro} (WSL)"), wsl.clone(), &["-d", &distro, "--cd", "~"], "wsl"));
        }
    }
    let git_candidates = [
        program_files.join(r"Git\bin\bash.exe"),
        env_path("ProgramFiles(x86)").unwrap_or_default().join(r"Git\bin\bash.exe"),
        env_path("LOCALAPPDATA").unwrap_or_default().join(r"Programs\Git\bin\bash.exe"),
    ];
    if let Some(bash) = git_candidates.into_iter().find(|p| p.is_file()) {
        out.push(spec("gitbash", "Git Bash", bash, &["--login", "-i"], "git"));
    }
    out
}

fn home() -> PathBuf {
    env_path("USERPROFILE").unwrap_or_else(|| PathBuf::from("."))
}

/// Ouvre le shell dans un pseudo-terminal et relaie ses entrées / sorties.
pub fn open(shell: &ShellSpec, cols: u16, rows: u16, sink: Arc<dyn Sink>) -> Result<Box<dyn TerminalConnection>> {
    let program = Path::new(&shell.command);
    if program.is_absolute() && !program.is_file() {
        bail!("Programme introuvable : {}", shell.command);
    }
    let pty = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| anyhow!("Console Windows indisponible : {e}"))?;
    let mut command = CommandBuilder::new(&shell.command);
    command.args(&shell.args);
    let cwd = if shell.cwd.trim().is_empty() { home() } else { PathBuf::from(shell.cwd.trim()) };
    command.cwd(if cwd.is_dir() { cwd } else { home() });
    command.env("TERM_PROGRAM", "Termoria");
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|e| anyhow!("Impossible de lancer {} : {e}", shell.name))?;
    // Le côté « esclave » appartient maintenant au processus lancé.
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
    let writer = pty.master.take_writer().map_err(|e| anyhow!("{e}"))?;
    let child: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));

    let exit_child = child.clone();
    thread::Builder::new()
        .name(format!("shell-{}", shell.id))
        .spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink.data(&buf[..n]),
                }
            }
            // Le shell s'est terminé : code de sortie non nul = message.
            let status = exit_child.lock().unwrap().wait().ok();
            let reason = status.filter(|s| !s.success()).map(|s| format!("le shell s'est arrêté (code {})", s.exit_code()));
            sink.closed(reason);
        })
        .context("Impossible de démarrer la lecture du shell")?;

    Ok(Box::new(LocalShell { writer: Mutex::new(writer), master: Mutex::new(pty.master), child }))
}

struct LocalShell {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl TerminalConnection for LocalShell {
    fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| anyhow!("{e}"))
    }

    fn close(&self) {
        let _ = self.child.lock().unwrap().kill();
    }
}

impl Drop for LocalShell {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}

/// Lance le shell en administrateur, dans sa propre fenêtre Windows (l'élévation
/// ne peut pas se faire à l'intérieur de Termoria sans l'élever tout entier).
pub fn open_elevated(shell: &ShellSpec) -> Result<()> {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let mut script = format!("Start-Process -Verb RunAs -FilePath {}", quote(&shell.command));
    if !shell.args.is_empty() {
        let list: Vec<String> = shell.args.iter().map(|a| quote(a)).collect();
        script.push_str(&format!(" -ArgumentList {}", list.join(",")));
    }
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().context("Impossible de demander les droits administrateur")?;
    Ok(())
}

/// Extension « Shell local » : permet aussi d'enregistrer un shell comme une session.
pub struct LocalShellConnector;

impl Connector for LocalShellConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "local".into(),
            name: "Shell local".into(),
            version: "0.1.0".into(),
            description: "PowerShell, Invite de commandes, WSL, Git Bash… de ce PC, dans un onglet.".into(),
            view: ViewKind::Terminal,
            builtin: true,
            file_browser: false,
            port_forwarding: false,
            fields: vec![
                Field::new("command", "Programme", FieldKind::Suggest { source: "shells".into() })
                    .required()
                    .placeholder("pwsh.exe"),
                Field::new("args", "Arguments", FieldKind::Text).placeholder("-NoLogo"),
                Field::new("cwd", "Dossier de départ", FieldKind::File).placeholder("Vide : dossier personnel"),
            ],
        }
    }

    fn suggestions(&self, source: &str) -> Vec<ChoiceOption> {
        if source != "shells" {
            return Vec::new();
        }
        detect()
            .into_iter()
            .map(|s| ChoiceOption { label: s.name.clone(), value: s.command })
            .collect()
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let command = ctx.require("command", "Programme")?;
        let shell = ShellSpec {
            id: "session".into(),
            name: ctx.session_name.clone(),
            command,
            args: ctx.str("args").map(|a| split_args(&a)).unwrap_or_default(),
            cwd: ctx.str("cwd").unwrap_or_default(),
            icon: "custom".into(),
        };
        Ok(Outcome::Terminal(open(&shell, ctx.cols, ctx.rows, ctx.sink.clone())?))
    }
}

/// Découpe une ligne d'arguments en respectant les guillemets doubles.
pub fn split_args(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut current));
                    has = false;
                }
            }
            c => {
                current.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoupe_les_arguments() {
        assert_eq!(split_args(r#"-d Ubuntu --cd "C:\Mes projets" -x"#), vec!["-d", "Ubuntu", "--cd", r"C:\Mes projets", "-x"]);
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn trouve_au_moins_cmd() {
        if cfg!(windows) {
            assert!(detect().iter().any(|s| s.id == "cmd"));
        }
    }

    /// Lance réellement l'Invite de commandes dans une ConPTY et lit sa réponse.
    /// (Au démarrage, la console demande la position du curseur : xterm.js y répond
    /// tout seul dans Termoria ; ici, le test répond comme lui.)
    #[cfg(windows)]
    #[test]
    fn execute_une_commande() {
        struct Collect(Mutex<Vec<u8>>);
        impl Sink for Collect {
            fn data(&self, bytes: &[u8]) {
                self.0.lock().unwrap().extend_from_slice(bytes);
            }
            fn closed(&self, _: Option<String>) {}
        }
        let sink = Arc::new(Collect(Mutex::new(Vec::new())));
        let cmd = detect().into_iter().find(|s| s.id == "cmd").unwrap();
        let shell = open(&cmd, 80, 24, sink.clone()).unwrap();
        let start = std::time::Instant::now();
        let (mut answered, mut sent) = (0usize, false);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let text = String::from_utf8_lossy(&sink.0.lock().unwrap()).into_owned();
            let asks = text.matches("\x1b[6n").count();
            while answered < asks {
                shell.write(b"\x1b[1;1R").unwrap();
                answered += 1;
            }
            if !sent && (!text.is_empty() || start.elapsed().as_secs() > 3) {
                shell.write(b"echo termoria-ok\r").unwrap();
                sent = true;
            }
            if text.matches("termoria-ok").count() >= 2 {
                break; // la commande tapée, puis son résultat
            }
            assert!(start.elapsed().as_secs() < 15, "pas de réponse du shell ; reçu : {text:?}");
        }
        shell.resize(100, 30).unwrap();
        shell.close();
    }
}

#[cfg(all(test, windows))]
mod debit {
    use super::*;
    use std::sync::Mutex;

    /// Débit de la console Windows seule (sans interface) :
    /// TERMORIA_BENCH_FILE=chemin cargo test --lib debit_console -- --ignored --nocapture
    #[test]
    #[ignore = "mesure à la demande"]
    fn debit_console() {
        let Ok(file) = std::env::var("TERMORIA_BENCH_FILE") else { return };
        struct Count(Mutex<(usize, usize, Vec<u8>)>);
        impl Sink for Count {
            fn data(&self, bytes: &[u8]) {
                let mut g = self.0.lock().unwrap();
                g.0 += bytes.len();
                g.1 += 1;
                g.2.extend_from_slice(bytes);
                let len = g.2.len();
                if len > 4096 {
                    g.2.drain(..len - 4096);
                }
            }
            fn closed(&self, _: Option<String>) {}
        }
        let sink = Arc::new(Count(Mutex::new((0, 0, Vec::new()))));
        let cmd = detect().into_iter().find(|s| s.id == "cmd").unwrap();
        let shell = open(&cmd, 120, 40, sink.clone()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(800));
        shell.write(b"\x1b[1;1R").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        sink.0.lock().unwrap().0 = 0;
        let start = std::time::Instant::now();
        // Commande mesurée : `type` par défaut, ou TERMORIA_BENCH_CMD ({file} remplacé).
        let command = std::env::var("TERMORIA_BENCH_CMD")
            .map(|c| c.replace("{file}", &file))
            .unwrap_or_else(|_| format!("type \"{file}\""));
        shell.write(format!("{command}\r").as_bytes()).unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let g = sink.0.lock().unwrap();
            if String::from_utf8_lossy(&g.2).contains("FIN-BENCH") {
                let s = start.elapsed().as_secs_f64();
                println!("console seule : {:.1} Mo en {s:.1} s = {:.1} Mo/s, {} lectures de {} octets en moyenne", g.0 as f64 / 1e6, g.0 as f64 / 1e6 / s, g.1, g.0 / g.1.max(1));
                break;
            }
            assert!(start.elapsed().as_secs() < 300, "trop long");
        }
        shell.close();
    }
}
