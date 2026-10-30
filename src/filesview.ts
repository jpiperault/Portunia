// Onglet « fichiers seulement » (FTP, S3…) : l'explorateur en pleine largeur, sans terminal.
import { handleConfirm } from './confirm';
import { api, errorText, TermEvent } from './api';
import { h } from './dom';
import type { FilePanel } from './files';
import type { Opener, TermState } from './terminal';
import { t } from './i18n';

export class FilesView {
  private connectionId: string | null = null;
  private opener: Opener | null = null;
  private label = '';
  private connecting = false;
  private disposed = false;
  private readonly status = h('div', { class: 'screen-status' });

  constructor(
    container: HTMLElement,
    private readonly panel: FilePanel,
    private readonly onState: (state: TermState, reason?: string) => void,
  ) {
    container.classList.add('files-view');
    container.append(panel.el, this.status);
    this.status.addEventListener('click', () => this.reconnectNow());
  }

  get connection(): string | null {
    return this.connectionId;
  }

  async connectWith(opener: Opener, label: string) {
    this.opener = opener;
    this.label = label;
    this.connecting = true;
    this.setStatus(t(`Connecting to ${label}…`, `Connexion à ${label}…`));
    this.onState('connecting');
    try {
      const res = await opener(80, 24, (e) => this.onEvent(e));
      if (this.disposed) {
        if (res.connectionId) api.disconnect(res.connectionId).catch(() => {});
        return;
      }
      this.connectionId = res.connectionId;
      this.setStatus('');
      // L'onglet rattache alors l'explorateur à la connexion (onState).
      this.onState('connected');
    } catch (e) {
      const reason = errorText(e);
      this.setStatus(t(`${reason}\nClick here to try again.`, `${reason}\nCliquez ici pour réessayer.`), true);
      this.onState('closed', reason);
    } finally {
      this.connecting = false;
    }
  }

  private onEvent(e: TermEvent) {
    if (handleConfirm(e) || e instanceof ArrayBuffer || e.event !== 'closed') return;
    this.connectionId = null;
    this.panel.detach();
    if (this.disposed) return;
    this.setStatus(e.data ? t(`Connection lost: ${e.data}\nClick here to reconnect.`, `Connexion perdue : ${e.data}\nCliquez ici pour vous reconnecter.`) : t('Connection closed. Click here to reconnect.', 'Connexion fermée. Cliquez ici pour vous reconnecter.'), !!e.data);
    this.onState('closed', e.data ?? undefined);
  }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.hidden = !text;
    this.status.classList.toggle('error', error);
  }

  reconnectNow() {
    if (this.connectionId || this.connecting || !this.opener) return;
    this.connectWith(this.opener, this.label);
  }

  cancelReconnect() { /* pas de reconnexion automatique */ }
  refit() { /* rien à recalculer */ }
  focus() { /* l'explorateur gère son focus */ }

  dispose() {
    this.disposed = true;
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
    this.panel.detach();
  }
}
