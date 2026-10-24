//! Supervision légère : le serveur répond-il, et en combien de temps ?
//! Une simple ouverture de connexion TCP sur le port de la session, sans
//! s'authentifier ni rien envoyer.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, time::timeout};

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
