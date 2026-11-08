//! Supervision légère : le serveur répond-il, et en combien de temps ?
//! Une simple ouverture de connexion TCP sur le port de la session, sans
//! s'authentifier ni rien envoyer.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{net::TcpStream, time::timeout};

use crate::connector::BoxFuture;
use crate::extension::{self, ExtManifest, Extension, Host};
use crate::license::Feature;

/// Extension « Alertes de supervision » (Pro) : méthode `notify`, une notification du
/// système par serveur qui tombe ou revient. La sonde elle-même (`monitor_check`) reste
/// gratuite, dans le cœur.
pub struct Alerts;

#[derive(Deserialize)]
pub struct Change {
    pub name: String,
    pub up: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct NotifyArgs {
    changes: Vec<Change>,
}

/// Au plus cinq notifications détaillées, puis une qui compte le reste.
const DETAILED: usize = 5;

/// Titre et texte de chaque notification.
pub fn messages(changes: &[Change]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = changes
        .iter()
        .take(DETAILED)
        .map(|c| {
            let name = &c.name;
            if c.up {
                (t!(format!("{name} is answering again"), format!("{name} répond de nouveau")), t!("The server is reachable again.", "Le serveur est de nouveau joignable.").to_string())
            } else {
                let body = c.error.clone().unwrap_or_else(|| t!("The server is unreachable.", "Le serveur est injoignable.").to_string());
                (t!(format!("{name} is not answering"), format!("{name} ne répond plus")), body)
            }
        })
        .collect();
    if changes.len() > DETAILED {
        let n = changes.len() - DETAILED;
        out.push(("Portunia".into(), t!(format!("{n} other status change(s)."), format!("{n} autre(s) changement(s) d'état."))));
    }
    out
}

impl Extension for Alerts {
    fn manifest(&self) -> ExtManifest {
        ExtManifest { id: "alerts", name: t!("Monitoring alerts", "Alertes de supervision").into(), feature: Some(Feature::MonitoringAlerts), free: &[] }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, args: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "notify" => {
                    let a: NotifyArgs = extension::args(args)?;
                    let messages = messages(&a.changes);
                    for (title, body) in &messages {
                        host.notify(title, body)?;
                    }
                    extension::reply(messages.len())
                }
                _ => Err(extension::unknown("alerts", method)),
            }
        })
    }
}

#[derive(Deserialize, Clone)]
pub struct Target {
    pub id: String,
    pub host: String,
    pub port: u16,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub id: String,
    pub up: bool,
    /// Temps d'ouverture de la connexion, en millisecondes.
    pub latency_ms: Option<u32>,
    pub error: Option<String>,
}

pub async fn probe(target: Target, limit: Duration) -> Probe {
    let started = Instant::now();
    let result = timeout(limit, TcpStream::connect((target.host.as_str(), target.port))).await;
    match result {
        Ok(Ok(_stream)) => Probe {
            id: target.id,
            up: true,
            latency_ms: Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
            error: None,
        },
        Ok(Err(e)) => Probe { id: target.id, up: false, latency_ms: None, error: Some(e.to_string()) },
        Err(_) => Probe {
            id: target.id,
            up: false,
            latency_ms: None,
            error: Some(format!("pas de réponse en {} s", limit.as_secs())),
        },
    }
}

/// Teste toutes les cibles en parallèle (au plus 32 à la fois).
pub async fn probe_all(targets: Vec<Target>) -> Vec<Probe> {
    let limit = Duration::from_secs(3);
    let mut out = Vec::with_capacity(targets.len());
    for chunk in targets.chunks(32) {
        let handles: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|t| tauri::async_runtime::spawn(probe(t, limit)))
            .collect();
        for handle in handles {
            if let Ok(result) = handle.await {
                out.push(result);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alertes_limitees() {
        let change = |i: usize, up: bool| Change { name: format!("s{i}"), up, error: (!up).then(|| "refusé".to_string()) };
        let few = messages(&[change(1, false), change(2, true)]);
        assert_eq!(few.len(), 2);
        assert!(few[0].0.contains("s1") && few[0].1 == "refusé");
        assert!(few[1].0.contains("s2"));
        let many: Vec<_> = (0..8).map(|i| change(i, false)).collect();
        let out = messages(&many);
        assert_eq!(out.len(), DETAILED + 1);
        assert!(out[DETAILED].1.contains('3'));
    }

    #[tokio::test]
    async fn serveur_joignable_et_injoignable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = probe(Target { id: "a".into(), host: "127.0.0.1".into(), port }, Duration::from_secs(2)).await;
        assert!(up.up && up.latency_ms.is_some());
        drop(listener);
        let down = probe(Target { id: "b".into(), host: "127.0.0.1".into(), port }, Duration::from_secs(2)).await;
        assert!(!down.up && down.error.is_some());
    }
}
