//! Conteneurs d'un serveur (Pro) : Docker (ou Podman) et pods Kubernetes,
//! lus par la connexion SSH ouverte ; commandes pour un shell ou les journaux.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connector::{BoxFuture, RemoteExec};
use crate::extension::{self, ExtManifest, Extension, Host};
use crate::license::Feature;

/// Docker si présent, sinon Podman (mêmes commandes).
const ENGINE: &str = "$(command -v docker || command -v podman)";

const LIST_SCRIPT: &str = r#"export LC_ALL=C
D=$(command -v docker || command -v podman)
echo @@docker
if [ -n "$D" ]; then
  out=$("$D" ps -a --format '{{.ID}}	{{.Names}}	{{.Image}}	{{.State}}	{{.Status}}' 2>&1); rc=$?
  printf '%s\n' "$out" | head -300; echo "@@rc $rc"
else echo "@@absent"; fi
echo @@kube
if command -v kubectl >/dev/null 2>&1; then
  out=$(kubectl get pods -A --no-headers --request-timeout=8s 2>&1); rc=$?
  printf '%s\n' "$out" | head -500; echo "@@rc $rc"
else echo "@@absent"; fi
echo @@end"#;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running, exited, paused, created…
    pub state: String,
    /// « Up 3 days », « Exited (0) 2 hours ago »…
    pub status: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pod {
    pub namespace: String,
    pub name: String,
    pub ready: String,
    pub status: String,
    pub restarts: String,
    pub age: String,
}

/// Une source (Docker ou Kubernetes) : absente, en erreur ou sa liste.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Source<T> {
    Absent,
    Error { message: String },
    Ok { items: Vec<T> },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub docker: Source<Container>,
    pub kube: Source<Pod>,
}

fn section<'a>(text: &'a str, name: &str) -> Option<(Vec<&'a str>, Option<i32>, bool)> {
    let mut lines = text.lines().skip_while(|l| l.trim() != format!("@@{name}")).skip(1);
    let mut body = Vec::new();
    let mut rc = None;
    let mut absent = false;
    for line in lines.by_ref() {
        let t = line.trim();
        if t == "@@absent" {
            absent = true;
        } else if let Some(code) = t.strip_prefix("@@rc ") {
            rc = code.parse().ok();
        } else if t.starts_with("@@") {
            break;
        } else if !t.is_empty() {
            body.push(line);
        }
    }
    Some((body, rc, absent))
}

fn explain(engine: &str, output: &str) -> String {
    let lower = output.to_lowercase();
    if lower.contains("permission denied") {
        format!("{engine} refuse l'accès à ce compte. Ajoutez-le au groupe « docker » (sudo usermod -aG docker $USER, puis reconnectez-vous).")
    } else if lower.contains("cannot connect to the docker daemon") || lower.contains("is the docker daemon running") {
        t!("The Docker service is not started on this server.", "Le service Docker n'est pas démarré sur ce serveur.").into()
    } else if lower.contains("connection refused") || lower.contains("unable to connect to the server") || lower.contains("the server could not find") {
        t!("kubectl cannot reach the cluster (~/.kube/config configuration?).", "kubectl ne joint pas le cluster (configuration ~/.kube/config ?).").into()
    } else {
        output.lines().take(3).collect::<Vec<_>>().join(" ")
    }
}

pub fn parse(text: &str) -> Result<Inventory> {
    if !text.contains("@@end") {
        bail!(t!("This server does not look like Linux: containers unavailable", "Ce serveur ne ressemble pas à un Linux : conteneurs indisponibles"));
    }
    let docker = match section(text, "docker") {
        None => Source::Absent,
        Some((_, _, true)) => Source::Absent,
        Some((body, Some(0), _)) => Source::Ok {
            items: body
                .iter()
                .filter_map(|l| {
                    let cols: Vec<&str> = l.split('\t').collect();
                    (cols.len() >= 5).then(|| Container {
                        id: cols[0].trim().into(),
                        name: cols[1].trim().into(),
                        image: cols[2].trim().into(),
                        state: cols[3].trim().into(),
                        status: cols[4].trim().into(),
                    })
                })
                .collect(),
        },
        Some((body, _, _)) => Source::Error { message: explain("Docker", &body.join("\n")) },
    };
    let kube = match section(text, "kube") {
        None => Source::Absent,
        Some((_, _, true)) => Source::Absent,
        Some((body, Some(0), _)) => Source::Ok {
            items: body
                .iter()
                .filter_map(|l| {
                    let cols: Vec<&str> = l.split_whitespace().collect();
                    // NAMESPACE NAME READY STATUS RESTARTS (peut contenir « (2m ago) ») AGE
                    (cols.len() >= 6).then(|| Pod {
                        namespace: cols[0].into(),
                        name: cols[1].into(),
                        ready: cols[2].into(),
                        status: cols[3].into(),
                        restarts: cols[4..cols.len() - 1].join(" "),
                        age: cols[cols.len() - 1].into(),
                    })
                })
                .collect(),
        },
        Some((body, _, _)) => Source::Error { message: explain("kubectl", &body.join("\n")) },
    };
    Ok(Inventory { docker, kube })
}

pub async fn list(exec: &dyn RemoteExec) -> Result<Inventory> {
    let out = exec.run(LIST_SCRIPT.to_string()).await?;
    parse(&out.stdout)
}

/// Identifiant sûr à placer dans une commande (nom, id, espace de noms).
fn safe(value: &str) -> Result<&str> {
    let ok = !value.is_empty()
        && value.len() <= 253
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && !value.starts_with('-');
    if ok { Ok(value) } else { Err(anyhow!("{}", t!(format!("Invalid name: {value}"), format!("Nom invalide : {value}")))) }
}

/// Shell interactif : bash s'il existe, sinon sh.
const BEST_SHELL: &str = "sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'";

/// Commande à lancer dans un terminal SSH pour « shell » ou « logs ».
pub fn terminal_command(kind: &str, what: &str, id: &str, namespace: Option<&str>) -> Result<String> {
    let id = safe(id)?;
    Ok(match (kind, what) {
        ("docker", "shell") => format!("exec {ENGINE} exec -it {id} {BEST_SHELL}"),
        ("docker", "logs") => format!("exec {ENGINE} logs -f --tail 300 {id}"),
        ("kube", "shell") => format!("exec kubectl exec -it -n {} {id} -- {BEST_SHELL}", safe(namespace.unwrap_or("default"))?),
        ("kube", "logs") => format!("exec kubectl logs -f --tail 300 -n {} {id}", safe(namespace.unwrap_or("default"))?),
        _ => bail!("{}", t!(format!("Unknown action: {kind} {what}"), format!("Action inconnue : {kind} {what}"))),
    })
}

/// Démarrer, arrêter, redémarrer un conteneur ; supprimer un pod (son contrôleur le recrée).
pub async fn action(exec: &dyn RemoteExec, kind: &str, action: &str, id: &str, namespace: Option<&str>) -> Result<String> {
    let id = safe(id)?;
    let command = match (kind, action) {
        ("docker", "start" | "stop" | "restart") => format!("{ENGINE} {action} {id}"),
        ("kube", "delete") => format!("kubectl delete pod -n {} {id} --wait=false", safe(namespace.unwrap_or("default"))?),
        _ => bail!("{}", t!(format!("Unknown action: {kind} {action}"), format!("Action inconnue : {kind} {action}"))),
    };
    let out = exec.run(format!("{command} 2>&1")).await?;
    if out.status.unwrap_or(1) != 0 {
        bail!("{}", explain(if kind == "docker" { "Docker" } else { "kubectl" }, &out.stdout));
    }
    Ok(out.stdout.trim().to_string())
}

/// Extension « Conteneurs » (Pro) : méthodes `list`, `action` et `command`.
pub struct Containers;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionArgs {
    connection_id: String,
    kind: String,
    action: String,
    id: String,
    namespace: Option<String>,
}

#[derive(Deserialize)]
struct CommandArgs {
    kind: String,
    what: String,
    id: String,
    namespace: Option<String>,
}

impl Extension for Containers {
    fn manifest(&self) -> ExtManifest {
        ExtManifest { id: "containers", name: t!("Docker and Kubernetes containers", "Conteneurs Docker et Kubernetes").into(), feature: Some(Feature::Containers) }
    }

    fn call<'a>(&'a self, host: &'a dyn Host, method: &'a str, args: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "list" => {
                    let a: ListArgs = extension::args(args)?;
                    let exec = host.exec(&a.connection_id)?;
                    extension::reply(list(exec.as_ref()).await?)
                }
                "action" => {
                    let a: ActionArgs = extension::args(args)?;
                    let exec = host.exec(&a.connection_id)?;
                    extension::reply(action(exec.as_ref(), &a.kind, &a.action, &a.id, a.namespace.as_deref()).await?)
                }
                // Commande de terminal pour un shell ou les journaux (vérifiée ici).
                "command" => {
                    let a: CommandArgs = extension::args(args)?;
                    extension::reply(terminal_command(&a.kind, &a.what, &a.id, a.namespace.as_deref())?)
                }
                _ => Err(extension::unknown("containers", method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_et_kubernetes() {
        let text = "@@docker\nab12cd34ef56\tweb\tnginx:1.27\trunning\tUp 3 days\n0f9e8d7c6b5a\tbackup\talpine\texited\tExited (1) 2 hours ago\n@@rc 0\n@@kube\nkube-system   coredns-5d78c9869d-abcde   1/1   Running   2 (3d ago)   12d\nprod   api-7c9f   0/1   CrashLoopBackOff   14   1h\n@@rc 0\n@@end\n";
        let inv = parse(text).unwrap();
        let Source::Ok { items } = inv.docker else { panic!("docker") };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "web");
        assert_eq!(items[1].state, "exited");
        let Source::Ok { items } = inv.kube else { panic!("kube") };
        assert_eq!(items[0].restarts, "2 (3d ago)");
        assert_eq!(items[1].status, "CrashLoopBackOff");
        assert_eq!(items[1].age, "1h");
    }

    #[test]
    fn absent_ou_refuse() {
        let text = "@@docker\nGot permission denied while trying to connect to the Docker daemon socket\n@@rc 1\n@@kube\n@@absent\n@@end\n";
        let inv = parse(text).unwrap();
        assert!(matches!(inv.docker, Source::Error { ref message } if message.contains("groupe « docker »")));
        assert_eq!(inv.kube, Source::Absent);
    }

    #[test]
    fn commandes_sures() {
        assert!(terminal_command("docker", "shell", "web", None).unwrap().contains("exec -it web "));
        assert!(terminal_command("kube", "logs", "api-7c9f", Some("prod")).unwrap().contains("-n prod api-7c9f"));
        assert!(terminal_command("docker", "shell", "web; rm -rf /", None).is_err());
        assert!(terminal_command("docker", "shell", "--privileged", None).is_err());
        assert!(terminal_command("kube", "shell", "x", Some("a b")).is_err());
    }
}
