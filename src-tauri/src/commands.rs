//! Commandes appelées par l'interface (`invoke`).

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::connector::{
    ConnectContext, FieldKind, Manifest, Outcome, PortForwarder, RemoteEntry, RemoteFiles, Sink,
    TerminalConnection, TunnelSpec, TunnelStatus,
    ViewKind,
};
use crate::importers::{self, Candidate};
use crate::registry::Registry;
use crate::secrets;
use crate::store::{Session, Snippet, Store};

pub struct AppState {
    registry: Registry,
    store: Mutex<Store>,
    connections: Mutex<HashMap<String, Box<dyn TerminalConnection>>>,
    data_dir: PathBuf,
}

impl AppState {
    pub fn new(registry: Registry, store: Store, data_dir: PathBuf) -> Self {
        Self {
            registry,
            store: Mutex::new(store),
            connections: Mutex::new(HashMap::new()),
            data_dir,
        }
    }
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn secret_fields(manifest: &Manifest) -> Vec<String> {
    manifest
        .fields
        .iter()
        .filter(|f| matches!(f.kind, FieldKind::Secret))
        .map(|f| f.key.clone())
        .collect()
}

#[tauri::command]
pub fn list_protocols(state: State<'_, AppState>) -> Vec<Manifest> {
    state.registry.manifests()
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<Session> {
    state.store.lock().unwrap().list()
}

#[derive(Deserialize)]
pub struct SaveSessionInput {
    session: Session,
    /// Secrets saisis dans le formulaire ; un secret absent reste inchangé.
    #[serde(default)]
    secrets: HashMap<String, String>,
}

#[tauri::command]
pub fn save_session(state: State<'_, AppState>, input: SaveSessionInput) -> CmdResult<Session> {
    let mut session = input.session;
    let manifest = state
        .registry
        .get(&session.protocol)
        .ok_or("Protocole inconnu")?
        .manifest();
    session.name = session.name.trim().to_string();
    if session.name.is_empty() {
        return Err("Donnez un nom à la session".into());
    }
    session.folder = crate::store::normalize_folder(&session.folder);
    if session.id.is_empty() {
        session.id = uuid::Uuid::new_v4().to_string();
    }

    let secret_keys = secret_fields(&manifest);
    session
        .values
        .retain(|k, _| manifest.fields.iter().any(|f| f.key == *k) && !secret_keys.contains(k));

    let mut store = state.store.lock().unwrap();
    let previous = store.get(&session.id).map(|s| s.secret_keys).unwrap_or_default();
    // Secrets d'un ancien protocole qui n'existent plus dans le nouveau.
    for key in previous.iter().filter(|k| !secret_keys.contains(k)) {
        secrets::delete(&session.id, key).map_err(err)?;
    }
    session.secret_keys = previous.into_iter().filter(|k| secret_keys.contains(k)).collect();
    for (key, value) in input.secrets {
        if value.is_empty() || !secret_keys.contains(&key) {
            continue;
        }
        secrets::set(&session.id, &key, &value).map_err(err)?;
        if !session.secret_keys.contains(&key) {
            session.secret_keys.push(key);
        }
    }

    store.upsert(session).map_err(err)
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let removed = state.store.lock().unwrap().remove(&id).map_err(err)?;
    if let Some(session) = removed {
        for key in &session.secret_keys {
            secrets::delete(&session.id, key).map_err(err)?;
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum TermEvent {
    /// Octets reçus, encodés en base64.
    Data(String),
    Closed(Option<String>),
}

struct ChannelSink {
    channel: Channel<TermEvent>,
    app: AppHandle,
    connection_id: String,
}

impl Sink for ChannelSink {
    fn data(&self, bytes: &[u8]) {
        let _ = self.channel.send(TermEvent::Data(B64.encode(bytes)));
    }

    fn closed(&self, reason: Option<String>) {
        let _ = self.channel.send(TermEvent::Closed(reason));
        if let Some(state) = self.app.try_state::<AppState>() {
            state.connections.lock().unwrap().remove(&self.connection_id);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResponse {
    connection_id: Option<String>,
    view: ViewKind,
    message: Option<String>,
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<ConnectResponse> {
    let session = state
        .store
        .lock()
        .unwrap()
        .get(&session_id)
        .ok_or("Session introuvable")?;
    let connector = state
        .registry
        .get(&session.protocol)
        .ok_or_else(|| format!("Extension « {} » non installée", session.protocol))?;
    let view = connector.manifest().view;

    let mut values = session.values.clone();
    for key in &session.secret_keys {
        if let Some(secret) = secrets::get(&session.id, key).map_err(err)? {
            values.insert(key.clone(), Value::String(secret));
        }
    }

    let connection_id = uuid::Uuid::new_v4().to_string();
    let ctx = ConnectContext {
        app: app.clone(),
        session_name: session.name.clone(),
        values,
        cols: cols.max(2),
        rows: rows.max(2),
        sink: Arc::new(ChannelSink {
            channel: on_event,
            app: app.clone(),
            connection_id: connection_id.clone(),
        }),
        data_dir: state.data_dir.clone(),
    };

    let outcome = tauri::async_runtime::spawn_blocking(move || connector.connect(ctx))
        .await
        .map_err(err)?
        .map_err(|e| format!("{e:#}"))?;

    Ok(match outcome {
        Outcome::Terminal(connection) => {
            state
                .connections
                .lock()
                .unwrap()
                .insert(connection_id.clone(), connection);
            ConnectResponse {
                connection_id: Some(connection_id),
                view,
                message: None,
            }
        }
        Outcome::Detached(message) => ConnectResponse {
            connection_id: None,
            view,
            message: Some(message),
        },
    })
}

#[tauri::command]
pub fn term_write(state: State<'_, AppState>, connection_id: String, data: String) -> CmdResult<()> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(&connection_id).ok_or("Session fermée")?;
    connection.write(data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn term_resize(
    state: State<'_, AppState>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    let connections = state.connections.lock().unwrap();
    match connections.get(&connection_id) {
        Some(connection) => connection.resize(cols.max(2), rows.max(2)).map_err(err),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, connection_id: String) {
    let connection = state.connections.lock().unwrap().remove(&connection_id);
    if let Some(connection) = connection {
        connection.close();
    }
}

// ---------- Explorateur de fichiers distant ----------

fn files_of(state: &AppState, connection_id: &str) -> CmdResult<Arc<dyn RemoteFiles>> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(connection_id).ok_or("Session fermée")?;
    connection
        .files()
        .ok_or_else(|| "Ce protocole ne propose pas d'explorateur de fichiers".into())
}

fn full(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    done: u64,
    total: u64,
}

#[tauri::command]
pub async fn fs_home(state: State<'_, AppState>, connection_id: String) -> CmdResult<String> {
    let files = files_of(&state, &connection_id)?;
    files.home().await.map_err(full)
}

#[tauri::command]
pub async fn fs_list(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> CmdResult<Vec<RemoteEntry>> {
    let files = files_of(&state, &connection_id)?;
    files.list(path).await.map_err(full)
}

#[tauri::command]
pub async fn fs_download(
    state: State<'_, AppState>,
    connection_id: String,
    remote: String,
    local: String,
    on_progress: Channel<TransferProgress>,
) -> CmdResult<()> {
    let files = files_of(&state, &connection_id)?;
    let progress = Arc::new(move |done, total| {
        let _ = on_progress.send(TransferProgress { done, total });
    });
    files.download(remote, PathBuf::from(local), progress).await.map_err(full)
}

#[tauri::command]
pub async fn fs_upload(
    state: State<'_, AppState>,
    connection_id: String,
    local: String,
    remote: String,
    on_progress: Channel<TransferProgress>,
) -> CmdResult<()> {
    let files = files_of(&state, &connection_id)?;
    let progress = Arc::new(move |done, total| {
        let _ = on_progress.send(TransferProgress { done, total });
    });
    files.upload(PathBuf::from(local), remote, progress).await.map_err(full)
}

#[tauri::command]
pub async fn fs_mkdir(state: State<'_, AppState>, connection_id: String, path: String) -> CmdResult<()> {
    let files = files_of(&state, &connection_id)?;
    files.mkdir(path).await.map_err(full)
}

#[tauri::command]
pub async fn fs_remove(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    is_dir: bool,
) -> CmdResult<()> {
    let files = files_of(&state, &connection_id)?;
    files.remove(path, is_dir).await.map_err(full)
}

#[tauri::command]
pub async fn fs_rename(
    state: State<'_, AppState>,
    connection_id: String,
    from: String,
    to: String,
) -> CmdResult<()> {
    let files = files_of(&state, &connection_id)?;
    files.rename(from, to).await.map_err(full)
}

// ---------- Dossiers de sessions ----------

#[tauri::command]
pub fn list_folders(state: State<'_, AppState>) -> Vec<String> {
    state.store.lock().unwrap().folders()
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    state.store.lock().unwrap().create_folder(&path).map_err(full)
}

#[tauri::command]
pub fn rename_folder(state: State<'_, AppState>, from: String, to: String) -> CmdResult<()> {
    state.store.lock().unwrap().rename_folder(&from, &to).map_err(full)
}

#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.store.lock().unwrap().delete_folder(&path).map_err(full)
}

#[tauri::command]
pub fn move_sessions(state: State<'_, AppState>, ids: Vec<String>, folder: String) -> CmdResult<()> {
    state.store.lock().unwrap().move_sessions(&ids, &folder).map_err(full)
}

/// Copie d'une session, mots de passe enregistrés compris.
#[tauri::command]
pub fn duplicate_session(state: State<'_, AppState>, id: String) -> CmdResult<Session> {
    let mut store = state.store.lock().unwrap();
    let original = store.get(&id).ok_or("Session introuvable")?;
    let mut copy = original.clone();
    copy.id = uuid::Uuid::new_v4().to_string();
    copy.name = format!("{} (copie)", original.name);
    for key in &original.secret_keys {
        if let Some(secret) = secrets::get(&original.id, key).map_err(err)? {
            secrets::set(&copy.id, key, &secret).map_err(err)?;
        }
    }
    store.upsert(copy).map_err(full)
}

// ---------- Commandes enregistrées ----------

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Vec<Snippet> {
    state.store.lock().unwrap().snippets()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, snippet: Snippet) -> CmdResult<Snippet> {
    state.store.lock().unwrap().upsert_snippet(snippet).map_err(full)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.lock().unwrap().delete_snippet(&id).map_err(full)
}

// ---------- Tunnels ----------

fn forwarder_of(state: &AppState, connection_id: &str) -> CmdResult<Arc<dyn PortForwarder>> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(connection_id).ok_or("Session fermée")?;
    connection
        .forwarder()
        .ok_or_else(|| "Ce protocole ne propose pas de tunnels".into())
}

#[tauri::command]
pub fn tunnel_list(state: State<'_, AppState>, connection_id: String) -> CmdResult<Vec<TunnelStatus>> {
    Ok(forwarder_of(&state, &connection_id)?.list())
}

#[tauri::command]
pub async fn tunnel_start(state: State<'_, AppState>, connection_id: String, spec: TunnelSpec) -> CmdResult<()> {
    let forwarder = forwarder_of(&state, &connection_id)?;
    forwarder.start(spec).await.map_err(full)
}

#[tauri::command]
pub fn tunnel_stop(state: State<'_, AppState>, connection_id: String, id: String) -> CmdResult<()> {
    forwarder_of(&state, &connection_id)?.stop(&id);
    Ok(())
}

// ---------- Import / export ----------

fn import_path(source: &str, path: Option<String>) -> PathBuf {
    match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None if source == "mremoteng" => importers::default_mremoteng(),
        None => importers::default_ssh_config(),
    }
}

/// Emplacement habituel du fichier d'une source (affiché dans l'interface).
#[tauri::command]
pub fn import_default_path(source: String) -> String {
    import_path(&source, None).display().to_string()
}

/// Sessions trouvées dans une source, avant confirmation.
#[tauri::command]
pub fn import_preview(
    state: State<'_, AppState>,
    source: String,
    path: Option<String>,
    folder: String,
) -> CmdResult<Vec<Candidate>> {
    let mut candidates = match source.as_str() {
        "ssh-config" => importers::ssh_config(&import_path(&source, path), &folder),
        "putty" => importers::putty(&folder),
        "mremoteng" => importers::mremoteng(&import_path(&source, path), &folder),
        _ => return Err("Source d'import inconnue".into()),
    }
    .map_err(full)?;
    let existing: Vec<String> = state.store.lock().unwrap().list().iter().map(importers::identity).collect();
    for c in &mut candidates {
        c.duplicate = existing.contains(&importers::identity(&c.session));
    }
    Ok(candidates)
}

#[tauri::command]
pub fn import_apply(state: State<'_, AppState>, sessions: Vec<Session>) -> CmdResult<usize> {
    state.store.lock().unwrap().add_sessions(sessions).map_err(full)
}

#[tauri::command]
pub fn export_backup(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    let (sessions, folders, snippets) = state.store.lock().unwrap().export_parts();
    let count = sessions.len();
    let backup = importers::Backup { app: "termoria".into(), version: 1, sessions, folders, snippets };
    let text = serde_json::to_string_pretty(&backup).map_err(err)?;
    std::fs::write(&path, text).map_err(|e| format!("Écriture impossible : {e}"))?;
    Ok(count)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    added: usize,
    skipped: usize,
    snippets: usize,
}

#[tauri::command]
pub fn import_backup(state: State<'_, AppState>, path: String) -> CmdResult<BackupReport> {
    let backup = importers::read_backup(&PathBuf::from(path)).map_err(full)?;
    let (added, skipped, snippets) = state
        .store
        .lock()
        .unwrap()
        .merge_backup(backup.sessions, backup.folders, backup.snippets)
        .map_err(full)?;
    Ok(BackupReport { added, skipped, snippets })
}
