use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};

use crate::connector::*;

pub struct TelnetConnector;

impl Connector for TelnetConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "telnet".into(),
            name: "Telnet".into(),
            version: "0.1.0".into(),
            description: t!("Older network equipment. Unencrypted: keep it to the local network.", "Équipements réseau anciens. Non chiffré : à réserver au réseau local.").into(),
            view: ViewKind::Terminal,
            builtin: true,
            catalog: false,
            file_browser: false,
            port_forwarding: false,
            fields: vec![
                Field::new("host", t!("Host", "Hôte"), FieldKind::Text).required(),
                Field::new("port", "Port", FieldKind::Number).default(23),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let host = ctx.require("host", t!("Host", "Hôte"))?;
        let port = ctx.port(23)?;
        let addr = (host.as_str(), port)
            .to_socket_addrs()
            .with_context(|| format!("Hôte introuvable : {host}"))?
            .next()
            .ok_or_else(|| anyhow!("{}", t!(format!("Host not found: {host}"), format!("Hôte introuvable : {host}"))))?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
            .with_context(|| format!("Connexion impossible à {host}:{port}"))?;
        stream.set_nodelay(true)?;

        let mut reader = stream.try_clone()?;
        let writer = Arc::new(Mutex::new(stream));
        let window = Arc::new(Mutex::new(Window {
            naws: false,
            cols: ctx.cols,
            rows: ctx.rows,
        }));
        let (connection, rx) = WorkerConnection::new();

        // Lecture : décode le protocole et répond aux négociations d'options.
        let sink = ctx.sink.clone();
        let (w, win) = (writer.clone(), window.clone());
        thread::Builder::new().name(format!("telnet-r-{host}")).spawn(move || {
            let mut parser = Parser::default();
            let mut buf = [0u8; 8192];
            let reason = loop {
                match reader.read(&mut buf) {
                    Ok(0) => break None,
                    Ok(n) => {
                        let (data, reply) = parser.feed(&buf[..n], &win);
                        if !reply.is_empty() {
                            let _ = w.lock().unwrap().write_all(&reply);
                        }
                        if !data.is_empty() {
                            sink.data(&data);
                        }
                    }
                    Err(e) => break Some(e.to_string()),
                }
            };
            sink.closed(reason);
        })?;

        // Écriture : saisie clavier et changements de taille.
        thread::Builder::new().name(format!("telnet-w-{host}")).spawn(move || {
            for cmd in rx {
                match cmd {
                    Cmd::Write(data) => {
                        let _ = writer.lock().unwrap().write_all(&encode_input(&data));
                    }
                    Cmd::Resize(cols, rows) => {
                        let mut win = window.lock().unwrap();
                        win.cols = cols;
                        win.rows = rows;
                        if win.naws {
                            let _ = writer.lock().unwrap().write_all(&naws(cols, rows));
                        }
                    }
                    Cmd::Close => break,
                }
            }
            let _ = writer.lock().unwrap().shutdown(Shutdown::Both);
        })?;

        Ok(Outcome::Terminal(Box::new(connection)))
    }
}

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

struct Window {
    naws: bool,
    cols: u16,
    rows: u16,
}

#[derive(Default)]
enum State {
    #[default]
    Data,
    Iac,
    Option(u8),
    Sub,
    SubIac,
}

#[derive(Default)]
struct Parser {
    state: State,
    sub: Vec<u8>,
}

impl Parser {
    /// Retourne (texte à afficher, réponse à envoyer au serveur).
    fn feed(&mut self, input: &[u8], window: &Mutex<Window>) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(input.len());
        let mut reply = Vec::new();
        for &b in input {
            self.state = match std::mem::take(&mut self.state) {
                State::Data if b == IAC => State::Iac,
                State::Data => {
                    data.push(b);
                    State::Data
                }
                State::Iac => match b {
                    IAC => {
                        data.push(IAC);
                        State::Data
                    }
                    DO | DONT | WILL | WONT => State::Option(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    _ => State::Data,
                },
                State::Option(cmd) => {
                    match (cmd, b) {
                        (WILL, ECHO | SGA) => reply.extend([IAC, DO, b]),
                        (WILL, _) => reply.extend([IAC, DONT, b]),
                        (DO, NAWS) => {
                            let mut win = window.lock().unwrap();
                            win.naws = true;
                            reply.extend([IAC, WILL, NAWS]);
                            reply.extend(naws(win.cols, win.rows));
                        }
                        (DO, SGA | TTYPE) => reply.extend([IAC, WILL, b]),
                        (DO, _) => reply.extend([IAC, WONT, b]),
                        _ => {}
                    }
                    State::Data
                }
                State::Sub if b == IAC => State::SubIac,
                State::Sub => {
                    self.sub.push(b);
                    State::Sub
                }
                State::SubIac => match b {
                    SE => {
                        // Le serveur demande le type de terminal.
                        if self.sub == [TTYPE, 1] {
                            reply.extend([IAC, SB, TTYPE, 0]);
                            reply.extend(b"XTERM-256COLOR");
                            reply.extend([IAC, SE]);
                        }
                        State::Data
                    }
                    IAC => {
                        self.sub.push(IAC);
                        State::Sub
                    }
                    _ => State::Data,
                },
            };
        }
        (data, reply)
    }
}

fn naws(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = vec![IAC, SB, NAWS];
    for byte in cols.to_be_bytes().into_iter().chain(rows.to_be_bytes()) {
        out.push(byte);
        if byte == IAC {
            out.push(IAC);
        }
    }
    out.extend([IAC, SE]);
    out
}

/// Double les octets 0xFF et transforme Entrée (CR) en CR LF.
fn encode_input(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 4);
    for &b in data {
        match b {
            IAC => out.extend([IAC, IAC]),
            b'\r' => out.extend(b"\r\n"),
            _ => out.push(b),
        }
    }
    out
}
