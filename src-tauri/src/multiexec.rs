//! Commande sur plusieurs serveurs (Pro) : une extension de fonction (voir extension.rs).
//! Chaque session SSH reçoit la commande par une connexion dédiée, sans terminal ;
//! les résultats arrivent un par un à l'interface.

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connector::BoxFuture;
use crate::extension::{self, ExtManifest, Extension, Host};
use crate::license::Feature;

/// Serveurs interrogés en même temps.
const PARALLEL: usize = 8;

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MultiEvent {
    #[serde(rename_all = "camelCase")]
    Result { session_id: String, status: Option<u32>, stdout: String, stderr: String, ms: u64 },
    #[serde(rename_all = "camelCase")]
    Failed { session_id: String, error: String, ms: u64 },
    Done { ok: usize, failed: usize },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunArgs {
    session_ids: Vec<String>,
    command: String,
    timeout_secs: Option<u64>,
}

pub struct MultiExec;

impl Extension for MultiExec {
    fn manifest(&self) -> ExtManifest {
        ExtManifest { id: "multiexec", name: t!("Command on several servers", "Commande sur plusieurs serveurs").into(), feature: Some(Feature::MultiExec) }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, args: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "run" => run(host, extension::args(args)?),
                _ => Err(extension::unknown("multiexec", method)),
            }
        })
    }
}

/// Lance la commande et renvoie l'identifiant de l'opération (arrêt : net_cancel).
fn run(host: &dyn Host, a: RunArgs) -> anyhow::Result<Value> {
    if a.command.trim().is_empty() {
        anyhow::bail!("{}", t!("Give a command", "Indiquez une commande"));
    }
    let emit = host.events()?;
    let send = move |e: MultiEvent| emit(serde_json::to_value(e).unwrap_or(Value::Null));
    let send = Arc::new(send);
    // Sessions préparées tout de suite (secrets, identifiants partagés, Gates) : erreurs par serveur.
    let targets: Vec<_> = a.session_ids.iter().map(|id| (id.clone(), host.ssh_session(id).map_err(|e| format!("{e:#}")))).collect();
    let job = host.job();
    let job_id = job.id.clone();
    let timeout = Duration::from_secs(a.timeout_secs.unwrap_or(60).clamp(5, 3600));
    let command = a.command;
    host.spawn(Box::pin(async move {
        let limit = Arc::new(tokio::sync::Semaphore::new(PARALLEL));
        let mut set = tokio::task::JoinSet::new();
        for (session_id, prepared) in targets {
            let (limit, job, command, send) = (limit.clone(), job.clone(), command.clone(), send.clone());
            set.spawn(async move {
                let _permit = limit.acquire_owned().await;
                let started = std::time::Instant::now();
                if job.cancelled() {
                    send(MultiEvent::Failed { session_id, error: t!("Cancelled", "Annulé").into(), ms: 0 });
                    return false;
                }
                let result = match prepared {
                    Err(e) => Err(e),
                    Ok(session) => session.run(command, timeout).await.map_err(|e| format!("{e:#}")),
                };
                let ms = started.elapsed().as_millis() as u64;
                match result {
                    Ok(out) => {
                        let ok = out.status == Some(0);
                        send(MultiEvent::Result { session_id, status: out.status, stdout: out.stdout, stderr: out.stderr, ms });
                        ok
                    }
                    Err(error) => {
                        send(MultiEvent::Failed { session_id, error, ms });
                        false
                    }
                }
            });
        }
        let (mut ok, mut failed) = (0, 0);
        while let Some(r) = set.join_next().await {
            if r.unwrap_or(false) { ok += 1 } else { failed += 1 }
        }
        drop(job);
        send(MultiEvent::Done { ok, failed });
    }));
    extension::reply(job_id)
}
