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
  /** Proposée dans le catalogue : à installer d'abord (sauf si des sessions l'utilisent déjà). */
  catalog: boolean;
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

export interface SyncSide { size: number; modified: number | null; isDir: boolean }
export type SyncStatus = 'onlyLocal' | 'onlyRemote' | 'localNewer' | 'remoteNewer' | 'different' | 'conflict';
/** Écart entre les deux côtés ; `path` est relatif, séparé par « / ». */
export interface SyncDiff { path: string; local: SyncSide | null; remote: SyncSide | null; status: SyncStatus }
export interface Comparison { diffs: SyncDiff[]; same: number; excluded: number }

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
  | { type: 'clipboard'; text: string }
  // Bureau à distance : copie de fichiers par le presse-papiers.
  | { type: 'files'; allowed: boolean }
  | { type: 'remoteFiles'; available: boolean }
  | { type: 'filesOffered'; count: number }
  | { type: 'fileSent'; name: string }
  | { type: 'fileProgress'; name: string; done: number; total: number }
  | { type: 'filesSaved'; dir: string; count: number }
  | { type: 'fileError'; code: string; name: string | null };

export type InputEvent =
  | { type: 'key'; keysym: number; down: boolean; code?: string }
  | { type: 'pointer'; x: number; y: number; buttons: number }
  | { type: 'clipboard'; text: string }
  | { type: 'resize'; width: number; height: number }
  | { type: 'sendFiles'; paths: string[] }
  | { type: 'fetchFiles'; dir: string };

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
  /** `modified` : date du fichier sur le serveur, donnée à la copie (secondes Unix). */
  fsDownload: (connectionId: string, remote: string, local: string, onProgress: (p: TransferProgress) => void, modified?: number | null) =>
    invoke<void>('fs_download', { connectionId, remote, local, onProgress: progressChannel(onProgress), modified: modified ?? null }),
  /** Écarts entre un dossier de ce PC et un dossier du serveur (Pro). */
  fsCompare: (connectionId: string, local: string, remote: string, bySize: boolean, exclude: string[]) =>
    invoke<Comparison>('fs_compare', { connectionId, local, remote, bySize, exclude }),
  fsUpload: (connectionId: string, local: string, remote: string, onProgress: (p: TransferProgress) => void) =>
    invoke<void>('fs_upload', { connectionId, local, remote, onProgress: progressChannel(onProgress) }),
  fsMkdir: (connectionId: string, path: string) => invoke<void>('fs_mkdir', { connectionId, path }),
  fsRemove: (connectionId: string, path: string, isDir: boolean) => invoke<void>('fs_remove', { connectionId, path, isDir }),
  fsRename: (connectionId: string, from: string, to: string) => invoke<void>('fs_rename', { connectionId, from, to }),
  // Fichiers de ce PC (volet gauche des sessions de fichiers) ; chemin vide = lecteurs.
  localHome: (start?: string) => invoke<string>('local_home', { start: start ?? null }),
  localList: (path: string) => invoke<RemoteEntry[]>('local_list', { path }),
  localMkdir: (path: string) => invoke<void>('local_mkdir', { path }),
  localRename: (from: string, to: string) => invoke<void>('local_rename', { from, to }),
  localReveal: (path: string) => invoke<void>('local_reveal', { path }),
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

// ---------- Gates ----------

export interface GateServer {
  nom: string;
  dossier: string;
  mode: 'coffre' | 'enregistre' | 'rebond';
  /** Absent sur une Gate antérieur à la 0.6 : SSH. */
  protocole?: 'ssh' | 'rdp' | 'http' | 'https';
  hote: string;
  port: number;
  compte: string | null;
  sftp: boolean;
  tunnels: boolean;
  /** Gate 0.31 : entrée RDP native ouverte pour ce serveur (mstsc, Windows App…). */
  rdp_natif?: boolean;
  /** Gate 0.33 : texte choisi par l'administrateur (vignette du portail, info-bulle). */
  description?: string;
}

export interface Gate {
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
  servers: GateServer[];
  connected: boolean;
  passwordSaved: boolean;
  /** Noms d'hôte publiés par Cloudflare en TCP (Gate 0.41) : accès de l'extérieur. */
  cloudflare?: { api: string; ssh: string; rdp: string } | null;
}

export interface GateLogin {
  id?: string;
  host: string;
  apiPort: number;
  fingerprint: string;
  login: string;
  password?: string;
  code?: string;
  newPassword?: string;
  /** Premier contact passé par Cloudflare (cloudflared sur le poste). */
  cloudflare?: boolean;
  remember: boolean;
}

/** Réponse de connexion : « ok » ou l'étape suivante demandée par la Gate. */
export type GateLoginAnswer =
  | { etat: 'ok'; gate: Gate }
  | { etat: 'code_requis' }
  | { etat: 'changer_mot_de_passe' }
  | { etat: 'enrolement'; secret: string; uri: string };

export const gates = {
  list: () => invoke<Gate[]>('gate_list'),
  /** Relais d'assistance de la Gate : actif, autorisé pour moi, adresse à donner. */
  assistStatus: (id: string) => invoke<import('./assist').AssistStatus>('gate_assist_status', { id }),
  probe: (address: string) => invoke<{ host: string; apiPort: number; fingerprint: string; cloudflare?: boolean; info: { nom: string; version: string; memo_mot_de_passe: boolean } }>('gate_probe', { address }),
  login: (request: GateLogin) => invoke<GateLoginAnswer>('gate_login', { request }),
  logout: (id: string) => invoke<void>('gate_logout', { id }),
  remove: (id: string) => invoke<void>('gate_remove', { id }),
  servers: (id: string) => invoke<Gate>('gate_servers', { id }),
  /** Fichier .rdp à usage unique ouvert dans le client RDP du système ; renvoie l'adresse appelée. */
  nativeRdp: (id: string, server: string, account?: string, password?: string) => invoke<string>('gate_native_rdp', { id, server, account: account ?? null, password: password ?? null }),
  admin: <T = any>(id: string, method: string, path: string, body?: unknown) => invoke<T>('gate_admin', { id, method, path, body: body ?? null }),
  journalCsv: (id: string, query: string, dest: string) => invoke<void>('gate_journal_csv', { id, query, dest }),
  /** Écrit un export de l'audit (enregistrement, transcription) dans le fichier choisi. */
  exportFile: (dest: string, content: string) => invoke<void>('gate_export', { dest, content }),
  /** Lecteur détaché : la relecture dans sa propre fenêtre. */
  openReplayWindow: (id: string, session: string, reveal: boolean, title: string) => invoke<void>('gate_replay_window', { id, session, reveal, title }),
  /** Fichier binaire (vidéo) : octets bruts, chemin en hexadécimal dans un en-tête. */
  exportBytes: async (dest: string, data: Blob) => {
    const hex = [...new TextEncoder().encode(dest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await rawInvoke<void>('gate_export_bytes', new Uint8Array(await data.arrayBuffer()), { headers: { 'x-dest': hex } });
  },
  /** Relecture d'une session Bureau à distance : le moteur RDP décode l'image enregistrée. */
  rdpReplay: async (id: string, session: string, onMessage: (m: any) => void) => {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    const replay = await invoke<string>('gate_rdp_replay', { id, session, onEvent: channel });
    return {
      seek: (t: number) => { invoke('gate_rdp_replay_seek', { replay, t }).catch(() => {}); },
      more: () => invoke<number>('gate_rdp_replay_more', { replay }),
      close: () => { invoke('gate_rdp_replay_close', { replay }).catch(() => {}); },
    };
  },
  qr: (text: string) => invoke<string>('qr_svg', { text }),
};

/** Assistance à distance : rejoint la personne aidée avec son code (onglet Bureau à distance). */
export function connectAssist(id: string, code: string, assist: string, cols: number, rows: number, onEvent: (e: TermEvent) => void, onAssist: (e: any) => void) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  const side = new Channel<any>();
  side.onmessage = onAssist;
  return invoke<ConnectResponse>('gate_assist', { id, code, assist, cols, rows, onEvent: channel, onAssist: side });
}

/** Message de l'onglet d'assistance vers la personne aidée (discussion, demande de contrôle). */
export function assistSend(assist: string, message: { type: 'message'; texte: string } | { type: 'demande_controle' }) {
  return invoke<void>('gate_assist_send', { assist, message });
}

export function connectGate(id: string, server: string, extra: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<ConnectResponse>('gate_connect', { id, server, extra, cols, rows, onEvent: channel });
}

// ---------- Proxmox VE ----------

export interface Pve {
  id: string;
  name: string;
  host: string;
  port: number;
  fingerprint: string;
  user: string;
  /** Nom du jeton d'API ; vide : mot de passe. */
  tokenId: string;
  hasSecret: boolean;
  /** Jeton : mot de passe des consoles gardé. */
  hasConsole?: boolean;
}

export interface PveSave {
  id?: string;
  name: string;
  host: string;
  port: number;
  fingerprint: string;
  user: string;
  tokenId: string;
  secret?: string;
  /** Jeton : mot de passe de l'utilisateur pour les consoles (Proxmox les refuse aux jetons). */
  consolePassword?: string;
}

/** Ligne de /cluster/resources : nœud, machine virtuelle (qemu), conteneur (lxc) ou stockage. */
export interface PveResource {
  id: string;
  type: 'node' | 'qemu' | 'lxc' | 'storage' | string;
  node: string;
  vmid?: number;
  name?: string;
  status?: string;
  template?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  storage?: string;
  tags?: string;
  lock?: string;
  /** Compteurs cumulés (octets) des machines. */
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  /** Stockage : type (dir, lvmthin, zfspool, nfs…), contenus, partagé entre nœuds. */
  plugintype?: string;
  content?: string;
  shared?: number;
}

export const proxmox = {
  list: () => invoke<Pve[]>('pve_list'),
  probe: (address: string) => invoke<{ host: string; port: number; fingerprint: string }>('pve_probe', { address }),
  save: (request: PveSave) => invoke<Pve>('pve_save', { request }),
  remove: (id: string) => invoke<void>('pve_remove', { id }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: <T = any>(id: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params?: Record<string, unknown>) => invoke<T>('pve_api', { id, method, path, params: params ?? null }),
};

/** Console d'une machine virtuelle, d'un conteneur ou d'un nœud (onglet VNC). */
export function connectProxmox(id: string, node: string, kind: 'qemu' | 'lxc' | 'node', vmid: number | null, cols: number, rows: number, onEvent: (e: TermEvent) => void, upgrade = false) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<ConnectResponse>('pve_console', { id, node, kind, vmid, upgrade, cols, rows, onEvent: channel });
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
export function connectWith(sessionId: string, extra: Record<string, unknown>, label: string, cols: number, rows: number, onEvent: (e: TermEvent) => void, protocol?: string) {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<ConnectResponse>('connect_with', { sessionId, extra, label, cols, rows, onEvent: channel, protocol: protocol ?? null });
}

/** Question posée pendant une connexion (empreinte d'un nouveau serveur…). */
export interface ConnectionQuestion { title: string; message: string; detail: string; accept: string; reject: string }

export const answerConfirm = (id: string, accept: boolean) => invoke<void>('confirm_answer', { id, accept });
