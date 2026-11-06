// Vidéo d'une relecture, fabriquée dans Portunia (choix du questionnaire « contrôle des accès ») :
// image par image depuis le lecteur, encodée en H.264 par le moteur web (WebCodecs) et rangée
// dans un fichier MP4. Sous-titres (la frappe) incrustés et donnés aussi en .srt ; filigrane
// avec le compte qui exporte et la date. Rien ne quitte le poste : la Gate note seulement
// l'export dans son journal.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { t } from './i18n';

/** Ce que le lecteur fournit pour fabriquer la vidéo. */
export interface VideoSource {
  /** Taille de l'image (paire, sinon arrondie). */
  width: number;
  height: number;
  /** Durée de la session (secondes). */
  duration: number;
  /** Dessine l'image de la session à ce temps sur le contexte (taille width × height). */
  draw(ctx: CanvasRenderingContext2D, time: number): Promise<void>;
  /** Sous-titre affiché à ce temps (la frappe), ou null. */
  subtitle(time: number): string | null;
}

export interface VideoOptions {
  /** Images par seconde (5 suffit pour un écran de travail). */
  fps?: number;
  /** Texte du filigrane (compte qui exporte, date). */
  watermark: string;
  onProgress?(done: number): void;
  signal?: AbortSignal;
}

/** Codecs H.264 essayés, du plus courant au plus permissif. */
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f'];

export async function videoSupported(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  for (const codec of CODECS) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 2_000_000 })).supported) return true;
    } catch { /* codec suivant */ }
  }
  return false;
}

/** Fabrique la vidéo MP4 (H.264). */
export async function makeVideo(src: VideoSource, opts: VideoOptions): Promise<Blob> {
  const fps = opts.fps ?? 5;
  const width = Math.max(2, Math.floor(src.width / 2) * 2);
  const height = Math.max(2, Math.floor(src.height / 2) * 2);
  let codec = '';
  for (const c of CODECS) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec: c, width, height, bitrate: 2_000_000 })).supported) { codec = c; break; }
    } catch { /* codec suivant */ }
  }
  if (!codec) throw new Error(t('This computer cannot encode H.264 video.', 'Ce poste ne sait pas encoder de vidéo H.264.'));

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec, width, height, bitrate: 2_000_000, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const frames = Math.max(1, Math.ceil(src.duration * fps));
  const font = Math.max(14, Math.round(height / 32));
  for (let i = 0; i < frames; i++) {
    if (opts.signal?.aborted) { encoder.close(); throw new DOMException('aborted', 'AbortError'); }
    if (failure) throw failure;
    const time = i / fps;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    await src.draw(ctx, time);
    // Sous-titre : bandeau en bas de l'image.
    const sub = src.subtitle(time);
    if (sub) {
      ctx.font = `600 ${font}px "Cascadia Mono", Consolas, monospace`;
      const text = sub.length > 120 ? `${sub.slice(0, 119)}…` : sub;
      const w = Math.min(width - 20, ctx.measureText(text).width + 24);
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect((width - w) / 2, height - font * 2.6, w, font * 1.7);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, width / 2, height - font * 1.75, width - 30);
    }
    // Filigrane : en haut à droite, discret mais présent sur chaque image.
    ctx.font = `${Math.round(font * 0.8)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(opts.watermark, width - 12, 10);
    ctx.textAlign = 'left';
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1_000_000) / fps), duration: Math.round(1_000_000 / fps) });
    // Une image clé toutes les 10 secondes : on peut se déplacer dans la vidéo.
    encoder.encode(frame, { keyFrame: i % (fps * 10) === 0 });
    frame.close();
    // L'encodeur ne doit pas prendre trop d'avance (mémoire).
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    if (i % fps === 0) opts.onProgress?.(i / frames);
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  opts.onProgress?.(1);
  return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' });
}

/** Sous-titres au format SubRip (.srt) : une entrée par ligne tapée. */
export function srt(lines: { t: number; end: number; text: string }[]): string {
  const stamp = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const kept = lines.filter((l) => l.text.trim()).sort((a, b) => a.t - b.t);
  return kept
    .map((l, i) => {
      // Affiché 2,5 s après la fin de la frappe, sans déborder sur la ligne suivante.
      const end = Math.min(Math.max(l.end, l.t) + 2.5, kept[i + 1]?.t ?? Infinity);
      return `${i + 1}\n${stamp(l.t)} --> ${stamp(Math.max(end, l.t + 0.5))}\n${l.text}\n`;
    })
    .join('\n');
}
