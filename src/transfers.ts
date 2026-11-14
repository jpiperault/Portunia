// File de transferts d'une session de fichiers à deux volets : un transfert à la fois,
// avec avancement, débit, pause de la file et règle « si le fichier existe ».
import { errorText, TransferProgress } from './api';
import { h, icon } from './dom';
import { formatSize } from './files';
import { t } from './i18n';

export type Direction = 'up' | 'down';
/** Fichier déjà présent à l'arrivée : demander, remplacer si plus récent, remplacer, ignorer. */
export type ExistsRule = 'ask' | 'newer' | 'overwrite' | 'skip';

interface Job {
  name: string;
  direction: Direction;
  /** Dossier d'arrivée, affiché en info-bulle. */
  target: string;
  done: number;
  total: number;
  state: 'waiting' | 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  started?: number;
  run: (cb: (p: TransferProgress) => void) => Promise<unknown>;
  /** Reprise d'où le transfert s'était arrêté (édition Pro, protocoles qui le permettent). */
  resume?: (cb: (p: TransferProgress) => void) => Promise<unknown>;
  after?: () => void;
}

const RULES: [ExistsRule, string][] = [
  ['ask', t('Ask', 'Demander')],
  ['newer', t('Replace if newer', 'Remplacer si plus récent')],
  ['overwrite', t('Replace', 'Remplacer')],
  ['skip', t('Skip', 'Ignorer')],
];

export class TransferQueue {
  readonly el = h('section', { class: 'tq', 'aria-label': t('Transfers', 'Transferts') });
  rule: ExistsRule = 'ask';
  private jobs: Job[] = [];
  private paused = false;
  private running = false;
  private frame = 0;
  /** Appelés une fois quand la file est vide. */
  private idle: (() => void)[] = [];

  constructor(private readonly toast: (msg: string, kind?: 'info' | 'error') => void) {
    this.render();
  }

  add(job: Pick<Job, 'name' | 'direction' | 'target' | 'run' | 'after' | 'resume'>) {
    this.jobs.push({ ...job, done: 0, total: 0, state: 'waiting' });
    this.render();
    this.next();
  }

  /** Appelle `f` quand tous les transferts en cours et en attente sont finis. */
  whenIdle(f: () => void) {
    this.idle.push(f);
    if (!this.running && !this.jobs.some((j) => j.state === 'waiting')) this.flushIdle();
  }

  private flushIdle() {
    const callbacks = this.idle;
    this.idle = [];
    for (const f of callbacks) f();
  }

  private async next() {
    if (this.running || this.paused) return;
    const job = this.jobs.find((j) => j.state === 'waiting');
    if (!job) return this.flushIdle();
    this.running = true;
    job.state = 'running';
    job.started = performance.now();
    this.render();
    try {
      await job.run((p) => { job.done = p.done; job.total = p.total; this.soon(); });
      job.state = 'done';
      job.after?.();
    } catch (e) {
      job.state = 'error';
      job.error = errorText(e);
      this.toast(`${job.name} : ${job.error}`, 'error');
    }
    this.running = false;
    // On garde les 30 derniers transferts terminés.
    const finished = this.jobs.filter((j) => j.state === 'done' || j.state === 'cancelled');
    if (finished.length > 30) this.jobs = this.jobs.filter((j) => !finished.slice(0, finished.length - 30).includes(j));
    this.render();
    this.next();
  }

  /** L'avancement arrive souvent : un rendu par image. */
  private soon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private render() {
    const waiting = this.jobs.filter((j) => j.state === 'waiting').length;
    const running = this.jobs.find((j) => j.state === 'running');
    const finished = this.jobs.some((j) => j.state !== 'waiting' && j.state !== 'running');
    const rule = h('select', { class: 'tq-rule', 'aria-label': t('If the file exists', 'Si le fichier existe'), onchange: (e: Event) => { this.rule = (e.target as HTMLSelectElement).value as ExistsRule; } },
      ...RULES.map(([value, label]) => h('option', { value, selected: value === this.rule }, label)));
    const summary = running
      ? t(`1 in progress${waiting ? ` · ${waiting} waiting` : ''}`, `1 en cours${waiting ? ` · ${waiting} en attente` : ''}`)
      : waiting ? (this.paused ? t(`Paused · ${waiting} waiting`, `En pause · ${waiting} en attente`) : t(`${waiting} waiting`, `${waiting} en attente`))
      : t('No transfer in progress', 'Aucun transfert en cours');
    this.el.replaceChildren(
      h('div', { class: 'tq-head' },
        h('strong', {}, t('Transfers', 'Transferts')),
        h('span', { class: 'muted small grow' }, summary),
        h('label', { class: 'tq-rule-label muted small' }, t('If the file exists', 'Si le fichier existe'), rule),
        h('button', { type: 'button', class: 'btn sm', disabled: !waiting && !this.paused, onclick: () => { this.paused = !this.paused; this.render(); this.next(); } },
          icon(this.paused ? 'play' : 'pause', 13), this.paused ? t('Resume', 'Reprendre') : t('Pause', 'Pause')),
        h('button', { type: 'button', class: 'btn sm', disabled: !finished, onclick: () => { this.jobs = this.jobs.filter((j) => j.state === 'waiting' || j.state === 'running'); this.render(); } },
          t('Clear finished', 'Effacer les terminés'))),
      h('div', { class: 'tq-list' }, ...(this.jobs.length ? [...this.jobs].reverse().map((j) => this.row(j)) : [h('p', { class: 'muted small tq-empty' }, t('Select files, then → (F5) to upload or ← (F6) to download. You can also drop files from Windows on the server pane.', 'Sélectionnez des fichiers, puis → (F5) pour envoyer ou ← (F6) pour récupérer. Vous pouvez aussi déposer des fichiers de Windows sur le volet du serveur.'))])),
    );
  }

  private row(j: Job): HTMLElement {
    const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : j.state === 'done' ? 100 : 0;
    const secs = j.started ? (performance.now() - j.started) / 1000 : 0;
    const speed = j.state === 'running' && secs > 0.5 && j.done ? `${formatSize(j.done / secs)}/s` : '';
    const status = j.state === 'waiting' ? t('waiting', 'en attente')
      : j.state === 'error' ? t('failed', 'échec')
      : j.state === 'cancelled' ? t('cancelled', 'annulé')
      : j.state === 'done' ? t('done', 'terminé')
      : `${pct} %${j.total ? ` · ${formatSize(j.done)} / ${formatSize(j.total)}` : ''}${speed ? ` · ${speed}` : ''}`;
    return h('div', { class: `tq-row ${j.state}`, title: j.error ?? j.target },
      h('span', { class: 'tq-dir', 'aria-label': j.direction === 'up' ? t('Upload', 'Envoi') : t('Download', 'Récupération') }, icon(j.direction === 'up' ? 'upload' : 'download', 13)),
      h('span', { class: 'grow ellipsis' }, j.name),
      h('span', { class: 'tq-bar' }, h('span', { class: 'bar-fill', style: `width: ${pct}%` })),
      h('span', { class: 'tq-status muted small' }, status),
      j.state === 'waiting'
        ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': t(`Cancel ${j.name}`, `Annuler ${j.name}`), title: t('Cancel', 'Annuler'), onclick: () => { j.state = 'cancelled'; this.render(); } }, icon('close', 12))
        : j.state === 'error'
          ? h('span', { class: 'tq-again' },
            j.resume ? h('button', { type: 'button', class: 'btn sm', title: t('Continue from where it stopped', 'Continuer d\'où il s\'était arrêté'), onclick: () => this.again(j, true) }, t('Resume', 'Reprendre')) : null,
            h('button', { type: 'button', class: 'btn sm', title: t('Start again from the beginning', 'Recommencer depuis le début'), onclick: () => this.again(j, false) }, t('Retry', 'Réessayer')))
          : h('span', { class: 'tq-gap' }));
  }

  /** Transfert en échec remis dans la file : repris là où il s'était arrêté, ou recommencé. */
  private again(j: Job, resume: boolean) {
    if (resume && j.resume) {
      const resumeRun = j.resume;
      j.run = resumeRun;
    }
    j.state = 'waiting';
    j.error = undefined;
    this.render();
    this.next();
  }
}
