//! Portunia Assist : ce que partagent le programme de la personne aidée et Portunia.
//!
//! - **Code** à 9 chiffres, « 483 216 907 » : les 3 premiers (la « place ») sont donnés par le
//!   relais pour mettre les deux côtés en relation ; les 6 suivants sont le secret, tiré par la
//!   personne aidée (ou par Portunia pour un lien) et jamais envoyé au relais.
//! - **Échange de clés** SPAKE2 authentifié par le secret : chacun prouve qu'il connaît le code
//!   (message de confirmation), sans que le relais ni un tiers puisse le deviner hors ligne.
//!   Trois essais au plus côté personne aidée, qui change ensuite de code.
//! - **Chiffrement** ChaCha20-Poly1305, une clé par sens, nonce = compteur de messages.
//!   Chaque message porte une sorte : contrôle (JSON), données (flux RDP) ou morceau de fichier.

pub mod link;
pub mod transfer;
pub use link::Link;

use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("code invalide : 9 chiffres attendus")]
    BadCode,
    #[error("message d'échange de clés invalide")]
    BadMessage,
    #[error("le code ne correspond pas")]
    WrongCode,
    #[error("message chiffré altéré ou rejoué")]
    Tampered,
}

/// Code donné au dépanneur : place (3 chiffres) et secret (6 chiffres).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Code {
    pub nameplate: String,
    pub secret: String,
}

impl Code {
    /// Lit « 483 216 907 », « 483-216-907 » ou « 483216907 ».
    pub fn parse(text: &str) -> Result<Self, Error> {
        let digits: String = text.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
        if digits.len() != 9 || !digits.chars().all(|c| c.is_ascii_digit()) {
            return Err(Error::BadCode);
        }
        Ok(Self { nameplate: digits[..3].into(), secret: digits[3..].into() })
    }

    /// Nouveau secret pour une place donnée par le relais.
    pub fn new(nameplate: &str) -> Self {
        Self { nameplate: nameplate.into(), secret: format!("{:06}", rand::thread_rng().gen_range(0..1_000_000)) }
    }

    /// Forme lisible : « 483 216 907 ».
    pub fn display(&self) -> String {
        format!("{} {} {}", self.nameplate, &self.secret[..3], &self.secret[3..])
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// La personne aidée (Portunia Assist).
    Agent,
    /// Le dépanneur (Portunia).
    Helper,
}

impl Role {
    fn label(self) -> &'static [u8] {
        match self {
            Role::Agent => b"portunia-assistance/agent",
            Role::Helper => b"portunia-assistance/helper",
        }
    }
    fn other(self) -> Role {
        match self {
            Role::Agent => Role::Helper,
            Role::Helper => Role::Agent,
        }
    }
}

/// Début de l'échange : le message à envoyer à l'autre côté.
pub struct Handshake {
    role: Role,
    nameplate: String,
    state: spake2::Spake2<Ed25519Group>,
}

impl Handshake {
    pub fn start(role: Role, code: &Code) -> (Self, Vec<u8>) {
        let password = Password::new(format!("{}{}", code.nameplate, code.secret).as_bytes());
        let (a, b) = (Identity::new(Role::Agent.label()), Identity::new(Role::Helper.label()));
        let (state, msg) = match role {
            Role::Agent => Spake2::<Ed25519Group>::start_a(&password, &a, &b),
            Role::Helper => Spake2::<Ed25519Group>::start_b(&password, &a, &b),
        };
        (Self { role, nameplate: code.nameplate.clone(), state }, msg)
    }

    /// Message de l'autre côté reçu : clés de la session et message de confirmation à envoyer.
    pub fn finish(self, peer: &[u8]) -> Result<(Pending, Vec<u8>), Error> {
        let shared = self.state.finish(peer).map_err(|_| Error::BadMessage)?;
        let hk = Hkdf::<Sha256>::new(Some(self.nameplate.as_bytes()), &shared);
        let derive = |info: &[u8]| {
            let mut k = [0u8; 32];
            hk.expand(info, &mut k).expect("32 octets");
            k
        };
        let confirm = |role: Role| {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&derive(b"confirmation")).expect("clé HMAC");
            mac.update(role.label());
            mac.finalize().into_bytes().to_vec()
        };
        let mine = confirm(self.role);
        let expected = confirm(self.role.other());
        let key_for = |role: Role| derive(&[b"chiffrement/".as_slice(), role.label()].concat());
        let pending = Pending { expected, send: key_for(self.role), recv: key_for(self.role.other()) };
        Ok((pending, mine))
    }
}

/// Clés calculées, en attente de la confirmation de l'autre côté.
pub struct Pending {
    expected: Vec<u8>,
    send: [u8; 32],
    recv: [u8; 32],
}

impl Pending {
    /// Confirmation reçue : le canal chiffré, ou une erreur si l'autre n'a pas le même code.
    pub fn confirm(self, peer: &[u8]) -> Result<(Sealer, Opener), Error> {
        // Comparaison en temps constant.
        if !constant_eq(peer, &self.expected) {
            return Err(Error::WrongCode);
        }
        Ok((
            Sealer { cipher: ChaCha20Poly1305::new(&self.send.into()), counter: 0 },
            Opener { cipher: ChaCha20Poly1305::new(&self.recv.into()), counter: 0 },
        ))
    }
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn nonce(counter: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n.into()
}

/// Sorte de message dans le canal chiffré.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Contrôle : JSON (accord, nom du dépanneur, fin…).
    Control = 0,
    /// Données : flux RDP.
    Data = 1,
    /// Morceau de fichier (voir [`transfer`]) ; seulement si l'autre côté annonce « fichiers ».
    File = 2,
}

/// Chiffre les messages envoyés (un compteur par sens : un message rejoué ou réordonné est refusé).
pub struct Sealer {
    cipher: ChaCha20Poly1305,
    counter: u64,
}

impl Sealer {
    pub fn seal(&mut self, kind: Kind, payload: &[u8]) -> Vec<u8> {
        let mut plain = Vec::with_capacity(payload.len() + 1);
        plain.push(kind as u8);
        plain.extend_from_slice(payload);
        let out = self.cipher.encrypt(&nonce(self.counter), plain.as_slice()).expect("chiffrement");
        self.counter += 1;
        out
    }
}

/// Déchiffre les messages reçus, dans l'ordre.
pub struct Opener {
    cipher: ChaCha20Poly1305,
    counter: u64,
}

impl Opener {
    pub fn open(&mut self, frame: &[u8]) -> Result<(Kind, Vec<u8>), Error> {
        let mut plain = self.cipher.decrypt(&nonce(self.counter), frame).map_err(|_| Error::Tampered)?;
        self.counter += 1;
        if plain.is_empty() {
            return Err(Error::Tampered);
        }
        let kind = match plain.remove(0) {
            0 => Kind::Control,
            1 => Kind::Data,
            2 => Kind::File,
            _ => return Err(Error::Tampered),
        };
        Ok((kind, plain))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(agent_code: &str, helper_code: &str) -> Result<((Sealer, Opener), (Sealer, Opener)), Error> {
        let (a, ma) = Handshake::start(Role::Agent, &Code::parse(agent_code)?);
        let (h, mh) = Handshake::start(Role::Helper, &Code::parse(helper_code)?);
        let (pa, ca) = a.finish(&mh)?;
        let (ph, ch) = h.finish(&ma)?;
        Ok((pa.confirm(&ch)?, ph.confirm(&ca)?))
    }

    #[test]
    fn codes() {
        let c = Code::parse("483 216-907").unwrap();
        assert_eq!((c.nameplate.as_str(), c.secret.as_str()), ("483", "216907"));
        assert_eq!(c.display(), "483 216 907");
        assert!(Code::parse("48321690").is_err());
        assert!(Code::parse("48321690a").is_err());
        assert_eq!(Code::new("012").secret.len(), 6);
    }

    #[test]
    fn meme_code() {
        let ((mut sa, mut oa), (mut sh, mut oh)) = pair("483216907", "483 216 907").unwrap();
        let f = sh.seal(Kind::Data, b"image RDP");
        assert_eq!(oa.open(&f).unwrap(), (Kind::Data, b"image RDP".to_vec()));
        let f = sa.seal(Kind::Control, br#"{"accord":true}"#);
        assert_eq!(oh.open(&f).unwrap().0, Kind::Control);
        // Rejouer un message : refusé (compteur).
        let f1 = sh.seal(Kind::Data, b"un");
        assert!(oa.open(&f1).is_ok());
        assert!(matches!(oa.open(&f1), Err(Error::Tampered)));
        // Message altéré : refusé.
        let mut f2 = sh.seal(Kind::Data, b"deux");
        f2[0] ^= 1;
        assert!(matches!(oa.open(&f2), Err(Error::Tampered)));
    }

    #[test]
    fn mauvais_code() {
        assert!(matches!(pair("483216907", "483216908"), Err(Error::WrongCode)));
    }
}
