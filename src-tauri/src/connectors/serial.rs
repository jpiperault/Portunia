//! Port série (COM) : microcontrôleurs, consoles de switchs et de routeurs.

use std::{
    io::{ErrorKind, Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};

use crate::connector::*;

pub struct SerialConnector;

impl Connector for SerialConnector {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: "serial".into(),
            name: "Port série".into(),
            version: "0.1.0".into(),
            description: "Ports COM : microcontrôleurs, consoles de switchs et de routeurs.".into(),
            view: ViewKind::Terminal,
            builtin: true,
            file_browser: false,
            port_forwarding: false,
            fields: vec![
                Field::new("port", "Port", FieldKind::Suggest { source: "serial-ports".into() })
                    .required()
                    .placeholder("COM3"),
                Field::new(
                    "baud",
                    "Vitesse (bauds)",
                    choice(&[
                        ("9600", "9600"),
                        ("19200", "19200"),
                        ("38400", "38400"),
                        ("57600", "57600"),
                        ("115200", "115200"),
                        ("230400", "230400"),
                    ]),
                )
                .default("115200"),
                Field::new("dataBits", "Bits de données", choice(&[("8", "8"), ("7", "7")])).default("8"),
                Field::new(
                    "parity",
                    "Parité",
                    choice(&[("none", "Aucune"), ("even", "Paire"), ("odd", "Impaire")]),
                )
                .default("none"),
                Field::new("stopBits", "Bits d'arrêt", choice(&[("1", "1"), ("2", "2")])).default("1"),
                Field::new(
                    "flow",
                    "Contrôle de flux",
                    choice(&[("none", "Aucun"), ("software", "XON/XOFF"), ("hardware", "RTS/CTS")]),
                )
                .default("none"),
                Field::new(
                    "enter",
                    "Touche Entrée envoie",
                    choice(&[("cr", "CR"), ("crlf", "CR LF"), ("lf", "LF")]),
                )
                .default("cr"),
            ],
        }
    }

    fn suggestions(&self, source: &str) -> Vec<ChoiceOption> {
        if source != "serial-ports" {
            return Vec::new();
        }
        serialport::available_ports()
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                let detail = match &p.port_type {
                    SerialPortType::UsbPort(usb) => usb
                        .product
                        .clone()
                        .or_else(|| usb.manufacturer.clone())
                        .unwrap_or_else(|| "USB".into()),
                    SerialPortType::BluetoothPort => "Bluetooth".into(),
                    _ => String::new(),
                };
                ChoiceOption {
                    label: if detail.is_empty() { p.port_name.clone() } else { format!("{} — {detail}", p.port_name) },
                    value: p.port_name,
                }
            })
            .collect()
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let name = ctx.require("port", "Port")?.to_uppercase();
        let baud: u32 = ctx
            .str("baud")
            .unwrap_or_else(|| "115200".into())
            .parse()
            .map_err(|_| anyhow!("Vitesse invalide"))?;
        let data_bits = if ctx.str("dataBits").as_deref() == Some("7") { DataBits::Seven } else { DataBits::Eight };
        let parity = match ctx.str("parity").as_deref() {
            Some("even") => Parity::Even,
            Some("odd") => Parity::Odd,
            _ => Parity::None,
        };
        let stop_bits = if ctx.str("stopBits").as_deref() == Some("2") { StopBits::Two } else { StopBits::One };
        let flow = match ctx.str("flow").as_deref() {
            Some("software") => FlowControl::Software,
            Some("hardware") => FlowControl::Hardware,
            _ => FlowControl::None,
        };
        let enter: &'static [u8] = match ctx.str("enter").as_deref() {
            Some("crlf") => b"\r\n",
            Some("lf") => b"\n",
            _ => b"\r",
        };

        let port = serialport::new(&name, baud)
            .data_bits(data_bits)
            .parity(parity)
            .stop_bits(stop_bits)
            .flow_control(flow)
            .timeout(Duration::from_millis(50))
            .open()
            .with_context(|| format!("Impossible d'ouvrir {name} (déjà utilisé par un autre programme ?)"))?;
        let mut reader = port.try_clone()?;
        let writer = Arc::new(Mutex::new(port));
        let (connection, rx) = WorkerConnection::new();

        ctx.sink.data(format!("\x1b[90m[Termoria] {name} ouvert à {baud} bauds\x1b[0m\r\n").as_bytes());

        let sink = ctx.sink.clone();
        let stop = Arc::new(Mutex::new(false));
        let reader_stop = stop.clone();
        thread::Builder::new().name(format!("serial-r-{name}")).spawn(move || {
            let mut buf = [0u8; 4096];
            let reason = loop {
                if *reader_stop.lock().unwrap() {
                    break None;
                }
                match reader.read(&mut buf) {
                    Ok(0) => continue,
                    Ok(n) => sink.data(&buf[..n]),
                    Err(e) if e.kind() == ErrorKind::TimedOut => continue,
                    // Câble USB débranché, par exemple.
                    Err(e) => break Some(format!("{e}")),
                }
            };
            sink.closed(reason);
        })?;

        thread::Builder::new().name(format!("serial-w-{name}")).spawn(move || {
            for cmd in rx {
                match cmd {
                    Cmd::Write(data) => {
                        let mut out = Vec::with_capacity(data.len() + 1);
                        for &b in &data {
                            if b == b'\r' { out.extend_from_slice(enter) } else { out.push(b) }
                        }
                        let _ = writer.lock().unwrap().write_all(&out);
                    }
                    Cmd::Resize(..) => {}
                    Cmd::Close => break,
                }
            }
            *stop.lock().unwrap() = true;
        })?;

        Ok(Outcome::Terminal(Box::new(connection)))
    }
}
