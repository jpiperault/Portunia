// Appels vers le cœur Rust (voir src-tauri/src/commands.rs).
import { Channel, invoke } from '@tauri-apps/api/core';

export type ViewKind = 'terminal' | 'screen' | 'desktop' | 'web';

export interface ChoiceOption { value: string; label: string }

export type FieldKind =
  | { type: 'text' }
  | { type: 'number' }
  | { type: 'secret' }
  | { type: 'file' }
  | { type: 'bool' }
  | { type: 'choice'; options: ChoiceOption[] }
  | { type: 'tunnels' }
  | { type: 'suggest'; source: string };

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default?: unknown;
  placeholder?: string;
  showIf?: { key: string; equals: string };
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  view: ViewKind;
  builtin: boolean;
  fileBrowser: boolean;
  portForwarding: boolean;
  fields: Field[];
}

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

export interface TransferProgress { done: number; total: number }

export interface TunnelSpec {
  id: string;
  /** local = ssh -L (un port du PC mène à une machine vue depuis le serveur) ; dynamic = proxy SOCKS (ssh -D). */
  kind: 'local' | 'dynamic';
  bindPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface TunnelStatus {
  spec: TunnelSpec;
  connections: number;
  lastError: string | null;
}

export type ImportSource = 'ssh-config' | 'putty' | 'mremoteng';

export interface ImportCandidate {
  session: Session;
  note: string | null;
  duplicate: boolean;
}

export type SnippetScope =
  | { kind: 'all' }
  | { kind: 'folder'; path: string }
  | { kind: 'session'; id: string };

export interface Snippet {
  id: string;
  name: string;
  command: string;
  scope: SnippetScope;
  /** Appuyer sur Entrée après la commande. */
  run: boolean;
}

function progressChannel(onProgress: (p: TransferProgress) => void) {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return channel;
}

export interface Session {
  id: string;
  name: string;
  folder: string;
  protocol: string;
  values: Record<string, unknown>;
  tags: string[];
  secretKeys: string[];
}

export type TermEvent =
  | { event: 'data'; data: string }
  | { event: 'closed'; data: string | null }
  | { event: 'screen'; data: ScreenEvent };

export type ScreenEvent =
  | { type: 'resize'; width: number; height: number }
  | { type: 'image'; x: number; y: number; width: number; height: number; rgba: string }
  | { type: 'jpeg'; x: number; y: number; width: number; height: number; data: string }
  | { type: 'copy'; x: number; y: number; width: number; height: number; srcX: number; srcY: number }
  | { type: 'bell' }
  | { type: 'clipboard'; text: string };

export type InputEvent =
  | { type: 'key'; keysym: number; down: boolean; code?: string }
  | { type: 'pointer'; x: number; y: number; buttons: number }
  | { type: 'clipboard'; text: string }
  | { type: 'resize'; width: number; height: number };

export interface ConnectResponse {
  connectionId: string | null;
  view: ViewKind;
  message: string | null;
}

export const api = {
  listProtocols: () => invoke<Manifest[]>('list_protocols'),
  listSessions: () => invoke<Session[]>('list_sessions'),
  saveSession: (session: Session, secrets: Record<string, string>) =>
    invoke<Session>('save_session', { input: { session, secrets } }),
  deleteSession: (id: string) => invoke<void>('delete_session', { id }),
  connect(sessionId: string, cols: number, rows: number, onEvent: (e: TermEvent) => void) {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<ConnectResponse>('connect', { sessionId, cols, rows, onEvent: channel });
  },
  termWrite: (connectionId: string, data: string) => invoke<void>('term_write', { connectionId, data }),
  termResize: (connectionId: string, cols: number, rows: number) =>
    invoke<void>('term_resize', { connectionId, cols, rows }),
  disconnect: (connectionId: string) => invoke<void>('disconnect', { connectionId }),
  screenInput: (connectionId: string, event: InputEvent) => invoke<void>('screen_input', { connectionId, event }),

  listFolders: () => invoke<string[]>('list_folders'),
  createFolder: (path: string) => invoke<string>('create_folder', { path }),
  renameFolder: (from: string, to: string) => invoke<void>('rename_folder', { from, to }),
  deleteFolder: (path: string) => invoke<void>('delete_folder', { path }),
  moveSessions: (ids: string[], folder: string) => invoke<void>('move_sessions', { ids, folder }),
  duplicateSession: (id: string) => invoke<Session>('duplicate_session', { id }),

  tunnelList: (connectionId: string) => invoke<TunnelStatus[]>('tunnel_list', { connectionId }),
  tunnelStart: (connectionId: string, spec: TunnelSpec) => invoke<void>('tunnel_start', { connectionId, spec }),
  tunnelStop: (connectionId: string, id: string) => invoke<void>('tunnel_stop', { connectionId, id }),

  importDefaultPath: (source: ImportSource) => invoke<string>('import_default_path', { source }),
  importPreview: (source: ImportSource, path: string | null, folder: string) =>
    invoke<ImportCandidate[]>('import_preview', { source, path, folder }),
  importApply: (sessions: Session[]) => invoke<number>('import_apply', { sessions }),
  exportBackup: (path: string) => invoke<number>('export_backup', { path }),
  importBackup: (path: string) => invoke<{ added: number; skipped: number; snippets: number }>('import_backup', { path }),

  fieldSuggestions: (protocol: string, source: string) => invoke<ChoiceOption[]>('field_suggestions', { protocol, source }),

  listSnippets: () => invoke<Snippet[]>('list_snippets'),
  saveSnippet: (snippet: Snippet) => invoke<Snippet>('save_snippet', { snippet }),
  deleteSnippet: (id: string) => invoke<void>('delete_snippet', { id }),

  fsHome: (connectionId: string) => invoke<string>('fs_home', { connectionId }),
  fsList: (connectionId: string, path: string) => invoke<RemoteEntry[]>('fs_list', { connectionId, path }),
  fsDownload: (connectionId: string, remote: string, local: string, onProgress: (p: TransferProgress) => void) =>
    invoke<void>('fs_download', { connectionId, remote, local, onProgress: progressChannel(onProgress) }),
  fsUpload: (connectionId: string, local: string, remote: string, onProgress: (p: TransferProgress) => void) =>
    invoke<void>('fs_upload', { connectionId, local, remote, onProgress: progressChannel(onProgress) }),
  fsMkdir: (connectionId: string, path: string) => invoke<void>('fs_mkdir', { connectionId, path }),
  fsRemove: (connectionId: string, path: string, isDir: boolean) => invoke<void>('fs_remove', { connectionId, path, isDir }),
  fsRename: (connectionId: string, from: string, to: string) => invoke<void>('fs_rename', { connectionId, from, to }),
};

/** Les erreurs Rust arrivent sous forme de texte. */
export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
}

// ---------- Licence et verrouillage ----------

export type Edition = 'free' | 'pro' | 'team';

export interface LicenseStatus {
  edition: Edition;
  preview: boolean;
  license: { id: string; name: string; email: string; edition: Edition; seats: number; issued: string; expires: string | null } | null;
  expired: boolean;
  features: { feature: string; label: string; edition: Edition; allowed: boolean }[];
}

export interface LockStatus {
  enabled: boolean;
  locked: boolean;
  hello: boolean;
  helloAvailable: boolean;
  timeoutMinutes: number;
}

export const security = {
  licenseStatus: () => invoke<LicenseStatus>('license_status'),
  licenseActivate: (text: string) => invoke<LicenseStatus>('license_activate', { text }),
  licenseRemove: () => invoke<LicenseStatus>('license_remove'),
  lockStatus: () => invoke<LockStatus>('lock_status'),
  lockSetPassword: (current: string, next: string) => invoke<LockStatus>('lock_set_password', { current, new: next }),
  lockDisable: (password: string) => invoke<LockStatus>('lock_disable', { password }),
  lockSetOptions: (hello: boolean, timeoutMinutes: number) => invoke<LockStatus>('lock_set_options', { hello, timeoutMinutes }),
  lockNow: () => invoke<void>('lock_now'),
  unlock: (password: string) => invoke<void>('unlock', { password }),
  unlockHello: () => invoke<boolean>('unlock_hello'),
};

// ---------- Enregistrement des sessions ----------

export interface RecordingInfo { path: string; name: string; size: number; modified: number }

export const recordings = {
  defaultDir: () => invoke<string>('recording_default_dir'),
  start: (connectionId: string, stamp: string, title: string, cols: number, rows: number, dir: string | null) =>
    invoke<string>('recording_start', { connectionId, stamp, title, cols, rows, dir }),
  stop: (connectionId: string) => invoke<string | null>('recording_stop', { connectionId }),
  list: (dir: string | null) => invoke<RecordingInfo[]>('recordings_list', { dir }),
  read: (dir: string | null, path: string) => invoke<string>('recording_read', { dir, path }),
  remove: (dir: string | null, path: string) => invoke<void>('recording_delete', { dir, path }),
};

// ---------- Couleurs de dossier ----------

export const folderColors = {
  list: () => invoke<Record<string, string>>('folder_colors'),
  set: (path: string, color: string | null) => invoke<void>('set_folder_color', { path, color }),
};

// ---------- Dossiers entiers et édition distante ----------

export type EditEvent = { type: 'uploaded'; at: number } | { type: 'error'; message: string };

function transferChannel(onProgress: (p: TransferProgress) => void) {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return channel;
}

export const remoteFiles = {
  downloadDir: (connectionId: string, remote: string, local: string, onProgress: (p: TransferProgress) => void) =>
    invoke<number>('fs_download_dir', { connectionId, remote, local, onProgress: transferChannel(onProgress) }),
  uploadAny: (connectionId: string, local: string, remoteDir: string, onProgress: (p: TransferProgress) => void) =>
    invoke<number>('fs_upload_any', { connectionId, local, remoteDir, onProgress: transferChannel(onProgress) }),
  editStart: (connectionId: string, remote: string, onEvent: (e: EditEvent) => void) => {
    const channel = new Channel<EditEvent>();
    channel.onmessage = onEvent;
    return invoke<string>('fs_edit_start', { connectionId, remote, onEvent: channel });
  },
  editStop: (id: string) => invoke<void>('fs_edit_stop', { id }),
};

// ---------- Shells locaux ----------

export interface ShellSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  /** pwsh, powershell, cmd, wsl, git, custom */
  icon: string;
}

export const shells = {
  detect: () => invoke<ShellSpec[]>('shells_detect'),
  connect(shell: ShellSpec, cols: number, rows: number, onEvent: (e: TermEvent) => void) {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<ConnectResponse>('connect_local', { shell, cols, rows, onEvent: channel });
  },
  openElevated: (shell: ShellSpec) => invoke<void>('open_shell_elevated', { shell }),
};
