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
    ChoiceOption, ConnectContext, FieldKind, InputEvent, Manifest, Outcome, PortForwarder, ScreenEvent, RemoteEntry, RemoteFiles, Sink,
    TerminalConnection, TunnelSpec, TunnelStatus,
    ViewKind,
};
use crate::importers::{self, Candidate};
use crate::license::{Feature, License};
use crate::recording::{self, Recorder};
use crate::transfer;
use crate::lock::{self, Lock};
use crate::registry::Registry;
use crate::secrets;
use crate::store::{Session, Snippet, Store};

pub struct AppState {
    registry: Registry,
    store: Mutex<Store>,
    connections: Mutex<HashMap<String, Box<dyn TerminalConnection>>>,
    data_dir: PathBuf,
    pub license: Mutex<License>,
    lock: Mutex<Lock>,
    /// Enregistrements en cours, par connexion.
    recordings: Mutex<HashMap<String, Recorder>>,
    /// Fichiers distants ouverts dans un éditeur local : (connexion, surveillance).
    edits: Mutex<HashMap<String, (String, tauri::async_runtime::JoinHandle<()>)>>,
}

impl AppState {
    pub fn new(registry: Registry, store: Store, data_dir: PathBuf) -> Self {
        Self {
            registry,
            store: Mutex::new(store),
            connections: Mutex::new(HashMap::new()),
            license: Mutex::new(License::load(&data_dir)),
            lock: Mutex::new(Lock::load(&data_dir)),
            recordings: Mutex::new(HashMap::new()),
            edits: Mutex::new(HashMap::new()),
            data_dir,
        }
    }

    /// Refuse les actions sensibles tant que Termoria est verrouillé.
    fn unlocked(&self) -> CmdResult<()> {
        self.lock.lock().unwrap().ensure_unlocked().map_err(err)
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
    state.unlocked()?;
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
    /// Image d'un écran distant (vue Screen).
    Screen(ScreenEvent),
}

struct ChannelSink {
    channel: Channel<TermEvent>,
    app: AppHandle,
    connection_id: String,
}

impl Sink for ChannelSink {
    fn data(&self, bytes: &[u8]) {
        let _ = self.channel.send(TermEvent::Data(B64.encode(bytes)));
        if let Some(state) = self.app.try_state::<AppState>() {
            if let Some(recorder) = state.recordings.lock().unwrap().get_mut(&self.connection_id) {
                recorder.output(bytes);
            }
        }
    }

    fn screen(&self, event: ScreenEvent) {
        let _ = self.channel.send(TermEvent::Screen(event));
    }

    fn closed(&self, reason: Option<String>) {
        let _ = self.channel.send(TermEvent::Closed(reason));
        if let Some(state) = self.app.try_state::<AppState>() {
            state.connections.lock().unwrap().remove(&self.connection_id);
            // Fin de session : l'enregistrement en cours est terminé et sauvegardé.
            // Les fichiers en cours d'édition ne sont plus synchronisés.
            state.edits.lock().unwrap().retain(|_, (conn, task)| {
                if *conn == self.connection_id { task.abort(); false } else { true }
            });
            let recorder = state.recordings.lock().unwrap().remove(&self.connection_id);
            if let Some(recorder) = recorder {
                let _ = recorder.finish();
            }
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
    state.unlocked()?;
    let session = state
        .store
        .lock()
        .unwrap()
        .get(&session_id)
        .ok_or("Session introuvable")?;
    let mut values = session.values.clone();
    for key in &session.secret_keys {
        if let Some(secret) = secrets::get(&session.id, key).map_err(err)? {
            values.insert(key.clone(), Value::String(secret));
        }
    }
    start_connection(&app, &state, &session.protocol, session.name.clone(), values, cols, rows, on_event).await
}

/// Connexion rapide : sans session enregistrée (« ssh deploy@10.0.1.12 »).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connect_quick(
    app: AppHandle,
    state: State<'_, AppState>,
    protocol: String,
    name: String,
    values: HashMap<String, Value>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    start_connection(&app, &state, &protocol, name, values, cols, rows, on_event).await
}

#[allow(clippy::too_many_arguments)]
async fn start_connection(
    app: &AppHandle,
    state: &AppState,
    protocol: &str,
    name: String,
    values: HashMap<String, Value>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<ConnectResponse> {
    let connector = state
        .registry
        .get(protocol)
        .ok_or_else(|| format!("Extension « {protocol} » non installée"))?;
    let view = connector.manifest().view;
    let connection_id = uuid::Uuid::new_v4().to_string();
    let ctx = ConnectContext {
        app: app.clone(),
        session_name: name,
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
    if let Some(recorder) = state.recordings.lock().unwrap().get_mut(&connection_id) {
        recorder.resize(cols.max(2), rows.max(2));
    }
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
    state.unlocked()?;
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
    state.unlocked()?;
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
    state.unlocked()?;
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
    state.unlocked()?;
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
    state.unlocked()?;
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

/// Suggestions d'un champ (ex. ports COM présents), fournies par l'extension.
#[tauri::command]
pub fn field_suggestions(state: State<'_, AppState>, protocol: String, source: String) -> Vec<ChoiceOption> {
    state.registry.get(&protocol).map(|c| c.suggestions(&source)).unwrap_or_default()
}

/// Clavier / souris / presse-papiers vers un écran distant.
#[tauri::command]
pub fn screen_input(state: State<'_, AppState>, connection_id: String, event: InputEvent) -> CmdResult<()> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(&connection_id).ok_or("Session fermée")?;
    connection.input(event).map_err(err)
}

// ---------- Licence ----------

#[tauri::command]
pub fn license_status(state: State<'_, AppState>) -> crate::license::LicenseStatus {
    state.license.lock().unwrap().status()
}

#[tauri::command]
pub fn license_activate(state: State<'_, AppState>, text: String) -> CmdResult<crate::license::LicenseStatus> {
    let mut license = state.license.lock().unwrap();
    license.activate(&text).map_err(full)?;
    Ok(license.status())
}

#[tauri::command]
pub fn license_remove(state: State<'_, AppState>) -> CmdResult<crate::license::LicenseStatus> {
    let mut license = state.license.lock().unwrap();
    license.remove().map_err(full)?;
    Ok(license.status())
}

// ---------- Verrouillage ----------

#[tauri::command]
pub fn lock_status(state: State<'_, AppState>) -> lock::LockStatus {
    state.lock.lock().unwrap().status()
}

#[tauri::command]
pub fn lock_set_password(state: State<'_, AppState>, current: String, new: String) -> CmdResult<lock::LockStatus> {
    let mut lock = state.lock.lock().unwrap();
    lock.ensure_unlocked().map_err(err)?;
    lock.set_password(&current, &new).map_err(full)?;
    Ok(lock.status())
}

#[tauri::command]
pub fn lock_disable(state: State<'_, AppState>, password: String) -> CmdResult<lock::LockStatus> {
    let mut lock = state.lock.lock().unwrap();
    lock.disable(&password).map_err(full)?;
    Ok(lock.status())
}

#[tauri::command]
pub fn lock_set_options(state: State<'_, AppState>, hello: bool, timeout_minutes: u32) -> CmdResult<lock::LockStatus> {
    let mut lock = state.lock.lock().unwrap();
    lock.ensure_unlocked().map_err(err)?;
    lock.set_options(hello, timeout_minutes).map_err(full)?;
    Ok(lock.status())
}

#[tauri::command]
pub fn lock_now(state: State<'_, AppState>) -> CmdResult<()> {
    state.lock.lock().unwrap().lock().map_err(full)
}

#[tauri::command]
pub fn unlock(state: State<'_, AppState>, password: String) -> CmdResult<()> {
    state.lock.lock().unwrap().unlock_with_password(&password).map_err(full)
}

/// Déverrouillage par Windows Hello (visage, empreinte, PIN).
#[tauri::command]
pub async fn unlock_hello(app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    if !state.lock.lock().unwrap().hello_enabled() {
        return Err("Windows Hello n'est pas activé pour Termoria".into());
    }
    let window = app.get_webview_window("main").ok_or("Fenêtre introuvable")?;
    #[cfg(windows)]
    let hwnd = window.hwnd().map_err(err)?.0 as usize;
    #[cfg(not(windows))]
    let hwnd = { let _ = window; 0usize };
    let verified = tauri::async_runtime::spawn_blocking(move || {
        lock::hello::verify(hwnd as *mut core::ffi::c_void, "Déverrouiller Termoria")
    })
    .await
    .map_err(err)?
    .map_err(full)?;
    if verified {
        state.lock.lock().unwrap().unlock_with_hello().map_err(full)?;
    }
    Ok(verified)
}

// ---------- Enregistrement des sessions (Pro) ----------

/// Dossier des enregistrements : choisi dans les Paramètres, sinon Documents\Termoria\Enregistrements.
fn recording_dir(app: &AppHandle, custom: Option<String>) -> CmdResult<PathBuf> {
    match custom.filter(|d| !d.trim().is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(app.path().document_dir().map_err(err)?.join("Termoria").join("Enregistrements")),
    }
}

#[tauri::command]
pub fn recording_default_dir(app: AppHandle) -> CmdResult<String> {
    Ok(recording_dir(&app, None)?.display().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn recording_start(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    stamp: String,
    title: String,
    cols: u16,
    rows: u16,
    dir: Option<String>,
) -> CmdResult<String> {
    state.license.lock().unwrap().require(Feature::SessionRecording).map_err(full)?;
    if !state.connections.lock().unwrap().contains_key(&connection_id) {
        return Err("Session fermée".into());
    }
    let mut recordings = state.recordings.lock().unwrap();
    if let Some(existing) = recordings.get(&connection_id) {
        return Ok(existing.path().display().to_string());
    }
    let recorder = Recorder::start(&recording_dir(&app, dir)?, &stamp, &title, cols, rows).map_err(full)?;
    let path = recorder.path().display().to_string();
    recordings.insert(connection_id, recorder);
    Ok(path)
}

#[tauri::command]
pub fn recording_stop(state: State<'_, AppState>, connection_id: String) -> CmdResult<Option<String>> {
    let recorder = state.recordings.lock().unwrap().remove(&connection_id);
    match recorder {
        Some(r) => Ok(Some(r.finish().map_err(full)?.display().to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn recordings_list(app: AppHandle, dir: Option<String>) -> CmdResult<Vec<recording::RecordingInfo>> {
    Ok(recording::list(&recording_dir(&app, dir)?))
}

#[tauri::command]
pub fn recording_read(app: AppHandle, dir: Option<String>, path: String) -> CmdResult<String> {
    recording::read(&recording_dir(&app, dir)?, &path).map_err(full)
}

#[tauri::command]
pub fn recording_delete(app: AppHandle, dir: Option<String>, path: String) -> CmdResult<()> {
    recording::delete(&recording_dir(&app, dir)?, &path).map_err(full)
}

// ---------- Supervision ----------

/// Le serveur de chaque session répond-il ? (ouverture TCP sur son port)
#[tauri::command]
pub async fn monitor_check(targets: Vec<crate::monitor::Target>) -> Vec<crate::monitor::Probe> {
    crate::monitor::probe_all(targets).await
}

/// Les alertes (notifications) sont une fonction Pro.
#[tauri::command]
pub fn monitor_alerts_allowed(state: State<'_, AppState>) -> bool {
    state.license.lock().unwrap().allows(Feature::MonitoringAlerts)
}

// ---------- Couleurs des dossiers ----------

#[tauri::command]
pub fn folder_colors(state: State<'_, AppState>) -> HashMap<String, String> {
    state.store.lock().unwrap().folder_colors()
}

#[tauri::command]
pub fn set_folder_color(state: State<'_, AppState>, path: String, color: Option<String>) -> CmdResult<()> {
    state.store.lock().unwrap().set_folder_color(&path, color).map_err(full)
}

// ---------- Dossiers entiers et édition de fichiers distants ----------

#[tauri::command]
pub async fn fs_download_dir(
    state: State<'_, AppState>,
    connection_id: String,
    remote: String,
    local: String,
    on_progress: Channel<TransferProgress>,
) -> CmdResult<usize> {
    state.unlocked()?;
    let files = files_of(&state, &connection_id)?;
    let progress: crate::connector::Progress = Arc::new(move |done, total| {
        let _ = on_progress.send(TransferProgress { done, total });
    });
    transfer::download_tree(files.as_ref(), &remote, &PathBuf::from(local), progress).await.map_err(full)
}

/// Envoie un fichier ou un dossier (avec son contenu) dans `remote_dir`.
#[tauri::command]
pub async fn fs_upload_any(
    state: State<'_, AppState>,
    connection_id: String,
    local: String,
    remote_dir: String,
    on_progress: Channel<TransferProgress>,
) -> CmdResult<usize> {
    state.unlocked()?;
    let files = files_of(&state, &connection_id)?;
    let progress: crate::connector::Progress = Arc::new(move |done, total| {
        let _ = on_progress.send(TransferProgress { done, total });
    });
    let local = PathBuf::from(local);
    if local.is_dir() {
        return transfer::upload_tree(files.as_ref(), &local, &remote_dir, progress).await.map_err(full);
    }
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("Fichier invalide")?;
    let remote = if remote_dir.ends_with('/') { format!("{remote_dir}{name}") } else { format!("{remote_dir}/{name}") };
    files.upload(local, remote, progress).await.map_err(full)?;
    Ok(1)
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EditEvent {
    /// Fichier renvoyé sur le serveur (heure Unix, en secondes).
    Uploaded { at: u64 },
    Error { message: String },
}

/// Ouvre un fichier distant dans l'éditeur par défaut de Windows ; chaque
/// enregistrement est renvoyé automatiquement sur le serveur.
#[tauri::command]
pub async fn fs_edit_start(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote: String,
    on_event: Channel<EditEvent>,
) -> CmdResult<String> {
    use tauri_plugin_opener::OpenerExt;
    state.unlocked()?;
    let files = files_of(&state, &connection_id)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let local = transfer::edit_copy_path(&id, &remote);
    if let Some(dir) = local.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    files.download(remote.clone(), local.clone(), Arc::new(|_, _| {})).await.map_err(full)?;
    app.opener().open_path(local.to_string_lossy(), None::<&str>).map_err(|e| format!("Aucun éditeur pour ce fichier : {e}"))?;

    let task = tauri::async_runtime::spawn(async move {
        let mut last = transfer::modified(&local);
        loop {
            tokio::time::sleep(transfer::EDIT_POLL).await;
            let now = transfer::modified(&local);
            if now.is_none() {
                break; // copie supprimée
            }
            if now == last {
                continue;
            }
            // Attend que l'éditeur ait fini d'écrire.
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let settled = transfer::modified(&local);
            if settled != now {
                continue;
            }
            last = settled;
            let event = match files.upload(local.clone(), remote.clone(), Arc::new(|_, _| {})).await {
                Ok(()) => EditEvent::Uploaded {
                    at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
                },
                Err(e) => EditEvent::Error { message: format!("{e:#}") },
            };
            let _ = on_event.send(event);
        }
    });
    state.edits.lock().unwrap().insert(id.clone(), (connection_id, task));
    Ok(id)
}

#[tauri::command]
pub fn fs_edit_stop(state: State<'_, AppState>, id: String) {
    if let Some((_, task)) = state.edits.lock().unwrap().remove(&id) {
        task.abort();
    }
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("termoria-edition").join(&id));
}

// ---------- Shells locaux ----------

/// Shells présents sur ce PC (PowerShell, cmd, distributions WSL, Git Bash).
#[tauri::command]
pub async fn shells_detect() -> Vec<crate::connectors::local::ShellSpec> {
    tauri::async_runtime::spawn_blocking(crate::connectors::local::detect).await.unwrap_or_default()
}

/// Ouvre un shell local dans un onglet.
#[tauri::command]
pub async fn connect_local(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: crate::connectors::local::ShellSpec,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    let connection_id = uuid::Uuid::new_v4().to_string();
    let sink: Arc<dyn Sink> = Arc::new(ChannelSink { channel: on_event, app: app.clone(), connection_id: connection_id.clone() });
    let connection = tauri::async_runtime::spawn_blocking(move || crate::connectors::local::open(&shell, cols, rows, sink))
        .await
        .map_err(err)?
        .map_err(|e| format!("{e:#}"))?;
    state.connections.lock().unwrap().insert(connection_id.clone(), connection);
    Ok(ConnectResponse { connection_id: Some(connection_id), view: ViewKind::Terminal, message: None })
}

/// Shell en administrateur : ouvert dans sa propre fenêtre Windows.
#[tauri::command]
pub fn open_shell_elevated(state: State<'_, AppState>, shell: crate::connectors::local::ShellSpec) -> CmdResult<()> {
    state.unlocked()?;
    crate::connectors::local::open_elevated(&shell).map_err(full)
}
