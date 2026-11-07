// Assistance à distance (Portunia Assist) : prendre la main sur le PC d'un proche ou d'un client.
// La personne ouvre Portunia Assist (téléchargé sur la page de la Gate), lit son code ; vous le
// tapez ici, elle accepte, et son écran s'ouvre dans un onglet Bureau à distance. Le relais du
// Gate met en relation ; la liaison est chiffrée de bout en bout à partir du code.
import { open as pickFiles, save as pickSave } from '@tauri-apps/plugin-dialog';
import { Gate, gates, Manifest } from './api';
import { h, icon } from './dom';
import { formatSize } from './files';
import { t } from './i18n';

export const ASSIST_EXTENSION: Manifest = {
  id: 'assistance',
  name: t('Remote assistance', 'Assistance à distance'),
  version: '1.0.0',
  description: t('Take control of a relative\'s or a customer\'s PC: they open Portunia Assistance and read you a code. Goes through your Gate, encrypted end to end.', 'Prendre la main sur le PC d\'un proche ou d\'un client : la personne ouvre Portunia Assistance et vous lit un code. Passe par votre Gate, chiffré de bout en bout.'),
  view: 'screen',
  builtin: true,
  catalog: false,
  fileBrowser: false,
  portForwarding: false,
  fields: [],
};

export interface AssistStatus {
  actif: boolean;
  autorise: boolean;
  adresse: string;
  programme: boolean;
}

export interface AssistHost {
  /** Ouvre l'onglet de l'assistance avec cette Gate et ce code. */
  open(b: Gate, code: string): void;
  toast(message: string, kind?: 'info' | 'error'): void;
}

/** « 483216907 » → « 483 216 907 » au fil de la frappe. */
function formatCode(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 9);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join(' ');
}

/** Fenêtre « Nouvelle assistance » : Gate, phrase à dire, code. */
export async function openAssistDialog(host: AssistHost) {
  let list: Gate[] = [];
  try { list = (await gates.list()).filter((b) => b.connected); } catch { /* aucun Gate */ }
  const statuses = await Promise.all(list.map(async (b) => {
    try { return { b, s: await gates.assistStatus(b.id) }; } catch { return { b, s: null as AssistStatus | null }; }
  }));
  const usable = statuses.filter((x) => x.s?.actif && x.s.autorise) as { b: Gate; s: AssistStatus }[];

  const dialog = h('dialog', { class: 'dialog narrow assist-dialog', 'aria-labelledby': 'assist-title' }) as HTMLDialogElement;
  const close = () => dialog.close();
  const body = h('div', { class: 'dlg-body' });
  dialog.append(
    h('header', { class: 'dlg-head' },
      h('h2', { id: 'assist-title' }, t('Remote assistance', 'Assistance à distance')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: close }, icon('close'))),
    body);

  if (!usable.length) {
    const why = !list.length
      ? t('Sign in to a Gate first (Gates section): assistance goes through its relay.', 'Connectez-vous d\'abord à une Gate (section Gates) : l\'assistance passe par son relais.')
      : statuses.some((x) => x.s && !x.s.actif)
        ? t('The assistance relay is disabled on your Gate. An administrator enables it in Administer › Assistance.', 'Le relais d\'assistance est coupé sur votre Gate. Un administrateur l\'active dans Administrer › Assistance.')
        : t('Your account is not in the gate\'s group of helpers (Administer › Assistance), or the Gate is too old (Portunia Gate 0.11 or later).', 'Votre compte n\'est pas dans le groupe des dépanneurs de la Gate (Administrer › Assistance), ou la Gate est trop ancienne (Portunia Gate 0.11 ou suivant).');
    body.append(h('p', { class: 'muted' }, why));
    dialog.append(h('footer', { class: 'dlg-foot' }, h('button', { type: 'button', class: 'btn', onclick: close }, t('Close', 'Fermer'))));
  } else {
    const select = h('select', { id: 'assist-gate' }, ...usable.map((x, i) => h('option', { value: String(i) }, x.b.name))) as HTMLSelectElement;
    const say = h('p', { class: 'assist-say' });
    const absent = h('p', { class: 'form-error' });
    const update = () => {
      const { s } = usable[Number(select.value)];
      const page = s.adresse || t('(the gate\'s web portal address is not set: Administer › Web portal)', '(adresse du portail web de la Gate non réglée : Administrer › Portail web)');
      say.replaceChildren(
        h('span', { class: 'label' }, t('To say on the phone', 'À dire au téléphone')),
        h('span', {}, t('« Go to ', '« Va sur '), h('b', {}, page), t(', click the big button, open the downloaded file and read me the digits. »', ', clique sur le gros bouton, ouvre le fichier téléchargé et lis-moi les chiffres. »')));
      absent.textContent = s.programme ? '' : t('The Gate has not downloaded Portunia Assistance yet (it does so when assistance is enabled; it needs Internet access).', 'La Gate n\'a pas encore téléchargé Portunia Assistance (elle le fait à l\'activation de l\'assistance ; il lui faut un accès Internet).');
    };
    select.addEventListener('change', update);
    update();
    const code = h('input', { id: 'assist-code', class: 'assist-code', inputmode: 'numeric', autocomplete: 'off', placeholder: '483 216 907', 'aria-label': t('Code of the person', 'Code de la personne') }) as HTMLInputElement;
    const error = h('p', { class: 'form-error', role: 'alert' });
    code.addEventListener('input', () => { code.value = formatCode(code.value); error.textContent = ''; });
    const form = h('form', { class: 'assist-form' },
      usable.length > 1 ? h('label', { class: 'fld' }, t('Through the Gate', 'Par la Gate'), select) : null,
      say, absent,
      h('label', { class: 'fld' }, t('Code read by the person', 'Code lu par la personne'), code),
      error,
      h('p', { class: 'muted small' }, t('The person sees your name and chooses whether you only see their screen or also control it. They can stop at any time.', 'La personne voit votre nom et choisit si vous voyez seulement son écran ou si vous en prenez aussi le contrôle. Elle peut arrêter à tout moment.')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (code.value.replace(/\D/g, '').length !== 9) { error.textContent = t('The code has 9 digits.', 'Le code a 9 chiffres.'); code.focus(); return; }
      host.open(usable[Number(select.value)].b, code.value);
      close();
    });
    body.append(form);
    dialog.append(h('footer', { class: 'dlg-foot' },
      h('button', { type: 'button', class: 'btn', onclick: close }, t('Cancel', 'Annuler')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => form.requestSubmit() }, t('Connect', 'Se connecter'))));
    setTimeout(() => code.focus(), 0);
  }
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Ce que le pont d'assistance dit de la session, à côté de l'image. */
export type AssistEvent =
  | { type: 'debut'; controle: boolean; fonctions: string[] }
  | { type: 'controle'; actif: boolean }
  | { type: 'pause'; actif: boolean }
  | { type: 'message'; texte: string }
  | { type: 'reconnexion'; actif: boolean }
  | { type: 'qualite'; ms: number }
  | { type: 'fichiers'; liste: AssistFile[]; max: number | null }
  | { type: 'fin'; raison: string };

/** Un fichier de la session d'assistance (voir assist-proto/src/transfer.rs). */
export interface AssistFile {
  id: number;
  nom: string;
  taille: number;
  fait: number;
  /** Reçu de la personne (true) ou envoyé (false). */
  recu: boolean;
  etat: 'demande' | 'attente' | 'refuse' | 'en_cours' | 'termine' | 'annule' | 'echec';
  probleme: 'trop_gros' | 'trop_de_demandes' | 'disque' | 'abime' | 'sans_reponse' | null;
  programme: boolean;
}

type AssistMessage = { type: 'message'; texte: string } | { type: 'demande_controle' } | { type: 'fichier_annuler'; id: number };

/** Ce que le bandeau demande pour les fichiers. */
export interface AssistFiles {
  offer(paths: string[]): Promise<void>;
  /** Ouvrir (sans `dest`) ou enregistrer un fichier reçu. */
  file(id: number, dest?: string): Promise<void>;
}

/** Extension en majuscules, pour la pastille du fichier. */
const ext = (name: string) => {
  const m = /\.([A-Za-z0-9]{1,4})$/.exec(name);
  return m ? m[1].toUpperCase() : t('FILE', 'FICH');
};

/**
 * Bandeau de l'onglet d'assistance : ce que la personne a accordé (vue seule, contrôle, pause),
 * qualité de la liaison, demande de contrôle et discussion. Les messages ne sont gardés que
 * pendant l'assistance.
 */
export class AssistPanel {
  readonly bar = h('div', { class: 'assist-strip', role: 'status' });
  readonly chat = h('aside', { class: 'assist-chat', hidden: true, 'aria-label': t('Chat', 'Discussion') });
  private readonly status = h('span', { class: 'assist-status' });
  private readonly quality = h('span', { class: 'assist-quality muted small' });
  private readonly askBtn = h('button', { type: 'button', class: 'btn small', hidden: true }, icon('pointer', 14), t('Ask for control', 'Demander le contrôle')) as HTMLButtonElement;
  private readonly chatBtn = h('button', { type: 'button', class: 'btn small', hidden: true, 'aria-expanded': 'false' }, icon('chat', 14), t('Chat', 'Discussion')) as HTMLButtonElement;
  private readonly fileBtn = h('button', { type: 'button', class: 'btn small', hidden: true }, icon('upload', 14), t('Send a file', 'Envoyer un fichier')) as HTMLButtonElement;
  /** Voile affiché pendant qu'on glisse des fichiers sur l'écran. */
  readonly drop = h('div', { class: 'assist-drop', hidden: true });
  private readonly cards = new Map<number, HTMLElement>();
  private known = new Map<number, AssistFile>();
  private limit: number | null = null;
  private readonly badge = h('span', { class: 'assist-badge', hidden: true });
  private readonly list = h('div', { class: 'assist-messages' });
  private readonly input = h('input', { type: 'text', maxlength: '2000', placeholder: t('Write a message…', 'Écrire un message…'), 'aria-label': t('Message', 'Message') }) as HTMLInputElement;
  private control = false;
  private paused = false;
  private reconnecting = false;
  private ended = '';
  private features: string[] = [];
  /** Le programme de la personne a dit ce qu'il sait faire (début de session). */
  private started = false;
  private asked = false;

  constructor(private readonly send: (m: AssistMessage) => Promise<void>, private readonly notify: (m: string, kind?: 'info' | 'error') => void, private readonly files: AssistFiles) {
    this.chatBtn.append(this.badge);
    this.bar.append(h('span', { class: 'assist-dot' }), this.status, this.quality, h('span', { class: 'spacer' }), this.askBtn, this.fileBtn, this.chatBtn);
    this.fileBtn.addEventListener('click', async () => {
      if (this.fileBtn.getAttribute('aria-disabled') === 'true') return this.notify(this.fileBtn.title, 'error');
      const chosen = await pickFiles({ multiple: true, directory: false, title: t('Files to send to the person', 'Fichiers à envoyer à la personne') });
      const paths = chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
      if (paths.length) this.offer(paths);
    });
    const form = h('form', { class: 'assist-send' }, this.input, h('button', { type: 'submit', class: 'btn primary small', 'aria-label': t('Send', 'Envoyer') }, icon('arrowRight', 14)));
    form.addEventListener('submit', (e) => { e.preventDefault(); this.sendMessage(); });
    this.chat.append(
      h('header', {}, h('b', {}, t('Chat', 'Discussion')), h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => this.toggleChat(false) }, icon('close', 14))),
      this.list, form);
    this.askBtn.addEventListener('click', () => {
      this.asked = true;
      this.render();
      this.send({ type: 'demande_controle' })
        .then(() => this.notify(t('Request sent: the person accepts or declines on their screen.', 'Demande envoyée : la personne accepte ou refuse sur son écran.')))
        .catch((e) => { this.asked = false; this.render(); this.notify(String(e), 'error'); });
    });
    this.chatBtn.addEventListener('click', () => this.toggleChat(this.chat.hidden));
    this.render();
  }

  handle(e: AssistEvent) {
    switch (e.type) {
      case 'debut': this.control = e.controle; this.features = e.fonctions; this.started = true; break;
      case 'controle':
        if (this.asked && !e.actif) this.notify(t('The person declined to give control.', 'La personne a refusé de donner le contrôle.'));
        else if (e.actif !== this.control) this.notify(e.actif ? t('The person gave you control.', 'La personne vous a donné le contrôle.') : t('The person took back control: view only.', 'La personne a repris la main : vue seule.'));
        this.control = e.actif;
        this.asked = false;
        break;
      case 'pause': this.paused = e.actif; break;
      case 'reconnexion': this.reconnecting = e.actif; break;
      case 'qualite':
        this.quality.textContent = `${e.ms} ms`;
        this.quality.title = t('Round trip to the person\'s PC', 'Aller-retour jusqu\'au PC de la personne');
        return;
      case 'message':
        this.addMessage(false, e.texte);
        if (this.chat.hidden) {
          this.badge.hidden = false;
          this.notify(t('New message from the person', 'Nouveau message de la personne'));
        }
        return;
      case 'fichiers': this.showFiles(e.liste, e.max); return;
      case 'fin': this.ended = e.raison || t('Assistance ended.', 'Assistance terminée.'); this.reconnecting = false; break;
    }
    this.render();
  }

  /** Des fichiers peuvent-ils être déposés sur l'écran maintenant ? */
  acceptsFiles() {
    return !this.ended && this.features.includes('fichiers');
  }

  setDropping(on: boolean) {
    const text = this.limit == null
      ? t('Drop to send to the person. They accept each file.', 'Déposer pour envoyer à la personne. Elle accepte chaque fichier.')
      : t(`Drop to send to the person. They accept each file · ${formatSize(this.limit)} at most (free edition)`, `Déposer pour envoyer à la personne. Elle accepte chaque fichier · ${formatSize(this.limit)} au plus (offre gratuite)`);
    this.drop.replaceChildren(h('div', {}, icon('upload', 22), h('span', {}, text)));
    this.drop.hidden = !on;
  }

  /** Propose des fichiers (ou dossiers, mis en .zip) à la personne ; la discussion s'ouvre pour suivre l'envoi. */
  offer(paths: string[]) {
    this.setDropping(false);
    if (!this.acceptsFiles() || !paths.length) return;
    this.toggleChat(true);
    this.files.offer(paths).catch((e) => this.notify(String(e), 'error'));
  }

  private showFiles(list: AssistFile[], max: number | null) {
    this.limit = max;
    for (const f of list) {
      const before = this.known.get(f.id);
      this.known.set(f.id, f);
      let card = this.cards.get(f.id);
      if (!card) {
        card = h('div', { class: `assist-file ${f.recu ? 'theirs' : 'mine'}` });
        this.cards.set(f.id, card);
        this.list.append(card);
        this.list.scrollTop = this.list.scrollHeight;
      }
      this.renderCard(card, f);
      // Fichier reçu de la personne : on le signale.
      if (f.recu && f.etat === 'termine' && before?.etat !== 'termine') {
        if (this.chat.hidden) this.badge.hidden = false;
        this.notify(t(`File received from the person: ${f.nom}`, `Fichier reçu de la personne : ${f.nom}`));
      }
    }
  }

  private fileStatus(f: AssistFile): [string, string] {
    const size = formatSize(f.taille);
    switch (f.etat) {
      case 'attente': return [t('Waiting for the person: they accept or decline on their screen', 'En attente de la personne : elle accepte ou refuse sur son écran'), ''];
      case 'demande': return [t('Offered', 'Proposé'), ''];
      case 'en_cours': {
        if (!f.recu && f.fait >= f.taille) return [t('Checking…', 'Vérification…'), ''];
        const pct = f.taille ? Math.floor((f.fait * 100) / f.taille) : 100;
        return [t(`${formatSize(f.fait)} of ${size} · ${pct} %`, `${formatSize(f.fait)} sur ${size} · ${pct} %`), ''];
      }
      case 'termine': return [f.recu ? t(`From the person · ${size} · checked`, `De la personne · ${size} · vérifié`) : t(`Accepted and received · ${size}`, `Accepté et reçu · ${size}`), 'ok'];
      case 'refuse':
        if (f.probleme === 'trop_gros') {
          const max = this.limit == null ? '' : formatSize(this.limit);
          return [t(`Too big for the free edition: ${max} at most per file. Pro: Settings › Licence.`, `Trop gros pour l'offre gratuite : ${max} au plus par fichier. Pro : Paramètres › Licence.`), 'warn'];
        }
        if (f.probleme === 'sans_reponse') return [t('No answer from the person', 'Sans réponse de la personne'), 'warn'];
        if (f.probleme === 'trop_de_demandes') return [t('Declined: too many files waiting', 'Refusé : trop de fichiers en attente'), 'warn'];
        return [t('Declined by the person', 'Refusé par la personne'), 'warn'];
      case 'annule': return [t('Cancelled', 'Annulé'), ''];
      case 'echec': return [f.probleme === 'abime' ? t('Damaged in transit: deleted', 'Abîmé en route : effacé') : t('Cannot read or write the file', 'Lecture ou écriture du fichier impossible'), 'warn'];
    }
  }

  private renderCard(card: HTMLElement, f: AssistFile) {
    const [status, tone] = this.fileStatus(f);
    const acts = h('div', { class: 'assist-file-acts' });
    if ((f.etat === 'en_cours' || f.etat === 'attente') && !this.ended) {
      acts.append(h('button', { type: 'button', class: 'btn small', onclick: () => this.send({ type: 'fichier_annuler', id: f.id }).catch((e) => this.notify(String(e), 'error')) }, t('Cancel', 'Annuler')));
    }
    if (f.recu && f.etat === 'termine') {
      if (!f.programme) acts.append(h('button', { type: 'button', class: 'btn small', onclick: () => this.files.file(f.id).catch((e) => this.notify(String(e), 'error')) }, t('Open', 'Ouvrir')));
      acts.append(h('button', { type: 'button', class: 'btn primary small', onclick: async () => {
        const dest = await pickSave({ defaultPath: f.nom, title: t('Save the file from the person', 'Enregistrer le fichier de la personne') });
        if (dest) this.files.file(f.id, dest).then(() => this.notify(t('File saved', 'Fichier enregistré'))).catch((e) => this.notify(String(e), 'error'));
      } }, t('Save…', 'Enregistrer…')));
    }
    card.replaceChildren(
      h('div', { class: 'assist-file-top' },
        h('span', { class: `assist-file-ext${f.programme ? ' program' : ''}` }, ext(f.nom)),
        h('div', { class: 'assist-file-text' },
          h('div', { class: 'assist-file-name', title: f.nom }, `${f.recu ? '↓' : '↑'} ${f.nom}`),
          h('div', { class: `assist-file-status ${tone}` }, status))),
      ...(f.etat === 'en_cours' ? [h('div', { class: 'assist-file-bar' }, h('i', { style: `width: ${f.taille ? Math.min(100, (f.fait * 100) / f.taille) : 100}%` }))] : []),
      ...(acts.childElementCount ? [acts] : []));
  }

  private render() {
    const [text, state] = this.ended ? [this.ended, 'off']
      : this.reconnecting ? [t('Network cut: reconnecting…', 'Réseau coupé : reconnexion…'), 'warn']
      : this.paused ? [t('The person paused the session: frozen image, no control', 'La personne a mis la session en pause : image figée, aucun contrôle'), 'warn']
      : this.control ? [t('You see and control the screen', 'Vous voyez et contrôlez l\'écran'), 'on']
      : [t('View only', 'Vue seule'), 'view'];
    this.status.textContent = text;
    this.bar.dataset.state = state;
    this.askBtn.hidden = !!this.ended || this.control || !this.features.includes('controle');
    this.askBtn.disabled = this.asked || this.paused || this.reconnecting;
    this.chatBtn.hidden = !this.features.includes('discussion');
    // Programme de la personne trop ancien (avant 0.82) : le bouton reste visible, grisé, avec la raison.
    const oldProgram = this.started && !this.ended && !this.features.includes('fichiers');
    this.fileBtn.hidden = !this.acceptsFiles() && !oldProgram;
    // Grisé mais cliquable : un clic dit pourquoi (une bulle ne s'affiche pas sur un bouton désactivé).
    this.fileBtn.setAttribute('aria-disabled', String(oldProgram));
    this.fileBtn.title = oldProgram
      ? t('The person\'s Portunia Assistance is too old for files: they must download it again from the Gate page (version 0.82 or later).', 'Le Portunia Assistance de la personne est trop ancien pour les fichiers : elle doit le retélécharger depuis la page de la Gate (version 0.82 ou suivante).')
      : t('The person accepts each file on their screen. You can also drop files or folders on the screen.', 'La personne accepte chaque fichier sur son écran. Vous pouvez aussi déposer des fichiers ou des dossiers sur l\'écran.');
    this.input.disabled = !!this.ended;
    if (this.ended) this.quality.textContent = '';
  }

  private toggleChat(open: boolean) {
    this.chat.hidden = !open;
    this.chatBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.badge.hidden = true;
      setTimeout(() => this.input.focus(), 0);
    }
  }

  private addMessage(mine: boolean, text: string) {
    this.list.append(h('div', { class: `assist-msg ${mine ? 'mine' : 'theirs'}` }, text));
    this.list.scrollTop = this.list.scrollHeight;
  }

  private sendMessage() {
    const text = this.input.value.trim();
    if (!text || this.ended) return;
    this.input.value = '';
    this.addMessage(true, text);
    this.send({ type: 'message', texte: text }).catch((e) => this.notify(String(e), 'error'));
  }
}
