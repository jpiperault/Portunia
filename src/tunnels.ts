// Tunnels SSH : éditeur dans la fiche session et fenêtre de suivi pendant la connexion.
import { openUrl } from '@tauri-apps/plugin-opener';
import { api, errorText, Session, TunnelSpec, TunnelStatus } from './api';
import { h, icon } from './dom';

export const newTunnel = (): TunnelSpec => ({
  id: crypto.randomUUID(), kind: 'local', bindPort: 8080, remoteHost: 'localhost', remotePort: 80, autoStart: true,
});

export const describe = (t: TunnelSpec) =>
  t.kind === 'dynamic' ? `Proxy SOCKS sur localhost:${t.bindPort}`
  : t.kind === 'remote' ? `serveur:${t.bindPort} → ${t.remoteHost}:${t.remotePort} (ce PC)`
  : `localhost:${t.bindPort} → ${t.remoteHost}:${t.remotePort}`;

/** Lignes de saisie d'un tunnel (type, ports, destination). */
function tunnelRow(t: TunnelSpec, onChange: () => void, onRemove?: () => void, withAuto = true): HTMLElement {
  const row = h('div', { class: 'tun-row' });
  const num = (key: 'bindPort' | 'remotePort', label: string) =>
    h('input', {
      type: 'number', min: '1', max: '65535', value: String(t[key]), 'aria-label': label, title: label, class: 'tun-port',
      oninput: (e: Event) => { t[key] = Number((e.target as HTMLInputElement).value); onChange(); },
    });
  const render = () => {
    const reverse = t.kind === 'remote';
    row.replaceChildren(
      h('select', {
        'aria-label': 'Type de tunnel',
        onchange: (e: Event) => { t.kind = (e.target as HTMLSelectElement).value as TunnelSpec['kind']; onChange(); render(); },
      },
        h('option', { value: 'local', selected: t.kind === 'local' }, 'Port local'),
        h('option', { value: 'dynamic', selected: t.kind === 'dynamic' }, 'Proxy SOCKS'),
        h('option', { value: 'remote', selected: reverse }, 'Port du serveur (inverse)')),
      h('span', { class: 'muted small' }, reverse ? 'serveur:' : 'localhost:'), num('bindPort', reverse ? 'Port ouvert sur le serveur' : 'Port sur ce PC'),
      ...(t.kind === 'dynamic' ? [] : [
        h('span', { class: 'muted' }, '→'),
        h('span', { class: 'tun-remote' },
          h('input', {
            type: 'text', value: t.remoteHost, placeholder: reverse ? 'hôte vu depuis ce PC' : 'hôte vu depuis le serveur', 'aria-label': 'Hôte de destination', spellcheck: 'false',
            oninput: (e: Event) => { t.remoteHost = (e.target as HTMLInputElement).value.trim(); onChange(); },
          }),
          ':', num('remotePort', 'Port de destination'))]),
      ...(withAuto ? [h('label', { class: 'check small', title: 'Ouvrir automatiquement à la connexion' },
        h('input', { type: 'checkbox', checked: t.autoStart, onchange: (e: Event) => { t.autoStart = (e.target as HTMLInputElement).checked; onChange(); } }),
        'auto')] : []),
      ...(onRemove ? [h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Supprimer ce tunnel', title: 'Supprimer', onclick: onRemove }, icon('trash', 14))] : []));
  };
  render();
  return row;
}

/** Champ « Tunnels » du formulaire de session. */
export function tunnelEditor(initial: unknown, onChange: (tunnels: TunnelSpec[]) => void): HTMLElement {
  const tunnels: TunnelSpec[] = Array.isArray(initial) ? initial.map((t) => ({ ...t })) : [];
  const box = h('fieldset', { class: 'fld tun-editor' });
  const render = () => {
    box.replaceChildren(
      h('legend', {}, 'Tunnels'),
      h('p', { class: 'muted small tun-help' },
        '« Port local » : une adresse de ce PC (localhost:8080) mène à une machine que le serveur sait joindre, par exemple une base de données interne. ',
        '« Proxy SOCKS » : réglez votre navigateur sur ce proxy pour naviguer comme si vous étiez sur le serveur. ',
        '« Port du serveur » (ssh -R) : un port du serveur mène à une machine de votre côté, par exemple pour montrer une application qui tourne sur ce PC.'),
      ...tunnels.map((t, i) => tunnelRow(t, () => onChange(tunnels), () => { tunnels.splice(i, 1); onChange(tunnels); render(); })),
      h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: () => { tunnels.push(newTunnel()); onChange(tunnels); render(); } },
        icon('plus', 14), 'Ajouter un tunnel'));
  };
  render();
  return box;
}

/** Fenêtre « Tunnels » d'une session connectée. */
export function openTunnels(session: Session, connectionId: string, toast: (m: string, k?: 'info' | 'error') => void, onSaved: () => void) {
  const configured: TunnelSpec[] = Array.isArray(session.values.tunnels) ? (session.values.tunnels as TunnelSpec[]) : [];
  const list = h('div', { class: 'tun-list' });
  const formBox = h('div', {});
  let timer = 0;

  const refresh = async () => {
    let running: TunnelStatus[] = [];
    try { running = await api.tunnelList(connectionId); } catch (e) { list.replaceChildren(h('p', { class: 'form-error' }, errorText(e))); return; }
    const byId = new Map(running.map((r) => [r.spec.id, r]));
    const all = [...configured, ...running.map((r) => r.spec).filter((s) => !configured.some((c) => c.id === s.id))];
    list.replaceChildren(...(all.length ? all.map((spec) => {
      const status = byId.get(spec.id);
      const saved = configured.some((c) => c.id === spec.id);
      return h('div', { class: `tun-item${status ? ' on' : ''}` },
        h('span', { class: `dot${status ? ' on' : ''}` }),
        h('div', { class: 'grow', style: 'min-width: 0' },
          h('div', {}, describe(spec), !saved && h('span', { class: 'chip', style: 'margin-left: 8px' }, 'temporaire')),
          h('div', { class: 'muted small' },
            status ? `Actif · ${status.connections} connexion(s) en cours` : 'Arrêté',
            status?.lastError && h('span', { class: 'tun-error' }, ` · dernière erreur : ${status.lastError}`))),
        status && spec.kind === 'local' && h('button', {
          class: 'btn', title: `Ouvrir http://localhost:${spec.bindPort} dans le navigateur`,
          onclick: () => openUrl(`http://localhost:${spec.bindPort}`).catch(() => {}),
        }, icon('web', 14), 'Ouvrir'),
        h('button', {
          class: `btn${status ? '' : ' primary'}`,
          onclick: async () => {
            try {
              if (status) await api.tunnelStop(connectionId, spec.id);
              else await api.tunnelStart(connectionId, spec);
            } catch (e) { toast(errorText(e), 'error'); }
            refresh();
          },
        }, status ? 'Arrêter' : 'Démarrer'));
    }) : [h('p', { class: 'muted' }, 'Aucun tunnel. Ajoutez-en un ci-dessous, ou dans la fiche de la session pour qu\'il s\'ouvre à chaque connexion.')]));
  };

  const showForm = () => {
    const spec = newTunnel();
    spec.autoStart = false;
    const keep = h('input', { type: 'checkbox' });
    formBox.replaceChildren(h('section', { class: 'ext-fields' },
      h('div', { class: 'ext-head' }, h('h3', {}, 'Nouveau tunnel')),
      tunnelRow(spec, () => {}, undefined, false),
      h('label', { class: 'check' }, keep, 'L\'enregistrer dans la session (ouvert à chaque connexion)'),
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => formBox.replaceChildren() }, 'Annuler'),
        h('button', {
          type: 'button', class: 'btn primary',
          onclick: async () => {
            try {
              await api.tunnelStart(connectionId, spec);
              if (keep.checked) {
                spec.autoStart = true;
                configured.push(spec);
                await api.saveSession({ ...session, values: { ...session.values, tunnels: configured } }, {});
                onSaved();
              }
              formBox.replaceChildren();
            } catch (e) { toast(errorText(e), 'error'); }
            refresh();
          },
        }, 'Démarrer'))));
  };

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'tun-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'tun-title' }, `Tunnels — ${session.name}`),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' },
        list,
        formBox,
        h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: showForm }, icon('plus', 14), 'Nouveau tunnel'),
        h('p', { class: 'muted small' }, 'Les tunnels n\'écoutent que sur ce PC (127.0.0.1) et se ferment avec la session.'))));
  dialog.addEventListener('close', () => { window.clearInterval(timer); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  refresh();
  timer = window.setInterval(refresh, 2000);
}
