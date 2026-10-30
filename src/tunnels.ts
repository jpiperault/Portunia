// Tunnels SSH : éditeur dans la fiche session et fenêtre de suivi pendant la connexion.
import { openUrl } from '@tauri-apps/plugin-opener';
import { api, errorText, Session, TunnelSpec, TunnelStatus } from './api';
import { h, icon } from './dom';
import { t as tr } from './i18n';

export const newTunnel = (): TunnelSpec => ({
  id: crypto.randomUUID(), kind: 'local', bindPort: 8080, remoteHost: 'localhost', remotePort: 80, autoStart: true,
});

export const describe = (t: TunnelSpec) =>
  t.kind === 'dynamic' ? tr(`SOCKS proxy on localhost:${t.bindPort}`, `Proxy SOCKS sur localhost:${t.bindPort}`)
  : t.kind === 'remote' ? tr(`server:${t.bindPort} → ${t.remoteHost}:${t.remotePort} (this PC)`, `serveur:${t.bindPort} → ${t.remoteHost}:${t.remotePort} (ce PC)`)
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
        'aria-label': tr('Tunnel type', 'Type de tunnel'),
        onchange: (e: Event) => { t.kind = (e.target as HTMLSelectElement).value as TunnelSpec['kind']; onChange(); render(); },
      },
        h('option', { value: 'local', selected: t.kind === 'local' }, tr('Local port', 'Port local')),
        h('option', { value: 'dynamic', selected: t.kind === 'dynamic' }, 'Proxy SOCKS'),
        h('option', { value: 'remote', selected: reverse }, tr('Server port (reverse)', 'Port du serveur (inverse)'))),
      h('span', { class: 'muted small' }, reverse ? tr('server:', 'serveur:') : 'localhost:'), num('bindPort', reverse ? tr('Port opened on the server', 'Port ouvert sur le serveur') : tr('Port on this PC', 'Port sur ce PC')),
      ...(t.kind === 'dynamic' ? [] : [
        h('span', { class: 'muted' }, '→'),
        h('span', { class: 'tun-remote' },
          h('input', {
            type: 'text', value: t.remoteHost, placeholder: reverse ? tr('host as seen from this PC', 'hôte vu depuis ce PC') : tr('host as seen from the server', 'hôte vu depuis le serveur'), 'aria-label': tr('Destination host', 'Hôte de destination'), spellcheck: 'false',
            oninput: (e: Event) => { t.remoteHost = (e.target as HTMLInputElement).value.trim(); onChange(); },
          }),
          ':', num('remotePort', tr('Destination port', 'Port de destination')))]),
      ...(withAuto ? [h('label', { class: 'check small', title: tr('Open automatically on connection', 'Ouvrir automatiquement à la connexion') },
        h('input', { type: 'checkbox', checked: t.autoStart, onchange: (e: Event) => { t.autoStart = (e.target as HTMLInputElement).checked; onChange(); } }),
        'auto')] : []),
      ...(onRemove ? [h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': tr('Delete this tunnel', 'Supprimer ce tunnel'), title: tr('Delete', 'Supprimer'), onclick: onRemove }, icon('trash', 14))] : []));
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
        tr('« Local port »: an address on this PC (localhost:8080) leads to a machine the server can reach, for example an internal database. ', '« Port local » : une adresse de ce PC (localhost:8080) mène à une machine que le serveur sait joindre, par exemple une base de données interne. '),
        tr('« SOCKS proxy »: set your browser to this proxy to browse as if you were on the server. ', '« Proxy SOCKS » : réglez votre navigateur sur ce proxy pour naviguer comme si vous étiez sur le serveur. '),
        tr('« Server port » (ssh -R): a port on the server leads to a machine on your side, for example to show an app running on this PC.', '« Port du serveur » (ssh -R) : un port du serveur mène à une machine de votre côté, par exemple pour montrer une application qui tourne sur ce PC.')),
      ...tunnels.map((t, i) => tunnelRow(t, () => onChange(tunnels), () => { tunnels.splice(i, 1); onChange(tunnels); render(); })),
      h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: () => { tunnels.push(newTunnel()); onChange(tunnels); render(); } },
        icon('plus', 14), tr('Add a tunnel', 'Ajouter un tunnel')));
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
            status ? tr(`Active · ${status.connections} open connection(s)`, `Actif · ${status.connections} connexion(s) en cours`) : tr('Stopped', 'Arrêté'),
            status?.lastError && h('span', { class: 'tun-error' }, tr(` · last error: ${status.lastError}`, ` · dernière erreur : ${status.lastError}`)))),
        status && spec.kind === 'local' && h('button', {
          class: 'btn', title: tr(`Open http://localhost:${spec.bindPort} in the browser`, `Ouvrir http://localhost:${spec.bindPort} dans le navigateur`),
          onclick: () => openUrl(`http://localhost:${spec.bindPort}`).catch(() => {}),
        }, icon('web', 14), tr('Open', 'Ouvrir')),
        h('button', {
          class: `btn${status ? '' : ' primary'}`,
          onclick: async () => {
            try {
              if (status) await api.tunnelStop(connectionId, spec.id);
              else await api.tunnelStart(connectionId, spec);
            } catch (e) { toast(errorText(e), 'error'); }
            refresh();
          },
        }, status ? tr('Stop', 'Arrêter') : tr('Start', 'Démarrer')));
    }) : [h('p', { class: 'muted' }, tr('No tunnel. Add one below, or in the session\'s settings so it opens at every connection.', 'Aucun tunnel. Ajoutez-en un ci-dessous, ou dans la fiche de la session pour qu\'il s\'ouvre à chaque connexion.'))]));
  };

  const showForm = () => {
    const spec = newTunnel();
    spec.autoStart = false;
    const keep = h('input', { type: 'checkbox' });
    formBox.replaceChildren(h('section', { class: 'ext-fields' },
      h('div', { class: 'ext-head' }, h('h3', {}, tr('New tunnel', 'Nouveau tunnel'))),
      tunnelRow(spec, () => {}, undefined, false),
      h('label', { class: 'check' }, keep, tr('Save it in the session (opened at every connection)', 'L\'enregistrer dans la session (ouvert à chaque connexion)')),
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => formBox.replaceChildren() }, tr('Cancel', 'Annuler')),
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
        }, tr('Start', 'Démarrer')))));
  };

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'tun-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'tun-title' }, tr(`Tunnels — ${session.name}`, `Tunnels — ${session.name}`)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': tr('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' },
        list,
        formBox,
        h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: showForm }, icon('plus', 14), tr('New tunnel', 'Nouveau tunnel')),
        h('p', { class: 'muted small' }, tr('Tunnels only listen on this PC (127.0.0.1) and close with the session.', 'Les tunnels n\'écoutent que sur ce PC (127.0.0.1) et se ferment avec la session.')))));
  dialog.addEventListener('close', () => { window.clearInterval(timer); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  refresh();
  timer = window.setInterval(refresh, 2000);
}
