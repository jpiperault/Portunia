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
