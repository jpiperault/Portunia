// Assistance à distance (Portunia Assist) : prendre la main sur le PC d'un proche ou d'un client.
// La personne ouvre Portunia Assist (téléchargé sur la page de la Gate), lit son code ; vous le
// tapez ici, elle accepte, et son écran s'ouvre dans un onglet Bureau à distance. Le relais du
// Gate met en relation ; la liaison est chiffrée de bout en bout à partir du code.
import { Gate, gates, Manifest } from './api';
import { h, icon } from './dom';
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
  | { type: 'fin'; raison: string };

type AssistMessage = { type: 'message'; texte: string } | { type: 'demande_controle' };

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
  private readonly badge = h('span', { class: 'assist-badge', hidden: true });
  private readonly list = h('div', { class: 'assist-messages' });
  private readonly input = h('input', { type: 'text', maxlength: '2000', placeholder: t('Write a message…', 'Écrire un message…'), 'aria-label': t('Message', 'Message') }) as HTMLInputElement;
  private control = false;
  private paused = false;
  private reconnecting = false;
  private ended = '';
  private features: string[] = [];
  private asked = false;

  constructor(private readonly send: (m: AssistMessage) => Promise<void>, private readonly notify: (m: string, kind?: 'info' | 'error') => void) {
    this.chatBtn.append(this.badge);
    this.bar.append(h('span', { class: 'assist-dot' }), this.status, this.quality, h('span', { class: 'spacer' }), this.askBtn, this.chatBtn);
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
      case 'debut': this.control = e.controle; this.features = e.fonctions; break;
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
      case 'fin': this.ended = e.raison || t('Assistance ended.', 'Assistance terminée.'); this.reconnecting = false; break;
    }
    this.render();
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
