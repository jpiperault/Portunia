// Onglet « Outils réseau » : ping, traceroute, test de ports, DNS, Wake-on-LAN.
import { errorText, net, NetEvent, Session } from './api';
import { h, icon } from './dom';

type Tool = 'ping' | 'trace' | 'ports' | 'dns' | 'wol';

const TOOLS: [Tool, string][] = [
  ['ping', 'Ping'], ['trace', 'Traceroute'], ['ports', 'Ports TCP'], ['dns', 'DNS'], ['wol', 'Wake-on-LAN'],
];

const COMMON_PORTS = '21,22,23,25,53,80,110,143,443,445,3306,3389,5432,5900,8080,8443';

export interface NetToolsView {
  el: HTMLElement;
  /** Prérempli depuis une session (hôte, adresse MAC) et lance l'outil demandé. */
  target(host: string, mac?: string, tool?: Tool): void;
  dispose(): void;
}

export function createNetTools(sessions: () => Session[]): NetToolsView {
  let tool: Tool = 'ping';
  let job: string | null = null;
  let running = false;

  const host = h('input', { type: 'text', list: 'net-hosts', placeholder: 'Hôte ou adresse IP', spellcheck: 'false', 'aria-label': 'Hôte' });
  const hosts = h('datalist', { id: 'net-hosts' });
  const count = h('input', { type: 'number', min: '0', max: '1000', value: '4', style: 'width: 80px', 'aria-label': 'Nombre de requêtes' });
  const ports = h('input', { type: 'text', value: '22,80,443,3389', spellcheck: 'false', 'aria-label': 'Ports' });
  const mac = h('input', { type: 'text', placeholder: 'AA:BB:CC:DD:EE:FF', spellcheck: 'false', 'aria-label': 'Adresse MAC' });
  const broadcast = h('input', { type: 'text', placeholder: '255.255.255.255', spellcheck: 'false', 'aria-label': 'Adresse de diffusion' });
  const runBtn = h('button', { type: 'submit', class: 'btn primary' });
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const options = h('div', { class: 'net-options' });
  const output = h('div', { class: 'net-output', role: 'log', 'aria-live': 'polite' });
  const summary = h('p', { class: 'net-summary muted' });

  const line = (cls: string, ...children: (Node | string | false | null | undefined)[]) => {
    output.append(h('div', { class: `net-line ${cls}` }, ...children));
    output.scrollTop = output.scrollHeight;
  };
  const ms = (v: number | null) => (v === null ? '*' : `${v} ms`);

  const setRunning = (on: boolean) => {
    running = on;
    runBtn.replaceChildren(on ? icon('pause', 14) : icon('play', 14), on ? 'Arrêter' : tool === 'wol' ? 'Réveiller' : 'Lancer');
    host.disabled = on;
  };

  const renderTabs = () => {
    tabs.replaceChildren(...TOOLS.map(([id, label]) => h('label', { class: `seg-opt${tool === id ? ' on' : ''}` },
      h('input', { type: 'radio', name: 'net-tool', value: id, checked: tool === id, onchange: () => select(id) }), label)));
    options.replaceChildren(...(
      tool === 'ping' ? [h('label', { class: 'fld inline' }, 'Requêtes (0 = continu)', count)]
      : tool === 'ports' ? [
          h('label', { class: 'fld grow' }, 'Ports (liste ou plages : 22,80,8000-8010)', ports),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { ports.value = COMMON_PORTS; } }, 'Ports courants')]
      : tool === 'wol' ? [
          h('label', { class: 'fld grow' }, 'Adresse MAC', mac),
          h('label', { class: 'fld grow' }, 'Diffusion (facultatif)', broadcast)]
      : []));
    host.hidden = tool === 'wol';
    setRunning(running);
  };

  const select = (t: Tool) => {
    if (running) stop();
    tool = t;
    renderTabs();
  };

  const onEvent = (e: NetEvent) => {
    switch (e.type) {
      case 'start':
        if (e.ip !== host.value.trim()) line('muted', `${host.value.trim()} → ${e.ip}`);
        break;
      case 'ping': {
        const r = e.echo;
        if (r.kind === 'reply') line('ok', h('span', { class: 'net-dot up' }), `#${e.seq}  réponse de ${r.from}  ${r.rtt} ms  TTL ${r.ttl}`);
        else if (r.kind === 'timeout') line('bad', h('span', { class: 'net-dot down' }), `#${e.seq}  délai dépassé`);
        else if (r.kind === 'unreachable') line('bad', h('span', { class: 'net-dot down' }), `#${e.seq}  ${r.reason}${r.from ? ` (${r.from})` : ''}`);
        break;
      }
      case 'hop':
        line(e.from ? '' : 'muted', h('span', { class: 'net-hop' }, String(e.hop)),
          h('span', { class: 'net-rtts' }, e.rtts.map(ms).join('  ')), e.from || 'pas de réponse');
        break;
      case 'port':
        line(e.state === 'open' ? 'ok' : 'muted',
          h('span', { class: `net-dot ${e.state === 'open' ? 'up' : e.state === 'closed' ? 'down' : 'off'}` }),
          h('span', { class: 'net-port' }, String(e.port)),
          h('span', { class: 'net-state' }, e.state === 'open' ? 'ouvert' : e.state === 'closed' ? 'fermé' : 'filtré'),
          e.service && h('span', { class: 'muted' }, e.service), e.ms !== null && e.state === 'open' && h('span', { class: 'muted' }, `${e.ms} ms`));
        break;
      case 'done':
        summary.textContent = e.message;
        job = null; setRunning(false);
        break;
      case 'error':
        summary.textContent = '';
        line('bad', e.message);
        job = null; setRunning(false);
        break;
    }
  };

  const stop = () => {
    if (job) net.cancel(job).catch(() => {});
    if (tool === 'ping' || tool === 'trace' || tool === 'ports') summary.textContent = 'Arrêt…';
  };

  const run = async () => {
    if (running) return stop();
    const target = host.value.trim();
    if (tool !== 'wol' && !target) { host.focus(); return; }
    output.replaceChildren();
    summary.textContent = '';
    try {
      if (tool === 'dns') {
        const ips = await net.resolve(target);
        ips.forEach((ip) => line('ok', h('span', { class: 'net-dot up' }), ip, h('span', { class: 'muted' }, ip.includes(':') ? 'IPv6' : 'IPv4')));
        summary.textContent = `${ips.length} adresse${ips.length > 1 ? 's' : ''}`;
        return;
      }
      if (tool === 'wol') {
        const to = await net.wake(mac.value, broadcast.value.trim() || null);
        line('ok', h('span', { class: 'net-dot up' }), `Paquet magique envoyé à ${mac.value.trim()} (diffusion ${to}, UDP 9)`);
        summary.textContent = 'La machine doit avoir le réveil par le réseau activé (BIOS/UEFI et carte réseau) et être sur le même réseau local.';
        return;
      }
      setRunning(true);
      job = tool === 'ping' ? await net.ping(target, Math.max(0, Number(count.value) || 0), onEvent)
        : tool === 'trace' ? await net.traceroute(target, onEvent)
        : await net.ports(target, ports.value, onEvent);
    } catch (e) {
      setRunning(false);
      line('bad', errorText(e));
    }
  };

  const form = h('form', { class: 'net-form', onsubmit: (e: Event) => { e.preventDefault(); run(); } },
    h('div', { class: 'net-row' }, host, hosts, runBtn), options);

  const el = h('div', { class: 'net-tools' },
    h('header', { class: 'net-head' }, h('h2', {}, 'Outils réseau'), tabs),
    form, output, summary);

  const refreshHosts = () => {
    const seen = new Set<string>();
    hosts.replaceChildren(...sessions().flatMap((s) => {
      const value = typeof s.values.host === 'string' ? s.values.host : '';
      if (!value || seen.has(value)) return [];
      seen.add(value);
      return [h('option', { value }, s.name)];
    }));
  };
  host.addEventListener('focus', refreshHosts);
  renderTabs();

  return {
    el,
    target(h2, macValue, t) {
      if (running) stop();
      host.value = h2;
      if (macValue) mac.value = macValue;
      if (t) select(t);
      if (t === 'wol' ? macValue : h2) run();
      else (t === 'wol' ? mac : host).focus();
    },
    dispose() { if (job) net.cancel(job).catch(() => {}); },
  };
}

/** Réveille la machine d'une session (adresse MAC renseignée). */
export async function wakeSession(s: Session, toast: (m: string, k?: 'info' | 'error') => void) {
  const mac = typeof s.values.mac === 'string' ? s.values.mac.trim() : '';
  if (!mac) return toast(`Renseignez l'adresse MAC de « ${s.name} » (Modifier) pour pouvoir la réveiller`, 'error');
  try {
    await net.wake(mac, null);
    toast(`Paquet de réveil envoyé à ${s.name} (${mac})`);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}
