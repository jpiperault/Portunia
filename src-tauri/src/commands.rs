//! Commandes appelées par l'interface (`invoke`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State,
};

use crate::connector::{
    ChoiceOption, Confirm, ConnectContext, FieldKind, InputEvent, Manifest, Outcome, PortForwarder, ScreenEvent, RemoteEntry, RemoteFiles, Sink,
    TerminalConnection, TunnelSpec, TunnelStatus,
    ViewKind,
};
use crate::importers::{self, Candidate};
use crate::keys;
use crate::notes::Notes;
use crate::credentials::{Credential, Credentials};
use crate::nettools;
use crate::connector::RemoteExec;
use crate::license::{Feature, License};
use crate::transfer;
use crate::lock::{self, Lock};
use crate::registry::Registry;
use crate::secrets;
use crate::store::{Session, Snippet, Store};

pub struct AppState {
    registry: Registry,
    /// Extensions de fonction (tableau de bord, conteneurs…).
    extensions: crate::extension::Extensions,
    store: Mutex<Store>,
    connections: Mutex<HashMap<String, Box<dyn TerminalConnection>>>,
    pub(crate) data_dir: PathBuf,
    pub license: Mutex<License>,
    lock: Mutex<Lock>,
    /// Enregistrements en cours, par connexion.
    observers: Mutex<crate::extension::Observers>,
    /// Fichiers distants ouverts dans un éditeur local : (connexion, surveillance).
    edits: Mutex<HashMap<String, (String, tauri::async_runtime::JoinHandle<()>)>>,
    notes: Mutex<Notes>,
    credentials: Mutex<Credentials>,
}

impl AppState {
    pub fn new(registry: Registry, store: Store, data_dir: PathBuf) -> Self {
        Self {
            registry,
            extensions: crate::extension::Extensions::with_builtins(),
            store: Mutex::new(store),
            connections: Mutex::new(HashMap::new()),
            license: Mutex::new(License::load(&data_dir)),
            lock: Mutex::new(Lock::load(&data_dir)),
            observers: Mutex::new(crate::extension::Observers::default()),
            edits: Mutex::new(HashMap::new()),
            notes: Mutex::new(Notes::load(data_dir.join("notes.json"))),
            credentials: Mutex::new(Credentials::load(data_dir.join("credentials.json"))),
            data_dir,
        }
    }

    /// Refuse les actions sensibles tant que Portunia est verrouillé.
    pub(crate) fn unlocked(&self) -> CmdResult<()> {
        self.lock.lock().unwrap().ensure_unlocked().map_err(err)
    }
}

pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}


/// Ne garde que les valeurs prévues par le formulaire du protocole, hors secrets.
/// Un fichier importé (sauvegarde partagée, configuration) ne peut ainsi glisser ni valeur
/// cachée (« remoteCommand »…) ni mot de passe en clair dans sessions.json.
fn clean_imported(state: &AppState, mut sessions: Vec<Session>) -> Vec<Session> {
    sessions.retain_mut(|s| {
        let Some(connector) = state.registry.get(&s.protocol) else { return false };
        let manifest = connector.manifest();
        let secrets = secret_fields(&manifest);
        s.values.retain(|k, _| manifest.fields.iter().any(|f| f.key == *k) && !secrets.contains(k));
        s.secret_keys.clear();
        true
    });
    sessions
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
    // Verrouillé : rien n'est montré (rechargé au déverrouillage).
    if state.unlocked().is_err() {
        return Vec::new();
    }
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
        .ok_or(t!("Unknown protocol", "Protocole inconnu"))?
        .manifest();
    session.name = session.name.trim().to_string();
    if session.name.is_empty() {
        return Err(t!("Give the session a name", "Donnez un nom à la session").into());
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
    state.unlocked()?;
    let removed = state.store.lock().unwrap().remove(&id).map_err(err)?;
    state.notes.lock().unwrap().remove(&id).map_err(err)?;
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
    Closed(Option<String>),
    /// Image d'un écran distant (vue Screen).
    Screen(ScreenEvent),
    /// Question à l'utilisateur ; réponse par la commande confirm_answer.
    Confirm { id: String, question: Confirm },
}

/// Questions en attente de réponse, par identifiant.
static CONFIRMS: std::sync::LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Réponse de l'utilisateur à une question posée pendant une connexion.
#[tauri::command]
pub fn confirm_answer(id: String, accept: bool) {
    if let Some(sender) = CONFIRMS.lock().unwrap().remove(&id) {
        let _ = sender.send(accept);
    }
}

/// Délai de regroupement : court pour l'écho de la frappe (aucun retard perceptible),
/// plus long pendant un flot continu (moins de messages, donc moins d'allers-retours IPC).
const COALESCE_IDLE: std::time::Duration = std::time::Duration::from_millis(2);
const COALESCE_STREAM: std::time::Duration = std::time::Duration::from_millis(16);
/// Flot continu : un envoi d'au moins STREAMING_BYTES il y a moins de STREAMING (la frappe,
/// elle, n'envoie que quelques octets et garde le délai court).
const STREAMING: std::time::Duration = std::time::Duration::from_millis(50);
const STREAMING_BYTES: usize = 2048;
/// Taille au-delà de laquelle on envoie sans attendre.
const COALESCE_MAX: usize = 256 * 1024;

/// Sortie d'un terminal vers l'interface. Chaque message de canal coûte un `eval` dans la
/// page (plus un aller-retour `fetch` au-delà de quelques Ko) : les petits morceaux
/// (console Windows, SSH) sont donc regroupés quelques millisecondes et envoyés en
/// binaire brut, sans base64. Mesuré : 1,7 → 5,8 Mo/s avec des morceaux de 120 octets.
struct ChannelSink {
    channel: Channel,
    app: AppHandle,
    connection_id: String,
    pending: Arc<Mutex<Pending>>,
}

struct Pending {
    bytes: Vec<u8>,
    /// Un envoi différé est déjà prévu.
    scheduled: bool,
    last_flush: std::time::Instant,
    last_size: usize,
}

impl Default for Pending {
    fn default() -> Self {
        Self { bytes: Vec::new(), scheduled: false, last_flush: std::time::Instant::now() - STREAMING, last_size: 0 }
    }
}

impl ChannelSink {
    fn new(channel: Channel, app: AppHandle, connection_id: String) -> Self {
        Self { channel, app, connection_id, pending: Arc::default() }
    }

    /// Envoie les octets en attente (sous le verrou : l'ordre des messages est garanti).
    fn flush_locked(channel: &Channel, pending: &mut Pending) {
        pending.scheduled = false;
        if !pending.bytes.is_empty() {
            pending.last_flush = std::time::Instant::now();
            pending.last_size = pending.bytes.len();
            let _ = channel.send(InvokeResponseBody::Raw(std::mem::take(&mut pending.bytes)));
        }
    }

    fn send_event(&self, event: TermEvent) {
        let mut pending = self.pending.lock().unwrap();
        Self::flush_locked(&self.channel, &mut pending);
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = self.channel.send(InvokeResponseBody::Json(json));
        }
    }
}

impl Sink for ChannelSink {
    fn confirm(&self, question: Confirm) -> Option<tokio::sync::oneshot::Receiver<bool>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4().simple().to_string();
        CONFIRMS.lock().unwrap().insert(id.clone(), tx);
        self.send_event(TermEvent::Confirm { id, question });
        Some(rx)
    }

    fn data(&self, bytes: &[u8]) {
        {
            let mut pending = self.pending.lock().unwrap();
            pending.bytes.extend_from_slice(bytes);
            if pending.bytes.len() >= COALESCE_MAX {
                Self::flush_locked(&self.channel, &mut pending);
            } else if !pending.scheduled {
                pending.scheduled = true;
                let streaming = pending.last_size >= STREAMING_BYTES && pending.last_flush.elapsed() < STREAMING;
                let delay = if streaming { COALESCE_STREAM } else { COALESCE_IDLE };
                let (channel, shared) = (self.channel.clone(), self.pending.clone());
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(delay).await;
                    Self::flush_locked(&channel, &mut shared.lock().unwrap());
                });
            }
        }
        if let Some(state) = self.app.try_state::<AppState>() {
            state.observers.lock().unwrap().output(&self.connection_id, bytes);
        }
    }

    fn screen(&self, event: ScreenEvent) {
        self.send_event(TermEvent::Screen(event));
    }

    fn screen_pixels(&self, packet: Vec<u8>) {
        // Sous le verrou, après les octets en attente : l'ordre avec les autres messages est gardé.
        let mut pending = self.pending.lock().unwrap();
        Self::flush_locked(&self.channel, &mut pending);
        let _ = self.channel.send(InvokeResponseBody::Raw(packet));
    }

    fn closed(&self, reason: Option<String>) {
        self.send_event(TermEvent::Closed(reason));
        if let Some(state) = self.app.try_state::<AppState>() {
            state.connections.lock().unwrap().remove(&self.connection_id);
            // Fin de session : l'enregistrement en cours est terminé et sauvegardé.
            // Les fichiers en cours d'édition ne sont plus synchronisés.
            state.edits.lock().unwrap().retain(|_, (conn, task)| {
                if *conn == self.connection_id { task.abort(); false } else { true }
            });
            state.observers.lock().unwrap().close(&self.connection_id);
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
    on_event: Channel,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    let session = state
        .store
        .lock()
        .unwrap()
        .get(&session_id)
        .ok_or(t!("Session not found", "Session introuvable"))?;
    let values = session_values(&state, &session)?;
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
    on_event: Channel,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    start_connection(&app, &state, &protocol, name, values, cols, rows, on_event).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_connection(
    app: &AppHandle,
    state: &AppState,
    protocol: &str,
    name: String,
    mut values: HashMap<String, Value>,
    cols: u16,
    rows: u16,
    on_event: Channel,
) -> CmdResult<ConnectResponse> {
    let connector = state
        .registry
        .get(protocol)
        .ok_or_else(|| format!("Extension « {protocol} » non installée"))?;
    if let Some(feature) = connector.required_feature() {
        state.license.lock().unwrap().require(feature).map_err(full)?;
    }
    if protocol == "ssh" || protocol == "sftp" {
        resolve_jump(state, &mut values, &mut Vec::new())?;
    }
    let view = connector.manifest().view;
    let connection_id = uuid::Uuid::new_v4().to_string();
    let ctx = ConnectContext {
        app: app.clone(),
        session_name: name,
        values,
        cols: cols.max(2),
        rows: rows.max(2),
        sink: Arc::new(ChannelSink::new(on_event, app.clone(), connection_id.clone())),
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
    state.unlocked()?;
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(&connection_id).ok_or(t!("Session closed", "Session fermée"))?;
    connection.write(data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn term_resize(
    state: State<'_, AppState>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state.observers.lock().unwrap().resize(&connection_id, cols.max(2), rows.max(2));
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

pub(crate) fn files_of(state: &AppState, connection_id: &str) -> CmdResult<Arc<dyn RemoteFiles>> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(connection_id).ok_or(t!("Session closed", "Session fermée"))?;
    connection
        .files()
        .ok_or_else(|| t!("This protocol has no file browser", "Ce protocole ne propose pas d'explorateur de fichiers").into())
}

pub(crate) fn full(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    done: u64,
    total: u64,
}

#[tauri::command]
pub async fn fs_home(state: State<'_, AppState>, connection_id: String) -> CmdResult<String> {
    state.unlocked()?;
    let files = files_of(&state, &connection_id)?;
    files.home().await.map_err(full)
}

#[tauri::command]
pub async fn fs_list(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> CmdResult<Vec<RemoteEntry>> {
    state.unlocked()?;
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
    modified: Option<u64>,
) -> CmdResult<()> {
    state.unlocked()?;
    let files = files_of(&state, &connection_id)?;
    let progress = Arc::new(move |done, total| {
        let _ = on_progress.send(TransferProgress { done, total });
    });
    files.download(remote, PathBuf::from(&local), progress).await.map_err(full)?;
    // La copie garde la date du serveur : une comparaison suivante la voit identique.
    if let Some(secs) = modified {
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let _ = std::fs::File::options().write(true).open(&local).and_then(|f| f.set_modified(time));
    }
    Ok(())
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
    let modified = transfer::modified(Path::new(&local)).map(|(time, _)| time);
    files.upload(PathBuf::from(local), remote.clone(), progress).await.map_err(full)?;
    // Le fichier envoyé garde la date de l'original, si le protocole le permet.
    if let Some(secs) = modified.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
        let _ = files.set_modified(remote, secs.as_secs()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_mkdir(state: State<'_, AppState>, connection_id: String, path: String) -> CmdResult<()> {
    state.unlocked()?;
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
    state.unlocked()?;
    let files = files_of(&state, &connection_id)?;
    files.rename(from, to).await.map_err(full)
}

// ---------- Dossiers de sessions ----------

#[tauri::command]
pub fn list_folders(state: State<'_, AppState>) -> Vec<String> {
    // Verrouillé : rien n'est montré (rechargé au déverrouillage).
    if state.unlocked().is_err() {
        return Vec::new();
    }
    state.store.lock().unwrap().folders()
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    state.unlocked()?;
    state.store.lock().unwrap().create_folder(&path).map_err(full)
}

#[tauri::command]
pub fn rename_folder(state: State<'_, AppState>, from: String, to: String) -> CmdResult<()> {
    state.unlocked()?;
    state.store.lock().unwrap().rename_folder(&from, &to).map_err(full)
}

#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.unlocked()?;
    state.store.lock().unwrap().delete_folder(&path).map_err(full)
}

#[tauri::command]
pub fn move_sessions(state: State<'_, AppState>, ids: Vec<String>, folder: String) -> CmdResult<()> {
    state.unlocked()?;
    state.store.lock().unwrap().move_sessions(&ids, &folder).map_err(full)
}

/// Copie d'une session, mots de passe enregistrés compris.
#[tauri::command]
pub fn duplicate_session(state: State<'_, AppState>, id: String) -> CmdResult<Session> {
    state.unlocked()?;
    let mut store = state.store.lock().unwrap();
    let original = store.get(&id).ok_or(t!("Session not found", "Session introuvable"))?;
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
    // Verrouillé : rien n'est montré (rechargé au déverrouillage).
    if state.unlocked().is_err() {
        return Vec::new();
    }
    state.store.lock().unwrap().snippets()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, snippet: Snippet) -> CmdResult<Snippet> {
    state.unlocked()?;
    state.store.lock().unwrap().upsert_snippet(snippet).map_err(full)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.unlocked()?;
    state.store.lock().unwrap().delete_snippet(&id).map_err(full)
}

// ---------- Tunnels ----------

fn forwarder_of(state: &AppState, connection_id: &str) -> CmdResult<Arc<dyn PortForwarder>> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(connection_id).ok_or(t!("Session closed", "Session fermée"))?;
    connection
        .forwarder()
        .ok_or_else(|| t!("This protocol has no tunnels", "Ce protocole ne propose pas de tunnels").into())
}

#[tauri::command]
pub fn tunnel_list(state: State<'_, AppState>, connection_id: String) -> CmdResult<Vec<TunnelStatus>> {
    state.unlocked()?;
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
    state.unlocked()?;
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
    state.unlocked()?;
    let mut candidates = match source.as_str() {
        "ssh-config" => importers::ssh_config(&import_path(&source, path), &folder),
        "putty" => importers::putty(&folder),
        "mremoteng" => importers::mremoteng(&import_path(&source, path), &folder),
        _ => return Err(t!("Unknown import source", "Source d'import inconnue").into()),
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
    state.unlocked()?;
    let sessions = clean_imported(&state, sessions);
    state.store.lock().unwrap().add_sessions(sessions).map_err(full)
}

#[tauri::command]
pub fn export_backup(state: State<'_, AppState>, path: String, passphrase: Option<String>) -> CmdResult<usize> {
    state.unlocked()?;
    let (sessions, folders, snippets) = state.store.lock().unwrap().export_parts();
    let count = sessions.len();
    let notes = {
        let all = state.notes.lock().unwrap();
        sessions.iter().filter_map(|s| all.all().get(&s.id).map(|n| (s.id.clone(), n.clone()))).collect()
    };
    let credentials = state.credentials.lock().unwrap().list().into_iter().map(|mut c| { c.secret_keys.clear(); c }).collect();
    let backup = importers::Backup { app: "portunia".into(), version: 1, sessions, folders, snippets, notes, credentials };
    let text = importers::backup_text(&backup, passphrase.as_deref()).map_err(full)?;
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
pub fn import_backup(state: State<'_, AppState>, path: String, passphrase: Option<String>) -> CmdResult<BackupReport> {
    state.unlocked()?;
    let backup = importers::read_backup(&PathBuf::from(path), passphrase.as_deref()).map_err(full)?;
    let (added, skipped, snippets) = state
        .store
        .lock()
        .unwrap()
        .merge_backup(clean_imported(&state, backup.sessions), backup.folders, backup.snippets)
        .map_err(full)?;
    // Identifiants partagés absents : recréés sans mot de passe (à ressaisir).
    {
        let mut creds = state.credentials.lock().unwrap();
        for c in &backup.credentials {
            if creds.find(&c.id).is_none() && creds.find(&c.name).is_none() {
                creds.restore(c.clone()).map_err(err)?;
            }
        }
    }
    // Notes des sessions restaurées (une note existante est gardée).
    let mut notes = state.notes.lock().unwrap();
    for (id, text) in &backup.notes {
        if notes.get(id).is_empty() && state.store.lock().unwrap().get(id).is_some() {
            notes.set(id, text).map_err(err)?;
        }
    }
    Ok(BackupReport { added, skipped, snippets })
}

/// Suggestions d'un champ (ex. ports COM présents), fournies par l'extension.
#[tauri::command]
pub fn field_suggestions(state: State<'_, AppState>, protocol: String, source: String) -> Vec<ChoiceOption> {
    // Verrouillé : rien n'est montré (rechargé au déverrouillage).
    if state.unlocked().is_err() {
        return Vec::new();
    }
    // Identifiants partagés : proposés par leur nom.
    if source == "credentials" {
        return state
            .credentials
            .lock()
            .unwrap()
            .list()
            .into_iter()
            .map(|c| ChoiceOption { label: if c.username.is_empty() { c.auth } else { c.username }, value: c.name })
            .collect();
    }
    // Serveurs de rebond : les sessions SSH enregistrées (le cœur seul les connaît).
    if source == "ssh-sessions" {
        let mut list: Vec<ChoiceOption> = state
            .store
            .lock()
            .unwrap()
            .list()
            .into_iter()
            .filter(|s| s.protocol == "ssh")
            .map(|s| {
                let host = s.values.get("host").and_then(Value::as_str).unwrap_or("");
                let user = s.values.get("username").and_then(Value::as_str).unwrap_or("");
                ChoiceOption { label: if user.is_empty() { host.into() } else { format!("{user}@{host}") }, value: s.name }
            })
            .collect();
        list.sort_by(|a, b| a.value.to_lowercase().cmp(&b.value.to_lowercase()));
        return list;
    }
    state.registry.get(&protocol).map(|c| c.suggestions(&source)).unwrap_or_default()
}

/// Clavier / souris / presse-papiers vers un écran distant.
#[tauri::command]
pub fn screen_input(state: State<'_, AppState>, connection_id: String, event: InputEvent) -> CmdResult<()> {
    state.unlocked()?;
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(&connection_id).ok_or(t!("Session closed", "Session fermée"))?;
    connection.input(event).map_err(err)
}

// ---------- Licence ----------

#[tauri::command]
pub fn license_status(state: State<'_, AppState>) -> crate::license::LicenseStatus {
    state.license.lock().unwrap().status()
}

#[tauri::command]
pub fn license_activate(state: State<'_, AppState>, text: String) -> CmdResult<crate::license::LicenseStatus> {
    state.unlocked()?;
    let mut license = state.license.lock().unwrap();
    license.activate(&text).map_err(full)?;
    Ok(license.status())
}

#[tauri::command]
pub fn license_remove(state: State<'_, AppState>) -> CmdResult<crate::license::LicenseStatus> {
    state.unlocked()?;
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
    let change = lock.set_password(&current, &new).map_err(full)?;
    let status = lock.status();
    drop(lock);
    apply_data_change(&state, change)?;
    Ok(status)
}

#[tauri::command]
pub fn lock_disable(state: State<'_, AppState>, password: String) -> CmdResult<lock::LockStatus> {
    let mut lock = state.lock.lock().unwrap();
    // Les fichiers doivent être lus pour être remis en clair.
    lock.ensure_unlocked().map_err(err)?;
    let change = lock.disable(&password).map_err(full)?;
    let status = lock.status();
    drop(lock);
    apply_data_change(&state, change)?;
    Ok(status)
}

#[tauri::command]
pub fn lock_set_options(state: State<'_, AppState>, hello: bool, timeout_minutes: u32) -> CmdResult<lock::LockStatus> {
    let mut lock = state.lock.lock().unwrap();
    lock.ensure_unlocked().map_err(err)?;
    // macOS : activer Touch ID exige l'invite biométrique, donc `enable_touch_id` ; ici seuls le
    // délai et la désactivation sont permis (une interface détournée ne contourne pas l'invite).
    #[cfg(target_os = "macos")]
    if hello && !lock.touch_id_enabled() {
        return Err(t!("Use the Touch ID activation to enable it", "Utilisez l'activation Touch ID pour l'activer").into());
    }
    lock.set_options(hello, timeout_minutes).map_err(full)?;
    Ok(lock.status())
}

#[tauri::command]
pub fn lock_now(state: State<'_, AppState>) -> CmdResult<()> {
    state.lock.lock().unwrap().lock().map_err(full)
}

#[tauri::command]
pub fn unlock(state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let change = state.lock.lock().unwrap().unlock_with_password(&password).map_err(full)?;
    apply_data_change(&state, change)
}

/// Après un déverrouillage, relit les fichiers chiffrés ; après un changement du chiffrement
/// (mot de passe maître défini, migré ou retiré), les réécrit dans le nouveau mode.
fn apply_data_change(state: &AppState, change: lock::DataChange) -> CmdResult<()> {
    state.store.lock().unwrap().reload();
    state.notes.lock().unwrap().reload();
    state.credentials.lock().unwrap().reload();
    if change != lock::DataChange::None {
        state.store.lock().unwrap().rewrite().map_err(full)?;
        state.notes.lock().unwrap().rewrite().map_err(full)?;
        state.credentials.lock().unwrap().rewrite().map_err(full)?;
        let known = state.data_dir.join("known_hosts.json");
        if let Ok(crate::vault::Content::Text(text)) = crate::vault::read(&known) {
            crate::vault::write(&known, &text).map_err(full)?;
        }
    }
    if change == lock::DataChange::Decrypt {
        crate::vault::clear_key();
    }
    Ok(())
}

/// Capteur biométrique utilisable : « hello », « touchid » ou rien.
#[tauri::command]
pub fn biometric_kind() -> Option<&'static str> {
    lock::biometric_kind()
}

/// Garde RAII de l'invite Touch ID : libérée à la destruction (retour, erreur, panique, annulation).
#[cfg(target_os = "macos")]
struct PromptGuard(&'static std::sync::atomic::AtomicBool);

#[cfg(target_os = "macos")]
impl PromptGuard {
    /// `None` si une invite est déjà en cours.
    fn acquire(flag: &'static std::sync::atomic::AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .ok()
            .map(|_| Self(flag))
    }
}

#[cfg(target_os = "macos")]
impl Drop for PromptGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Une seule invite Touch ID à la fois, activation et déverrouillage confondus.
#[cfg(target_os = "macos")]
static PROMPT_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Active Touch ID : coffre déverrouillé requis, invite Touch ID qui doit réussir, puis la clé déjà
/// en mémoire est rangée dans le Trousseau (aucun mot de passe demandé). Annulation ou échec :
/// rien n'est stocké, l'option reste désactivée. Renvoie l'état à jour.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn enable_touch_id(app: AppHandle, state: State<'_, AppState>, timeout_minutes: u32) -> CmdResult<lock::LockStatus> {
    use crate::biometric_mac::{self, TouchId};
    state.unlocked()?;
    let Some(_prompt) = PromptGuard::acquire(&PROMPT_ACTIVE) else {
        return Err(t!("A Touch ID prompt is already open", "Une invite Touch ID est déjà ouverte").into());
    };
    // L'invite peut durer : le verrou de l'application n'est tenu que avant et après.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        lock::enable_touch_id(&state.lock, &TouchId, biometric_mac::enable_reason(), timeout_minutes)
    })
    .await
    .map_err(err)?;
    outcome.map_err(full)?;
    // `false` = annulé : l'état renvoyé montre l'option toujours désactivée.
    Ok(state.lock.lock().unwrap().status())
}

/// Touch ID n'existe que sous macOS.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn enable_touch_id(_timeout_minutes: u32) -> CmdResult<lock::LockStatus> {
    Err(t!("Touch ID is only available on macOS", "Touch ID n'existe que sous macOS").into())
}

/// Touch ID : vérifie l'utilisateur puis relit la clé du coffre dans le Trousseau. `Ok(false)` si
/// l'utilisateur annule ; toute autre cause d'échec est une erreur. Aucune clé n'est appliquée
/// sans une authentification réussie.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn unlock_biometric(state: State<'_, AppState>) -> CmdResult<bool> {
    use crate::biometric_mac::{self, BiometricError, KeychainStore, TouchId, UnlockError};
    if !state.lock.lock().unwrap().touch_id_enabled() {
        return Err(t!("Touch ID is not enabled for Portunia", "Touch ID n'est pas activé pour Portunia").into());
    }
    // Une invite à la fois : un second appel pendant l'invite en cours ne relance rien.
    let Some(_prompt) = PromptGuard::acquire(&PROMPT_ACTIVE) else {
        return Ok(false);
    };
    // L'invite Touch ID peut durer : le verrou de l'application n'est pas tenu pendant ce temps.
    let outcome = tauri::async_runtime::spawn_blocking(|| {
        biometric_mac::unlock_key(&TouchId, &KeychainStore::vault(), biometric_mac::unlock_reason())
    })
    .await
    .map_err(err)?;
    match outcome {
        Ok(key) => {
            state.lock.lock().unwrap().finish_biometric_unlock(key).map_err(full)?;
            apply_data_change(&state, lock::DataChange::None)?;
            Ok(true)
        }
        Err(UnlockError::Auth(BiometricError::Cancelled)) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Touch ID n'existe que sous macOS : ailleurs, refus (Windows passe par `unlock_hello`).
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn unlock_biometric() -> CmdResult<bool> {
    Err(t!("Touch ID is only available on macOS", "Touch ID n'existe que sous macOS").into())
}

/// Déverrouillage par Windows Hello (visage, empreinte, PIN).
#[tauri::command]
pub async fn unlock_hello(app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    if !state.lock.lock().unwrap().hello_enabled() {
        return Err(t!("Windows Hello is not enabled for Portunia", "Windows Hello n'est pas activé pour Portunia").into());
    }
    let window = app.get_webview_window("main").ok_or(t!("Window not found", "Fenêtre introuvable"))?;
    #[cfg(windows)]
    let hwnd = window.hwnd().map_err(err)?.0 as usize;
    #[cfg(not(windows))]
    let hwnd = { let _ = window; 0usize };
    let verified = tauri::async_runtime::spawn_blocking(move || {
        lock::hello::verify(hwnd as *mut core::ffi::c_void, t!("Unlock Portunia", "Déverrouiller Portunia"))
    })
    .await
    .map_err(err)?
    .map_err(full)?;
    if verified {
        state.lock.lock().unwrap().unlock_with_hello().map_err(full)?;
        apply_data_change(&state, lock::DataChange::None)?;
    }
    Ok(verified)
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
    // Verrouillé : les noms des dossiers ne sont pas montrés.
    if state.unlocked().is_err() {
        return HashMap::new();
    }
    state.store.lock().unwrap().folder_colors()
}

#[tauri::command]
pub fn set_folder_color(state: State<'_, AppState>, path: String, color: Option<String>) -> CmdResult<()> {
    state.unlocked()?;
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
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or(t!("Invalid file", "Fichier invalide"))?;
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
    let name = remote.rsplit('/').next().unwrap_or_default();
    if transfer::runs_when_opened(name) {
        return Err(t!(
            format!("« {name} » would be run by Windows instead of opening in an editor: editing refused for safety. Download it if you want to inspect it."),
            format!("« {name} » serait exécuté par Windows au lieu de s'ouvrir dans un éditeur : modification refusée par sécurité. Téléchargez-le si vous voulez l'examiner.")
        ));
    }
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
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("portunia-edition").join(&id));
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
    on_event: Channel,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    let connection_id = uuid::Uuid::new_v4().to_string();
    let sink: Arc<dyn Sink> = Arc::new(ChannelSink::new(on_event, app.clone(), connection_id.clone()));
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

// ---------- Serveurs de rebond (SSH) ----------

/// Rebonds enchaînés au plus.
const MAX_JUMPS: usize = 3;

/// Valeurs d'une session, mots de passe compris.
fn session_values(state: &AppState, session: &Session) -> CmdResult<HashMap<String, Value>> {
    let mut values = session.values.clone();
    // Seuls les champs du formulaire comptent : une valeur cachée (fichier modifié à la main,
    // ancienne importation) ne doit rien déclencher à la connexion.
    if let Some(connector) = state.registry.get(&session.protocol) {
        let manifest = connector.manifest();
        values.retain(|k, _| manifest.fields.iter().any(|f| f.key == *k));
    }
    for key in &session.secret_keys {
        if let Some(secret) = secrets::get(&session.id, key).map_err(err)? {
            values.insert(key.clone(), Value::String(secret));
        }
    }
    // Identifiants partagés : ils remplacent utilisateur, authentification et secrets.
    state.credentials.lock().unwrap().apply(&mut values).map_err(full)?;
    Ok(values)
}

/// Champ « jump » (nom d'une session SSH ou user@hôte:port, plusieurs séparés
/// par des virgules comme ProxyJump) → valeurs complètes dans `jumpHost`.
fn resolve_jump(state: &AppState, values: &mut HashMap<String, Value>, visited: &mut Vec<String>) -> CmdResult<()> {
    let spec = values.get("jump").and_then(Value::as_str).unwrap_or("").trim().to_string();
    // Sans champ « jump », un rebond déjà préparé (Gate) est gardé tel quel.
    if spec.is_empty() {
        return Ok(());
    }
    values.remove("jumpHost");
    // « a,b » : a d'abord, puis b, puis le serveur.
    let mut previous: Option<HashMap<String, Value>> = None;
    for hop in spec.split(',').map(str::trim).filter(|h| !h.is_empty()) {
        if visited.len() >= MAX_JUMPS {
            return Err(format!("Trop de serveurs de rebond enchaînés (maximum {MAX_JUMPS})"));
        }
        let mut hop_values = jump_values(state, hop, visited)?;
        if let Some(before) = previous.take() {
            hop_values.insert("jumpHost".into(), Value::Object(before.into_iter().collect()));
        }
        previous = Some(hop_values);
    }
    if let Some(last) = previous {
        values.insert("jumpHost".into(), Value::Object(last.into_iter().collect()));
    }
    Ok(())
}

fn jump_values(state: &AppState, hop: &str, visited: &mut Vec<String>) -> CmdResult<HashMap<String, Value>> {
    let found = state
        .store
        .lock()
        .unwrap()
        .list()
        .into_iter()
        .find(|s| s.protocol == "ssh" && (s.id == hop || s.name.eq_ignore_ascii_case(hop)));
    if let Some(session) = found {
        if visited.contains(&session.id) {
            return Err(format!("Boucle de serveurs de rebond : « {} » revient deux fois", session.name));
        }
        visited.push(session.id.clone());
        let mut values = session_values(state, &session)?;
        // La Gate n'ouvre pas ses propres tunnels.
        values.remove("tunnels");
        resolve_jump(state, &mut values, visited)?;
        return Ok(values);
    }
    visited.push(hop.to_string());
    let (user, rest) = hop
        .rsplit_once('@')
        .ok_or_else(|| format!("Serveur de rebond « {hop} » : aucune session SSH de ce nom (ou indiquez utilisateur@hôte)"))?;
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h, p.parse::<u16>().map_err(|_| format!("Port invalide pour le rebond « {hop} »"))?),
        _ => (rest.trim_matches(|c| c == '[' || c == ']'), 22),
    };
    Ok(HashMap::from([
        ("host".into(), Value::String(host.into())),
        ("port".into(), Value::from(port)),
        ("username".into(), Value::String(user.into())),
        ("auth".into(), Value::String("auto".into())),
    ]))
}

// ---------- Clés SSH ----------

#[tauri::command]
pub fn ssh_keys_list(state: State<'_, AppState>) -> CmdResult<Vec<keys::KeyInfo>> {
    state.unlocked()?;
    keys::list().map_err(full)
}

/// Commentaire proposé : utilisateur@ordinateur.
#[tauri::command]
pub fn ssh_key_default_comment() -> String {
    let user = std::env::var("USERNAME").unwrap_or_default();
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    format!("{user}@{host}").to_lowercase()
}

#[tauri::command]
pub async fn ssh_key_generate(
    state: State<'_, AppState>,
    name: String,
    kind: String,
    comment: String,
    passphrase: Option<String>,
) -> CmdResult<keys::KeyInfo> {
    state.unlocked()?;
    // Une clé RSA prend quelques secondes : hors du thread de l'interface.
    tauri::async_runtime::spawn_blocking(move || keys::generate(&name, &kind, &comment, passphrase.as_deref()))
        .await
        .map_err(err)?
        .map_err(full)
}

/// Ajoute la clé publique au fichier authorized_keys du serveur de la connexion.
#[tauri::command]
pub async fn ssh_key_install(state: State<'_, AppState>, connection_id: String, public: String) -> CmdResult<keys::Installed> {
    state.unlocked()?;
    let exec = {
        let connections = state.connections.lock().unwrap();
        let connection = connections.get(&connection_id).ok_or(t!("Session closed", "Session fermée"))?;
        connection.exec().ok_or(t!("This protocol cannot install a key", "Ce protocole ne permet pas d'installer une clé"))?
    };
    keys::install(exec.as_ref(), &public).await.map_err(full)
}

// ---------- Notes ----------

#[tauri::command]
pub fn note_get(state: State<'_, AppState>, session_id: String) -> CmdResult<String> {
    state.unlocked()?;
    Ok(state.notes.lock().unwrap().get(&session_id))
}

#[tauri::command]
pub fn note_set(state: State<'_, AppState>, session_id: String, text: String) -> CmdResult<()> {
    state.unlocked()?;
    state.notes.lock().unwrap().set(&session_id, &text).map_err(err)
}

/// Sessions qui ont une note.
#[tauri::command]
pub fn notes_list(state: State<'_, AppState>) -> Vec<String> {
    // Verrouillé : rien n'est montré (rechargé au déverrouillage).
    if state.unlocked().is_err() {
        return Vec::new();
    }
    state.notes.lock().unwrap().ids()
}

// ---------- Outils réseau ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NetEvent {
    /// Adresse résolue de la cible.
    Start { ip: String },
    Ping { seq: u32, echo: nettools::Echo },
    /// Saut de traceroute : adresse et temps des 3 essais (None = pas de réponse).
    Hop { hop: u8, from: String, rtts: Vec<Option<u32>> },
    Port(nettools::PortResult),
    Done { message: String },
    Error { message: String },
}

/// Opérations réseau en cours, interrompues par net_cancel.
static NET_JOBS: std::sync::LazyLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn net_job() -> (String, Arc<std::sync::atomic::AtomicBool>) {
    let id = uuid::Uuid::new_v4().to_string();
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    NET_JOBS.lock().unwrap().insert(id.clone(), flag.clone());
    (id, flag)
}

fn net_finish(id: &str, channel: &Channel<NetEvent>, result: anyhow::Result<String>) {
    NET_JOBS.lock().unwrap().remove(id);
    let _ = channel.send(match result {
        Ok(message) => NetEvent::Done { message },
        Err(e) => NetEvent::Error { message: format!("{e:#}") },
    });
}

#[tauri::command]
pub fn net_cancel(id: String) {
    if let Some(flag) = NET_JOBS.lock().unwrap().get(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn net_resolve(host: String) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || nettools::resolve(&host))
        .await
        .map_err(err)?
        .map(|ips| ips.into_iter().map(|ip| ip.to_string()).collect())
        .map_err(full)
}

/// Ping : `count` requêtes (0 = jusqu'à l'arrêt), une par seconde.
#[tauri::command]
pub fn net_ping(host: String, count: u32, on_event: Channel<NetEvent>) -> String {
    let (id, stop) = net_job();
    let job = id.clone();
    std::thread::spawn(move || {
        let result = (|| -> anyhow::Result<String> {
            let ip = nettools::resolve_v4(&host)?;
            let _ = on_event.send(NetEvent::Start { ip: ip.to_string() });
            let (mut sent, mut received, mut times) = (0u32, 0u32, Vec::new());
            while (count == 0 || sent < count) && !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let started = std::time::Instant::now();
                sent += 1;
                let echo = nettools::echo(ip, 128, std::time::Duration::from_secs(2))?;
                if let nettools::Echo::Reply { rtt, .. } = &echo {
                    received += 1;
                    times.push(*rtt);
                }
                let _ = on_event.send(NetEvent::Ping { seq: sent, echo });
                if let Some(rest) = std::time::Duration::from_secs(1).checked_sub(started.elapsed()) {
                    std::thread::sleep(rest);
                }
            }
            let loss = if sent == 0 { 0 } else { (sent - received) * 100 / sent };
            let stats = if times.is_empty() {
                String::new()
            } else {
                let avg = times.iter().sum::<u32>() / times.len() as u32;
                format!(" · min {} ms, moy {avg} ms, max {} ms", times.iter().min().unwrap(), times.iter().max().unwrap())
            };
            Ok(format!("{sent} envoyés, {received} reçus, {loss} % de perte{stats}"))
        })();
        net_finish(&job, &on_event, result);
    });
    id
}

#[tauri::command]
pub fn net_traceroute(host: String, on_event: Channel<NetEvent>) -> String {
    let (id, stop) = net_job();
    let job = id.clone();
    std::thread::spawn(move || {
        let result = (|| -> anyhow::Result<String> {
            let ip = nettools::resolve_v4(&host)?;
            let _ = on_event.send(NetEvent::Start { ip: ip.to_string() });
            for hop in 1..=30u8 {
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    return Ok(t!("Interrupted", "Interrompu").into());
                }
                let (mut from, mut rtts, mut arrived) = (String::new(), Vec::new(), false);
                for _ in 0..3 {
                    match nettools::echo(ip, hop, std::time::Duration::from_millis(1500))? {
                        nettools::Echo::Reply { from: f, rtt, .. } => { from = f; rtts.push(Some(rtt)); arrived = true; }
                        nettools::Echo::TtlExpired { from: f, rtt } => { from = f; rtts.push(Some(rtt)); }
                        nettools::Echo::Unreachable { from: f, .. } => { if !f.is_empty() { from = f; } rtts.push(None); arrived = true; }
                        nettools::Echo::Timeout => rtts.push(None),
                    }
                }
                let _ = on_event.send(NetEvent::Hop { hop, from, rtts });
                if arrived {
                    return Ok(format!("{ip} atteint en {hop} saut{}", if hop > 1 { "s" } else { "" }));
                }
            }
            Ok(format!("{ip} non atteint après 30 sauts"))
        })();
        net_finish(&job, &on_event, result);
    });
    id
}

/// Test de ports TCP, 64 à la fois ; résultats envoyés au fil de l'eau.
#[tauri::command]
pub fn net_ports(host: String, ports: String, on_event: Channel<NetEvent>) -> CmdResult<String> {
    let list = nettools::parse_ports(&ports).map_err(full)?;
    let (id, stop) = net_job();
    let job = id.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let host2 = host.clone();
            let ips = tauri::async_runtime::spawn_blocking(move || nettools::resolve(&host2)).await??;
            let ip = ips[0];
            let _ = on_event.send(NetEvent::Start { ip: ip.to_string() });
            let mut open = 0;
            for chunk in list.chunks(64) {
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    return Ok(t!("Interrupted", "Interrompu").to_string());
                }
                let checks = chunk.iter().map(|&p| nettools::check_port(ip, p, std::time::Duration::from_secs(3)));
                let mut set = tokio::task::JoinSet::new();
                for check in checks {
                    set.spawn(check);
                }
                let mut results = Vec::new();
                while let Some(r) = set.join_next().await {
                    results.push(r?);
                }
                results.sort_by_key(|r| r.port);
                for r in results {
                    if r.state == "open" {
                        open += 1;
                    }
                    let _ = on_event.send(NetEvent::Port(r));
                }
            }
            Ok::<_, anyhow::Error>(format!("{} port{} testé{}, {open} ouvert{}", list.len(), s(list.len()), s(list.len()), s(open)))
        }
        .await;
        net_finish(&job, &on_event, result);
    });
    Ok(id)
}

fn s(n: usize) -> &'static str {
    if n > 1 { "s" } else { "" }
}

#[tauri::command]
pub fn net_wake(mac: String, broadcast: Option<String>) -> CmdResult<String> {
    nettools::wake(&mac, broadcast.as_deref()).map_err(full)
}

// ---------- Identifiants partagés ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
    #[serde(flatten)]
    credential: Credential,
    /// Sessions qui l'utilisent.
    used_by: Vec<String>,
}

fn credential_users(state: &AppState, c: &Credential) -> Vec<String> {
    state
        .store
        .lock()
        .unwrap()
        .list()
        .into_iter()
        .filter(|s| {
            s.values
                .get("credential")
                .and_then(Value::as_str)
                .is_some_and(|k| k.trim() == c.id || k.trim().eq_ignore_ascii_case(&c.name))
        })
        .map(|s| s.name)
        .collect()
}

#[tauri::command]
pub fn credentials_list(state: State<'_, AppState>) -> CmdResult<Vec<CredentialView>> {
    state.unlocked()?;
    let list = state.credentials.lock().unwrap().list();
    Ok(list
        .into_iter()
        .map(|c| CredentialView { used_by: credential_users(&state, &c), credential: c })
        .collect())
}

#[tauri::command]
pub fn credential_save(state: State<'_, AppState>, credential: Credential, secrets: HashMap<String, String>) -> CmdResult<Credential> {
    state.unlocked()?;
    let old_name = state.credentials.lock().unwrap().find(&credential.id).map(|c| c.name.clone());
    let saved = state.credentials.lock().unwrap().save(credential, &secrets).map_err(full)?;
    // Renommé : les sessions qui le désignaient par son nom suivent.
    if let Some(old) = old_name.filter(|o| *o != saved.name) {
        let mut store = state.store.lock().unwrap();
        for mut s in store.list() {
            if s.values.get("credential").and_then(Value::as_str).is_some_and(|k| k.trim().eq_ignore_ascii_case(&old)) {
                s.values.insert("credential".into(), Value::String(saved.name.clone()));
                store.upsert(s).map_err(err)?;
            }
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn credential_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.unlocked()?;
    if let Some(c) = state.credentials.lock().unwrap().find(&id).cloned() {
        let users = credential_users(&state, &c);
        if !users.is_empty() {
            return Err(format!("« {} » est utilisé par {} : retirez-le de ces sessions d'abord", c.name, users.join(", ")));
        }
    }
    state.credentials.lock().unwrap().remove(&id).map_err(err)
}

// ---------- Tableau de bord du serveur (Pro) ----------

fn exec_of(state: &AppState, connection_id: &str) -> CmdResult<Arc<dyn RemoteExec>> {
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(connection_id).ok_or(t!("Session closed", "Session fermée"))?;
    connection.exec().ok_or_else(|| t!("This protocol cannot run commands", "Ce protocole ne permet pas de lancer des commandes").into())
}

// ---------- Extensions de fonction (voir extension.rs) ----------

/// Ce que le cœur prête aux extensions de fonction.
struct StateHost<'a> {
    state: &'a AppState,
    app: AppHandle,
    events: Option<Channel>,
}

/// Session SSH enregistrée, valeurs résolues : une connexion dédiée par commande.
struct SavedSsh {
    app: AppHandle,
    name: String,
    values: HashMap<String, Value>,
    data_dir: PathBuf,
}

impl crate::extension::SessionExec for SavedSsh {
    fn run(&self, command: String, timeout: std::time::Duration) -> crate::connector::BoxFuture<'_, crate::connector::ExecOutput> {
        Box::pin(async move {
            let ctx = ConnectContext {
                app: self.app.clone(), session_name: self.name.clone(), values: self.values.clone(), cols: 80, rows: 24,
                sink: Arc::new(crate::connectors::ssh::QuietSink), data_dir: self.data_dir.clone(),
            };
            crate::connectors::ssh::run_command(&ctx, &command, timeout).await
        })
    }
}

impl crate::extension::Host for StateHost<'_> {
    fn exec(&self, connection_id: &str) -> anyhow::Result<Arc<dyn RemoteExec>> {
        exec_of(self.state, connection_id).map_err(|e| anyhow::anyhow!(e))
    }

    fn files(&self, connection_id: &str) -> anyhow::Result<Arc<dyn RemoteFiles>> {
        files_of(self.state, connection_id).map_err(|e| anyhow::anyhow!(e))
    }

    fn ssh_session(&self, session_id: &str) -> anyhow::Result<Arc<dyn crate::extension::SessionExec>> {
        let state = self.state;
        let session = state.store.lock().unwrap().get(session_id).ok_or_else(|| anyhow::anyhow!(t!("Session not found", "Session introuvable")))?;
        if session.protocol != "ssh" {
            anyhow::bail!("{}", t!(format!("« {} » is not an SSH session", session.name), format!("« {} » n'est pas une session SSH", session.name)));
        }
        let mut values = session_values(state, &session).map_err(|e| anyhow::anyhow!(e))?;
        resolve_jump(state, &mut values, &mut Vec::new()).map_err(|e| anyhow::anyhow!(e))?;
        Ok(Arc::new(SavedSsh { app: self.app.clone(), name: session.name, values, data_dir: state.data_dir.clone() }))
    }

    fn events(&self) -> anyhow::Result<crate::extension::Emit> {
        let channel = self.events.clone().ok_or_else(|| anyhow::anyhow!(t!("This call needs an event channel", "Cet appel demande un canal d'évènements")))?;
        Ok(Arc::new(move |v: Value| {
            let _ = channel.send(InvokeResponseBody::Json(v.to_string()));
        }))
    }

    fn job(&self) -> Arc<crate::extension::Job> {
        let (id, stop) = net_job();
        let key = id.clone();
        Arc::new(crate::extension::Job::new(id, stop, move || {
            NET_JOBS.lock().unwrap().remove(&key);
        }))
    }

    fn spawn(&self, task: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>>) {
        tauri::async_runtime::spawn(task);
    }

    fn data_dir(&self) -> PathBuf {
        self.state.data_dir.clone()
    }

    fn documents_dir(&self) -> anyhow::Result<PathBuf> {
        Ok(self.app.path().document_dir()?)
    }

    fn observe(&self, connection_id: &str, key: &str, make: &mut dyn FnMut() -> anyhow::Result<Box<dyn crate::extension::SessionObserver>>) -> anyhow::Result<Value> {
        // Verrou des connexions tenu pendant l'ajout : une session qui se ferme en même temps
        // ne laisse pas d'observateur orphelin.
        let connections = self.state.connections.lock().unwrap();
        if !connections.contains_key(connection_id) {
            anyhow::bail!("{}", t!("Session closed", "Session fermée"));
        }
        self.state.observers.lock().unwrap().add(connection_id, key, make)
    }

    fn unobserve(&self, connection_id: &str, key: &str) -> anyhow::Result<Option<Value>> {
        let observer = self.state.observers.lock().unwrap().remove(connection_id, key);
        observer.map(|o| o.finish()).transpose()
    }

    fn open_connection<'a>(&'a self, protocol: &'a str, name: String, values: HashMap<String, Value>, cols: u16, rows: u16) -> crate::connector::BoxFuture<'a, Value> {
        Box::pin(async move {
            let channel = self.events.clone().ok_or_else(|| anyhow::anyhow!(t!("This call needs an event channel", "Cet appel demande un canal d'évènements")))?;
            let response = start_connection(&self.app, self.state, protocol, name, values, cols, rows, channel).await.map_err(|e| anyhow::anyhow!(e))?;
            Ok(serde_json::to_value(response)?)
        })
    }
}

/// Extension de fonction connue, avec ce que la licence permet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    #[serde(flatten)]
    manifest: crate::extension::ExtManifest,
    allowed: bool,
}

#[tauri::command]
pub fn ext_list(state: State<'_, AppState>) -> Vec<ExtInfo> {
    let license = state.license.lock().unwrap();
    state.extensions.manifests().into_iter().map(|m| {
        let allowed = m.feature.is_none_or(|f| license.allows(f));
        ExtInfo { manifest: m, allowed }
    }).collect()
}

/// Seule entrée des extensions de fonction : verrouillage et licence vérifiés ici, une fois.
#[tauri::command]
pub async fn ext_call(
    app: AppHandle,
    state: State<'_, AppState>,
    extension: String,
    method: String,
    args: Value,
    on_event: Channel,
) -> CmdResult<Value> {
    state.unlocked()?;
    let ext = state.extensions.get(&extension).ok_or_else(|| t!(format!("Unknown extension: {extension}"), format!("Extension inconnue : {extension}")))?;
    if let Some(feature) = ext.manifest().needs(&method) {
        state.license.lock().unwrap().require(feature).map_err(full)?;
    }
    // Le canal est toujours fourni ; seules les méthodes qui en ont besoin s'en servent.
    let host = StateHost { state: &state, app, events: Some(on_event) };
    ext.call(&host, &method, args).await.map_err(full)
}

/// Session enregistrée ouverte avec des valeurs en plus (ex. remoteCommand pour un conteneur).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connect_with(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    extra: HashMap<String, Value>,
    label: String,
    cols: u16,
    rows: u16,
    on_event: Channel,
    protocol: Option<String>,
) -> CmdResult<ConnectResponse> {
    state.unlocked()?;
    let session = state.store.lock().unwrap().get(&session_id).ok_or(t!("Session not found", "Session introuvable"))?;
    // Une session SSH peut s'ouvrir en fichiers seulement (SFTP), avec les mêmes réglages.
    let protocol = match protocol {
        Some(p) if p == "sftp" && session.protocol == "ssh" => p,
        Some(p) if p != session.protocol => return Err(t!(format!("« {} » cannot be opened as {p}", session.name), format!("« {} » ne s'ouvre pas en {p}", session.name))),
        _ => session.protocol.clone(),
    };
    let mut values = session_values(&state, &session)?;
    values.extend(extra);
    start_connection(&app, &state, &protocol, label, values, cols, rows, on_event).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une seule invite Touch ID à la fois : la garde est libérée à la sortie, y compris sur panique.
    #[cfg(target_os = "macos")]
    #[test]
    fn garde_d_invite_unique_et_liberee_dans_tous_les_cas() {
        use std::sync::atomic::AtomicBool;
        static FLAG: AtomicBool = AtomicBool::new(false);
        let first = PromptGuard::acquire(&FLAG).expect("première invite");
        assert!(PromptGuard::acquire(&FLAG).is_none(), "second appel refusé");
        drop(first);
        assert!(PromptGuard::acquire(&FLAG).is_some(), "libérée après usage");
        let result = std::panic::catch_unwind(|| {
            let _guard = PromptGuard::acquire(&FLAG).unwrap();
            panic!("échec pendant l'invite");
        });
        assert!(result.is_err());
        assert!(PromptGuard::acquire(&FLAG).is_some(), "libérée après panique");
    }

    /// `biometric_kind` ne renvoie que le capteur de la plateforme courante (ou rien).
    #[test]
    fn biometric_kind_correspond_a_la_plateforme() {
        let expected = if cfg!(windows) { "hello" } else if cfg!(target_os = "macos") { "touchid" } else { "aucun" };
        if let Some(kind) = biometric_kind() {
            assert_eq!(kind, expected);
        }
    }
}
