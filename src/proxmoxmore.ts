// Proxmox VE, suite (Portunia 0.83) : journal des tâches, adresses des machines et connexion
// SSH/RDP, matériel (disques, cartes réseau, lecteur CD, ordre de démarrage, processeur),
// cloud-init, envoi d'images ISO et de modèles, pare-feu, utilisateurs et droits, Ceph, ajout
// de stockages et réseau des nœuds en écriture. Tout passe par l'API de Proxmox (pve_api).
import { open as pickFile } from '@tauri-apps/plugin-dialog';
import { errorText, proxmox, proxmoxUpload, Pve, PveResource } from './api';
import { h, icon } from './dom';
import { t } from './i18n';
import { bytes, check, closeButton, date, field, guestLabel, input, modal, ProxmoxPanel, select, table } from './proxmox';

type Guest = PveResource & { type: 'qemu' | 'lxc'; vmid: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Config = Record<string, any>;

const btn = (label: string, onclick: () => void, extra = '') => h('button', { type: 'button', class: `btn sm${extra ? ` ${extra}` : ''}`, onclick }, label);
const actions = (...b: HTMLElement[]) => h('td', { class: 'pve-actions' }, ...b);
const section = (title: string, ...body: (HTMLElement | null)[]) => h('section', { class: 'pve-section' }, h('h3', {}, title), ...body.filter((x): x is HTMLElement => !!x));
/** Options « clé=valeur » d'une valeur Proxmox (« virtio=AA:BB,bridge=vmbr0,firewall=1 »). */
function parseOpts(v: string): [string, string][] {
  return String(v ?? '').split(',').filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)];
  });
}
const opt = (v: string, key: string) => parseOpts(v).find(([k]) => k === key)?.[1];
/** Premier numéro libre pour « scsi », « net », « mp »… */
function nextKey(config: Config, prefix: string, max: number): string | null {
  for (let i = 0; i <= max; i++) if (config[`${prefix}${i}`] === undefined) return `${prefix}${i}`;
  return null;
}
const guestBase = (g: Guest) => `/nodes/${g.node}/${g.type}/${g.vmid}`;

async function bridges(p: Pve, node: string): Promise<string[]> {
  try {
    const list = await proxmox.api<{ iface: string; type: string }[]>(p.id, 'GET', `/nodes/${node}/network`);
    return list.filter((i) => i.type === 'bridge' || i.type === 'OVSBridge').map((i) => i.iface).sort();
  } catch {
    return ['vmbr0'];
  }
}

async function storesFor(p: Pve, node: string, content: string): Promise<{ storage: string; avail?: number }[]> {
  try {
    return await proxmox.api(p.id, 'GET', `/nodes/${node}/storage`, { content, enabled: 1 });
  } catch {
    return [];
  }
}

// ---------- Journal d'une tâche ----------

/** Journal d'une tâche Proxmox, suivi en direct tant qu'elle tourne ; elle peut être arrêtée. */
export function openTaskLog(p: Pve, node: string, upid: string, title: string) {
  const log = h('pre', { class: 'pve-log', style: 'max-height: 55vh; overflow: auto; white-space: pre-wrap' }, t('Loading…', 'Chargement…'));
  const status = h('p', { class: 'muted small' });
  const stop = h('button', { type: 'button', class: 'btn danger', hidden: true }, t('Stop the task', 'Arrêter la tâche'));
  const { dialog, error } = modal(t(`Task log · ${title}`, `Journal de la tâche · ${title}`), [status, log], [stop], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  let open = true;
  dialog.addEventListener('close', () => { open = false; });
  stop.addEventListener('click', async () => {
    if (!confirm(t('Stop this task? What it was doing may be left half done.', 'Arrêter cette tâche ? Ce qu\'elle faisait peut rester à moitié fait.'))) return;
    try {
      await proxmox.api(p.id, 'DELETE', `/nodes/${node}/tasks/${encodeURIComponent(upid)}`);
    } catch (e) {
      error.textContent = errorText(e);
    }
  });
  const poll = async () => {
    while (open) {
      try {
        const [s, lines] = await Promise.all([
          proxmox.api<{ status: string; exitstatus?: string; starttime?: number; user?: string; type?: string }>(p.id, 'GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`),
          proxmox.api<{ n: number; t: string }[]>(p.id, 'GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log`, { start: 0, limit: 5000 }),
        ]);
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
        log.textContent = lines.map((l) => l.t).join('\n') || t('(empty)', '(vide)');
        if (atEnd) log.scrollTop = log.scrollHeight;
        const running = s.status !== 'stopped';
        stop.hidden = !running;
        status.textContent = `${s.type ?? ''} · ${s.user ?? ''} · ${date(s.starttime)} · ${running ? t('running…', 'en cours…') : s.exitstatus ?? ''}`;
        status.className = running || s.exitstatus === 'OK' ? 'muted small' : 'danger-text small';
        if (!running) return;
      } catch (e) {
        error.textContent = errorText(e);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  dialog.showModal();
  poll();
}

// ---------- Adresses et connexion ----------

/** Adresses IP d'une machine : agent QEMU (machines virtuelles) ou interfaces (conteneurs). */
export async function guestAddresses(p: Pve, g: Guest): Promise<{ iface: string; ip: string; v6: boolean }[]> {
  const out: { iface: string; ip: string; v6: boolean }[] = [];
  const usable = (ip: string) => !!ip && !ip.startsWith('127.') && ip !== '::1' && !ip.toLowerCase().startsWith('fe80');
  if (g.type === 'qemu') {
    const r = await proxmox.api<{ result: { name: string; 'ip-addresses'?: { 'ip-address': string; 'ip-address-type': string }[] }[] }>(p.id, 'GET', `${guestBase(g)}/agent/network-get-interfaces`);
    for (const i of r?.result ?? []) {
      if (i.name === 'lo' || /loopback/i.test(i.name)) continue;
      for (const a of i['ip-addresses'] ?? []) if (usable(a['ip-address'])) out.push({ iface: i.name, ip: a['ip-address'], v6: a['ip-address-type'] === 'ipv6' });
    }
  } else {
    const r = await proxmox.api<{ name: string; inet?: string; inet6?: string }[]>(p.id, 'GET', `${guestBase(g)}/interfaces`);
    for (const i of r ?? []) {
      if (i.name === 'lo') continue;
      for (const [cidr, v6] of [[i.inet, false], [i.inet6, true]] as const) {
        for (const one of String(cidr ?? '').split(/[ ,]+/).filter(Boolean)) {
          const ip = one.split('/')[0];
          if (usable(ip)) out.push({ iface: i.name, ip, v6 });
        }
      }
    }
  }
  // IPv4 d'abord.
  return out.sort((a, b) => Number(a.v6) - Number(b.v6));
}

/** Se connecter à une machine par SSH ou Bureau à distance, avec son adresse vue par Proxmox. */
export async function openConnect(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const list = h('div', {}, h('p', { class: 'muted' }, t('Looking for the machine\'s addresses…', 'Recherche des adresses de la machine…')));
  const { dialog } = modal(t(`Connect · ${guestLabel(g)}`, `Se connecter · ${guestLabel(g)}`), [list], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  dialog.showModal();
  try {
    const ips = await guestAddresses(p, g);
    if (!ips.length) throw new Error(t('no address', 'aucune adresse'));
    const windows = /win/i.test(String((await proxmox.api<Config>(p.id, 'GET', `${guestBase(g)}/config`).catch((): Config => ({})))?.ostype ?? ''));
    list.replaceChildren(table([t('Interface', 'Interface'), t('Address', 'Adresse'), ''], ips.map((a) => {
      const host = a.v6 ? `[${a.ip}]` : a.ip;
      return h('tr', {}, h('td', {}, a.iface), h('td', { class: 'mono small' }, a.ip), actions(
        btn('SSH', () => { dialog.close(); panel.host.quickConnect(`ssh ${host}`); }, windows ? '' : 'primary'),
        btn(t('Remote Desktop', 'Bureau à distance'), () => { dialog.close(); panel.host.quickConnect(`rdp ${host}`); }, windows ? 'primary' : ''),
        btn(t('Save as a session…', 'Enregistrer comme session…'), () => { dialog.close(); panel.host.saveSession(windows ? 'rdp' : 'ssh', g.name ?? String(g.vmid), a.ip); }),
      ));
    })), h('p', { class: 'muted small' }, t('Addresses reported by the machine itself; Portunia connects to it directly (not through Proxmox).', 'Adresses données par la machine elle-même ; Portunia s\'y connecte directement (pas par Proxmox).')));
  } catch (e) {
    const agentHint = g.type === 'qemu'
      ? t('Proxmox learns a VM\'s addresses through the QEMU guest agent: install it in the machine (qemu-guest-agent on Linux, the VirtIO tools on Windows), then tick « QEMU Guest Agent » in its options and restart it.', 'Proxmox connaît les adresses d\'une VM par l\'agent invité QEMU : installez-le dans la machine (qemu-guest-agent sous Linux, les outils VirtIO sous Windows), cochez « QEMU Guest Agent » dans ses options et redémarrez-la.')
      : t('The container gives no address: check its network card (Hardware) and that it is running.', 'Le conteneur ne donne aucune adresse : vérifiez sa carte réseau (Matériel) et qu\'il est en marche.');
    list.replaceChildren(h('p', {}, agentHint), h('p', { class: 'muted small' }, errorText(e)));
  }
}

// ---------- Matériel ----------

const DISK_RE = /^(scsi|virtio|sata|ide)\d+$/;
const NET_MODELS: [string, string][] = [['virtio', 'VirtIO'], ['e1000', 'Intel E1000'], ['e1000e', 'Intel E1000E'], ['vmxnet3', 'VMware vmxnet3'], ['rtl8139', 'Realtek RTL8139']];
const CPU_TYPES = ['host', 'x86-64-v2-AES', 'x86-64-v3', 'x86-64-v4', 'kvm64', 'qemu64'];

/** Disques, cartes réseau, lecteur CD, ordre de démarrage et processeur d'une machine. */
export async function openHardware(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const body = h('div', { class: 'pve-sections' });
  const { dialog, error } = modal(t(`Hardware · ${guestLabel(g)}`, `Matériel · ${guestLabel(g)}`), [body,
    h('p', { class: 'muted small' }, g.status === 'running' ? t('Running: disks and network cards are usually added live; other changes wait for the next restart (Proxmox marks them as pending).', 'En marche : disques et cartes réseau s\'ajoutent en général à chaud ; les autres changements attendent le prochain redémarrage (Proxmox les note « en attente »).') : null)], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  const path = `${guestBase(g)}/config`;
  const put = async (params: Config, done: string) => {
    error.textContent = '';
    try {
      await proxmox.api(p.id, 'PUT', path, params);
      panel.host.toast(done);
      await draw();
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  const task = async (url: string, method: 'POST' | 'PUT', params: Config, label: string) => {
    error.textContent = '';
    await panel.run(p, g.node, url, label, method, params);
    await draw();
  };
  const draw = async () => {
    let config: Config;
    try {
      config = await proxmox.api<Config>(p.id, 'GET', path);
    } catch (e) {
      error.textContent = errorText(e);
      return;
    }
    const images = await storesFor(p, g.node, g.type === 'qemu' ? 'images' : 'rootdir');
    const storeOptions = images.map((s): [string, string] => [s.storage, s.avail != null ? `${s.storage} (${t(`${bytes(s.avail)} free`, `${bytes(s.avail)} libres`)})` : s.storage]);
    const sections: HTMLElement[] = [];

    // Disques (et volumes des conteneurs).
    const diskKeys = Object.keys(config).filter((k) => (g.type === 'qemu' ? DISK_RE.test(k) && !/media=cdrom/.test(config[k]) && !/cloudinit/.test(config[k]) : k === 'rootfs' || /^mp\d+$/.test(k)))
      .sort((a, b) => (a === 'rootfs' ? -1 : b === 'rootfs' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    const resize = (key: string) => {
      const more = prompt(t(`Grow ${key} by how many GiB? (it cannot shrink)`, `Agrandir ${key} de combien de Gio ? (impossible de réduire)`), '10');
      const n = Number(more);
      if (!more || !Number.isFinite(n) || n <= 0) return;
      task(`${guestBase(g)}/resize`, 'PUT', { disk: key, size: `+${n}G` }, t(`Resize ${key}`, `Agrandissement de ${key}`));
    };
    const move = (key: string) => {
      const target = select(storeOptions);
      const keep = check(t('Keep the old copy', 'Garder l\'ancienne copie'), false);
      const go = h('button', { type: 'submit', class: 'btn primary' }, t('Move', 'Déplacer'));
      const m = modal(t(`Move ${key}`, `Déplacer ${key}`), [field(t('To the storage', 'Vers le stockage'), target), keep.row], [go]);
      m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
      m.form.addEventListener('submit', (e) => {
        e.preventDefault();
        m.dialog.close();
        const params = g.type === 'qemu' ? { disk: key, storage: target.value, delete: keep.box.checked ? 0 : 1 } : { volume: key, storage: target.value, delete: keep.box.checked ? 0 : 1 };
        task(`${guestBase(g)}/${g.type === 'qemu' ? 'move_disk' : 'move_volume'}`, 'POST', params, t(`Move of ${key}`, `Déplacement de ${key}`));
      });
      m.dialog.showModal();
    };
    const addDisk = () => {
      const bus = select(g.type === 'qemu' ? [['scsi', 'SCSI'], ['virtio', 'VirtIO Block'], ['sata', 'SATA']] : [['mp', t('Mount point', 'Point de montage')]], 'scsi');
      const storage = select(storeOptions);
      const size = input({ type: 'number', min: 1, value: '32' });
      const mount = input({ placeholder: '/data' });
      const go = h('button', { type: 'submit', class: 'btn primary' }, t('Add', 'Ajouter'));
      const m = modal(t('Add a disk', 'Ajouter un disque'), [
        g.type === 'qemu' ? field(t('Bus', 'Bus'), bus) : null,
        field(t('Storage', 'Stockage'), storage), field(t('Size (GiB)', 'Taille (Gio)'), size),
        g.type === 'lxc' ? field(t('Path in the container', 'Chemin dans le conteneur'), mount) : null,
      ], [go]);
      m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
      m.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const prefix = g.type === 'qemu' ? bus.value : 'mp';
        const key = nextKey(config, prefix, prefix === 'sata' ? 5 : prefix === 'virtio' ? 15 : prefix === 'mp' ? 255 : 30);
        if (!key) { m.error.textContent = t('No free slot on this bus.', 'Plus d\'emplacement libre sur ce bus.'); return; }
        if (g.type === 'lxc' && !mount.value.startsWith('/')) { m.error.textContent = t('Give an absolute path (/data).', 'Indiquez un chemin absolu (/data).'); return; }
        const value = g.type === 'qemu' ? `${storage.value}:${Number(size.value)}${prefix === 'scsi' ? ',iothread=1' : ''}` : `${storage.value}:${Number(size.value)},mp=${mount.value}`;
        m.dialog.close();
        put({ [key]: value, digest: config.digest }, t(`Disk ${key} added`, `Disque ${key} ajouté`));
      });
      m.dialog.showModal();
    };
    sections.push(section(t('Disks', 'Disques'),
      table([t('Slot', 'Emplacement'), t('Volume', 'Volume'), t('Size', 'Taille'), ''], diskKeys.map((k) => h('tr', {},
        h('td', {}, k), h('td', { class: 'mono small' }, String(config[k]).split(',')[0]), h('td', {}, opt(config[k], 'size') ?? ''),
        actions(btn(t('Grow', 'Agrandir'), () => resize(k)), btn(t('Move', 'Déplacer'), () => move(k)))))),
      h('div', { class: 'pve-row-actions' }, btn(t('Add a disk…', 'Ajouter un disque…'), addDisk))));

    // Cartes réseau.
    const netKeys = Object.keys(config).filter((k) => /^net\d+$/.test(k)).sort();
    const bridgeList = await bridges(p, g.node);
    const editNet = (key: string | null) => {
      const cur = key ? String(config[key]) : '';
      const parts = parseOpts(cur);
      const model = select(NET_MODELS, g.type === 'qemu' ? (parts.find(([k]) => NET_MODELS.some(([m]) => m === k))?.[0] ?? 'virtio') : undefined);
      const bridge = select(bridgeList.map((b): [string, string] => [b, b]), opt(cur, 'bridge') ?? bridgeList[0]);
      const tag = input({ type: 'number', min: 1, max: 4094, value: opt(cur, 'tag') ?? '', placeholder: t('none', 'aucun') });
      const fw = check(t('Proxmox firewall on this card', 'Pare-feu Proxmox sur cette carte'), key ? opt(cur, 'firewall') === '1' : true);
      const name = input({ value: opt(cur, 'name') ?? `eth${netKeys.length}` });
      const ip = input({ value: opt(cur, 'ip') ?? 'dhcp', placeholder: 'dhcp · 192.168.1.20/24' });
      const gw = input({ value: opt(cur, 'gw') ?? '' });
      const go = h('button', { type: 'submit', class: 'btn primary' }, key ? t('Save', 'Enregistrer') : t('Add', 'Ajouter'));
      const m = modal(key ? t(`Network card ${key}`, `Carte réseau ${key}`) : t('Add a network card', 'Ajouter une carte réseau'), [
        g.type === 'qemu' ? field(t('Model', 'Modèle'), model) : field(t('Name in the container', 'Nom dans le conteneur'), name),
        h('div', { class: 'row2' }, field(t('Bridge', 'Pont'), bridge), field(t('VLAN tag', 'Étiquette VLAN'), tag)),
        g.type === 'lxc' ? h('div', { class: 'row2' }, field(t('IPv4 address', 'Adresse IPv4'), ip), field(t('Gateway', 'Passerelle'), gw)) : null,
        fw.row,
      ], [go]);
      m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
      m.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const target = key ?? nextKey(config, 'net', 31);
        if (!target) return;
        let value: string;
        if (g.type === 'qemu') {
          // L'adresse MAC reste celle de la carte quand le modèle change.
          const mac = parts.find(([k]) => NET_MODELS.some(([mm]) => mm === k))?.[1];
          value = `${model.value}${mac ? `=${mac}` : ''},bridge=${bridge.value}`;
          for (const [k, v] of parts) if (!NET_MODELS.some(([mm]) => mm === k) && !['bridge', 'tag', 'firewall'].includes(k)) value += `,${k}=${v}`;
        } else {
          value = `name=${name.value.trim()},bridge=${bridge.value}`;
          if (ip.value.trim()) value += `,ip=${ip.value.trim()}`;
          if (gw.value.trim() && ip.value.trim() !== 'dhcp') value += `,gw=${gw.value.trim()}`;
          for (const [k, v] of parts) if (!['name', 'bridge', 'tag', 'firewall', 'ip', 'gw'].includes(k)) value += `,${k}=${v}`;
        }
        if (tag.value) value += `,tag=${Number(tag.value)}`;
        if (fw.box.checked) value += ',firewall=1';
        m.dialog.close();
        put({ [target]: value, digest: config.digest }, t(`Network card ${target} saved`, `Carte réseau ${target} enregistrée`));
      });
      m.dialog.showModal();
    };
    sections.push(section(t('Network cards', 'Cartes réseau'),
      table([t('Card', 'Carte'), t('Settings', 'Réglages'), ''], netKeys.map((k) => h('tr', {},
        h('td', {}, k), h('td', { class: 'mono small' }, String(config[k])),
        actions(btn(t('Edit', 'Modifier'), () => editNet(k)), btn(t('Remove', 'Retirer'), () => {
          if (confirm(t(`Remove the network card ${k}?`, `Retirer la carte réseau ${k} ?`))) put({ delete: k, digest: config.digest }, t(`${k} removed`, `${k} retirée`));
        }, 'danger'))))),
      h('div', { class: 'pve-row-actions' }, btn(t('Add a network card…', 'Ajouter une carte réseau…'), () => editNet(null)))));

    if (g.type === 'qemu') {
      // Lecteur CD : image ISO à insérer ou retirer.
      const cdKeys = Object.keys(config).filter((k) => DISK_RE.test(k) && /media=cdrom/.test(config[k]) && !/cloudinit/.test(config[k]));
      const isoStores = await storesFor(p, g.node, 'iso');
      const isos: [string, string][] = [['none', t('(empty drive)', '(lecteur vide)')]];
      for (const s of isoStores) {
        try {
          const vols = await proxmox.api<{ volid: string }[]>(p.id, 'GET', `/nodes/${g.node}/storage/${encodeURIComponent(s.storage)}/content`, { content: 'iso' });
          for (const v of vols) isos.push([v.volid, v.volid.replace(/^[^:]+:iso\//, '')]);
        } catch { /* stockage injoignable */ }
      }
      const cdRows = (cdKeys.length ? cdKeys : ['ide2']).map((k) => {
        const current = config[k] ? String(config[k]).split(',')[0] : 'none';
        const iso = select(isos, current);
        return h('tr', {}, h('td', {}, k), h('td', {}, iso), actions(btn(t('Apply', 'Appliquer'), () => put({ [k]: `${iso.value},media=cdrom`, digest: config.digest }, t('CD drive changed', 'Lecteur CD changé')))));
      });
      sections.push(section(t('CD drive', 'Lecteur CD'), table([t('Drive', 'Lecteur'), t('Image', 'Image'), ''], cdRows),
        h('p', { class: 'muted small' }, t('Images come from the node\'s storages: send one from this PC with « Send an ISO… » (node menu).', 'Les images viennent des stockages du nœud : envoyez-en une depuis ce PC avec « Envoyer une ISO… » (menu du nœud).'))));

      // Ordre de démarrage.
      const bootable = [...diskKeys, ...cdKeys, ...netKeys];
      const current = String(config.boot ?? '').replace(/^order=/, '').split(';').filter((x) => bootable.includes(x));
      const order = [...current, ...bootable.filter((x) => !current.includes(x))];
      const enabled = new Set(current);
      const list = h('div', { class: 'pve-boot' });
      const drawBoot = () => list.replaceChildren(...order.map((dev, i) => {
        const box = h('input', { type: 'checkbox', checked: enabled.has(dev), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) enabled.add(dev); else enabled.delete(dev); } });
        return h('div', { class: 'pve-boot-row' }, box, h('span', { class: 'grow mono small' }, `${dev} · ${String(config[dev]).split(',')[0]}`),
          h('button', { type: 'button', class: 'icon-btn sm', disabled: i === 0, 'aria-label': t('Up', 'Monter'), onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawBoot(); } }, '↑'),
          h('button', { type: 'button', class: 'icon-btn sm', disabled: i === order.length - 1, 'aria-label': t('Down', 'Descendre'), onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; drawBoot(); } }, '↓'));
      }));
      drawBoot();
      sections.push(section(t('Boot order', 'Ordre de démarrage'), list,
        h('div', { class: 'pve-row-actions' }, btn(t('Save the order', 'Enregistrer l\'ordre'), () => put({ boot: `order=${order.filter((d) => enabled.has(d)).join(';')}`, digest: config.digest }, t('Boot order saved', 'Ordre de démarrage enregistré'))))));

      // Processeur.
      const cpuNow = String(config.cpu ?? 'kvm64').split(',')[0];
      const cpu = select([...new Set([cpuNow, ...CPU_TYPES])].map((c): [string, string] => [c, c === 'host' ? t('host (all the node\'s features, no migration to another CPU model)', 'host (toutes les fonctions du nœud, pas de migration vers un autre modèle)') : c]), cpuNow);
      const agent = check(t('QEMU guest agent (addresses, clean shutdown)', 'Agent invité QEMU (adresses, arrêt propre)'), /^1|enabled=1/.test(String(config.agent ?? '')));
      sections.push(section(t('Processor and options', 'Processeur et options'), field(t('CPU type', 'Type de processeur'), cpu), agent.row,
        h('div', { class: 'pve-row-actions' }, btn(t('Save', 'Enregistrer'), () => put({ cpu: cpu.value, agent: agent.box.checked ? 1 : 0, digest: config.digest }, t('Saved', 'Enregistré'))))));
    }
    body.replaceChildren(...sections);
  };
  dialog.showModal();
  await draw();
}

// ---------- Cloud-init ----------

/** Utilisateur, clés SSH, adresse et DNS donnés au premier démarrage d'une VM (modèles cloud-init). */
export async function openCloudInit(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const path = `${guestBase(g)}/config`;
  let config: Config;
  try {
    config = await proxmox.api<Config>(p.id, 'GET', path);
  } catch (e) {
    return panel.host.toast(errorText(e), 'error');
  }
  const drive = Object.keys(config).find((k) => /cloudinit/.test(String(config[k])));
  const user = input({ value: config.ciuser ?? '', placeholder: 'debian' });
  const password = input({ type: 'password', placeholder: config.cipassword ? t('Kept: leave empty', 'Gardé : laisser vide') : t('None (SSH keys only)', 'Aucun (clés SSH seulement)') });
  let keys = '';
  try { keys = decodeURIComponent(config.sshkeys ?? ''); } catch { keys = config.sshkeys ?? ''; }
  const sshkeys = h('textarea', { class: 'input mono small', rows: 4, placeholder: 'ssh-ed25519 AAAA… julien@pc' }, keys) as HTMLTextAreaElement;
  const ip0 = String(config.ipconfig0 ?? 'ip=dhcp');
  const mode = select([['dhcp', 'DHCP'], ['static', t('Fixed address', 'Adresse fixe')]], opt(ip0, 'ip') === 'dhcp' || !opt(ip0, 'ip') ? 'dhcp' : 'static');
  const ip = input({ value: opt(ip0, 'ip') !== 'dhcp' ? opt(ip0, 'ip') ?? '' : '', placeholder: '192.168.1.50/24' });
  const gw = input({ value: opt(ip0, 'gw') ?? '', placeholder: '192.168.1.1' });
  const dns = input({ value: config.nameserver ?? '', placeholder: t('like the node', 'comme le nœud') });
  const domain = input({ value: config.searchdomain ?? '', placeholder: t('like the node', 'comme le nœud') });
  const upgrade = check(t('Update packages at first boot', 'Mettre à jour les paquets au premier démarrage'), config.ciupgrade !== 0);
  const staticRow = h('div', { class: 'row2' }, field(t('Address/prefix', 'Adresse/préfixe'), ip), field(t('Gateway', 'Passerelle'), gw));
  const sync = () => { staticRow.hidden = mode.value !== 'static'; };
  mode.addEventListener('change', sync);
  sync();
  const storage = select((await storesFor(p, g.node, 'images')).map((s): [string, string] => [s.storage, s.storage]));
  const addDrive = h('div', { class: 'pve-note', hidden: !!drive },
    h('p', {}, t('This VM has no cloud-init drive yet: add one, on the storage below.', 'Cette VM n\'a pas encore de lecteur cloud-init : ajoutez-en un, sur le stockage ci-dessous.')), field(t('Storage', 'Stockage'), storage));
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Save', 'Enregistrer'));
  const { dialog, form, error } = modal(t(`Cloud-init · ${guestLabel(g)}`, `Cloud-init · ${guestLabel(g)}`), [
    addDrive,
    h('div', { class: 'row2' }, field(t('User', 'Utilisateur'), user), field(t('Password', 'Mot de passe'), password)),
    field(t('SSH public keys (one per line)', 'Clés SSH publiques (une par ligne)'), sshkeys),
    field(t('Network (first card)', 'Réseau (première carte)'), mode), staticRow,
    h('div', { class: 'row2' }, field(t('DNS servers', 'Serveurs DNS'), dns), field(t('Search domain', 'Domaine de recherche'), domain)),
    upgrade.row,
    h('p', { class: 'muted small' }, t('Applied at the next boot of the VM (the system image must support cloud-init, like the official « cloud » images of Debian or Ubuntu).', 'Appliqué au prochain démarrage de la VM (l\'image du système doit gérer cloud-init, comme les images « cloud » officielles de Debian ou d\'Ubuntu).')),
  ], [submit], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const params: Config = { digest: config.digest };
    const remove: string[] = [];
    if (!drive) {
      const slot = ['ide2', 'ide0', 'ide3', 'ide1'].find((k) => config[k] === undefined);
      if (!slot) { error.textContent = t('No free IDE slot for the cloud-init drive.', 'Aucun emplacement IDE libre pour le lecteur cloud-init.'); return; }
      params[slot] = `${storage.value}:cloudinit`;
    }
    const setOrDelete = (key: string, value: string) => { if (value) params[key] = value; else if (config[key] !== undefined) remove.push(key); };
    setOrDelete('ciuser', user.value.trim());
    if (password.value) params.cipassword = password.value;
    // Proxmox attend les clés encodées comme une adresse.
    const k = sshkeys.value.split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
    if (k) params.sshkeys = encodeURIComponent(k).replace(/'/g, '%27'); else if (config.sshkeys !== undefined) remove.push('sshkeys');
    params.ipconfig0 = mode.value === 'dhcp' ? 'ip=dhcp' : `ip=${ip.value.trim()}${gw.value.trim() ? `,gw=${gw.value.trim()}` : ''}`;
    setOrDelete('nameserver', dns.value.trim());
    setOrDelete('searchdomain', domain.value.trim());
    params.ciupgrade = upgrade.box.checked ? 1 : 0;
    if (remove.length) params.delete = remove.join(',');
    try {
      await proxmox.api(p.id, 'PUT', path, params);
      // Proxmox 8.1 et suivants : le lecteur est refait tout de suite (sinon au démarrage).
      await proxmox.api(p.id, 'PUT', `${guestBase(g)}/cloudinit`).catch(() => undefined);
      panel.host.toast(t('Cloud-init saved: applied at the next boot', 'Cloud-init enregistré : appliqué au prochain démarrage'));
      dialog.close();
    } catch (err) {
      error.textContent = errorText(err);
    }
  });
  dialog.showModal();
}

// ---------- Envoi d'une image ----------

/** Envoie une image ISO ou un modèle de conteneur de ce PC vers un stockage du nœud. */
export async function openUpload(panel: ProxmoxPanel, p: Pve, node: string, done?: () => void) {
  const kind = select([['iso', t('ISO image (.iso, .img)', 'Image ISO (.iso, .img)')], ['vztmpl', t('Container template (.tar.zst, .tar.xz, .tar.gz)', 'Modèle de conteneur (.tar.zst, .tar.xz, .tar.gz)')]], 'iso');
  const storage = select([]);
  const fillStores = async () => {
    const list = await storesFor(p, node, kind.value);
    storage.replaceChildren(...list.map((s) => h('option', { value: s.storage }, s.avail != null ? `${s.storage} (${t(`${bytes(s.avail)} free`, `${bytes(s.avail)} libres`)})` : s.storage)));
  };
  const chosen = h('div', { class: 'mono small' }, t('No file chosen', 'Aucun fichier choisi'));
  let path = '';
  const choose = btn(t('Choose the file…', 'Choisir le fichier…'), async () => {
    const r = await pickFile({ multiple: false, directory: false, filters: kind.value === 'iso' ? [{ name: 'ISO', extensions: ['iso', 'img'] }] : [{ name: t('Templates', 'Modèles'), extensions: ['zst', 'xz', 'gz', 'tar'] }] });
    if (typeof r === 'string') { path = r; chosen.textContent = r; }
  });
  const bar = h('div', { class: 'assist-file-bar', hidden: true }, h('i', { style: 'width: 0%' }));
  const status = h('p', { class: 'muted small' });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Send', 'Envoyer'));
  const { dialog, form, error } = modal(t(`Send to ${node}`, `Envoyer vers ${node}`), [
    field(t('Type', 'Type'), kind), field(t('Storage', 'Stockage'), storage), h('div', { class: 'fld' }, choose, chosen), bar, status,
  ], [submit]);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  kind.addEventListener('change', fillStores);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!path) { error.textContent = t('Choose a file.', 'Choisissez un fichier.'); return; }
    if (!storage.value) { error.textContent = t('No storage of this node accepts this type.', 'Aucun stockage de ce nœud n\'accepte ce type.'); return; }
    submit.setAttribute('disabled', '');
    bar.hidden = false;
    const started = Date.now();
    try {
      const upid = await proxmoxUpload(p.id, node, storage.value, kind.value as 'iso' | 'vztmpl', path, (sent, total) => {
        (bar.firstElementChild as HTMLElement).style.width = `${total ? (sent * 100) / total : 100}%`;
        const speed = sent / Math.max(1, (Date.now() - started) / 1000);
        status.textContent = t(`${bytes(sent)} of ${bytes(total)} · ${bytes(speed)}/s`, `${bytes(sent)} sur ${bytes(total)} · ${bytes(speed)}/s`);
      });
      status.textContent = t('Sent: Proxmox checks and stores the file…', 'Envoyé : Proxmox vérifie et range le fichier…');
      const ok = typeof upid === 'string' && upid.startsWith('UPID:') ? await panel.waitTask(p, node, upid, t('Upload', 'Envoi')) : true;
      if (ok) {
        dialog.close();
        done?.();
      }
    } catch (err) {
      error.textContent = errorText(err);
    } finally {
      submit.removeAttribute('disabled');
    }
  });
  dialog.showModal();
  fillStores();
}

// ---------- Pare-feu ----------

export type FirewallScope = { kind: 'cluster' } | { kind: 'node'; node: string } | { kind: 'guest'; guest: Guest };
const MACROS = ['', 'SSH', 'HTTP', 'HTTPS', 'RDP', 'Ping', 'DNS', 'SMB', 'NTP', 'SMTP', 'IMAPS', 'MySQL', 'PostgreSQL', 'VNC'];

/** Règles du pare-feu de Proxmox (datacenter, nœud ou machine), et son interrupteur. */
export async function openFirewall(_panel: ProxmoxPanel, p: Pve, scope: FirewallScope) {
  const base = scope.kind === 'cluster' ? '/cluster/firewall' : scope.kind === 'node' ? `/nodes/${scope.node}/firewall` : `${guestBase(scope.guest)}/firewall`;
  const title = scope.kind === 'cluster' ? t('Datacenter', 'Datacenter') : scope.kind === 'node' ? scope.node : guestLabel(scope.guest);
  const body = h('div', {});
  const { dialog, error } = modal(t(`Firewall · ${title}`, `Pare-feu · ${title}`), [body], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  const call = async (method: 'POST' | 'PUT' | 'DELETE', path: string, params?: Config) => {
    error.textContent = '';
    try {
      await proxmox.api(p.id, method, path, params);
      await draw();
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  const draw = async () => {
    let options: Config;
    let rules: { pos: number; type: string; action: string; macro?: string; proto?: string; dport?: string; source?: string; dest?: string; enable?: number; comment?: string }[];
    try {
      [options, rules] = await Promise.all([proxmox.api<Config>(p.id, 'GET', `${base}/options`), proxmox.api(p.id, 'GET', `${base}/rules`)]);
    } catch (e) {
      error.textContent = errorText(e);
      return;
    }
    const on = options.enable === 1 || (scope.kind === 'node' && options.enable === undefined);
    const toggle = check(scope.kind === 'node' ? t('Firewall of the node on (needs the datacenter one on)', 'Pare-feu du nœud actif (demande celui du datacenter actif)') : t('Firewall on', 'Pare-feu actif'), on);
    toggle.box.addEventListener('change', () => {
      const enable = toggle.box.checked;
      if (enable && scope.kind === 'cluster' && !confirm(t('Turn on the datacenter firewall? Incoming traffic is then dropped unless a rule allows it (the web interface and SSH stay reachable from the local network). Check the rules first.', 'Activer le pare-feu du datacenter ? Le trafic entrant est alors refusé sauf règle qui l\'autorise (l\'interface web et SSH restent joignables depuis le réseau local). Vérifiez d\'abord les règles.'))) { toggle.box.checked = false; return; }
      call('PUT', `${base}/options`, { enable: enable ? 1 : 0 });
    });
    const policy = scope.kind !== 'node' ? h('p', { class: 'muted small' }, t(`Default policy: in ${options.policy_in ?? 'DROP'}, out ${options.policy_out ?? 'ACCEPT'}.`, `Politique par défaut : entrée ${options.policy_in ?? 'DROP'}, sortie ${options.policy_out ?? 'ACCEPT'}.`)) : null;
    const guestNote = scope.kind === 'guest' ? h('p', { class: 'muted small' }, t('Rules apply to the network cards marked « firewall » (Hardware), when the datacenter firewall is on.', 'Les règles s\'appliquent aux cartes réseau marquées « pare-feu » (Matériel), quand le pare-feu du datacenter est actif.')) : null;
    // Nouvelle règle.
    const dir = select([['in', t('In', 'Entrée')], ['out', t('Out', 'Sortie')]], 'in');
    const action = select([['ACCEPT', 'ACCEPT'], ['DROP', 'DROP'], ['REJECT', 'REJECT']], 'ACCEPT');
    const macro = select(MACROS.map((m): [string, string] => [m, m || t('(none: protocol and port)', '(aucune : protocole et port)')]), '');
    const proto = select([['', t('any', 'tous')], ['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']], 'tcp');
    const dport = input({ placeholder: '443, 8000:8100' });
    const source = input({ placeholder: t('any · 192.168.1.0/24', 'toutes · 192.168.1.0/24') });
    const comment = input({ placeholder: t('Comment', 'Commentaire') });
    const syncMacro = () => { proto.disabled = !!macro.value; dport.disabled = !!macro.value; };
    macro.addEventListener('change', syncMacro);
    syncMacro();
    const add = btn(t('Add the rule', 'Ajouter la règle'), () => {
      const params: Config = { type: dir.value, action: action.value, enable: 1 };
      if (macro.value) params.macro = macro.value;
      else { if (proto.value) params.proto = proto.value; if (dport.value.trim()) params.dport = dport.value.trim(); }
      if (source.value.trim()) params.source = source.value.trim();
      if (comment.value.trim()) params.comment = comment.value.trim();
      call('POST', `${base}/rules`, params);
    }, 'primary');
    body.replaceChildren(toggle.row, policy ?? '', guestNote ?? '',
      rules.length ? table([t('On', 'Active'), t('Direction', 'Sens'), t('Action', 'Action'), t('Rule', 'Règle'), t('Source', 'Source'), t('Comment', 'Commentaire'), ''], rules.sort((a, b) => a.pos - b.pos).map((r) => {
        const box = h('input', { type: 'checkbox', checked: r.enable === 1, onchange: (e: Event) => call('PUT', `${base}/rules/${r.pos}`, { enable: (e.target as HTMLInputElement).checked ? 1 : 0 }) });
        return h('tr', {}, h('td', {}, box), h('td', {}, r.type), h('td', { class: r.action === 'ACCEPT' ? '' : 'danger-text' }, r.action),
          h('td', { class: 'mono small' }, r.macro ?? [r.proto, r.dport].filter(Boolean).join(' ') ?? ''), h('td', { class: 'mono small' }, r.source ?? t('any', 'toutes')),
          h('td', { class: 'muted small' }, r.comment ?? ''),
          actions(btn(t('Delete', 'Supprimer'), () => { if (confirm(t('Delete this rule?', 'Supprimer cette règle ?'))) call('DELETE', `${base}/rules/${r.pos}`); }, 'danger')));
      })) : h('p', { class: 'muted' }, t('No rule.', 'Aucune règle.')),
      section(t('New rule', 'Nouvelle règle'),
        h('div', { class: 'row2' }, field(t('Direction', 'Sens'), dir), field(t('Action', 'Action'), action)),
        field(t('Service (macro)', 'Service (macro)'), macro),
        h('div', { class: 'row2' }, field(t('Protocol', 'Protocole'), proto), field(t('Destination port', 'Port de destination'), dport)),
        h('div', { class: 'row2' }, field(t('Source', 'Source'), source), field(t('Comment', 'Commentaire'), comment)),
        h('div', { class: 'pve-row-actions' }, add)));
  };
  dialog.showModal();
  await draw();
}

// ---------- Utilisateurs et droits ----------

interface PveUser { userid: string; enable?: number; expire?: number; email?: string; comment?: string; firstname?: string; lastname?: string; groups?: string | string[]; tokens?: { tokenid: string; privsep?: number; comment?: string; expire?: number }[] }

/** Utilisateurs, jetons d'API, groupes et permissions de Proxmox. */
export async function openAccess(_panel: ProxmoxPanel, p: Pve) {
  const tabs = h('div', { class: 'pve-tabs', role: 'tablist' });
  const body = h('div', {});
  const { dialog, error } = modal(t(`Users and permissions · ${p.name}`, `Utilisateurs et droits · ${p.name}`), [tabs, body], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  let current: 'users' | 'acl' | 'groups' = 'users';
  const call = async (method: 'POST' | 'PUT' | 'DELETE', path: string, params?: Config, done?: string) => {
    error.textContent = '';
    try {
      const r = await proxmox.api(p.id, method, path, params);
      if (done) _panel.host.toast(done);
      await draw();
      return r;
    } catch (e) {
      error.textContent = errorText(e);
      return undefined;
    }
  };
  const usersView = async () => {
    const [users, realms, groups] = await Promise.all([
      proxmox.api<PveUser[]>(p.id, 'GET', '/access/users', { full: 1 }),
      proxmox.api<{ realm: string; type: string; comment?: string }[]>(p.id, 'GET', '/access/domains'),
      proxmox.api<{ groupid: string }[]>(p.id, 'GET', '/access/groups').catch(() => []),
    ]);
    const showSecret = (full: string, value: string) => {
      const m = modal(t('New API token', 'Nouveau jeton d\'API'), [
        h('p', {}, t('Copy the secret now: Proxmox will never show it again.', 'Copiez le secret maintenant : Proxmox ne le montrera plus jamais.')),
        field(t('Token', 'Jeton'), input({ value: full, readonly: true })),
        field(t('Secret', 'Secret'), input({ value, readonly: true })),
      ], [btn(t('Copy the secret', 'Copier le secret'), () => navigator.clipboard.writeText(value).then(() => _panel.host.toast(t('Secret copied', 'Secret copié'))), 'primary')]);
      m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
      m.dialog.showModal();
    };
    const newToken = (u: PveUser) => {
      const id = input({ placeholder: 'portunia' });
      const privsep = check(t('Separate privileges (the token gets only the permissions given to it)', 'Droits séparés (le jeton n\'a que les permissions qu\'on lui donne)'), true);
      const comment = input({});
      const go = h('button', { type: 'submit', class: 'btn primary' }, t('Create', 'Créer'));
      const m = modal(t(`New token for ${u.userid}`, `Nouveau jeton pour ${u.userid}`), [field(t('Token name', 'Nom du jeton'), id), privsep.row, field(t('Comment', 'Commentaire'), comment)], [go]);
      m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
      m.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id.value.trim())) { m.error.textContent = t('Letters, digits, « . _ - », starting with a letter.', 'Lettres, chiffres, « . _ - », en commençant par une lettre.'); return; }
        try {
          const r = await proxmox.api<{ value: string; 'full-tokenid': string }>(p.id, 'POST', `/access/users/${encodeURIComponent(u.userid)}/token/${encodeURIComponent(id.value.trim())}`, { privsep: privsep.box.checked ? 1 : 0, comment: comment.value || undefined });
          m.dialog.close();
          showSecret(r['full-tokenid'], r.value);
          await draw();
        } catch (err) {
          m.error.textContent = errorText(err);
        }
      });
      m.dialog.showModal();
    };
    const password = (u: PveUser) => {
      const pw = input({ type: 'password', autocomplete: 'new-password' });
      const confirmPw = input({ type: 'password', autocomplete: 'current-password', placeholder: t('Asked by Proxmox 8.1 and later', 'Demandé par Proxmox 8.1 et suivants') });
      const go = h('button', { type: 'submit', class: 'btn primary' }, t('Change', 'Changer'));
      const m = modal(t(`Password of ${u.userid}`, `Mot de passe de ${u.userid}`), [field(t('New password', 'Nouveau mot de passe'), pw), field(t('Your own password (confirmation)', 'Votre propre mot de passe (confirmation)'), confirmPw)], [go]);
      m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
      m.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await proxmox.api(p.id, 'PUT', '/access/password', { userid: u.userid, password: pw.value, 'confirmation-password': confirmPw.value || undefined });
          m.dialog.close();
          _panel.host.toast(t('Password changed', 'Mot de passe changé'));
        } catch (err) {
          m.error.textContent = errorText(err);
        }
      });
      m.dialog.showModal();
    };
    // Nouvel utilisateur.
    const name = input({ placeholder: 'marie' });
    const realm = select(realms.map((r): [string, string] => [r.realm, `${r.realm} (${r.type})`]), realms.some((r) => r.realm === 'pve') ? 'pve' : realms[0]?.realm);
    const pw = input({ type: 'password', autocomplete: 'new-password', placeholder: t('Proxmox realm (pve) only', 'Domaine Proxmox (pve) seulement') });
    const email = input({ type: 'email' });
    const group = select([['', t('(no group)', '(aucun groupe)')], ...groups.map((g): [string, string] => [g.groupid, g.groupid])], '');
    const add = btn(t('Add the user', 'Ajouter l\'utilisateur'), () => {
      if (!name.value.trim()) return;
      call('POST', '/access/users', { userid: `${name.value.trim()}@${realm.value}`, password: pw.value || undefined, email: email.value || undefined, groups: group.value || undefined }, t('User added', 'Utilisateur ajouté'));
    }, 'primary');
    return [
      table([t('User', 'Utilisateur'), t('On', 'Actif'), t('Groups', 'Groupes'), t('API tokens', 'Jetons d\'API'), ''], users.sort((a, b) => a.userid.localeCompare(b.userid)).map((u) => {
        const box = h('input', { type: 'checkbox', checked: u.enable !== 0, disabled: u.userid === 'root@pam', onchange: (e: Event) => call('PUT', `/access/users/${encodeURIComponent(u.userid)}`, { enable: (e.target as HTMLInputElement).checked ? 1 : 0 }) });
        const tokens = (u.tokens ?? []).map((tk) => h('div', { class: 'pve-token' }, h('span', { class: 'mono small' }, `${tk.tokenid}${tk.privsep === 0 ? '' : t(' (separate)', ' (séparé)')}`),
          h('button', { type: 'button', class: 'icon-btn sm', title: t('Delete the token', 'Supprimer le jeton'), onclick: () => { if (confirm(t(`Delete the token ${u.userid}!${tk.tokenid}? What uses it stops working.`, `Supprimer le jeton ${u.userid}!${tk.tokenid} ? Ce qui s'en sert cesse de fonctionner.`))) call('DELETE', `/access/users/${encodeURIComponent(u.userid)}/token/${encodeURIComponent(tk.tokenid)}`); } }, icon('trash', 12))));
        return h('tr', {}, h('td', {}, u.userid, u.email ? h('div', { class: 'muted small' }, u.email) : null), h('td', {}, box),
          h('td', { class: 'small' }, Array.isArray(u.groups) ? u.groups.join(', ') : u.groups ?? ''), h('td', {}, ...tokens),
          actions(btn(t('New token', 'Nouveau jeton'), () => newToken(u)),
            /@(pve|pam)$/.test(u.userid) ? btn(t('Password', 'Mot de passe'), () => password(u)) : h('span', {}),
            u.userid === 'root@pam' ? h('span', {}) : btn(t('Delete', 'Supprimer'), () => { if (confirm(t(`Delete the user ${u.userid} and their tokens?`, `Supprimer l'utilisateur ${u.userid} et ses jetons ?`))) call('DELETE', `/access/users/${encodeURIComponent(u.userid)}`); }, 'danger')));
      })),
      section(t('New user', 'Nouvel utilisateur'),
        h('div', { class: 'row2' }, field(t('Name', 'Nom'), name), field(t('Realm', 'Domaine'), realm)),
        h('div', { class: 'row2' }, field(t('Password', 'Mot de passe'), pw), field(t('Email', 'E-mail'), email)),
        field(t('Group', 'Groupe'), group), h('div', { class: 'pve-row-actions' }, add)),
    ];
  };
  const aclView = async () => {
    const [acl, roles, users, groups] = await Promise.all([
      proxmox.api<{ path: string; type: 'user' | 'group' | 'token'; ugid: string; roleid: string; propagate?: number }[]>(p.id, 'GET', '/access/acl'),
      proxmox.api<{ roleid: string }[]>(p.id, 'GET', '/access/roles'),
      proxmox.api<PveUser[]>(p.id, 'GET', '/access/users', { full: 1 }),
      proxmox.api<{ groupid: string }[]>(p.id, 'GET', '/access/groups').catch(() => []),
    ]);
    const key = { user: 'users', group: 'groups', token: 'tokens' } as const;
    const who = select([
      ...users.map((u): [string, string] => [`user:${u.userid}`, `${t('User', 'Utilisateur')} · ${u.userid}`]),
      ...users.flatMap((u) => (u.tokens ?? []).map((tk): [string, string] => [`token:${u.userid}!${tk.tokenid}`, `${t('Token', 'Jeton')} · ${u.userid}!${tk.tokenid}`])),
      ...groups.map((g): [string, string] => [`group:${g.groupid}`, `${t('Group', 'Groupe')} · ${g.groupid}`]),
    ]);
    const path = input({ value: '/', placeholder: '/ · /vms/100 · /storage/local · /pool/prod' });
    const role = select(roles.map((r): [string, string] => [r.roleid, r.roleid]).sort((a, b) => a[0].localeCompare(b[0])), 'PVEVMAdmin');
    const propagate = check(t('Also below this path', 'Aussi en dessous de ce chemin'), true);
    const add = btn(t('Give the permission', 'Donner la permission'), () => {
      const [type, id] = [who.value.slice(0, who.value.indexOf(':')), who.value.slice(who.value.indexOf(':') + 1)] as ['user' | 'group' | 'token', string];
      call('PUT', '/access/acl', { path: path.value.trim() || '/', roles: role.value, [key[type]]: id, propagate: propagate.box.checked ? 1 : 0 }, t('Permission given', 'Permission donnée'));
    }, 'primary');
    return [
      table([t('Path', 'Chemin'), t('Who', 'Qui'), t('Role', 'Rôle'), t('Below', 'En dessous'), ''], acl.sort((a, b) => a.path.localeCompare(b.path)).map((a) => h('tr', {},
        h('td', { class: 'mono small' }, a.path), h('td', {}, `${a.type === 'token' ? t('token', 'jeton') : a.type === 'group' ? t('group', 'groupe') : t('user', 'utilisateur')} · ${a.ugid}`), h('td', {}, a.roleid),
        h('td', {}, a.propagate === 0 ? t('no', 'non') : t('yes', 'oui')),
        actions(btn(t('Remove', 'Retirer'), () => { if (confirm(t(`Remove ${a.roleid} on ${a.path} for ${a.ugid}?`, `Retirer ${a.roleid} sur ${a.path} pour ${a.ugid} ?`))) call('PUT', '/access/acl', { path: a.path, roles: a.roleid, [key[a.type]]: a.ugid, delete: 1 }); }, 'danger'))))),
      section(t('New permission', 'Nouvelle permission'), field(t('Who', 'Qui'), who), h('div', { class: 'row2' }, field(t('Path', 'Chemin'), path), field(t('Role', 'Rôle'), role)), propagate.row,
        h('p', { class: 'muted small' }, t('PVEVMAdmin: manage machines · PVEVMUser: use them (console, power) · PVEAuditor: only look · Administrator: everything.', 'PVEVMAdmin : gérer les machines · PVEVMUser : les utiliser (console, marche/arrêt) · PVEAuditor : seulement regarder · Administrator : tout.')),
        h('div', { class: 'pve-row-actions' }, add)),
    ];
  };
  const groupsView = async () => {
    const groups = await proxmox.api<{ groupid: string; comment?: string; users?: string }[]>(p.id, 'GET', '/access/groups');
    const id = input({ placeholder: 'admins' });
    const comment = input({});
    return [
      table([t('Group', 'Groupe'), t('Members', 'Membres'), t('Comment', 'Commentaire'), ''], groups.map((g) => h('tr', {}, h('td', {}, g.groupid), h('td', { class: 'small' }, (g.users ?? '').replace(/,/g, ', ')), h('td', { class: 'muted small' }, g.comment ?? ''),
        actions(btn(t('Delete', 'Supprimer'), () => { if (confirm(t(`Delete the group ${g.groupid}?`, `Supprimer le groupe ${g.groupid} ?`))) call('DELETE', `/access/groups/${encodeURIComponent(g.groupid)}`); }, 'danger'))))),
      section(t('New group', 'Nouveau groupe'), h('div', { class: 'row2' }, field(t('Name', 'Nom'), id), field(t('Comment', 'Commentaire'), comment)),
        h('div', { class: 'pve-row-actions' }, btn(t('Create', 'Créer'), () => { if (id.value.trim()) call('POST', '/access/groups', { groupid: id.value.trim(), comment: comment.value || undefined }); }, 'primary'))),
    ];
  };
  const draw = async () => {
    tabs.replaceChildren(...([['users', t('Users and tokens', 'Utilisateurs et jetons')], ['acl', t('Permissions', 'Permissions')], ['groups', t('Groups', 'Groupes')]] as const).map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', class: `btn sm${current === id ? ' primary' : ''}`, 'aria-selected': String(current === id), onclick: () => { current = id; draw(); } }, label)));
    try {
      body.replaceChildren(...(current === 'users' ? await usersView() : current === 'acl' ? await aclView() : await groupsView()));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  dialog.showModal();
  await draw();
}

// ---------- Ceph ----------

/** État de Ceph vu d'un nœud : santé, moniteurs, OSD, pools, place. En lecture. */
export async function openCeph(_panel: ProxmoxPanel, p: Pve, node: string) {
  const body = h('div', {}, h('p', { class: 'muted' }, t('Loading…', 'Chargement…')));
  const refresh = btn(t('Refresh', 'Actualiser'), () => draw());
  const { dialog } = modal(t(`Ceph · ${node}`, `Ceph · ${node}`), [body], [refresh], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const draw = async () => {
    try {
      const s = await proxmox.api<Config>(p.id, 'GET', `/nodes/${node}/ceph/status`);
      const health = s.health?.status ?? '?';
      const checks = Object.entries<Config>(s.health?.checks ?? {}).map(([k, v]) => h('li', { class: v.severity === 'HEALTH_ERR' ? 'danger-text' : '' }, `${k} : ${v.summary?.message ?? ''}`));
      const osdmap = s.osdmap?.osdmap ?? s.osdmap ?? {};
      const pg = s.pgmap ?? {};
      const [pools, osd] = await Promise.all([
        proxmox.api<{ pool_name: string; size?: number; min_size?: number; pg_num?: number; bytes_used?: number; percent_used?: number }[]>(p.id, 'GET', `/nodes/${node}/ceph/pool`).catch(() => []),
        proxmox.api<{ root?: Config }>(p.id, 'GET', `/nodes/${node}/ceph/osd`).catch(() => ({ root: undefined })),
      ]);
      const osds: Config[] = [];
      const walk = (n: Config, host = '') => { if (n.type === 'osd') osds.push({ ...n, host }); for (const c of n.children ?? []) walk(c, n.type === 'host' ? n.name : host); };
      if (osd.root) walk(osd.root);
      body.replaceChildren(
        h('p', { class: health === 'HEALTH_OK' ? '' : 'danger-text' }, h('b', {}, health), ` · ${t('monitors', 'moniteurs')} ${(s.monmap?.mons ?? []).map((m: Config) => m.name).join(', ')}`),
        checks.length ? h('ul', { class: 'small' }, ...checks) : h('span', {}),
        h('p', {}, t(`OSD: ${osdmap.num_up_osds ?? '?'} up, ${osdmap.num_in_osds ?? '?'} in, out of ${osdmap.num_osds ?? '?'} · used ${bytes(pg.bytes_used)} / ${bytes(pg.bytes_total)} · ${pg.num_pgs ?? '?'} PG`,
          `OSD : ${osdmap.num_up_osds ?? '?'} en marche, ${osdmap.num_in_osds ?? '?'} dans le cluster, sur ${osdmap.num_osds ?? '?'} · occupé ${bytes(pg.bytes_used)} / ${bytes(pg.bytes_total)} · ${pg.num_pgs ?? '?'} PG`)),
        section(t('Pools', 'Pools'), table([t('Pool', 'Pool'), t('Copies', 'Copies'), 'PG', t('Used', 'Occupé')], pools.map((x) => h('tr', {}, h('td', {}, x.pool_name), h('td', {}, `${x.size ?? '?'}/${x.min_size ?? '?'}`), h('td', {}, String(x.pg_num ?? '')), h('td', {}, `${bytes(x.bytes_used)} (${Math.round((x.percent_used ?? 0) * 100)} %)`))))),
        section('OSD', table(['OSD', t('Host', 'Hôte'), t('State', 'État'), t('Class', 'Classe'), t('Used', 'Occupé')], osds.map((o) => h('tr', {},
          h('td', {}, o.name), h('td', {}, o.host), h('td', { class: o.status === 'up' && o.in === 1 ? '' : 'danger-text' }, `${o.status ?? '?'}${o.in === 1 ? '' : ' · out'}`), h('td', {}, o.device_class ?? ''),
          h('td', {}, o.percent_used != null ? `${Math.round(o.percent_used)} %` : ''))))),
        h('p', { class: 'muted small' }, t('Read only: installing Ceph, adding OSDs or pools stays in the Proxmox web interface.', 'En lecture : installer Ceph, ajouter des OSD ou des pools reste dans l\'interface web de Proxmox.')));
    } catch (e) {
      body.replaceChildren(h('p', {}, /not (installed|initialized)|binary not installed|no such file|500/i.test(errorText(e)) ? t('Ceph is not installed or not set up on this node.', 'Ceph n\'est pas installé ou pas configuré sur ce nœud.') : errorText(e)));
    }
  };
  dialog.showModal();
  await draw();
}

// ---------- Stockages : ajout ----------

const CONTENTS: [string, string][] = [['images', t('VM disks', 'Disques de VM')], ['rootdir', t('Container disks', 'Disques de conteneur')], ['iso', t('ISO images', 'Images ISO')], ['vztmpl', t('Container templates', 'Modèles de conteneur')], ['backup', t('Backups', 'Sauvegardes')], ['snippets', t('Snippets', 'Extraits (snippets)')]];

/** Ajoute un stockage au datacenter : dossier, partage NFS ou SMB, Proxmox Backup Server. */
export function openAddStorage(panel: ProxmoxPanel, p: Pve, done: () => void) {
  const type = select([['dir', t('Folder on the node', 'Dossier du nœud')], ['nfs', 'NFS'], ['cifs', t('SMB/CIFS (Windows share)', 'SMB/CIFS (partage Windows)')], ['pbs', 'Proxmox Backup Server']], 'nfs');
  const id = input({ placeholder: 'nas' });
  const path = input({ placeholder: '/mnt/data' });
  const server = input({ placeholder: '192.168.1.10' });
  const exportPath = input({ placeholder: '/volume1/proxmox' });
  const share = input({ placeholder: 'proxmox' });
  const user = input({ placeholder: 'proxmox' });
  const password = input({ type: 'password', autocomplete: 'new-password' });
  const domain = input({ placeholder: t('optional', 'facultatif') });
  const datastore = input({ placeholder: 'store1' });
  const fingerprint = input({ placeholder: 'AA:BB:…' });
  const contents = CONTENTS.map(([v, label]) => ({ v, ...check(label, ['images', 'rootdir', 'iso', 'backup'].includes(v)) }));
  // Champs du type choisi, refaits à chaque changement (un champ ne peut être qu'à un endroit).
  const parts = (kind: string): HTMLElement[] => ({
    dir: () => [field(t('Path', 'Chemin'), path)],
    nfs: () => [field(t('Server', 'Serveur'), server), field(t('Export', 'Export'), exportPath)],
    cifs: () => [field(t('Server', 'Serveur'), server), field(t('Share', 'Partage'), share), h('div', { class: 'row2' }, field(t('User', 'Utilisateur'), user), field(t('Password', 'Mot de passe'), password)), field(t('Domain', 'Domaine'), domain)],
    pbs: () => [field(t('Server', 'Serveur'), server), field(t('Datastore', 'Datastore'), datastore), h('div', { class: 'row2' }, field(t('User (user@pbs)', 'Utilisateur (user@pbs)'), user), field(t('Password', 'Mot de passe'), password)), field(t('Server fingerprint', 'Empreinte du serveur'), fingerprint)],
  } as Record<string, () => HTMLElement[]>)[kind]();
  const specific = h('div', {});
  const contentBox = h('div', { class: 'pve-checks' }, ...contents.map((c) => c.row));
  const sync = () => { specific.replaceChildren(...parts(type.value)); contentBox.hidden = type.value === 'pbs'; };
  type.addEventListener('change', sync);
  sync();
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Add', 'Ajouter'));
  const { dialog, form, error } = modal(t('Add a storage', 'Ajouter un stockage'), [h('div', { class: 'row2' }, field(t('Type', 'Type'), type), field(t('Name (ID)', 'Nom (ID)'), id)), specific, contentBox,
    h('p', { class: 'muted small' }, t('The storage is added for all the nodes of the datacenter. Other types (ZFS, LVM, Ceph RBD) are created from the node\'s disks in the Proxmox web interface.', 'Le stockage est ajouté pour tous les nœuds du datacenter. Les autres types (ZFS, LVM, Ceph RBD) se créent à partir des disques du nœud dans l\'interface web de Proxmox.'))], [submit], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const params: Config = { storage: id.value.trim(), type: type.value };
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(params.storage)) { error.textContent = t('Name: letters, digits, « _ . - », starting with a letter.', 'Nom : lettres, chiffres, « _ . - », en commençant par une lettre.'); return; }
    if (type.value === 'dir') params.path = path.value.trim();
    if (type.value === 'nfs') Object.assign(params, { server: server.value.trim(), export: exportPath.value.trim() });
    if (type.value === 'cifs') Object.assign(params, { server: server.value.trim(), share: share.value.trim(), username: user.value.trim() || undefined, password: password.value || undefined, domain: domain.value.trim() || undefined });
    if (type.value === 'pbs') Object.assign(params, { server: server.value.trim(), datastore: datastore.value.trim(), username: user.value.trim(), password: password.value, fingerprint: fingerprint.value.trim() || undefined, content: 'backup' });
    else params.content = contents.filter((c) => c.box.checked).map((c) => c.v).join(',');
    try {
      await proxmox.api(p.id, 'POST', '/storage', params);
      panel.host.toast(t(`Storage ${params.storage} added`, `Stockage ${params.storage} ajouté`));
      dialog.close();
      done();
    } catch (err) {
      error.textContent = errorText(err);
    }
  });
  dialog.showModal();
}

// ---------- Réseau du nœud ----------

interface Iface { iface: string; type: string; method?: string; cidr?: string; address?: string; netmask?: string; gateway?: string; cidr6?: string; gateway6?: string; bridge_ports?: string; slaves?: string; bridge_vlan_aware?: number; 'vlan-raw-device'?: string; 'vlan-id'?: number; active?: number; autostart?: number; comments?: string }

/** Interfaces réseau du nœud, modifiables : les changements attendent « Appliquer » (Proxmox les garde à part). */
export async function openNetworkEdit(panel: ProxmoxPanel, p: Pve, node: string) {
  const list = h('div', {});
  const pending = h('div', { class: 'pve-note', hidden: true });
  const apply = h('button', { type: 'button', class: 'btn primary', hidden: true }, t('Apply the configuration', 'Appliquer la configuration'));
  const revert = h('button', { type: 'button', class: 'btn', hidden: true }, t('Cancel the pending changes', 'Annuler les changements en attente'));
  const add = btn(t('Add an interface…', 'Ajouter une interface…'), () => edit(null));
  const { dialog, error } = modal(t(`Network · ${node}`, `Réseau · ${node}`), [pending, list, h('div', { class: 'pve-row-actions' }, add),
    h('p', { class: 'muted small' }, t('Changes are kept aside until « Apply ». A mistake on the interface that carries the node\'s address can cut it off: keep a console (IPMI, screen) at hand.', 'Les changements restent à part jusqu\'à « Appliquer ». Une erreur sur l\'interface qui porte l\'adresse du nœud peut le couper du réseau : gardez une console (IPMI, écran) sous la main.'))], [revert, apply], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const base = `/nodes/${node}/network`;
  let ifaces: Iface[] = [];
  const call = async (method: 'POST' | 'PUT' | 'DELETE', path: string, params?: Config) => {
    error.textContent = '';
    try {
      const r = await proxmox.api(p.id, method, path, params);
      return r ?? true;
    } catch (e) {
      error.textContent = errorText(e);
      return false;
    }
  };
  const edit = (cur: Iface | null) => {
    const type = select([['bridge', t('Linux bridge', 'Pont Linux')], ['vlan', 'Linux VLAN'], ['bond', t('Linux bond (aggregation)', 'Agrégat Linux (bond)')]], cur?.type ?? 'bridge');
    const name = input({ value: cur?.iface ?? '', placeholder: 'vmbr1 · eno1.20 · bond0', disabled: !!cur });
    const cidr = input({ value: cur?.cidr ?? '', placeholder: '192.168.10.2/24' });
    const gateway = input({ value: cur?.gateway ?? '', placeholder: t('only one per node', 'une seule par nœud') });
    const ports = input({ value: cur?.bridge_ports ?? cur?.slaves ?? '', placeholder: 'eno2' });
    const vlanAware = check(t('VLAN aware', 'Gestion des VLAN'), cur?.bridge_vlan_aware === 1);
    const raw = input({ value: cur?.['vlan-raw-device'] ?? '', placeholder: 'eno1' });
    const vlanId = input({ type: 'number', min: 1, max: 4094, value: String(cur?.['vlan-id'] ?? '') });
    const autostart = check(t('Start at boot', 'Démarrer au boot'), cur ? cur.autostart === 1 : true);
    const comment = input({ value: (cur?.comments ?? '').trim() });
    const portsField = field(t('Ports (bridge) or members (bond)', 'Ports (pont) ou membres (agrégat)'), ports);
    const vlanFields = h('div', { class: 'row2' }, field(t('Parent interface', 'Interface parente'), raw), field(t('VLAN ID', 'ID de VLAN'), vlanId));
    const sync = () => { portsField.hidden = type.value === 'vlan'; vlanFields.hidden = type.value !== 'vlan'; vlanAware.row.hidden = type.value !== 'bridge'; };
    type.addEventListener('change', sync);
    if (cur) type.disabled = true;
    sync();
    const go = h('button', { type: 'submit', class: 'btn primary' }, cur ? t('Save', 'Enregistrer') : t('Add', 'Ajouter'));
    const m = modal(cur ? t(`Interface ${cur.iface}`, `Interface ${cur.iface}`) : t('New interface', 'Nouvelle interface'), [
      h('div', { class: 'row2' }, field(t('Type', 'Type'), type), field(t('Name', 'Nom'), name)),
      h('div', { class: 'row2' }, field(t('IPv4 address/prefix', 'Adresse IPv4/préfixe'), cidr), field(t('Gateway', 'Passerelle'), gateway)),
      portsField, vlanFields, vlanAware.row, autostart.row, field(t('Comment', 'Commentaire'), comment),
    ], [go]);
    m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
    m.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const params: Config = { type: type.value, autostart: autostart.box.checked ? 1 : 0 };
      if (cidr.value.trim()) params.cidr = cidr.value.trim();
      if (gateway.value.trim()) params.gateway = gateway.value.trim();
      if (comment.value.trim()) params.comments = comment.value.trim();
      if (type.value === 'bridge') { params.bridge_ports = ports.value.trim(); params.bridge_vlan_aware = vlanAware.box.checked ? 1 : 0; }
      if (type.value === 'bond') { params.slaves = ports.value.trim(); params.bond_mode = 'active-backup'; }
      if (type.value === 'vlan') { if (raw.value.trim()) params['vlan-raw-device'] = raw.value.trim(); if (vlanId.value) params['vlan-id'] = Number(vlanId.value); }
      const remove = cur ? ['cidr', 'gateway', 'comments'].filter((k) => !params[k] && (cur as unknown as Config)[k]) : [];
      if (remove.length) params.delete = remove.join(',');
      const ok = cur ? await call('PUT', `${base}/${encodeURIComponent(cur.iface)}`, params) : await call('POST', base, { iface: name.value.trim(), ...params });
      if (ok !== false) { m.dialog.close(); await draw(); }
      else m.error.textContent = error.textContent;
    });
    m.dialog.showModal();
  };
  const draw = async () => {
    try {
      const r = await proxmox.apiFull<Iface[]>(p.id, base);
      ifaces = r.data ?? [];
      const changes = (r.changes ?? '').trim();
      pending.hidden = !changes;
      apply.hidden = !changes;
      revert.hidden = !changes;
      pending.replaceChildren(h('p', {}, h('b', {}, t('Pending changes (not applied yet):', 'Changements en attente (pas encore appliqués) :'))), h('pre', { class: 'pve-log small' }, changes));
      list.replaceChildren(table([t('Interface', 'Interface'), t('Type', 'Type'), t('Active', 'Active'), t('Address', 'Adresse'), t('Gateway', 'Passerelle'), t('Ports', 'Ports'), t('Comment', 'Commentaire'), ''],
        ifaces.sort((a, b) => a.iface.localeCompare(b.iface)).map((i) => h('tr', {},
          h('td', {}, i.iface), h('td', {}, i.type, i.bridge_vlan_aware ? h('span', { class: 'muted small' }, ' VLAN') : null),
          h('td', { class: i.active ? '' : 'muted' }, i.active ? t('yes', 'oui') : t('no', 'non')),
          h('td', { class: 'mono small' }, [i.cidr ?? (i.address ? `${i.address}${i.netmask ? `/${i.netmask}` : ''}` : ''), i.cidr6 ?? ''].filter(Boolean).join(' ') || (i.method ?? '')),
          h('td', { class: 'mono small' }, i.gateway ?? ''), h('td', { class: 'small' }, i.bridge_ports ?? i.slaves ?? i['vlan-raw-device'] ?? ''),
          h('td', { class: 'muted small' }, (i.comments ?? '').trim()),
          ['bridge', 'vlan', 'bond', 'eth'].includes(i.type)
            ? actions(btn(t('Edit', 'Modifier'), () => (i.type === 'eth' ? editEth(i) : edit(i))),
              i.type === 'eth' ? h('span', {}) : btn(t('Delete', 'Supprimer'), async () => { if (confirm(t(`Delete ${i.iface}? (applied with « Apply »)`, `Supprimer ${i.iface} ? (appliqué avec « Appliquer »)`))) { if (await call('DELETE', `${base}/${encodeURIComponent(i.iface)}`) !== false) draw(); } }, 'danger'))
            : h('td', {})))));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  // Carte physique : seulement l'adresse, la passerelle, le commentaire et le démarrage.
  const editEth = (i: Iface) => {
    const cidr = input({ value: i.cidr ?? '' });
    const gateway = input({ value: i.gateway ?? '' });
    const comment = input({ value: (i.comments ?? '').trim() });
    const autostart = check(t('Start at boot', 'Démarrer au boot'), i.autostart === 1);
    const go = h('button', { type: 'submit', class: 'btn primary' }, t('Save', 'Enregistrer'));
    const m = modal(t(`Interface ${i.iface}`, `Interface ${i.iface}`), [h('div', { class: 'row2' }, field(t('IPv4 address/prefix', 'Adresse IPv4/préfixe'), cidr), field(t('Gateway', 'Passerelle'), gateway)), autostart.row, field(t('Comment', 'Commentaire'), comment)], [go]);
    m.dialog.querySelector('.dlg-foot')!.prepend(closeButton(m.dialog));
    m.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const params: Config = { type: 'eth', autostart: autostart.box.checked ? 1 : 0 };
      if (cidr.value.trim()) params.cidr = cidr.value.trim();
      if (gateway.value.trim()) params.gateway = gateway.value.trim();
      if (comment.value.trim()) params.comments = comment.value.trim();
      const remove = ['cidr', 'gateway', 'comments'].filter((k) => !params[k] && (i as unknown as Config)[k]);
      if (remove.length) params.delete = remove.join(',');
      if (await call('PUT', `${base}/${encodeURIComponent(i.iface)}`, params) !== false) { m.dialog.close(); await draw(); }
      else m.error.textContent = error.textContent;
    });
    m.dialog.showModal();
  };
  apply.addEventListener('click', async () => {
    const typed = prompt(t(`Apply the network configuration of ${node} now? A mistake can cut the node off. Type the node's name (${node}) to confirm.`, `Appliquer maintenant la configuration réseau de ${node} ? Une erreur peut couper le nœud du réseau. Tapez le nom du nœud (${node}) pour confirmer.`));
    if (typed?.trim() !== node) return;
    const upid = await call('PUT', base);
    if (typeof upid === 'string' && upid.startsWith('UPID:')) await panel.waitTask(p, node, upid, t('Network configuration', 'Configuration réseau'));
    await draw();
  });
  revert.addEventListener('click', async () => {
    if (!confirm(t('Cancel all the pending network changes?', 'Annuler tous les changements réseau en attente ?'))) return;
    if (await call('DELETE', base) !== false) await draw();
  });
  dialog.showModal();
  await draw();
}

/** Retire un stockage de la configuration du datacenter (les données restent sur place). */
export async function removeStorage(panel: ProxmoxPanel, p: Pve, storage: string): Promise<boolean> {
  if (!confirm(t(`Remove the storage ${storage} from Proxmox? Its data stays where it is; machines whose disks are on it will no longer start.`, `Retirer le stockage ${storage} de Proxmox ? Ses données restent en place ; les machines dont les disques y sont ne démarreront plus.`))) return false;
  try {
    await proxmox.api(p.id, 'DELETE', `/storage/${encodeURIComponent(storage)}`);
    panel.host.toast(t(`Storage ${storage} removed`, `Stockage ${storage} retiré`));
    return true;
  } catch (e) {
    panel.host.toast(errorText(e), 'error');
    return false;
  }
}
