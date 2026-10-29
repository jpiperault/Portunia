//! Outil de l'éditeur (ne pas distribuer).
//!
//!   license-tool keygen <dossier>
//!       Crée la clé privée de signature (portunia-licences.pk8, À GARDER SECRÈTE)
//!       et affiche la clé publique à inscrire dans src-tauri/src/license.rs.
//!
//!   license-tool sign <clé.pk8> <édition: pro|team> <nom> <email> [--expires AAAA-MM-JJ] [--seats N] [--id ID]
//!       Affiche la licence à envoyer au client (il la colle dans Paramètres › Licence).

use std::{env, fs, path::PathBuf};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::Serialize;

/// Doit rester identique à `LicenseData` dans Portunia (même ordre des champs).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseData {
    id: String,
    name: String,
    email: String,
    edition: String,
    seats: u32,
    issued: String,
    expires: Option<String>,
}

#[derive(Serialize)]
struct SignedLicense {
    data: LicenseData,
    signature: String,
}

fn today() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 / 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => {
            let dir = PathBuf::from(args.get(1).context("Indiquez le dossier où créer la clé")?);
            let path = dir.join("portunia-licences.pk8");
            if path.exists() {
                bail!("{} existe déjà : refus de l'écraser", path.display());
            }
            fs::create_dir_all(&dir)?;
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| anyhow::anyhow!("génération impossible"))?;
            let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| anyhow::anyhow!("clé invalide"))?;
            fs::write(&path, pkcs8.as_ref())?;
            println!("Clé privée créée : {}  (à sauvegarder et garder secrète)", path.display());
            println!("Clé publique à inscrire dans src-tauri/src/license.rs (PUBLIC_KEY) :");
            println!("{}", B64.encode(pair.public_key().as_ref()));
        }
        Some("sign") => {
            let key = fs::read(args.get(1).context("Indiquez le fichier de clé privée")?)?;
            let edition = args.get(2).context("Indiquez l'édition : pro ou team")?.to_lowercase();
            if edition != "pro" && edition != "team" {
                bail!("Édition inconnue : {edition} (pro ou team)");
            }
            let name = args.get(3).context("Indiquez le nom du client")?.clone();
            let email = args.get(4).context("Indiquez l'e-mail du client")?.clone();
            let pair = Ed25519KeyPair::from_pkcs8(&key).map_err(|_| anyhow::anyhow!("Clé privée illisible"))?;
            let id = option(&args, "--id").unwrap_or_else(|| {
                let mut bytes = [0u8; 6];
                SystemRandom::new().fill(&mut bytes).expect("aléatoire");
                format!("TRM-{}", bytes.iter().map(|b| format!("{b:02X}")).collect::<String>())
            });
            let data = LicenseData {
                id,
                name,
                email,
                edition,
                seats: option(&args, "--seats").map(|s| s.parse()).transpose()?.unwrap_or(1),
                issued: today(),
                expires: option(&args, "--expires"),
            };
            let signature = B64.encode(pair.sign(&serde_json::to_vec(&data)?).as_ref());
            println!("{}", serde_json::to_string(&SignedLicense { data, signature })?);
        }
        _ => {
            eprintln!("Utilisation :\n  license-tool keygen <dossier>\n  license-tool sign <clé.pk8> <pro|team> <nom> <email> [--expires AAAA-MM-JJ] [--seats N] [--id ID]");
            std::process::exit(2);
        }
    }
    Ok(())
}
