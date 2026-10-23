// Appels vers le cœur Rust (voir src-tauri/src/commands.rs).
import { Channel, invoke } from '@tauri-apps/api/core';

export type ViewKind = 'terminal' | 'desktop' | 'web';

export interface ChoiceOption { value: string; label: string }

export type FieldKind =
  | { type: 'text' }
  | { type: 'number' }
  | { type: 'secret' }
  | { type: 'file' }
  | { type: 'bool' }
  | { type: 'choice'; options: ChoiceOption[] };

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
  | { event: 'closed'; data: string | null };

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
