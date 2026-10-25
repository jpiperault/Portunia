// Question posée par le cœur pendant une connexion (ex. empreinte d'un nouveau serveur SSH).
import { answerConfirm, ConnectionQuestion, TermEvent } from './api';
import { h } from './dom';

/** Traite l'événement s'il s'agit d'une question ; renvoie true dans ce cas. */
export function handleConfirm(e: TermEvent): boolean {
  if (e instanceof ArrayBuffer || e.event !== 'confirm') return false;
  ask(e.data.id, e.data.question);
  return true;
}

function ask(id: string, q: ConnectionQuestion) {
  let answered = false;
  const reply = (accept: boolean) => {
    if (answered) return;
    answered = true;
    answerConfirm(id, accept).catch(() => {});
    dialog.close();
  };
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'confirm-title', style: 'width: min(560px, calc(100vw - 32px))' },
    h('header', { class: 'dlg-head' }, h('h2', { id: 'confirm-title' }, q.title)),
    h('div', { class: 'dlg-body' },
      h('p', { style: 'margin: 0; line-height: 1.5' }, q.message),
      q.detail && h('code', { class: 'confirm-detail' }, q.detail)),
    h('footer', { class: 'dlg-foot' },
      // Le choix prudent est celui qui a le focus : Entrée par réflexe n'accepte rien.
      h('button', { type: 'button', class: 'btn', autofocus: true, onclick: () => reply(false) }, q.reject),
      h('button', { type: 'button', class: 'btn primary', onclick: () => reply(true) }, q.accept)));
  // Échap ou fermeture : refus.
  dialog.addEventListener('close', () => { reply(false); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
}
