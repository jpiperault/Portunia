//! Stockage objet S3 (Pro) : AWS, MinIO, Scaleway, OVH, Wasabi, Cloudflare R2…
//! Client minimal écrit ici (signature AWS SigV4 avec ring, HTTP avec reqwest)
//! plutôt que le SDK d'Amazon, bien plus lourd.
//!
//! Chemins de l'explorateur : « / » liste les compartiments (buckets),
//! « /compartiment/dossier/fichier » désigne un objet.

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use ring::{digest, hmac};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::connector::*;
use crate::license::Feature;

pub struct S3Connector;

impl Connector for S3Connector {
    fn required_feature(&self) -> Option<Feature> {
        Some(Feature::CloudStorage)
    }

    fn manifest(&self) -> Manifest {
        Manifest {
            id: "s3".into(),
            name: "Stockage S3".into(),
            version: "0.1.0".into(),
            description: "Fichiers d'un stockage objet S3 : AWS, MinIO, Scaleway, OVH, Wasabi…".into(),
            view: ViewKind::Files,
            builtin: true,
            file_browser: true,
            port_forwarding: false,
            fields: vec![
                Field::new("endpoint", "Adresse du service", FieldKind::Text)
                    .placeholder("Vide = Amazon S3 ; ex. https://s3.fr-par.scw.cloud"),
                Field::new("region", "Région", FieldKind::Text).default("us-east-1").placeholder("eu-west-3, fr-par…"),
                Field::new("bucket", "Compartiment (bucket)", FieldKind::Text).placeholder("Vide = liste de tous les compartiments"),
                Field::new("accessKey", "Clé d'accès", FieldKind::Text).required(),
                Field::new("secretKey", "Clé secrète", FieldKind::Secret),
                Field::new("pathStyle", "Adressage par chemin (MinIO, Ceph…)", FieldKind::Bool).default(false),
                Field::new("insecureTls", "Accepter un certificat non vérifié (auto-signé)", FieldKind::Bool).default(false),
            ],
        }
    }

    fn connect(&self, ctx: ConnectContext) -> Result<Outcome> {
        let endpoint = ctx.str("endpoint").map(|e| e.trim_end_matches('/').to_string());
        if let Some(e) = &endpoint {
            if !e.starts_with("https://") && !e.starts_with("http://") {
                bail!("L'adresse du service doit commencer par https:// (ou http:// pour un service local)");
            }
        }
        let client = Client {
            http: reqwest::Client::builder()
                .tls_backend_preconfigured((*crate::tls::tls_config(ctx.bool("insecureTls"))?).clone())
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            endpoint,
            region: ctx.str("region").unwrap_or_else(|| "us-east-1".into()),
            access: ctx.require("accessKey", "Clé d'accès")?,
            secret: ctx.raw("secretKey").ok_or_else(|| anyhow!("Clé secrète manquante"))?,
            path_style: ctx.bool("pathStyle"),
        };
        let files = Arc::new(S3Files { client: Arc::new(client), bucket: ctx.str("bucket") });
        // Première requête tout de suite : clés ou région erronées signalées à l'ouverture.
        let check = files.clone();
        tauri::async_runtime::block_on(async move {
            let home = check.home_path();
            check.list_path(&home).await.map(|_| ())
        })?;
        Ok(Outcome::Terminal(Box::new(S3Connection { files })))
    }
}

// ---------- Signature AWS SigV4 ----------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, data).as_ref())
}

fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes()).as_ref().to_vec()
}

/// Encodage URI d'AWS : seuls A-Z a-z 0-9 - _ . ~ restent tels quels ; « / » au choix.
fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) || (keep_slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Date et heure UTC (AAAAMMJJ, AAAAMMJJTHHMMSSZ) sans dépendance de calendrier.
fn amz_dates(t: SystemTime) -> (String, String) {
    let secs = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Jours depuis 1970 → date civile (algorithme de Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let date = format!("{year:04}{month:02}{day:02}");
    let time = format!("{date}T{:02}{:02}{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60);
    (date, time)
}

struct Signed {
    authorization: String,
}

/// Signe une requête. `headers` : (nom en minuscules, valeur), « host » compris.
#[allow(clippy::too_many_arguments)]
fn sign(
    method: &str,
    canonical_uri: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    payload_hash: &str,
    access: &str,
    secret: &str,
    region: &str,
    date: &str,
    time: &str,
) -> Signed {
    let mut q: Vec<(String, String)> = query.iter().map(|(k, v)| (uri_encode(k, false), uri_encode(v, false))).collect();
    q.sort();
    let canonical_query = q.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let mut h: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_lowercase(), v.trim().to_string())).collect();
    h.sort();
    let canonical_headers: String = h.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = h.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical = format!("{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{time}\n{scope}\n{}", sha256_hex(canonical.as_bytes()));
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date);
    let k_region = hmac_sha256(&k_date, region);
    let k_service = hmac_sha256(&k_region, "s3");
    let k_signing = hmac_sha256(&k_service, "aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, &to_sign));
    Signed { authorization: format!("AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed_headers}, Signature={signature}") }
}

// ---------- Client ----------

struct Client {
    http: reqwest::Client,
    endpoint: Option<String>,
    region: String,
    access: String,
    secret: String,
    path_style: bool,
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

enum Payload {
    Empty,
    /// Corps envoyé sans calculer son empreinte (HTTPS).
    Unsigned(reqwest::Body, u64),
}

impl Client {
    /// (schéma://hôte, chemin) de la requête.
    fn target(&self, bucket: Option<&str>, key: &str) -> (String, String) {
        let key_path = format!("/{}", uri_encode(key, true));
        let (scheme, host) = match &self.endpoint {
            Some(e) => {
                let (scheme, host) = e.split_once("://").unwrap_or(("https", e));
                (scheme.to_string(), host.to_string())
            }
            None => ("https".into(), format!("s3.{}.amazonaws.com", self.region)),
        };
        match bucket {
            None => (format!("{scheme}://{host}"), "/".into()),
            Some(b) if self.path_style || b.contains('.') => {
                (format!("{scheme}://{host}"), format!("/{}{}", uri_encode(b, false), if key.is_empty() { "/".into() } else { key_path }))
            }
            Some(b) => (format!("{scheme}://{b}.{host}"), if key.is_empty() { "/".into() } else { key_path }),
        }
    }

    async fn send(
        &self,
        method: reqwest::Method,
        bucket: Option<&str>,
        key: &str,
        query: &[(String, String)],
        extra: &[(String, String)],
        payload: Payload,
    ) -> Result<reqwest::Response> {
        let (base, path) = self.target(bucket, key);
        let host = base.split_once("://").map(|(_, h)| h.to_string()).unwrap_or_default();
        let (date, time) = amz_dates(SystemTime::now());
        let payload_hash = match payload { Payload::Empty => EMPTY_SHA256, Payload::Unsigned(..) => "UNSIGNED-PAYLOAD" };
        let mut headers = vec![
            ("host".to_string(), host),
            ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
            ("x-amz-date".to_string(), time.clone()),
        ];
        headers.extend(extra.iter().cloned());
        let signed = sign(method.as_str(), &path, query, &headers, payload_hash, &self.access, &self.secret, &self.region, &date, &time);
        let url = if query.is_empty() {
            format!("{base}{path}")
        } else {
            let q: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", uri_encode(k, false), uri_encode(v, false))).collect();
            format!("{base}{path}?{}", q.join("&"))
        };
        let mut req = self.http.request(method, &url).header("authorization", signed.authorization);
        for (k, v) in headers.iter().filter(|(k, _)| k != "host") {
            req = req.header(k, v);
        }
        req = match payload {
            Payload::Empty => req,
            Payload::Unsigned(body, len) => req.header("content-length", len).body(body),
        };
        let resp = req.send().await.map_err(|e| anyhow!("Service S3 injoignable : {e}"))?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(anyhow!(explain(status.as_u16(), &body)))
    }
}

/// Texte d'une balise XML (première occurrence), entités décodées.
fn tag(xml: &str, name: &str) -> Option<String> {
    let start = xml.find(&format!("<{name}>"))? + name.len() + 2;
    let end = start + xml[start..].find(&format!("</{name}>"))?;
    quick_xml::escape::unescape(&xml[start..end]).ok().map(|s| s.into_owned())
}

/// Contenus de chaque bloc <name>…</name>.
fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

fn explain(status: u16, body: &str) -> String {
    let code = tag(body, "Code").unwrap_or_default();
    let message = tag(body, "Message").unwrap_or_default();
    match code.as_str() {
        "InvalidAccessKeyId" => "Clé d'accès inconnue de ce service S3".into(),
        "SignatureDoesNotMatch" => "Clé secrète incorrecte (signature refusée)".into(),
        "AccessDenied" => "Accès refusé : ces clés n'ont pas les droits nécessaires".into(),
        "NoSuchBucket" => "Compartiment introuvable".into(),
        "NoSuchKey" => "Fichier introuvable".into(),
        "AuthorizationHeaderMalformed" | "IllegalLocationConstraintException" | "PermanentRedirect" => {
            let region = tag(body, "Region").map(|r| format!(" (région attendue : {r})")).unwrap_or_default();
            format!("Mauvaise région pour ce compartiment{region}")
        }
        "RequestTimeTooSkewed" => "L'horloge de ce PC est trop décalée : la signature est refusée".into(),
        "" => format!("Le service S3 a répondu {status}"),
        _ => format!("{code} : {message}"),
    }
}

/// (compartiment, clé) d'un chemin « /compartiment/clé ».
fn split_path(path: &str) -> (Option<&str>, &str) {
    let p = path.trim_start_matches('/');
    if p.is_empty() {
        return (None, "");
    }
    match p.split_once('/') {
        Some((b, k)) => (Some(b), k),
        None => (Some(p), ""),
    }
}

/// Date ISO 8601 (« 2026-10-23T18:02:00.000Z ») → secondes Unix.
fn parse_iso(s: &str) -> Option<u64> {
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    let hh: i64 = s.get(11..13)?.parse().ok()?;
    let mm: i64 = s.get(14..16)?.parse().ok()?;
    let ss: i64 = s.get(17..19)?.parse().ok()?;
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

// ---------- Explorateur ----------

pub struct S3Files {
    client: Arc<Client>,
    bucket: Option<String>,
}

const CHUNK: usize = 1024 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Limite d'un envoi en une seule requête.
const MAX_SINGLE_PUT: u64 = 5 * 1024 * 1024 * 1024;

impl S3Files {
    fn home_path(&self) -> String {
        self.bucket.as_ref().map(|b| format!("/{b}")).unwrap_or_else(|| "/".into())
    }

    async fn list_path(&self, path: &str) -> Result<Vec<RemoteEntry>> {
        let (bucket, key) = split_path(path);
        let Some(bucket) = bucket else {
            let resp = self.client.send(reqwest::Method::GET, None, "", &[], &[], Payload::Empty).await?;
            let xml = resp.text().await?;
            return Ok(blocks(&xml, "Bucket")
                .into_iter()
                .filter_map(|b| {
                    let name = tag(b, "Name")?;
                    Some(RemoteEntry {
                        path: format!("/{name}"),
                        name,
                        is_dir: true,
                        is_link: false,
                        size: 0,
                        modified: tag(b, "CreationDate").and_then(|d| parse_iso(&d)),
                        permissions: None,
                    })
                })
                .collect());
        };
        let prefix = if key.is_empty() || key.ends_with('/') { key.to_string() } else { format!("{key}/") };
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("delimiter".to_string(), "/".to_string()),
                ("prefix".to_string(), prefix.clone()),
            ];
            if let Some(t) = &token {
                query.push(("continuation-token".into(), t.clone()));
            }
            let xml = self.client.send(reqwest::Method::GET, Some(bucket), "", &query, &[], Payload::Empty).await?.text().await?;
            for p in blocks(&xml, "CommonPrefixes") {
                let Some(full) = tag(p, "Prefix") else { continue };
                let name = full[prefix.len()..].trim_end_matches('/').to_string();
                if !name.is_empty() {
                    out.push(RemoteEntry { path: format!("/{bucket}/{}", full.trim_end_matches('/')), name, is_dir: true, is_link: false, size: 0, modified: None, permissions: None });
                }
            }
            for c in blocks(&xml, "Contents") {
                let Some(full) = tag(c, "Key") else { continue };
                // Marqueur de dossier (« dossier/ ») : déjà affiché comme dossier.
                if full == prefix || full.ends_with('/') {
                    continue;
                }
                out.push(RemoteEntry {
                    name: full[prefix.len()..].to_string(),
                    path: format!("/{bucket}/{full}"),
                    is_dir: false,
                    is_link: false,
                    size: tag(c, "Size").and_then(|s| s.parse().ok()).unwrap_or(0),
                    modified: tag(c, "LastModified").and_then(|d| parse_iso(&d)),
                    permissions: None,
                });
            }
            token = (tag(&xml, "IsTruncated").as_deref() == Some("true")).then(|| tag(&xml, "NextContinuationToken")).flatten();
            if token.is_none() || out.len() > 20_000 {
                break;
            }
        }
        Ok(out)
    }

    /// Toutes les clés sous un « dossier » (sans délimiteur).
    async fn all_keys(&self, bucket: &str, prefix: &str) -> Result<Vec<String>> {
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![("list-type".to_string(), "2".to_string()), ("prefix".to_string(), prefix.to_string())];
            if let Some(t) = &token {
                query.push(("continuation-token".into(), t.clone()));
            }
            let xml = self.client.send(reqwest::Method::GET, Some(bucket), "", &query, &[], Payload::Empty).await?.text().await?;
            keys.extend(blocks(&xml, "Contents").into_iter().filter_map(|c| tag(c, "Key")));
            token = (tag(&xml, "IsTruncated").as_deref() == Some("true")).then(|| tag(&xml, "NextContinuationToken")).flatten();
            if token.is_none() {
                return Ok(keys);
            }
        }
    }

    async fn delete_key(&self, bucket: &str, key: &str) -> Result<()> {
        self.client.send(reqwest::Method::DELETE, Some(bucket), key, &[], &[], Payload::Empty).await?;
        Ok(())
    }

    async fn copy_key(&self, bucket: &str, from: &str, to: &str) -> Result<()> {
        let source = format!("/{bucket}/{}", uri_encode(from, true));
        self.client
            .send(reqwest::Method::PUT, Some(bucket), to, &[], &[("x-amz-copy-source".into(), source)], Payload::Empty)
            .await?;
        Ok(())
    }
}

fn need_bucket<'a>(path: &'a str, what: &str) -> Result<(&'a str, &'a str)> {
    match split_path(path) {
        (Some(b), k) if !k.is_empty() => Ok((b, k)),
        _ => bail!("{what} : choisissez d'abord un compartiment"),
    }
}

impl RemoteFiles for S3Files {
    fn home(&self) -> BoxFuture<'_, String> {
        Box::pin(async move { Ok(self.home_path()) })
    }

    fn list(&self, path: String) -> BoxFuture<'_, Vec<RemoteEntry>> {
        Box::pin(async move { self.list_path(&path).await })
    }

    fn download(&self, remote: String, local: PathBuf, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (bucket, key) = need_bucket(&remote, "Téléchargement")?;
            let mut resp = self.client.send(reqwest::Method::GET, Some(bucket), key, &[], &[], Payload::Empty).await?;
            let total = resp.content_length().unwrap_or(0);
            let mut file = tokio::fs::File::create(&local).await.with_context(|| format!("Écriture impossible : {}", local.display()))?;
            let (mut done, mut last) = (0u64, Instant::now());
            while let Some(chunk) = resp.chunk().await? {
                file.write_all(&chunk).await?;
                done += chunk.len() as u64;
                if last.elapsed() >= PROGRESS_EVERY {
                    progress(done, total.max(done));
                    last = Instant::now();
                }
            }
            file.flush().await?;
            progress(done, total.max(done));
            Ok(())
        })
    }

    fn upload(&self, local: PathBuf, remote: String, progress: Progress) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (bucket, key) = need_bucket(&remote, "Envoi")?;
            let total = tokio::fs::metadata(&local).await?.len();
            if total > MAX_SINGLE_PUT {
                bail!("Fichier de plus de 5 Go : envoi en plusieurs parties pas encore pris en charge");
            }
            let file = tokio::fs::File::open(&local).await.with_context(|| format!("Lecture impossible : {}", local.display()))?;
            // Le corps est lu par morceaux ; la progression suit ce qui part.
            let state = (file, 0u64, Instant::now(), progress.clone());
            let stream = futures_util::stream::unfold(state, move |(mut file, done, last, progress)| async move {
                let mut buf = vec![0u8; CHUNK];
                match file.read(&mut buf).await {
                    Ok(0) => None,
                    Ok(n) => {
                        buf.truncate(n);
                        let done = done + n as u64;
                        let last = if last.elapsed() >= PROGRESS_EVERY { progress(done, total); Instant::now() } else { last };
                        Some((Ok::<_, std::io::Error>(buf), (file, done, last, progress)))
                    }
                    Err(e) => Some((Err(e), (file, done, last, progress))),
                }
            });
            self.client
                .send(reqwest::Method::PUT, Some(bucket), key, &[], &[], Payload::Unsigned(reqwest::Body::wrap_stream(stream), total))
                .await?;
            progress(total, total);
            Ok(())
        })
    }

    fn mkdir(&self, path: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (bucket, key) = need_bucket(&path, "Nouveau dossier")?;
            // S3 n'a pas de dossiers : un objet vide « dossier/ » en tient lieu.
            let marker = format!("{}/", key.trim_end_matches('/'));
            self.client
                .send(reqwest::Method::PUT, Some(bucket), &marker, &[], &[], Payload::Unsigned(reqwest::Body::from(Vec::new()), 0))
                .await?;
            Ok(())
        })
    }

    fn remove(&self, path: String, is_dir: bool) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (bucket, key) = need_bucket(&path, "Suppression")?;
            if !is_dir {
                return self.delete_key(bucket, key).await;
            }
            let prefix = format!("{}/", key.trim_end_matches('/'));
            for k in self.all_keys(bucket, &prefix).await? {
                self.delete_key(bucket, &k).await?;
            }
            // Le marqueur de dossier, s'il existe (sinon S3 répond quand même « supprimé »).
            self.delete_key(bucket, &prefix).await
        })
    }

    fn rename(&self, from: String, to: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (bucket, from_key) = need_bucket(&from, "Renommage")?;
            let (to_bucket, to_key) = need_bucket(&to, "Renommage")?;
            if bucket != to_bucket {
                bail!("Renommage entre deux compartiments impossible");
            }
            // S3 ne renomme pas : copie puis suppression, objet par objet pour un dossier.
            let keys = self.all_keys(bucket, &format!("{from_key}/")).await?;
            if keys.is_empty() {
                self.copy_key(bucket, from_key, to_key).await?;
                return self.delete_key(bucket, from_key).await;
            }
            for k in keys {
                let target = format!("{to_key}/{}", &k[from_key.len() + 1..]);
                self.copy_key(bucket, &k, &target).await?;
                self.delete_key(bucket, &k).await?;
            }
            Ok(())
        })
    }
}

struct S3Connection {
    files: Arc<S3Files>,
}

impl TerminalConnection for S3Connection {
    fn write(&self, _data: &[u8]) -> Result<()> {
        bail!("Cet onglet n'a pas de terminal")
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }

    fn close(&self) {}

    fn files(&self) -> Option<Arc<dyn RemoteFiles>> {
        Some(self.files.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exemple « GET Object » de la documentation AWS (signature de référence).
    #[test]
    fn signature_de_reference_aws() {
        let headers = vec![
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("range".to_string(), "bytes=0-9".to_string()),
            ("x-amz-content-sha256".to_string(), EMPTY_SHA256.to_string()),
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
        ];
        let s = sign("GET", "/test.txt", &[], &headers, EMPTY_SHA256, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "20130524", "20130524T000000Z");
        assert_eq!(
            s.authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    /// Exemples « GET Bucket (List Objects) » et « GET Bucket Lifecycle » de la documentation AWS.
    #[test]
    fn signature_avec_parametres() {
        let headers = vec![
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("x-amz-content-sha256".to_string(), EMPTY_SHA256.to_string()),
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
        ];
        let key = ("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
        let list = sign("GET", "/", &[("max-keys".into(), "2".into()), ("prefix".into(), "J".into())], &headers, EMPTY_SHA256, key.0, key.1, "us-east-1", "20130524", "20130524T000000Z");
        assert!(list.authorization.ends_with("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"), "{}", list.authorization);
        let lifecycle = sign("GET", "/", &[("lifecycle".into(), String::new())], &headers, EMPTY_SHA256, key.0, key.1, "us-east-1", "20130524", "20130524T000000Z");
        assert!(lifecycle.authorization.ends_with("Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"), "{}", lifecycle.authorization);
    }

    #[test]
    fn dates_et_chemins() {
        assert_eq!(amz_dates(UNIX_EPOCH + Duration::from_secs(1_369_353_600)), ("20130524".into(), "20130524T000000Z".into()));
        assert_eq!(amz_dates(UNIX_EPOCH + Duration::from_secs(951_782_400)).0, "20000229");
        assert_eq!(parse_iso("2013-05-24T00:00:00.000Z"), Some(1_369_353_600));
        assert_eq!(split_path("/"), (None, ""));
        assert_eq!(split_path("/photos"), (Some("photos"), ""));
        assert_eq!(split_path("/photos/2026/été.jpg"), (Some("photos"), "2026/été.jpg"));
        assert_eq!(uri_encode("2026/été 1.jpg", true), "2026/%C3%A9t%C3%A9%201.jpg");
    }

    #[test]
    fn lecture_xml() {
        let xml = "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a&amp;b.txt</Key><Size>12</Size></Contents><CommonPrefixes><Prefix>docs/</Prefix></CommonPrefixes></ListBucketResult>";
        assert_eq!(blocks(xml, "Contents").len(), 1);
        assert_eq!(tag(blocks(xml, "Contents")[0], "Key").unwrap(), "a&b.txt");
        assert_eq!(tag(xml, "IsTruncated").unwrap(), "false");
        assert!(explain(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>").contains("Clé secrète"));
    }
}

#[cfg(test)]
mod reseau {
    use super::*;

    /// Essai réel avec vos clés, dans un compartiment existant (préfixe temporaire supprimé à la fin) :
    /// PORTUNIA_S3_ACCESS, PORTUNIA_S3_SECRET, PORTUNIA_S3_BUCKET, et selon le service
    /// PORTUNIA_S3_ENDPOINT, PORTUNIA_S3_REGION, PORTUNIA_S3_PATH_STYLE=1, puis
    /// cargo test --lib s3_reel -- --ignored --nocapture
    #[test]
    #[ignore = "nécessite des clés S3"]
    fn s3_reel() {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let (Some(access), Some(secret), Some(bucket)) = (env("PORTUNIA_S3_ACCESS"), env("PORTUNIA_S3_SECRET"), env("PORTUNIA_S3_BUCKET")) else {
            println!("Variables PORTUNIA_S3_* absentes : essai ignoré");
            return;
        };
        tauri::async_runtime::block_on(async {
            let client = Client {
                http: reqwest::Client::builder().tls_backend_preconfigured((*crate::tls::tls_config(false).unwrap()).clone()).build().unwrap(),
                endpoint: env("PORTUNIA_S3_ENDPOINT"),
                region: env("PORTUNIA_S3_REGION").unwrap_or_else(|| "us-east-1".into()),
                access,
                secret,
                path_style: env("PORTUNIA_S3_PATH_STYLE").is_some(),
            };
            let files = S3Files { client: Arc::new(client), bucket: Some(bucket.clone()) };
            let base = format!("/{bucket}/portunia-test-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
            let local = std::env::temp_dir().join("portunia-s3-envoi.txt");
            std::fs::write(&local, "Bonjour S3 — été 2026\n".repeat(1000)).unwrap();
            let p: Progress = Arc::new(|_, _| {});
            files.mkdir(format!("{base}/dossier")).await.unwrap();
            files.upload(local.clone(), format!("{base}/dossier/été 1.txt"), p.clone()).await.unwrap();
            let listed = files.list_path(&format!("{base}/dossier")).await.unwrap();
            println!("{:?}", listed.iter().map(|e| (&e.name, e.size, e.modified)).collect::<Vec<_>>());
            assert!(listed.iter().any(|e| e.name == "été 1.txt" && e.size == std::fs::metadata(&local).unwrap().len()));
            files.rename(format!("{base}/dossier"), format!("{base}/renommé")).await.unwrap();
            let back = std::env::temp_dir().join("portunia-s3-retour.txt");
            files.download(format!("{base}/renommé/été 1.txt"), back.clone(), p).await.unwrap();
            assert_eq!(std::fs::read(&back).unwrap(), std::fs::read(&local).unwrap());
            files.remove(base.clone(), true).await.unwrap();
            assert!(files.list_path(&base).await.unwrap().is_empty());
        });
    }
}
