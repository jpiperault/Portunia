// Appels vers le cœur Rust (voir src-tauri/src/commands.rs).
import { Channel, invoke as rawInvoke, InvokeArgs } from '@tauri-apps/api/core';
import { LANG } from './i18n';

// Le cœur écrit ses messages dans la langue de l'interface : on la lui donne avant tout autre appel.
const languageReady = rawInvoke('set_language', { lang: LANG }).catch(() => {});
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  await languageReady;
  return rawInvoke<T>(cmd, args);
}

export type ViewKind = 'terminal' | 'screen' | 'desktop' | 'web' | 'files';

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
  /** Masqué quand cet autre champ est rempli. */
  hiddenBy?: string;
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
  kind: 'local' | 'dynamic' | 'remote';
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

/** Octets du terminal (binaire brut, regroupés côté cœur), ou événement. */
export type TermEvent =
  | ArrayBuffer
  | { event: 'closed'; data: string | null }
  | { event: 'screen'; data: ScreenEvent }
  | { event: 'confirm'; data: { id: string; question: ConnectionQuestion } };

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
  exportBackup: (path: string, passphrase: string | null) => invoke<number>('export_backup', { path, passphrase }),
  importBackup: (path: string, passphrase: string | null) => invoke<{ added: number; skipped: number; snippets: number }>('import_backup', { path, passphrase }),

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
  /** Données chiffrées sur le disque (mot de passe maître défini). */
  encrypted: boolean;
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

// ---------- Connexion rapide ----------

export function connectQuick(protocol: string, name: string, values: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<ConnectResponse>('connect_quick', { protocol, name, values, cols, rows, onEvent: channel });
}

// ---------- Bastions Heimdia ----------

export interface BastionServer {
  nom: string;
  dossier: string;
  mode: 'coffre' | 'enregistre' | 'rebond';
  /** Absent sur un bastion antérieur à la 0.6 : SSH. */
  protocole?: 'ssh' | 'rdp';
  hote: string;
  port: number;
  compte: string | null;
  sftp: boolean;
  tunnels: boolean;
}

export interface Bastion {
  id: string;
  name: string;
  host: string;
  apiPort: number;
  sshPort: number;
  apiFingerprint: string;
  sshFingerprint: string;
  login: string;
  role: 'user' | 'auditor' | 'admin';
  expires: string;
  rememberAllowed: boolean;
  ownReplay: boolean;
  servers: BastionServer[];
  connected: boolean;
  passwordSaved: boolean;
}

export interface BastionLogin {
  id?: string;
  host: string;
  apiPort: number;
  fingerprint: string;
  login: string;
  password?: string;
  code?: string;
  newPassword?: string;
  remember: boolean;
}

/** Réponse de connexion : « ok » ou l'étape suivante demandée par le bastion. */
export type BastionLoginAnswer =
  | { etat: 'ok'; bastion: Bastion }
  | { etat: 'code_requis' }
  | { etat: 'changer_mot_de_passe' }
  | { etat: 'enrolement'; secret: string; uri: string };

export const bastions = {
  list: () => invoke<Bastion[]>('bastion_list'),
  probe: (address: string) => invoke<{ host: string; apiPort: number; fingerprint: string; info: { nom: string; version: string; memo_mot_de_passe: boolean } }>('bastion_probe', { address }),
  login: (request: BastionLogin) => invoke<BastionLoginAnswer>('bastion_login', { request }),
  logout: (id: string) => invoke<void>('bastion_logout', { id }),
  remove: (id: string) => invoke<void>('bastion_remove', { id }),
  servers: (id: string) => invoke<Bastion>('bastion_servers', { id }),
  admin: <T = any>(id: string, method: string, path: string, body?: unknown) => invoke<T>('bastion_admin', { id, method, path, body: body ?? null }),
  journalCsv: (id: string, query: string, dest: string) => invoke<void>('bastion_journal_csv', { id, query, dest }),
  /** Écrit un export de l'audit (enregistrement, transcription) dans le fichier choisi. */
  exportFile: (dest: string, content: string) => invoke<void>('bastion_export', { dest, content }),
  /** Relecture d'une session Bureau à distance : le moteur RDP décode l'image enregistrée. */
  rdpReplay: async (id: string, session: string, onMessage: (m: any) => void) => {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    const replay = await invoke<string>('bastion_rdp_replay', { id, session, onEvent: channel });
    return {
      seek: (t: number) => { invoke('bastion_rdp_replay_seek', { replay, t }).catch(() => {}); },
      close: () => { invoke('bastion_rdp_replay_close', { replay }).catch(() => {}); },
    };
  },
  qr: (text: string) => invoke<string>('qr_svg', { text }),
};

export function connectBastion(id: string, server: string, extra: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<ConnectResponse>('bastion_connect', { id, server, extra, cols, rows, onEvent: channel });
}

// ---------- Clés SSH ----------

export interface KeyInfo {
  name: string;
  path: string;
  algorithm: string;
  fingerprint: string;
  comment: string;
  public: string;
  encrypted: boolean;
}

export const sshKeys = {
  list: () => invoke<KeyInfo[]>('ssh_keys_list'),
  defaultComment: () => invoke<string>('ssh_key_default_comment'),
  generate: (name: string, kind: 'ed25519' | 'rsa', comment: string, passphrase: string | null) =>
    invoke<KeyInfo>('ssh_key_generate', { name, kind, comment, passphrase }),
  install: (connectionId: string, publicKey: string) =>
    invoke<'added' | 'alreadyThere'>('ssh_key_install', { connectionId, public: publicKey }),
};

// ---------- Notes ----------

export const notes = {
  get: (sessionId: string) => invoke<string>('note_get', { sessionId }),
  set: (sessionId: string, text: string) => invoke<void>('note_set', { sessionId, text }),
  list: () => invoke<string[]>('notes_list'),
};

// ---------- Outils réseau ----------

export type Echo =
  | { kind: 'reply'; from: string; rtt: number; ttl: number }
  | { kind: 'ttlExpired'; from: string; rtt: number }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; from: string; reason: string };

export interface PortResult { port: number; state: 'open' | 'closed' | 'filtered'; ms: number | null; service: string }

export type NetEvent =
  | { type: 'start'; ip: string }
  | { type: 'ping'; seq: number; echo: Echo }
  | { type: 'hop'; hop: number; from: string; rtts: (number | null)[] }
  | ({ type: 'port' } & PortResult)
  | { type: 'done'; message: string }
  | { type: 'error'; message: string };

function netChannel(onEvent: (e: NetEvent) => void) {
  const channel = new Channel<NetEvent>();
  channel.onmessage = onEvent;
  return channel;
}

export const net = {
  resolve: (host: string) => invoke<string[]>('net_resolve', { host }),
  ping: (host: string, count: number, onEvent: (e: NetEvent) => void) => invoke<string>('net_ping', { host, count, onEvent: netChannel(onEvent) }),
  traceroute: (host: string, onEvent: (e: NetEvent) => void) => invoke<string>('net_traceroute', { host, onEvent: netChannel(onEvent) }),
  ports: (host: string, ports: string, onEvent: (e: NetEvent) => void) => invoke<string>('net_ports', { host, ports, onEvent: netChannel(onEvent) }),
  cancel: (id: string) => invoke<void>('net_cancel', { id }),
  wake: (mac: string, broadcast: string | null) => invoke<string>('net_wake', { mac, broadcast }),
};

// ---------- Identifiants partagés ----------

export interface Credential {
  id: string;
  name: string;
  username: string;
  auth: 'password' | 'key' | 'agent';
  keyPath: string;
  domain: string;
  secretKeys: string[];
}

export const credentials = {
  list: () => invoke<(Credential & { usedBy: string[] })[]>('credentials_list'),
  save: (credential: Credential, secrets: Record<string, string>) => invoke<Credential>('credential_save', { credential, secrets }),
  remove: (id: string) => invoke<void>('credential_delete', { id }),
};

// ---------- Tableau de bord du serveur ----------

export interface ServerStats {
  os: string;
  kernel: string;
  hostname: string;
  uptimeSecs: number;
  load: [number, number, number];
  cpus: number;
  cpuPercent: number;
  memTotalKb: number;
  memAvailableKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  disks: { mount: string; fs: string; totalKb: number; usedKb: number }[];
  processes: { pid: number; cpu: number; mem: number; name: string }[];
  failedServices: string[];
}

export const serverStats = (connectionId: string) => invoke<ServerStats>('server_stats', { connectionId });

// ---------- Commande sur plusieurs serveurs ----------

export type MultiEvent =
  | { type: 'result'; sessionId: string; status: number | null; stdout: string; stderr: string; ms: number }
  | { type: 'failed'; sessionId: string; error: string; ms: number }
  | { type: 'done'; ok: number; failed: number };

export function multiExec(sessionIds: string[], command: string, timeoutSecs: number, onEvent: (e: MultiEvent) => void) {
  const channel = new Channel<MultiEvent>();
  channel.onmessage = onEvent;
  return invoke<string>('multi_exec', { sessionIds, command, timeoutSecs, onEvent: channel });
}

// ---------- Conteneurs ----------

export interface Container { id: string; name: string; image: string; state: string; status: string }
export interface Pod { namespace: string; name: string; ready: string; status: string; restarts: string; age: string }
export type Source<T> = { state: 'absent' } | { state: 'error'; message: string } | { state: 'ok'; items: T[] };
export interface Inventory { docker: Source<Container>; kube: Source<Pod> }

export const containers = {
  list: (connectionId: string) => invoke<Inventory>('containers_list', { connectionId }),
  action: (connectionId: string, kind: 'docker' | 'kube', action: string, id: string, namespace?: string) =>
    invoke<string>('container_action', { connectionId, kind, action, id, namespace: namespace ?? null }),
  command: (kind: 'docker' | 'kube', what: 'shell' | 'logs', id: string, namespace?: string) =>
    invoke<string>('container_command', { kind, what, id, namespace: namespace ?? null }),
};

/** Session enregistrée ouverte avec des valeurs en plus (commande distante…). */
export function connectWith(sessionId: string, extra: Record<string, unknown>, label: string, cols: number, rows: number, onEvent: (e: TermEvent) => void) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<ConnectResponse>('connect_with', { sessionId, extra, label, cols, rows, onEvent: channel });
}

/** Question posée pendant une connexion (empreinte d'un nouveau serveur…). */
export interface ConnectionQuestion { title: string; message: string; detail: string; accept: string; reject: string }

export const answerConfirm = (id: string, accept: boolean) => invoke<void>('confirm_answer', { id, accept });
