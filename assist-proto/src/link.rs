//! Liaison de bout en bout au-dessus du chiffrement : accusés de réception, débit et reprise.
//!
//! - **Accusés** : chacun dit régulièrement combien de messages il a ouverts
//!   (`{"type":"recu","n":…}`, message de contrôle chiffré).
//! - **Débit** : l'image ne part que si ce qui n'est pas encore reçu de l'autre côté tient dans
//!   une fenêtre (un quart de seconde au débit mesuré). Réseau lent : l'envoi attend, les
//!   changements de l'écran s'accumulent et seule l'image la plus récente part ensuite.
//! - **Reprise** : les messages non reçus sont gardés ; après une coupure, chacun dit au relais
//!   combien il en a ouverts, et l'autre renvoie la suite, chiffrée à l'identique. Le flux RDP
//!   continue comme si de rien n'était.

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use crate::{Error, Kind, Opener, Sealer};

const MIN_WINDOW: usize = 256 * 1024;
const MAX_WINDOW: usize = 8 * 1024 * 1024;
const START_WINDOW: usize = 512 * 1024;
/// Au-delà, la reprise n'est plus possible (l'autre côté ne répond plus aux accusés).
const MAX_KEPT: usize = 32 * 1024 * 1024;

pub struct Link {
    sealer: Sealer,
    opener: Opener,
    /// Messages chiffrés envoyés (= prochain compteur).
    sent: u64,
    /// Messages ouverts.
    opened: u64,
    /// Messages envoyés pas encore reçus de l'autre côté : (numéro, heure d'envoi, message).
    kept: VecDeque<(u64, Instant, Vec<u8>)>,
    kept_bytes: usize,
    /// Accusés envoyés jusqu'à ce nombre ; un message autre qu'un accusé reçu depuis ?
    acked_upto: u64,
    ack_due: bool,
    last_ack: Instant,
    /// Débit mesuré par les accusés : octets reçus de l'autre côté, par fenêtres d'une seconde.
    rate_since: Instant,
    rate_bytes: usize,
    rate: usize,
    rtt: Option<Duration>,
    /// L'autre côté envoie-t-il des accusés ? Sinon, ni attente ni reprise (ancienne version).
    pub flow: bool,
}

/// Message d'accusé (contrôle).
pub fn ack_payload(n: u64) -> Vec<u8> {
    format!(r#"{{"type":"recu","n":{n}}}"#).into_bytes()
}

impl Link {
    pub fn new(sealer: Sealer, opener: Opener) -> Self {
        Self {
            sealer,
            opener,
            sent: 0,
            opened: 0,
            kept: VecDeque::new(),
            kept_bytes: 0,
            acked_upto: 0,
            ack_due: false,
            last_ack: Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now),
            rate_since: Instant::now(),
            rate_bytes: 0,
            rate: 0,
            rtt: None,
            flow: false,
        }
    }

    /// Chiffre un message ; il est gardé jusqu'à son accusé.
    pub fn seal(&mut self, kind: Kind, payload: &[u8]) -> Vec<u8> {
        let frame = self.sealer.seal(kind, payload);
        if self.flow && self.kept_bytes + frame.len() <= MAX_KEPT {
            self.kept_bytes += frame.len();
            self.kept.push_back((self.sent, Instant::now(), frame.clone()));
        } else if self.flow {
            // Plus de reprise possible : on cesse de garder.
            self.kept.clear();
            self.kept_bytes = 0;
            self.flow = false;
        }
        self.sent += 1;
        frame
    }

    /// Ouvre un message reçu. `is_ack` : ce n'est qu'un accusé (il n'en appelle pas d'autre).
    pub fn open(&mut self, frame: &[u8]) -> Result<(Kind, Vec<u8>), Error> {
        let (kind, payload) = self.opener.open(frame)?;
        self.opened += 1;
        let is_ack = kind == Kind::Control && payload.starts_with(br#"{"type":"recu""#);
        if !is_ack {
            self.ack_due = true;
        }
        Ok((kind, payload))
    }

    /// L'autre côté a ouvert `n` messages : ceux-là ne sont plus gardés.
    pub fn acked(&mut self, n: u64) {
        self.flow = true;
        let now = Instant::now();
        while let Some((i, at, f)) = self.kept.front() {
            if *i >= n {
                break;
            }
            if *i + 1 == n {
                self.rtt = Some(now.duration_since(*at));
            }
            self.kept_bytes -= f.len();
            self.rate_bytes += f.len();
            self.kept.pop_front();
        }
        let elapsed = now.duration_since(self.rate_since);
        if elapsed >= Duration::from_millis(500) {
            let measured = (self.rate_bytes as f64 / elapsed.as_secs_f64()) as usize;
            // Moyenne glissante, pour ne pas suivre chaque à-coup.
            self.rate = if self.rate == 0 { measured } else { (self.rate * 3 + measured) / 4 };
            self.rate_since = now;
            self.rate_bytes = 0;
        }
    }

    /// Accusé à envoyer maintenant ? À appeler après chaque message reçu et à intervalle
    /// régulier : un accusé part au plus toutes les 15 ms (le temps d'aller-retour mesuré reste juste).
    pub fn take_ack(&mut self) -> Option<Vec<u8>> {
        if !self.ack_due || self.opened == self.acked_upto || self.last_ack.elapsed() < Duration::from_millis(15) {
            return None;
        }
        self.last_ack = Instant::now();
        self.ack_due = false;
        self.acked_upto = self.opened;
        Some(self.seal(Kind::Control, &ack_payload(self.opened)))
    }

    /// Octets envoyés et pas encore reçus de l'autre côté.
    pub fn in_flight(&self) -> usize {
        self.kept_bytes
    }

    /// Ce qu'on peut avoir en route : un quart de seconde au débit mesuré.
    pub fn window(&self) -> usize {
        if self.rate == 0 {
            START_WINDOW
        } else {
            (self.rate / 4).clamp(MIN_WINDOW, MAX_WINDOW)
        }
    }

    /// Faut-il attendre avant d'envoyer de l'image ?
    pub fn congested(&self) -> bool {
        self.flow && self.kept_bytes >= self.window()
    }

    /// Temps d'aller-retour mesuré par le dernier accusé.
    pub fn rtt(&self) -> Option<Duration> {
        self.rtt
    }

    /// Messages ouverts (à donner à l'autre côté après une coupure).
    pub fn opened(&self) -> u64 {
        self.opened
    }

    /// Reprise : l'autre côté a ouvert `n` messages ; les suivants sont à renvoyer, dans l'ordre.
    /// `None` : ils ne sont plus gardés, la reprise est impossible.
    pub fn resend_from(&mut self, n: u64) -> Option<Vec<Vec<u8>>> {
        if n > self.sent {
            return None;
        }
        self.acked(n);
        match self.kept.front() {
            Some((i, _, _)) if *i != n => None,
            None if n != self.sent => None,
            _ => Some(self.kept.iter().map(|(_, _, f)| f.clone()).collect()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Code, Handshake, Role};

    fn links() -> (Link, Link) {
        let code = Code::parse("483216907").unwrap();
        let (a, ma) = Handshake::start(Role::Agent, &code);
        let (h, mh) = Handshake::start(Role::Helper, &code);
        let (pa, ca) = a.finish(&mh).unwrap();
        let (ph, ch) = h.finish(&ma).unwrap();
        let (sa, oa) = pa.confirm(&ch).unwrap();
        let (sh, oh) = ph.confirm(&ca).unwrap();
        (Link::new(sa, oa), Link::new(sh, oh))
    }

    #[test]
    fn accuses_et_reprise() {
        let (mut agent, mut helper) = links();
        agent.flow = true;
        let frames: Vec<_> = (0..5).map(|i| agent.seal(Kind::Data, &[i; 1000])).collect();
        assert_eq!(agent.in_flight(), frames.iter().map(Vec::len).sum::<usize>());
        // Le dépanneur en reçoit deux, puis la liaison est coupée.
        for f in &frames[..2] {
            helper.open(f).unwrap();
        }
        let ack = helper.take_ack().unwrap();
        assert!(helper.take_ack().is_none());
        let (kind, payload) = agent.open(&ack).unwrap();
        assert_eq!((kind, payload.as_slice()), (Kind::Control, br#"{"type":"recu","n":2}"#.as_slice()));
        agent.acked(2);
        // Un accusé n'appelle pas d'accusé.
        assert!(agent.take_ack().is_none());
        // Reprise : le dépanneur a ouvert 2 messages ; les 3 suivants reviennent, identiques.
        let again = agent.resend_from(helper.opened()).unwrap();
        assert_eq!(again, frames[2..].to_vec());
        for f in &again {
            assert_eq!(helper.open(f).unwrap().0, Kind::Data);
        }
        // Un numéro inconnu : reprise impossible.
        assert!(agent.resend_from(99).is_none());
    }

    #[test]
    fn fenetre() {
        let (mut agent, _) = links();
        assert!(!agent.congested());
        agent.flow = true;
        while !agent.congested() {
            agent.seal(Kind::Data, &[0; 16 * 1024]);
        }
        assert!(agent.in_flight() >= START_WINDOW);
        agent.acked(agent.sent);
        assert!(!agent.congested());
    }
}
