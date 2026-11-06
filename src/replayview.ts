// Relecture d'une session de la Gate (SSH, Bureau à distance, interface web), dans un onglet de
// la fenêtre principale ou dans sa propre fenêtre (lecteur détaché). Exports (transcription,
// .cast, vidéo MP4 + .srt) inscrits au journal de la Gate ; session encore ouverte suivie en
// direct (relue toutes les 3 secondes).
import { save } from '@tauri-apps/plugin-dialog';
import { Gate, gates, errorText } from './api';
import { h } from './dom';
import { LOCALE, t } from './i18n';
import type { AuditPlayer, AuditRecording } from './auditplayer';
import type { RdpPlayer, RdpRecording } from './rdpplayer';
import type { WebPlayer, WebRecording } from './webplayer';
import type { VideoSource } from './videoexport';

export type ReplayPlayer = AuditPlayer | RdpPlayer | WebPlayer;

export interface ReplayHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Rouvre la relecture avec les saisies révélées (administrateur). */
  reveal(): void;
  /** Ouvre la relecture dans sa propre fenêtre (absent : déjà détachée). */
  detach?(): void;
}

/** La session telle que la Gate la décrit dans l'enregistrement. */
export type ReplaySession = AuditRecording['session'];

const expired = (e: unknown) => (errorText(e) === 'SESSION_EXPIREE'
  ? t('Gate session expired: sign in again (sidebar).', 'Session de la Gate expirée : reconnectez-vous (barre latérale).')
  : errorText(e));

/**
 * Charge l'enregistrement et construit le lecteur dans `view`. Renvoie le lecteur et la session,
 * ou null (erreur déjà affichée).
 */
export async function buildReplay(b: Gate, sessionId: string, view: HTMLElement, opts: { start?: number; reveal: boolean; host: ReplayHost }): Promise<{ player: ReplayPlayer; session: ReplaySession } | null> {
  const { host, start, reveal } = opts;
  let rec: AuditRecording;
  try {
    rec = await gates.admin<AuditRecording>(b.id, 'GET', `/audit/sessions/${sessionId}/enregistrement${reveal ? '?reveler=true' : ''}`);
  } catch (e) {
    host.toast(expired(e), 'error');
    return null;
  }
  const s = rec.session;
  const stamp = new Date(s.debut).toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const logExport = (format: string) => gates.admin(b.id, 'POST', `/audit/sessions/${s.id}/export`, { format }).catch(() => {});
  const exportFile = async (name: string, ext: string, content: string, done: string) => {
    const dest = await save({ defaultPath: `${s.serveur}-${s.compte}-${stamp}${name}.${ext}`, filters: [{ name: ext === 'cast' ? t('asciicast recording', 'Enregistrement asciicast') : t('Text', 'Texte'), extensions: [ext] }] });
    if (!dest) return;
    try {
      await gates.exportFile(dest, content);
      host.toast(`${done} : ${dest}`);
      // Export inscrit au journal de la Gate (0.37 et suivantes ; ignoré par les précédentes).
      logExport(ext);
    } catch (e) { host.toast(errorText(e), 'error'); }
  };
  // Vidéo MP4 fabriquée dans Portunia, avec ses sous-titres .srt à côté.
  const exportVideo = async (p: { videoSource(): VideoSource; subtitleLines(): { t: number; end: number; text: string }[] }) => {
    const { makeVideo, videoSupported, srt } = await import('./videoexport');
    if (!(await videoSupported())) return host.toast(t('This computer cannot encode H.264 video.', 'Ce poste ne sait pas encoder de vidéo H.264.'), 'error');
    const dest = await save({ defaultPath: `${s.serveur}-${s.compte}-${stamp}.mp4`, filters: [{ name: t('MP4 video', 'Vidéo MP4'), extensions: ['mp4'] }] });
    if (!dest) return;
    const abort = new AbortController();
    const label = h('span', {}, t('Making the video… 0 %', 'Fabrication de la vidéo… 0 %'));
    const bar = h('div', { class: 'vp-bar' }, h('div', { class: 'vp-fill' }));
    const panel = h('div', { class: 'video-progress', role: 'status' }, label, bar,
      h('button', { class: 'btn sm', onclick: () => abort.abort() }, t('Cancel', 'Annuler')));
    view.append(panel);
    try {
      const blob = await makeVideo(p.videoSource(), {
        watermark: `${b.login} · ${new Date().toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })} · ${b.name}`,
        signal: abort.signal,
        onProgress: (done) => {
          label.textContent = t(`Making the video… ${Math.round(done * 100)} %`, `Fabrication de la vidéo… ${Math.round(done * 100)} %`);
          (bar.firstElementChild as HTMLElement).style.width = `${Math.round(done * 100)}%`;
        },
      });
      await gates.exportBytes(dest, blob);
      const subtitles = srt(p.subtitleLines());
      if (subtitles) await gates.exportFile(dest.replace(/\.mp4$/i, '') + '.srt', subtitles);
      logExport('mp4');
      host.toast(t(`Video exported: ${dest}`, `Vidéo exportée : ${dest}`));
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') host.toast(errorText(e), 'error');
    } finally {
      panel.remove();
    }
  };

  let player: ReplayPlayer;
  // Interface web : journal d'actions (pages, envois, WebSocket, coffre).
  if (s.type === 'web') {
    const { WebPlayer } = await import('./webplayer');
    const web: WebPlayer = new WebPlayer(view, rec as unknown as WebRecording, {
      viewer: b.login,
      start,
      detach: host.detach,
      exportText: () => exportFile('-actions', 'txt', web.transcript(), t('Transcript exported', 'Transcription exportée')),
    });
    player = web;
  // Bureau à distance : l'image est décodée par le moteur RDP à partir du flux enregistré.
  } else if (s.type === 'rdp') {
    const { RdpPlayer } = await import('./rdpplayer');
    const rdp = new RdpPlayer(view, rec as unknown as RdpRecording, {
      viewer: b.login,
      start,
      canReveal: b.role === 'admin',
      detach: host.detach,
      reveal: () => {
        if (!confirm(t('Show the copied-pasted text in clear? This replay will be written to the gate\'s log.', 'Afficher en clair le texte copié-collé ? Cette relecture sera inscrite au journal de la Gate.'))) return;
        host.reveal();
      },
      exportText: () => exportFile('-transcription', 'txt', rdp.transcript(), t('Transcript exported', 'Transcription exportée')),
      exportVideo: () => exportVideo(rdp),
      open: (onMessage) => gates.rdpReplay(b.id, s.id, onMessage),
    });
    player = rdp;
  } else try {
    const { AuditPlayer } = await import('./auditplayer');
    const ssh: AuditPlayer = new AuditPlayer(view, rec, {
      viewer: b.login,
      start,
      canReveal: b.role === 'admin',
      detach: host.detach,
      reveal: () => {
        if (!confirm(t('Show input typed without echo (usually passwords) in clear? This replay will be written to the gate\'s log.', 'Afficher en clair les saisies sans écho (le plus souvent des mots de passe) ? Cette relecture sera inscrite au journal de la Gate.'))) return;
        host.reveal();
      },
      exportCast: () => exportFile(rec.revele ? '' : '-masque', 'cast', rec.cast, rec.revele ? t('Signed recording exported', 'Enregistrement signé exporté') : t('Masked copy exported (not signed)', 'Copie masquée exportée (non signée)')),
      exportText: () => exportFile('-transcription', 'txt', ssh.transcript(), t('Transcript exported', 'Transcription exportée')),
      exportVideo: () => exportVideo(ssh),
    });
    player = ssh;
  } catch (e) {
    host.toast(t(`Unreadable recording: ${errorText(e)}`, `Enregistrement illisible : ${errorText(e)}`), 'error');
    return null;
  }
  // Session encore ouverte (Audit › En direct) : l'enregistrement est relu toutes les 3 secondes
  // et le lecteur s'allonge, jusqu'à la fin de la session.
  if (!s.fin) {
    const live = player;
    let busy = false;
    live.liveTimer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await gates.admin<AuditRecording>(b.id, 'GET', `/audit/sessions/${s.id}/enregistrement?suite=true${reveal ? '&reveler=true' : ''}`);
        await live.extend(next as never);
        if (next.session.fin) clearInterval(live.liveTimer);
      } catch {
        // Gate injoignable un instant : nouvel essai au tour suivant.
      }
      busy = false;
    }, 3000);
  }
  return { player, session: s };
}

/** Titre d'une relecture (onglet ou fenêtre). */
export function replayTitle(serveur: string, debut: string): string {
  return `▶ ${serveur} · ${new Date(debut).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })}`;
}
