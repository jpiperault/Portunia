//! Contrat des extensions de fonction (options payantes et modules à part).
//!
//! Les connecteurs (`connector.rs`) ajoutent un protocole ; une extension de fonction
//! ajoute un outil à une session ouverte (tableau de bord, conteneurs…). Elle ne voit
//! le reste de Portunia que par `Host` : c'est la frontière qui permettra plus tard de
//! la livrer à part (module WebAssembly signé), sans rien changer à l'interface.
//!
//! Point de contrôle unique : l'interface appelle `ext_call(extension, méthode, arguments)` ;
//! le cœur vérifie le verrouillage et la licence de l'extension, puis lui passe l'appel.
//! Une extension ne vérifie donc jamais la licence elle-même.

use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::connector::{BoxFuture, ExecOutput, RemoteExec};
use crate::license::Feature;

/// Description d'une extension de fonction.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtManifest {
    pub id: &'static str,
    pub name: String,
    /// Fonctionnalité de la licence qui la débloque (aucune : gratuite).
    pub feature: Option<Feature>,
}

/// Ce que le cœur met à la disposition d'une extension. Tout passe par ici : une extension
/// n'accède jamais directement aux sessions, aux secrets ni aux fichiers de Portunia.
pub trait Host: Send + Sync {
    /// Lance des commandes sur une connexion ouverte (SSH…).
    fn exec(&self, connection_id: &str) -> Result<Arc<dyn RemoteExec>>;
    /// Session SSH enregistrée, prête pour des commandes (une connexion dédiée par commande,
    /// sans terminal). Secrets, identifiants partagés et rebonds sont résolus par le cœur.
    fn ssh_session(&self, session_id: &str) -> Result<Arc<dyn SessionExec>>;
    /// Envoi d'évènements à l'interface (canal donné à `ext_call`).
    fn events(&self) -> Result<Emit>;
    /// Opération de fond qu'on peut arrêter depuis l'interface (net_cancel).
    fn job(&self) -> Arc<Job>;
    /// Lance une tâche de fond, qui peut durer après la réponse.
    fn spawn(&self, task: Pin<Box<dyn Future<Output = ()> + Send + 'static>>);
}

/// Session enregistrée qui lance des commandes.
pub trait SessionExec: Send + Sync {
    fn run(&self, command: String, timeout: Duration) -> BoxFuture<'_, ExecOutput>;
}

/// Évènements vers l'interface.
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Opération de fond : son identifiant, et l'arrêt demandé par l'interface.
/// Elle disparaît de la liste des opérations quand la dernière copie est relâchée.
pub struct Job {
    pub id: String,
    stop: Arc<AtomicBool>,
    end: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl Job {
    pub fn new(id: String, stop: Arc<AtomicBool>, end: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self { id, stop, end: Some(Box::new(end)) }
    }

    pub fn cancelled(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            end();
        }
    }
}

pub trait Extension: Send + Sync {
    fn manifest(&self) -> ExtManifest;
    /// Une méthode de l'extension, avec ses arguments en JSON ; réponse en JSON.
    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, args: Value) -> BoxFuture<'a, Value>;
}

/// Extensions de fonction disponibles.
pub struct Extensions {
    list: Vec<Arc<dyn Extension>>,
}

impl Extensions {
    pub fn with_builtins() -> Self {
        Self {
            list: vec![
                Arc::new(crate::serverstats::Dashboard),
                Arc::new(crate::containers::Containers),
                Arc::new(crate::multiexec::MultiExec),
            ],
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Extension>> {
        self.list.iter().find(|e| e.manifest().id == id).cloned()
    }

    pub fn manifests(&self) -> Vec<ExtManifest> {
        self.list.iter().map(|e| e.manifest()).collect()
    }
}

/// Arguments d'une méthode, lus depuis le JSON envoyé par l'interface.
pub fn args<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| anyhow!(t!(format!("Invalid arguments: {e}"), format!("Arguments invalides : {e}"))))
}

/// Réponse d'une méthode, mise en JSON.
pub fn reply<T: Serialize>(value: T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

/// Méthode inconnue de l'extension.
pub fn unknown(id: &str, method: &str) -> anyhow::Error {
    anyhow!(t!(format!("{id}: unknown method « {method} »"), format!("{id} : méthode « {method} » inconnue")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::ExecOutput;
    use serde_json::json;

    /// Serveur factice : renvoie toujours la même sortie.
    struct FakeExec(&'static str);

    impl RemoteExec for FakeExec {
        fn run(&self, _command: String) -> BoxFuture<'_, ExecOutput> {
            let stdout = self.0.to_string();
            Box::pin(async move { Ok(ExecOutput { status: Some(0), stdout, stderr: String::new() }) })
        }
    }

    struct FakeHost(&'static str);

    impl Host for FakeHost {
        fn exec(&self, connection_id: &str) -> Result<Arc<dyn RemoteExec>> {
            if connection_id != "c1" {
                anyhow::bail!("session fermée");
            }
            Ok(Arc::new(FakeExec(self.0)))
        }
        fn ssh_session(&self, _: &str) -> Result<Arc<dyn SessionExec>> {
            anyhow::bail!("aucune session")
        }
        fn events(&self) -> Result<Emit> {
            anyhow::bail!("aucun canal")
        }
        fn job(&self) -> Arc<Job> {
            Arc::new(Job::new("j".into(), Arc::new(AtomicBool::new(false)), || {}))
        }
        fn spawn(&self, task: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
            tauri::async_runtime::block_on(task)
        }
    }

    fn call(host: &dyn Host, ext: &str, method: &str, args: Value) -> Result<Value> {
        let exts = Extensions::with_builtins();
        let e = exts.get(ext).expect("extension");
        tauri::async_runtime::block_on(e.call(host, method, args))
    }

    #[test]
    fn extensions_payantes_declarees() {
        let exts = Extensions::with_builtins();
        let m = exts.manifests();
        assert!(m.iter().any(|m| m.id == "dashboard" && m.feature == Some(Feature::ServerDashboard)));
        assert!(m.iter().any(|m| m.id == "containers" && m.feature == Some(Feature::Containers)));
        assert!(m.iter().any(|m| m.id == "multiexec" && m.feature == Some(Feature::MultiExec)));
        assert!(exts.get("inconnue").is_none());
    }

    #[test]
    fn appels_par_le_routeur() {
        let host = FakeHost("@@docker\nab12\tweb\tnginx\trunning\tUp\n@@rc 0\n@@kube\n@@absent\n@@end\n");
        let inv = call(&host, "containers", "list", json!({ "connectionId": "c1" })).unwrap();
        assert_eq!(inv["docker"]["items"][0]["name"], "web");
        let cmd = call(&host, "containers", "command", json!({ "kind": "docker", "what": "logs", "id": "web", "namespace": null })).unwrap();
        assert!(cmd.as_str().unwrap().contains("logs -f"));
        // Session fermée, arguments manquants, méthode inconnue, nom dangereux : refusés.
        assert!(call(&host, "containers", "list", json!({ "connectionId": "c2" })).is_err());
        assert!(call(&host, "containers", "list", json!({})).is_err());
        assert!(call(&host, "dashboard", "effacer", json!({})).is_err());
        assert!(call(&host, "containers", "command", json!({ "kind": "docker", "what": "shell", "id": "x; rm -rf /" })).is_err());
        // Commande sur plusieurs serveurs : sans canal d'évènements, refusée.
        assert!(call(&host, "multiexec", "run", json!({ "sessionIds": ["s1"], "command": "uptime" })).is_err());
        assert!(call(&host, "multiexec", "run", json!({ "sessionIds": ["s1"], "command": "  " })).is_err());
    }

    #[test]
    fn fin_d_operation() {
        let ended = Arc::new(AtomicBool::new(false));
        let flag = ended.clone();
        let job = Arc::new(Job::new("j".into(), Arc::new(AtomicBool::new(false)), move || flag.store(true, Ordering::Relaxed)));
        let copy = job.clone();
        drop(job);
        assert!(!ended.load(Ordering::Relaxed));
        drop(copy);
        assert!(ended.load(Ordering::Relaxed));
    }
}
