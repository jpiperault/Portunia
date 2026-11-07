//! Transfert de fichiers dans l'assistance, dans les deux sens, par la liaison chiffrée.
//!
//! - Celui qui envoie **propose** le fichier (`fichier_offre` : numéro, nom, taille) ; l'autre
//!   accepte ou refuse (`fichier_reponse`). La personne aidée décide de chaque fichier reçu ; le
//!   dépanneur accepte d'office ce qu'elle choisit de lui envoyer.
//! - Le contenu part en morceaux (messages de sorte `Kind::File` : numéro sur 4 octets, puis les
//!   octets), seulement quand l'image ne manque pas de place (voir [`crate::Link`]). La liaison
//!   garde l'ordre et reprend après une coupure : pas de position à transmettre.
//! - À la fin, l'empreinte SHA-256 (`fichier_fin`) : un fichier abîmé est effacé, jamais rangé.
//!   Le destinataire confirme (`fichier_recu`). Chacun peut annuler (`fichier_annule`).
//! - Numéros : impairs pour la personne aidée, pairs pour le dépanneur (pas de collision).
//!
//! Le fichier arrive sous un nom provisoire (`.portunia-partiel`), puis prend un nom libre dans
//! le dossier d'arrivée (« nom (2).pdf »), avec la marque « venu d'Internet » de Windows.

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::Role;

/// Taille d'un morceau de fichier.
pub const CHUNK: usize = 60 * 1024;
/// Taille maximale d'un fichier dans l'offre gratuite.
pub const FREE_LIMIT: u64 = 100 * 1024 * 1024;
/// Temps laissé pour accepter un fichier.
pub const ANSWER_FOR: Duration = Duration::from_secs(60);
/// Demandes en attente au plus (contre un envoi en rafale).
const MAX_ASKING: usize = 5;
/// Progression montrée au plus à ce rythme.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);
const PART: &str = ".portunia-partiel";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    /// Reçu : en attente de la décision de ce côté.
    Asking,
    /// Envoyé : en attente de la décision de l'autre côté.
    Waiting,
    Refused,
    /// En cours (envoi ou réception).
    Active,
    Done,
    Canceled,
    Failed,
}

impl State {
    pub fn id(self) -> &'static str {
        match self {
            State::Asking => "demande",
            State::Waiting => "attente",
            State::Refused => "refuse",
            State::Active => "en_cours",
            State::Done => "termine",
            State::Canceled => "annule",
            State::Failed => "echec",
        }
    }
    pub fn finished(self) -> bool {
        matches!(self, State::Refused | State::Done | State::Canceled | State::Failed)
    }
}

/// Pourquoi un transfert n'a pas abouti.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Problem {
    /// Plus gros que la limite de l'offre.
    TooBig,
    /// Trop de demandes en attente.
    Busy,
    /// Lecture ou écriture du fichier impossible.
    Disk,
    /// Empreinte ou taille fausse.
    Corrupt,
    /// Personne n'a répondu à temps.
    Timeout,
}

impl Problem {
    pub fn id(self) -> &'static str {
        match self {
            Problem::TooBig => "trop_gros",
            Problem::Busy => "trop_de_demandes",
            Problem::Disk => "disque",
            Problem::Corrupt => "abime",
            Problem::Timeout => "sans_reponse",
        }
    }
    fn from_id(s: &str) -> Option<Self> {
        Some(match s {
            "trop_gros" => Problem::TooBig,
            "trop_de_demandes" => Problem::Busy,
            "disque" => Problem::Disk,
            "abime" => Problem::Corrupt,
            "sans_reponse" => Problem::Timeout,
            _ => return None,
        })
    }
}

/// Ce que l'interface montre d'un fichier.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub done: u64,
    /// Reçu (true) ou envoyé (false).
    pub incoming: bool,
    pub state: State,
    pub problem: Option<Problem>,
    /// Programme ou script (mise en garde).
    pub program: bool,
    /// Où il est rangé, une fois reçu.
    pub path: Option<PathBuf>,
    /// Demande reçue à cette heure (pour le refus automatique).
    pub asked: Instant,
}

impl Snapshot {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "nom": self.name,
            "taille": self.size,
            "fait": self.done,
            "recu": self.incoming,
            "etat": self.state.id(),
            "probleme": self.problem.map(Problem::id),
            "programme": self.program,
        })
    }
}

struct Entry {
    snap: Snapshot,
    file: Option<File>,
    hasher: Sha256,
    /// Envoi : chemin lu. Réception : fichier provisoire.
    local: PathBuf,
    /// Envoi : empreinte envoyée, en attente de la confirmation.
    fin_sent: bool,
    last_emit: Instant,
}

/// Morceau à envoyer.
pub enum Outgoing {
    /// Contenu (message `Kind::File`).
    Data(Vec<u8>),
    /// Message de contrôle.
    Control(Value),
}

/// Les fichiers d'une session.
pub struct Transfers {
    next_id: u32,
    mine_odd: bool,
    limit: Option<u64>,
    dir: PathBuf,
    auto_accept: bool,
    entries: Vec<Entry>,
    changed: Vec<u32>,
}

/// Extensions de programmes et de scripts.
const PROGRAMS: [&str; 22] = [
    "exe", "msi", "msix", "msp", "bat", "cmd", "com", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "lnk", "hta", "cpl", "reg", "jar", "appx",
];

pub fn is_program(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, e)| PROGRAMS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Nom sûr pour Windows : sans chemin ni caractère interdit, pas un nom réservé.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut s: String = base.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).collect();
    while s.ends_with(['.', ' ']) {
        s.pop();
    }
    let s = s.trim_start().to_string();
    let mut s: String = s.chars().take(180).collect();
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.insert(0, '_');
    }
    if s.is_empty() || s.starts_with('.') && s.len() == 1 {
        "fichier".into()
    } else {
        s
    }
}

/// Premier nom libre dans `dir` : « nom.ext », puis « nom (2).ext »…
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..10_000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Marque « venu d'Internet » : Windows SmartScreen vérifie le fichier à l'ouverture.
fn mark_of_the_web(path: &Path) {
    #[cfg(windows)]
    {
        let mut ads = path.as_os_str().to_owned();
        ads.push(":Zone.Identifier");
        let _ = std::fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(not(windows))]
    let _ = path;
}

impl Transfers {
    /// `dir` : dossier d'arrivée (créé au premier fichier). `limit` : taille maximale d'un
    /// fichier (`None` : sans limite). `auto_accept` : les fichiers reçus sont acceptés d'office.
    pub fn new(role: Role, dir: PathBuf, limit: Option<u64>, auto_accept: bool) -> Self {
        let mine_odd = role == Role::Agent;
        Self { next_id: if mine_odd { 1 } else { 2 }, mine_odd, limit, dir, auto_accept, entries: Vec::new(), changed: Vec::new() }
    }

    pub fn limit(&self) -> Option<u64> {
        self.limit
    }

    pub fn set_limit(&mut self, limit: Option<u64>) {
        self.limit = limit;
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn mine(&self, id: u32) -> bool {
        (id % 2 == 1) == self.mine_odd
    }

    fn get(&mut self, id: u32) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.snap.id == id)
    }

    fn touch(&mut self, id: u32) {
        if !self.changed.contains(&id) {
            self.changed.push(id);
        }
    }

    fn set_state(&mut self, id: u32, state: State, problem: Option<Problem>) {
        let mut cleanup = None;
        if let Some(e) = self.get(id) {
            e.snap.state = state;
            if problem.is_some() {
                e.snap.problem = problem;
            }
            if state.finished() {
                e.file = None;
                // Réception inachevée : le fichier provisoire est effacé.
                if e.snap.incoming && state != State::Done {
                    cleanup = Some(e.local.clone());
                }
            }
        }
        if let Some(p) = cleanup {
            let _ = std::fs::remove_file(p);
        }
        self.touch(id);
    }

    /// Propose un fichier à l'autre côté. Erreur : il n'est pas lisible ou trop gros (il figure
    /// quand même dans la liste, refusé, pour que l'interface le dise).
    pub fn offer(&mut self, path: &Path) -> Result<Value, Problem> {
        let name = safe_name(&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let meta = std::fs::metadata(path).ok().filter(|m| m.is_file());
        let size = meta.as_ref().map_or(0, |m| m.len());
        let problem = match &meta {
            None => Some(Problem::Disk),
            Some(m) if self.limit.is_some_and(|l| m.len() > l) => Some(Problem::TooBig),
            _ => None,
        };
        let id = self.next_id;
        self.next_id += 2;
        let snap = Snapshot {
            id,
            name: name.clone(),
            size,
            done: 0,
            incoming: false,
            state: match problem {
                Some(Problem::TooBig) => State::Refused,
                Some(_) => State::Failed,
                None => State::Waiting,
            },
            problem,
            program: is_program(&name),
            path: Some(path.to_path_buf()),
            asked: Instant::now(),
        };
        self.entries.push(Entry { snap, file: None, hasher: Sha256::new(), local: path.to_path_buf(), fin_sent: false, last_emit: Instant::now() });
        self.touch(id);
        match problem {
            Some(p) => Err(p),
            None => Ok(json!({ "type": "fichier_offre", "id": id, "nom": name, "taille": size })),
        }
    }

    /// Décision de ce côté sur un fichier proposé.
    pub fn answer(&mut self, id: u32, accept: bool) -> Option<Value> {
        let e = self.entries.iter().find(|e| e.snap.id == id && e.snap.incoming && e.snap.state == State::Asking)?;
        let name = e.snap.name.clone();
        if !accept {
            self.set_state(id, State::Refused, None);
            return Some(json!({ "type": "fichier_reponse", "id": id, "accepte": false }));
        }
        let opened = std::fs::create_dir_all(&self.dir).and_then(|_| {
            let part = free_path(&self.dir, &format!("{name}{PART}"));
            File::create(&part).map(|f| (part, f))
        });
        match opened {
            Ok((part, file)) => {
                let e = self.get(id)?;
                e.local = part;
                e.file = Some(file);
                self.set_state(id, State::Active, None);
                Some(json!({ "type": "fichier_reponse", "id": id, "accepte": true }))
            }
            Err(_) => {
                self.set_state(id, State::Failed, Some(Problem::Disk));
                Some(json!({ "type": "fichier_reponse", "id": id, "accepte": false, "raison": Problem::Disk.id() }))
            }
        }
    }

    /// Annule un transfert de ce côté ; message à envoyer.
    pub fn cancel(&mut self, id: u32) -> Option<Value> {
        let e = self.entries.iter().find(|e| e.snap.id == id && !e.snap.state.finished())?;
        if e.snap.incoming && e.snap.state == State::Asking {
            return self.answer(id, false);
        }
        self.set_state(id, State::Canceled, None);
        Some(json!({ "type": "fichier_annule", "id": id }))
    }

    /// Fin de session : tout ce qui n'est pas fini est annulé, les fichiers provisoires effacés.
    pub fn close(&mut self) {
        let open: Vec<u32> = self.entries.iter().filter(|e| !e.snap.state.finished()).map(|e| e.snap.id).collect();
        for id in open {
            self.set_state(id, State::Canceled, None);
        }
    }

    /// Message de contrôle reçu (`fichier_…`) ; réponse éventuelle à envoyer.
    pub fn on_control(&mut self, v: &Value) -> Option<Value> {
        let id = v["id"].as_u64().and_then(|i| u32::try_from(i).ok())?;
        match v["type"].as_str()? {
            "fichier_offre" => {
                if self.mine(id) || self.entries.iter().any(|e| e.snap.id == id) {
                    return None;
                }
                let name = safe_name(v["nom"].as_str().unwrap_or_default());
                let size = v["taille"].as_u64().unwrap_or(0);
                let snap = Snapshot {
                    id,
                    program: is_program(&name),
                    name,
                    size,
                    done: 0,
                    incoming: true,
                    state: State::Asking,
                    problem: None,
                    path: None,
                    asked: Instant::now(),
                };
                let asking = self.entries.iter().filter(|e| e.snap.state == State::Asking).count();
                self.entries.push(Entry { snap, file: None, hasher: Sha256::new(), local: PathBuf::new(), fin_sent: false, last_emit: Instant::now() });
                self.touch(id);
                let refuse = if self.limit.is_some_and(|l| size > l) {
                    Some(Problem::TooBig)
                } else if asking >= MAX_ASKING {
                    Some(Problem::Busy)
                } else {
                    None
                };
                if let Some(p) = refuse {
                    self.set_state(id, State::Refused, Some(p));
                    return Some(json!({ "type": "fichier_reponse", "id": id, "accepte": false, "raison": p.id() }));
                }
                if self.auto_accept {
                    return self.answer(id, true);
                }
                None
            }
            "fichier_reponse" => {
                let e = self.entries.iter().find(|e| e.snap.id == id && !e.snap.incoming && e.snap.state == State::Waiting)?;
                if v["accepte"].as_bool() != Some(true) {
                    let problem = v["raison"].as_str().and_then(Problem::from_id);
                    self.set_state(id, State::Refused, problem);
                    return None;
                }
                match File::open(&e.local) {
                    Ok(f) => {
                        let e = self.get(id)?;
                        e.file = Some(f);
                        self.set_state(id, State::Active, None);
                        None
                    }
                    Err(_) => {
                        self.set_state(id, State::Failed, Some(Problem::Disk));
                        Some(json!({ "type": "fichier_annule", "id": id }))
                    }
                }
            }
            "fichier_fin" => {
                let e = self.get(id).filter(|e| e.snap.incoming && e.snap.state == State::Active)?;
                let sum = hex(&std::mem::take(&mut e.hasher).finalize());
                let ok = e.snap.done == e.snap.size && v["sha256"].as_str() == Some(sum.as_str());
                if let Some(f) = e.file.take() {
                    let _ = f.sync_all();
                }
                if !ok {
                    self.set_state(id, State::Failed, Some(Problem::Corrupt));
                    return Some(json!({ "type": "fichier_recu", "id": id, "ok": false }));
                }
                let (part, name) = (e.local.clone(), e.snap.name.clone());
                let target = free_path(&self.dir, &name);
                if std::fs::rename(&part, &target).is_err() {
                    self.set_state(id, State::Failed, Some(Problem::Disk));
                    return Some(json!({ "type": "fichier_recu", "id": id, "ok": false }));
                }
                mark_of_the_web(&target);
                if let Some(e) = self.get(id) {
                    e.local = target.clone();
                    e.snap.name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name);
                    e.snap.path = Some(target);
                }
                self.set_state(id, State::Done, None);
                Some(json!({ "type": "fichier_recu", "id": id, "ok": true }))
            }
            "fichier_recu" => {
                self.entries.iter().find(|e| e.snap.id == id && !e.snap.incoming && e.fin_sent && e.snap.state == State::Active)?;
                if v["ok"].as_bool() == Some(true) {
                    self.set_state(id, State::Done, None);
                } else {
                    self.set_state(id, State::Failed, Some(Problem::Corrupt));
                }
                None
            }
            "fichier_annule" => {
                self.entries.iter().find(|e| e.snap.id == id && !e.snap.state.finished())?;
                self.set_state(id, State::Canceled, None);
                None
            }
            _ => None,
        }
    }

    /// Morceau reçu (message `Kind::File`) ; message à envoyer si le fichier est refusé.
    pub fn on_data(&mut self, payload: &[u8]) -> Option<Value> {
        if payload.len() < 4 {
            return None;
        }
        let id = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
        let data = &payload[4..];
        // Morceaux encore en route après une annulation : ignorés.
        let e = self.get(id).filter(|e| e.snap.incoming && e.snap.state == State::Active)?;
        if e.snap.done + data.len() as u64 > e.snap.size {
            self.set_state(id, State::Failed, Some(Problem::Corrupt));
            return Some(json!({ "type": "fichier_annule", "id": id }));
        }
        let written = e.file.as_mut().map(|f| f.write_all(data));
        if !matches!(written, Some(Ok(()))) {
            self.set_state(id, State::Failed, Some(Problem::Disk));
            return Some(json!({ "type": "fichier_annule", "id": id }));
        }
        e.hasher.update(data);
        e.snap.done += data.len() as u64;
        if e.last_emit.elapsed() >= PROGRESS_EVERY {
            e.last_emit = Instant::now();
            self.touch(id);
        }
        None
    }

    /// Un envoi a-t-il quelque chose à faire partir ?
    pub fn sending(&self) -> bool {
        self.entries.iter().any(|e| !e.snap.incoming && e.snap.state == State::Active && !e.fin_sent)
    }

    /// Prochain morceau à envoyer (un fichier à la fois, dans l'ordre).
    pub fn next(&mut self) -> Option<Outgoing> {
        let i = self.entries.iter().position(|e| !e.snap.incoming && e.snap.state == State::Active && !e.fin_sent)?;
        let id = self.entries[i].snap.id;
        let e = &mut self.entries[i];
        if e.snap.done >= e.snap.size {
            e.fin_sent = true;
            let sum = hex(&std::mem::take(&mut e.hasher).finalize());
            e.file = None;
            self.touch(id);
            return Some(Outgoing::Control(json!({ "type": "fichier_fin", "id": id, "sha256": sum })));
        }
        let want = CHUNK.min((e.snap.size - e.snap.done) as usize);
        let mut buf = vec![0u8; 4 + want];
        buf[..4].copy_from_slice(&id.to_be_bytes());
        let read = e.file.as_mut().map(|f| f.read(&mut buf[4..]));
        match read {
            Some(Ok(n)) if n > 0 => {
                buf.truncate(4 + n);
                e.hasher.update(&buf[4..]);
                e.snap.done += n as u64;
                if e.last_emit.elapsed() >= PROGRESS_EVERY || e.snap.done >= e.snap.size {
                    e.last_emit = Instant::now();
                    self.touch(id);
                }
                Some(Outgoing::Data(buf))
            }
            // Fichier raccourci ou illisible pendant l'envoi.
            _ => {
                self.set_state(id, State::Failed, Some(Problem::Disk));
                Some(Outgoing::Control(json!({ "type": "fichier_annule", "id": id })))
            }
        }
    }

    /// Refus automatique des demandes restées sans réponse ; messages à envoyer.
    pub fn expire(&mut self) -> Vec<Value> {
        let late: Vec<u32> = self.entries.iter().filter(|e| e.snap.state == State::Asking && e.snap.asked.elapsed() >= ANSWER_FOR).map(|e| e.snap.id).collect();
        late.into_iter()
            .filter_map(|id| {
                let m = self.answer(id, false);
                if let Some(e) = self.get(id) {
                    e.snap.problem = Some(Problem::Timeout);
                }
                m
            })
            .collect()
    }

    /// Fichiers changés depuis le dernier appel.
    pub fn take_changes(&mut self) -> Vec<Snapshot> {
        let ids = std::mem::take(&mut self.changed);
        ids.iter().filter_map(|id| self.entries.iter().find(|e| e.snap.id == *id).map(|e| e.snap.clone())).collect()
    }

    /// Tous les fichiers de la session, dans l'ordre.
    pub fn all(&self) -> Vec<Snapshot> {
        self.entries.iter().map(|e| e.snap.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("assist-transfert-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Fait passer tout ce que `from` envoie vers `to`, et les réponses en retour.
    fn pump(from: &mut Transfers, to: &mut Transfers) {
        while let Some(o) = from.next() {
            match o {
                Outgoing::Data(d) => assert!(to.on_data(&d).is_none()),
                Outgoing::Control(c) => {
                    if let Some(r) = to.on_control(&c) {
                        from.on_control(&r);
                    }
                }
            }
        }
    }

    #[test]
    fn envoi_accepte() {
        let d = dir("ok");
        let src = d.join("source");
        std::fs::create_dir_all(&src).unwrap();
        let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(src.join("Notice imprimante.pdf"), &content).unwrap();
        // Un fichier du même nom existe déjà : le reçu prend « (2) ».
        let arrive = d.join("arrivee");
        std::fs::create_dir_all(&arrive).unwrap();
        std::fs::write(arrive.join("Notice imprimante.pdf"), b"ancien").unwrap();
        let mut helper = Transfers::new(Role::Helper, d.join("inutile"), None, true);
        let mut agent = Transfers::new(Role::Agent, arrive.clone(), Some(FREE_LIMIT), false);
        let offer = helper.offer(&src.join("Notice imprimante.pdf")).unwrap();
        assert!(agent.on_control(&offer).is_none());
        let asked = agent.take_changes();
        assert_eq!((asked[0].state, asked[0].incoming, asked[0].size), (State::Asking, true, 200_000));
        let reply = agent.answer(asked[0].id, true).unwrap();
        helper.on_control(&reply);
        pump(&mut helper, &mut agent);
        let got = agent.all();
        assert_eq!(got[0].state, State::Done);
        let path = got[0].path.clone().unwrap();
        assert_eq!(path.file_name().unwrap(), "Notice imprimante (2).pdf");
        assert_eq!(std::fs::read(&path).unwrap(), content);
        assert_eq!(helper.all()[0].state, State::Done);
        // Aucun fichier provisoire ne reste.
        assert!(std::fs::read_dir(&arrive).unwrap().all(|f| !f.unwrap().file_name().to_string_lossy().ends_with(PART)));
    }

    #[test]
    fn refus_limite_et_abime() {
        let d = dir("refus");
        std::fs::write(d.join("gros.iso"), vec![0u8; 3000]).unwrap();
        std::fs::write(d.join("petit.txt"), b"bonjour").unwrap();
        // L'envoyeur connaît la limite : refus avant tout envoi.
        let mut agent = Transfers::new(Role::Agent, d.join("a"), Some(1000), false);
        assert_eq!(agent.offer(&d.join("gros.iso")).unwrap_err(), Problem::TooBig);
        // Le destinataire aussi : refus automatique, avec la raison.
        let mut helper = Transfers::new(Role::Helper, d.join("h"), None, true);
        let offer = helper.offer(&d.join("gros.iso")).unwrap();
        let reply = agent.on_control(&offer).unwrap();
        helper.on_control(&reply);
        assert_eq!((helper.all()[0].state, helper.all()[0].problem), (State::Refused, Some(Problem::TooBig)));
        // Empreinte fausse : fichier effacé.
        let offer = helper.offer(&d.join("petit.txt")).unwrap();
        agent.on_control(&offer);
        let id = offer["id"].as_u64().unwrap() as u32;
        helper.on_control(&agent.answer(id, true).unwrap());
        let Some(Outgoing::Data(data)) = helper.next() else { panic!() };
        agent.on_data(&data);
        let r = agent.on_control(&json!({ "type": "fichier_fin", "id": id, "sha256": "00" })).unwrap();
        assert_eq!(r["ok"], false);
        let last = agent.all().pop().unwrap();
        assert_eq!((last.state, last.problem), (State::Failed, Some(Problem::Corrupt)));
        assert!(std::fs::read_dir(d.join("a")).unwrap().next().is_none());
    }

    #[test]
    fn annulation_et_numeros() {
        let d = dir("annule");
        std::fs::write(d.join("f.bin"), vec![1u8; CHUNK * 3]).unwrap();
        let mut helper = Transfers::new(Role::Helper, d.join("h"), None, true);
        let mut agent = Transfers::new(Role::Agent, d.join("a"), None, false);
        let offer = helper.offer(&d.join("f.bin")).unwrap();
        // Un programme de la personne ne peut pas se faire passer pour une offre du dépanneur.
        assert!(helper.on_control(&offer).is_none());
        agent.on_control(&offer);
        let id = offer["id"].as_u64().unwrap() as u32;
        helper.on_control(&agent.answer(id, true).unwrap());
        let Some(Outgoing::Data(data)) = helper.next() else { panic!() };
        agent.on_data(&data);
        let cancel = agent.cancel(id).unwrap();
        helper.on_control(&cancel);
        assert_eq!(helper.all()[0].state, State::Canceled);
        assert!(helper.next().is_none());
        // Morceau encore en route : ignoré, et rien ne reste sur le disque.
        assert!(agent.on_data(&data).is_none());
        assert!(std::fs::read_dir(d.join("a")).unwrap().next().is_none());
    }

    #[test]
    fn noms() {
        assert_eq!(safe_name("..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("a<b>:c?.txt. "), "abc.txt");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_name("com1"), "_com1");
        assert_eq!(safe_name(""), "fichier");
        assert!(is_program("Pilote.EXE") && is_program("x.ps1") && !is_program("notice.pdf"));
    }
}
