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

use crate::connector::{ConnectContext, FieldKind, Manifest, Outcome, Sink, TerminalConnection, ViewKind};
use crate::registry::Registry;
use crate::secrets;
use crate::store::{Session, Store};

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
    session.folder = session.folder.trim().to_string();
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
