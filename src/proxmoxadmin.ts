// Proxmox VE : création de machines virtuelles et de conteneurs, et gestion des nœuds
// (redémarrage, mises à jour, services, journal, réseau, disques). Tout passe par pve_api.
import { errorText, proxmox, Pve } from './api';
import { h, icon } from './dom';
import { t } from './i18n';
import { bytes, check, closeButton, field, input, modal, ProxmoxPanel, select, table } from './proxmox';

interface Store { storage: string; type: string; content: string; avail?: number; total?: number; active?: number; enabled?: number }
interface Volume { volid: string; size?: number; ctime?: number }

/** Stockages actifs d'un nœud qui acceptent ce contenu (iso, images, rootdir, vztmpl). */
async function stores(p: Pve, node: string, content: string): Promise<Store[]> {
  const list = await proxmox.api<Store[]>(p.id, 'GET', `/nodes/${node}/storage`, { content, enabled: 1 });
  return list.filter((s) => s.active !== 0).sort((a, b) => a.storage.localeCompare(b.storage));
}

/** Volumes d'un type (images ISO, modèles de conteneurs) sur tous les stockages du nœud. */
async function volumes(p: Pve, node: string, content: string): Promise<Volume[]> {
  const out: Volume[] = [];
  for (const s of await stores(p, node, content)) {
    out.push(...await proxmox.api<Volume[]>(p.id, 'GET', `/nodes/${node}/storage/${encodeURIComponent(s.storage)}/content`, { content }));
  }
  return out.sort((a, b) => a.volid.localeCompare(b.volid));
}

const storeLabel = (s: Store) => (s.avail != null ? `${s.storage} (${t(`${bytes(s.avail)} free`, `${bytes(s.avail)} libres`)})` : s.storage);
const volumeLabel = (v: Volume) => v.volid.replace(/^[^:]+:(iso|vztmpl)\//, '') + (v.size ? ` · ${bytes(v.size)}` : '');

/** Remplit un menu déroulant ; garde la valeur choisie si elle existe encore. */
function fill(s: HTMLSelectElement, options: [string, string][], empty?: string) {
  const keep = s.value;
  s.replaceChildren(...(empty != null ? [h('option', { value: '' }, empty)] : []), ...options.map(([v, label]) => h('option', { value: v }, label)));
  if (options.some(([v]) => v === keep)) s.value = keep;
}

/** Nœud, numéro et réseau : communs aux deux assistants. */
function common(panel: ProxmoxPanel, p: Pve, node?: string) {
  const nodes = panel.nodes(p.id);
  const nodeSel = select(nodes.map((n) => [n, n]), node ?? nodes[0]);
  const vmid = input({ inputmode: 'numeric' });
  const bridge = select([]);
  const vlan = input({ inputmode: 'numeric', placeholder: t('none', 'aucun') });
  const cores = input({ type: 'number', min: 1, max: 512, value: '2' });
  const memory = input({ type: 'number', min: 64, step: 64, value: '2048' });
  const disk = select([]);
  const size = input({ type: 'number', min: 1, value: '32' });
  const start = check(t('Start after creation', 'Démarrer après la création'), true);
  const onboot = check(t('Start with the node', 'Démarrer avec le nœud'), false);
  proxmox.api<number | string>(p.id, 'GET', '/cluster/nextid').then((id) => { if (!vmid.value) vmid.value = String(id); }).catch(() => { /* laissé vide */ });
  const checkId = (): number | string => {
    const id = Number(vmid.value);
    if (!Number.isInteger(id) || id < 100) return t('Number: 100 or more, not used yet.', 'Numéro : 100 ou plus, pas encore utilisé.');
    if (panel.guests(p.id).some((g) => g.vmid === id)) return t(`Number ${id} is already used.`, `Le numéro ${id} est déjà pris.`);
    return id;
  };
  const checkVlan = (): string | null => {
    const v = vlan.value.trim();
    if (!v) return '';
    return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 4094 ? `,tag=${v}` : null;
  };
  /** Ponts réseau du nœud (vmbr…), le premier par défaut. */
  const loadBridges = async () => {
    const list = (await proxmox.api<{ iface: string; type?: string; comments?: string }[]>(p.id, 'GET', `/nodes/${nodeSel.value}/network`, { type: 'any_bridge' })).filter((b) => !b.type || /bridge/i.test(b.type));
    fill(bridge, list.sort((a, b) => a.iface.localeCompare(b.iface)).map((b) => [b.iface, b.comments ? `${b.iface} · ${b.comments.trim()}` : b.iface]));
  };
  return { nodeSel, vmid, bridge, vlan, cores, memory, disk, size, start, onboot, checkId, checkVlan, loadBridges };
}

// ---------- Créer une machine virtuelle ----------

/** Assistant de création d'une machine virtuelle : système, image ISO, processeur, mémoire, disque, réseau. */
export async function openCreateVm(panel: ProxmoxPanel, p: Pve, node?: string) {
  if (!panel.nodes(p.id).length) return panel.host.toast(t('No node known yet: refresh the server.', 'Aucun nœud connu : actualisez le serveur.'), 'error');
  const c = common(panel, p, node);
  const name = input({ placeholder: 'web-01' });
  const os = select([
    ['l26', 'Linux (6.x – 2.6)'],
    ['win11', 'Windows 11 / Server 2022 / 2025'],
    ['win10', 'Windows 10 / Server 2016 / 2019'],
    ['other', t('Other', 'Autre')],
  ], 'l26');
  const iso = select([]);
  const drivers = select([]);
  const driversField = field(t('VirtIO drivers ISO', 'ISO des pilotes VirtIO'), drivers, t('(recommended for Windows)', '(conseillé pour Windows)'));
  const cpu = select([['x86-64-v2-AES', 'x86-64-v2-AES ' + t('(default, allows migration)', '(par défaut, permet la migration)')], ['host', t('host (fastest, same CPUs only)', 'host (le plus rapide, processeurs identiques seulement)')], ['kvm64', t('kvm64 (old systems)', 'kvm64 (anciens systèmes)')]], 'x86-64-v2-AES');
  const agent = check(t('QEMU guest agent (install qemu-guest-agent in the machine)', 'Agent invité QEMU (installez qemu-guest-agent dans la machine)'), true);
  const downloadIso = h('button', { type: 'button', class: 'btn sm' }, icon('download', 13), ' ', t('Download an ISO…', 'Télécharger une ISO…'));
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Create', 'Créer'));
  const { dialog, form, error } = modal(t(`New virtual machine · ${p.name}`, `Nouvelle machine virtuelle · ${p.name}`), [
    h('div', { class: 'row2' }, field(t('Node', 'Nœud'), c.nodeSel), field(t('Number (VM ID)', 'Numéro (VM ID)'), c.vmid)),
    h('div', { class: 'row2' }, field(t('Name', 'Nom'), name), field(t('System', 'Système'), os)),
    field(t('Installation ISO', 'ISO d\'installation'), iso),
    h('div', {}, downloadIso),
    driversField,
    h('h3', {}, t('Processor and memory', 'Processeur et mémoire')),
    h('div', { class: 'row2' }, field(t('Cores', 'Cœurs'), c.cores), field(t('Memory (MiB)', 'Mémoire (Mio)'), c.memory)),
    field(t('CPU type', 'Type de processeur'), cpu),
    h('h3', {}, t('Disk', 'Disque')),
    h('div', { class: 'row2' }, field(t('Storage', 'Stockage'), c.disk), field(t('Size (GiB)', 'Taille (Gio)'), c.size)),
    h('h3', {}, t('Network', 'Réseau')),
    h('div', { class: 'row2' }, field(t('Bridge', 'Pont'), c.bridge), field(t('VLAN tag', 'Étiquette VLAN'), c.vlan)),
    agent.row, c.start.row, c.onboot.row,
    h('p', { class: 'muted small' }, t('Windows 11 gets UEFI, Secure Boot and a TPM. Without the VirtIO drivers ISO, Windows gets a SATA disk and an Intel E1000 card, which its installer recognises.', 'Windows 11 reçoit l\'UEFI, le Secure Boot et un TPM. Sans l\'ISO des pilotes VirtIO, Windows reçoit un disque SATA et une carte Intel E1000, que son installateur reconnaît.')),
  ], [submit], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const syncOs = () => {
    const win = os.value.startsWith('win');
    driversField.hidden = !win;
    if (win && Number(c.memory.value) < 4096) c.memory.value = '4096';
    if (win && Number(c.size.value) < 64) c.size.value = '64';
  };
  const load = async () => {
    error.textContent = '';
    try {
      const n = c.nodeSel.value;
      const isos = (await volumes(p, n, 'iso')).map((v): [string, string] => [v.volid, volumeLabel(v)]);
      fill(iso, isos, t('None (network boot, or add one later)', 'Aucune (démarrage réseau, ou à ajouter plus tard)'));
      fill(drivers, isos.filter(([v]) => /virtio/i.test(v)).concat(isos.filter(([v]) => !/virtio/i.test(v))), t('None', 'Aucune'));
      fill(c.disk, (await stores(p, n, 'images')).map((s) => [s.storage, storeLabel(s)]));
      await c.loadBridges();
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  os.addEventListener('change', syncOs);
  c.nodeSel.addEventListener('change', load);
  downloadIso.addEventListener('click', () => openDownloadIso(panel, p, c.nodeSel.value, load));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const id = c.checkId();
    if (typeof id === 'string') { error.textContent = id; return; }
    const vmName = name.value.trim();
    if (vmName && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(vmName)) { error.textContent = t('Name: letters, digits, - and . (a DNS name).', 'Nom : lettres, chiffres, - et . (un nom DNS).'); return; }
    const tag = c.checkVlan();
    if (tag == null) { error.textContent = t('VLAN tag: 1 to 4094.', 'Étiquette VLAN : 1 à 4094.'); return; }
    if (!c.disk.value || !c.bridge.value) { error.textContent = t('Choose a storage and a bridge.', 'Choisissez un stockage et un pont.'); return; }
    const win = os.value.startsWith('win');
    const virtio = !win || !!drivers.value;
    const bus = virtio ? 'scsi0' : 'sata0';
    const params: Record<string, unknown> = {
      vmid: id, name: vmName || undefined, ostype: os.value, cores: Number(c.cores.value), sockets: 1, memory: Number(c.memory.value), cpu: cpu.value,
      scsihw: 'virtio-scsi-single', [bus]: `${c.disk.value}:${Number(c.size.value)}${virtio ? ',iothread=1' : ''}`,
      net0: `${virtio ? 'virtio' : 'e1000'},bridge=${c.bridge.value}${tag},firewall=1`,
      boot: `order=${bus}${iso.value ? ';ide2' : ''};net0`,
      agent: agent.box.checked ? 1 : 0, onboot: c.onboot.box.checked ? 1 : 0, start: c.start.box.checked ? 1 : 0,
    };
    if (iso.value) params.ide2 = `${iso.value},media=cdrom`;
    if (win && drivers.value) params.ide0 = `${drivers.value},media=cdrom`;
    if (os.value === 'win11') Object.assign(params, { bios: 'ovmf', machine: 'q35', efidisk0: `${c.disk.value}:1,efitype=4m,pre-enrolled-keys=1`, tpmstate0: `${c.disk.value}:1,version=v2.0` });
    submit.setAttribute('disabled', '');
    const ok = await panel.run(p, c.nodeSel.value, `/nodes/${c.nodeSel.value}/qemu`, t(`Creation of VM ${id}`, `Création de la VM ${id}`), 'POST', params);
    submit.removeAttribute('disabled');
    if (ok) dialog.close();
  });
  dialog.showModal();
  syncOs();
  load();
}

/** Téléchargement d'une image ISO par le nœud, depuis une adresse web. */
function openDownloadIso(panel: ProxmoxPanel, p: Pve, node: string, done: () => void) {
  const url = input({ placeholder: 'https://…/debian-12.iso' });
  const name = input({ placeholder: 'debian-12.iso' });
  const storage = select([]);
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Download', 'Télécharger'));
  const { dialog, form, error } = modal(t(`Download an ISO · ${node}`, `Télécharger une ISO · ${node}`), [
    field(t('Address', 'Adresse'), url),
    h('div', { class: 'row2' }, field(t('File name', 'Nom du fichier'), name), field(t('Storage', 'Stockage'), storage)),
    h('p', { class: 'muted small' }, t('The node downloads the file itself: it needs Internet access.', 'Le nœud télécharge le fichier lui-même : il lui faut un accès à Internet.')),
  ], [submit]);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  url.addEventListener('input', () => {
    const last = url.value.split('?')[0].split('/').pop() ?? '';
    if (last.toLowerCase().endsWith('.iso')) name.value = decodeURIComponent(last);
  });
  stores(p, node, 'iso').then((list) => fill(storage, list.map((s) => [s.storage, storeLabel(s)]))).catch((e) => { error.textContent = errorText(e); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!/^https?:\/\//i.test(url.value.trim())) { error.textContent = t('Address: http:// or https://', 'Adresse : http:// ou https://'); return; }
    if (!/^[\w.+-]+\.iso$/i.test(name.value.trim())) { error.textContent = t('File name: letters, digits, . - _ and ending in .iso', 'Nom du fichier : lettres, chiffres, . - _ et finissant par .iso'); return; }
    if (!storage.value) { error.textContent = t('No storage accepts ISO images on this node.', 'Aucun stockage n\'accepte d\'images ISO sur ce nœud.'); return; }
    dialog.close();
    if (await panel.run(p, node, `/nodes/${node}/storage/${encodeURIComponent(storage.value)}/download-url`, t(`Download of ${name.value.trim()}`, `Téléchargement de ${name.value.trim()}`), 'POST', { content: 'iso', url: url.value.trim(), filename: name.value.trim() })) done();
  });
  dialog.showModal();
  url.focus();
}

// ---------- Créer un conteneur ----------

/** Assistant de création d'un conteneur LXC : modèle, accès root, ressources, disque, réseau. */
export async function openCreateCt(panel: ProxmoxPanel, p: Pve, node?: string) {
  if (!panel.nodes(p.id).length) return panel.host.toast(t('No node known yet: refresh the server.', 'Aucun nœud connu : actualisez le serveur.'), 'error');
  const c = common(panel, p, node);
  c.cores.value = '1';
  c.memory.value = '512';
  c.size.value = '8';
  const hostname = input({ placeholder: 'ct-01' });
  const template = select([]);
  const getTemplates = h('button', { type: 'button', class: 'btn sm' }, icon('download', 13), ' ', t('Get templates…', 'Obtenir des modèles…'));
  const password = input({ type: 'password', autocomplete: 'new-password' });
  const confirmPw = input({ type: 'password', autocomplete: 'new-password' });
  const keys = h('textarea', { class: 'input mono', rows: 2, spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA… user@pc' }) as HTMLTextAreaElement;
  const swap = input({ type: 'number', min: 0, step: 256, value: '512' });
  const unprivileged = check(t('Unprivileged container (recommended)', 'Conteneur non privilégié (conseillé)'), true);
  const nesting = check(t('Nesting (needed by recent systemd distributions, and by Docker)', 'Imbrication (nécessaire aux distributions récentes avec systemd, et à Docker)'), true);
  const ipMode = select([['dhcp', 'DHCP'], ['static', t('Fixed address', 'Adresse fixe')]], 'dhcp');
  const ip = input({ placeholder: '192.168.1.50/24' });
  const gw = input({ placeholder: '192.168.1.1' });
  const ip6 = select([['', t('None', 'Aucune')], ['auto', 'SLAAC'], ['dhcp', 'DHCPv6']], '');
  const dns = input({ placeholder: t('the node\'s', 'celui du nœud') });
  const staticRow = h('div', { class: 'row2' }, field(t('IPv4 address (CIDR)', 'Adresse IPv4 (CIDR)'), ip), field(t('Gateway', 'Passerelle'), gw));
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Create', 'Créer'));
  const { dialog, form, error } = modal(t(`New container · ${p.name}`, `Nouveau conteneur · ${p.name}`), [
    h('div', { class: 'row2' }, field(t('Node', 'Nœud'), c.nodeSel), field(t('Number (CT ID)', 'Numéro (CT ID)'), c.vmid)),
    field(t('Host name', 'Nom d\'hôte'), hostname),
    field(t('Template', 'Modèle'), template),
    h('div', {}, getTemplates),
    h('h3', {}, t('Root access', 'Accès root')),
    h('div', { class: 'row2' }, field(t('Root password', 'Mot de passe root'), password), field(t('Confirm', 'Confirmer'), confirmPw)),
    field(t('SSH public keys', 'Clés SSH publiques'), keys, t('(optional, one per line)', '(facultatif, une par ligne)')),
    h('h3', {}, t('Resources', 'Ressources')),
    h('div', { class: 'row2' }, field(t('Cores', 'Cœurs'), c.cores), field(t('Memory (MiB)', 'Mémoire (Mio)'), c.memory)),
    h('div', { class: 'row2' }, field(t('Swap (MiB)', 'Swap (Mio)'), swap), h('span', {})),
    h('div', { class: 'row2' }, field(t('Disk storage', 'Stockage du disque'), c.disk), field(t('Size (GiB)', 'Taille (Gio)'), c.size)),
    unprivileged.row, nesting.row,
    h('h3', {}, t('Network', 'Réseau')),
    h('div', { class: 'row2' }, field(t('Bridge', 'Pont'), c.bridge), field(t('VLAN tag', 'Étiquette VLAN'), c.vlan)),
    h('div', { class: 'row2' }, field('IPv4', ipMode), field('IPv6', ip6)),
    staticRow,
    field(t('DNS server', 'Serveur DNS'), dns, t('(optional)', '(facultatif)')),
    c.start.row, c.onboot.row,
  ], [submit], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const syncIp = () => { staticRow.hidden = ipMode.value !== 'static'; };
  const load = async () => {
    error.textContent = '';
    try {
      const n = c.nodeSel.value;
      fill(template, (await volumes(p, n, 'vztmpl')).map((v) => [v.volid, volumeLabel(v)]));
      if (!template.options.length) error.textContent = t('No container template on this node: get one with « Get templates… ».', 'Aucun modèle de conteneur sur ce nœud : obtenez-en un avec « Obtenir des modèles… ».');
      fill(c.disk, (await stores(p, n, 'rootdir')).map((s) => [s.storage, storeLabel(s)]));
      await c.loadBridges();
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  ipMode.addEventListener('change', syncIp);
  c.nodeSel.addEventListener('change', load);
  getTemplates.addEventListener('click', () => openTemplates(panel, p, c.nodeSel.value, load));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const id = c.checkId();
    if (typeof id === 'string') { error.textContent = id; return; }
    const host = hostname.value.trim();
    if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) { error.textContent = t('Host name: letters, digits, - and . (a DNS name).', 'Nom d\'hôte : lettres, chiffres, - et . (un nom DNS).'); return; }
    if (!template.value) { error.textContent = t('Choose a template.', 'Choisissez un modèle.'); return; }
    const sshKeys = keys.value.trim();
    if (!password.value && !sshKeys) { error.textContent = t('Give a root password or an SSH key.', 'Donnez un mot de passe root ou une clé SSH.'); return; }
    if (password.value && password.value.length < 5) { error.textContent = t('Password: at least 5 characters.', 'Mot de passe : au moins 5 caractères.'); return; }
    if (password.value !== confirmPw.value) { error.textContent = t('The two passwords differ.', 'Les deux mots de passe diffèrent.'); return; }
    const tag = c.checkVlan();
    if (tag == null) { error.textContent = t('VLAN tag: 1 to 4094.', 'Étiquette VLAN : 1 à 4094.'); return; }
    let ipPart = ',ip=dhcp';
    if (ipMode.value === 'static') {
      if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(ip.value.trim())) { error.textContent = t('IPv4 address: like 192.168.1.50/24.', 'Adresse IPv4 : comme 192.168.1.50/24.'); return; }
      if (gw.value.trim() && !/^\d{1,3}(\.\d{1,3}){3}$/.test(gw.value.trim())) { error.textContent = t('Gateway: an IPv4 address.', 'Passerelle : une adresse IPv4.'); return; }
      ipPart = `,ip=${ip.value.trim()}${gw.value.trim() ? `,gw=${gw.value.trim()}` : ''}`;
    }
    if (!c.disk.value || !c.bridge.value) { error.textContent = t('Choose a storage and a bridge.', 'Choisissez un stockage et un pont.'); return; }
    const params: Record<string, unknown> = {
      vmid: id, hostname: host, ostemplate: template.value,
      password: password.value || undefined, 'ssh-public-keys': sshKeys || undefined,
      unprivileged: unprivileged.box.checked ? 1 : 0, features: nesting.box.checked ? 'nesting=1' : undefined,
      cores: Number(c.cores.value), memory: Number(c.memory.value), swap: Number(swap.value),
      rootfs: `${c.disk.value}:${Number(c.size.value)}`,
      net0: `name=eth0,bridge=${c.bridge.value}${tag},firewall=1${ipPart}${ip6.value ? `,ip6=${ip6.value}` : ''}`,
      nameserver: dns.value.trim() || undefined,
      onboot: c.onboot.box.checked ? 1 : 0, start: c.start.box.checked ? 1 : 0,
    };
    submit.setAttribute('disabled', '');
    const ok = await panel.run(p, c.nodeSel.value, `/nodes/${c.nodeSel.value}/lxc`, t(`Creation of CT ${id}`, `Création du CT ${id}`), 'POST', params);
    submit.removeAttribute('disabled');
    if (ok) dialog.close();
  });
  dialog.showModal();
  syncIp();
  load();
}

/** Catalogue des modèles de conteneurs de Proxmox (aplinfo) : téléchargement sur un stockage du nœud. */
async function openTemplates(panel: ProxmoxPanel, p: Pve, node: string, done: () => void) {
  const storage = select([]);
  const filter = input({ type: 'search', placeholder: t('Filter (debian, ubuntu, alpine…)', 'Filtrer (debian, ubuntu, alpine…)') });
  const list = h('div', {});
  const { dialog, error } = modal(t(`Container templates · ${node}`, `Modèles de conteneurs · ${node}`), [
    h('div', { class: 'row2' }, field(t('Download to', 'Télécharger sur'), storage), field(t('Filter', 'Filtrer'), filter)),
    list,
  ], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  let catalog: { template: string; headline?: string; os?: string; section?: string; version?: string }[] = [];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = catalog.filter((x) => !q || `${x.template} ${x.headline ?? ''} ${x.os ?? ''}`.toLowerCase().includes(q))
      .map((x) => h('tr', {},
        h('td', {}, x.section ?? ''),
        h('td', { class: 'mono small' }, x.template),
        h('td', { class: 'muted' }, x.headline ?? ''),
        h('td', { class: 'pve-actions' }, h('button', { type: 'button', class: 'btn sm', onclick: async () => {
          if (!storage.value) return;
          if (await panel.run(p, node, `/nodes/${node}/aplinfo`, t(`Download of ${x.template}`, `Téléchargement de ${x.template}`), 'POST', { storage: storage.value, template: x.template })) done();
        } }, t('Download', 'Télécharger')))));
    list.replaceChildren(rows.length ? table([t('Section', 'Section'), t('Template', 'Modèle'), t('Description', 'Description'), ''], rows) : h('p', { class: 'muted' }, t('No template.', 'Aucun modèle.')));
  };
  filter.addEventListener('input', draw);
  dialog.showModal();
  try {
    fill(storage, (await stores(p, node, 'vztmpl')).map((s) => [s.storage, storeLabel(s)]));
    catalog = (await proxmox.api<typeof catalog>(p.id, 'GET', `/nodes/${node}/aplinfo`)).sort((a, b) => (a.section ?? '').localeCompare(b.section ?? '') || a.template.localeCompare(b.template));
    if (!catalog.length) error.textContent = t('The catalogue is empty: run « pveam update » on the node (or wait for its daily update).', 'Le catalogue est vide : lancez « pveam update » sur le nœud (ou attendez sa mise à jour quotidienne).');
    draw();
  } catch (e) {
    error.textContent = errorText(e);
  }
}

// ---------- Gestion du nœud ----------

/** Redémarrer ou éteindre un nœud, après avoir tapé son nom. */
export async function nodePower(panel: ProxmoxPanel, p: Pve, node: string, command: 'reboot' | 'shutdown') {
  const running = panel.guests(p.id).filter((g) => g.node === node && g.status === 'running').length;
  const what = command === 'reboot' ? t('Restart', 'Redémarrer') : t('Shut down', 'Éteindre');
  const warn = running ? t(` Its ${running} running machine(s) and container(s) are shut down first (or stopped after a delay).`, ` Ses ${running} machine(s) et conteneur(s) en marche sont d'abord éteints (ou arrêtés après un délai).`) : '';
  const after = command === 'shutdown' ? t(' It will have to be started again on site or through its management card (iDRAC, iLO…).', ' Il faudra le rallumer sur place ou par sa carte de gestion (iDRAC, iLO…).') : '';
  const typed = prompt(t(`${what} the node ${node}?${warn}${after} Type its name (${node}) to confirm.`, `${what} le nœud ${node} ?${warn}${after} Tapez son nom (${node}) pour confirmer.`));
  if (typed?.trim() !== node) return;
  try {
    await proxmox.api(p.id, 'POST', `/nodes/${node}/status`, { command });
    panel.host.toast(command === 'reboot' ? t(`${node} is restarting`, `${node} redémarre`) : t(`${node} is shutting down`, `${node} s'éteint`));
  } catch (e) {
    panel.host.toast(errorText(e), 'error');
  }
}

/** Mises à jour des paquets : version, liste des mises à jour, rafraîchir, lancer la mise à jour dans un shell. */
export async function openUpdates(panel: ProxmoxPanel, p: Pve, node: string) {
  const summary = h('p', { class: 'muted small' });
  const list = h('div', {});
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', 14), ' ', t('Refresh the list', 'Rafraîchir la liste'));
  const upgrade = h('button', { type: 'button', class: 'btn primary' }, icon('terminal', 14), ' ', t('Upgrade in a shell', 'Mettre à jour dans un shell'));
  const { dialog, error } = modal(t(`Updates · ${node}`, `Mises à jour · ${node}`), [
    summary, list,
    h('p', { class: 'muted small' }, t('« Upgrade » opens the node shell and runs apt dist-upgrade, as in Proxmox: answer its questions there. Proxmox only allows it for root@pam. A new kernel needs a restart of the node.', '« Mettre à jour » ouvre le shell du nœud et y lance apt dist-upgrade, comme dans Proxmox : répondez-y à ses questions. Proxmox ne le permet qu\'à root@pam. Un nouveau noyau demande un redémarrage du nœud.')),
  ], [refresh, upgrade], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const draw = async () => {
    error.textContent = '';
    try {
      const s = await proxmox.api<{ pveversion?: string; kversion?: string; uptime?: number }>(p.id, 'GET', `/nodes/${node}/status`);
      summary.textContent = [s.pveversion, s.kversion?.split(' ').slice(0, 3).join(' '), s.uptime ? t(`up ${Math.round(s.uptime / 86400)} d`, `en marche depuis ${Math.round(s.uptime / 86400)} j`) : ''].filter(Boolean).join(' · ');
    } catch { /* résumé facultatif */ }
    try {
      const pkgs = await proxmox.api<{ Package: string; OldVersion?: string; Version: string; Priority?: string; Section?: string; Title?: string }[]>(p.id, 'GET', `/nodes/${node}/apt/update`);
      list.replaceChildren(pkgs.length
        ? h('div', {}, h('p', {}, t(`${pkgs.length} update(s) available.`, `${pkgs.length} mise(s) à jour disponible(s).`)),
          table([t('Package', 'Paquet'), t('Installed', 'Installé'), t('New', 'Nouveau'), t('Description', 'Description')],
            pkgs.sort((a, b) => a.Package.localeCompare(b.Package)).map((x) => h('tr', {}, h('td', {}, x.Package), h('td', { class: 'mono small' }, x.OldVersion ?? ''), h('td', { class: 'mono small' }, x.Version), h('td', { class: 'muted small' }, x.Title ?? '')))))
        : h('p', { class: 'muted' }, t('Up to date (according to the last refresh of the list).', 'À jour (d\'après le dernier rafraîchissement de la liste).')));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  refresh.addEventListener('click', async () => {
    refresh.setAttribute('disabled', '');
    await panel.run(p, node, `/nodes/${node}/apt/update`, t(`Package list of ${node}`, `Liste des paquets de ${node}`));
    refresh.removeAttribute('disabled');
    draw();
  });
  upgrade.addEventListener('click', () => {
    dialog.close();
    panel.terminal(p, node, 'node', null, t(`Upgrade ${node}`, `Mise à jour ${node}`), 'upgrade');
  });
  dialog.showModal();
  draw();
}

/** Services du nœud : état, démarrer, arrêter, redémarrer. */
export async function openServices(panel: ProxmoxPanel, p: Pve, node: string) {
  const list = h('div', {});
  const { dialog, error } = modal(t(`Services · ${node}`, `Services · ${node}`), [list,
    h('p', { class: 'muted small' }, t('Restarting pveproxy or pvedaemon cuts Portunia off for a few seconds; stopping sshd, corosync or pve-cluster can make the node unreachable.', 'Redémarrer pveproxy ou pvedaemon coupe Portunia quelques secondes ; arrêter sshd, corosync ou pve-cluster peut rendre le nœud injoignable.'))], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  const critical = ['pveproxy', 'pvedaemon', 'sshd', 'corosync', 'pve-cluster'];
  const draw = async () => {
    try {
      const services = await proxmox.api<{ service?: string; name: string; desc?: string; state?: string; 'active-state'?: string; 'unit-state'?: string }[]>(p.id, 'GET', `/nodes/${node}/services`);
      list.replaceChildren(table([t('Service', 'Service'), t('Description', 'Description'), t('State', 'État'), ''],
        services.sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
          const id = s.service ?? s.name;
          const running = s.state === 'running' || s['active-state'] === 'active';
          const act = (cmd: string, label: string, danger = false) => h('button', { type: 'button', class: `btn sm${danger ? ' danger' : ''}`, onclick: async () => {
            if ((cmd === 'stop' || cmd === 'restart') && critical.includes(id) && !confirm(t(`${label} ${id} on ${node}? Access to the node may be cut.`, `${label} ${id} sur ${node} ? L'accès au nœud peut être coupé.`))) return;
            await panel.run(p, node, `/nodes/${node}/services/${encodeURIComponent(id)}/${cmd}`, `${label} ${id}`);
            draw();
          } }, label);
          return h('tr', {},
            h('td', {}, s.name),
            h('td', { class: 'muted small' }, s.desc ?? ''),
            h('td', { class: running ? '' : 'muted' }, s.state ?? s['active-state'] ?? '', s['unit-state'] && s['unit-state'] !== 'enabled' ? h('span', { class: 'muted small' }, ` (${s['unit-state']})`) : null),
            h('td', { class: 'pve-actions' }, ...(running
              ? [act('restart', t('Restart', 'Redémarrer')), act('stop', t('Stop', 'Arrêter'), true)]
              : [act('start', t('Start', 'Démarrer'))])));
        })));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  dialog.showModal();
  draw();
}

/** Journal système du nœud (journalctl), avec un filtre. */
export async function openJournal(_panel: ProxmoxPanel, p: Pve, node: string) {
  const count = select([['200', '200'], ['500', '500'], ['2000', '2000']], '500');
  const filter = input({ type: 'search', placeholder: t('Filter (error, pveproxy…)', 'Filtrer (error, pveproxy…)') });
  const log = h('pre', { class: 'pve-log' });
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', 14), ' ', t('Refresh', 'Actualiser'));
  const { dialog, error } = modal(t(`System log · ${node}`, `Journal système · ${node}`), [
    h('div', { class: 'row2' }, field(t('Last lines', 'Dernières lignes'), count), field(t('Filter', 'Filtrer'), filter)), log,
  ], [refresh], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  let lines: string[] = [];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    log.textContent = (q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines).join('\n');
    log.scrollTop = log.scrollHeight;
  };
  const load = async () => {
    error.textContent = '';
    try {
      lines = await proxmox.api<string[]>(p.id, 'GET', `/nodes/${node}/journal`, { lastentries: Number(count.value) });
      draw();
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  filter.addEventListener('input', draw);
  count.addEventListener('change', load);
  refresh.addEventListener('click', load);
  dialog.showModal();
  load();
}

/** Disques physiques du nœud : modèle, taille, usage, santé SMART. */
export async function openDisks(_panel: ProxmoxPanel, p: Pve, node: string) {
  const list = h('div', {});
  const detail = h('div', {});
  const { dialog, error } = modal(t(`Disks · ${node}`, `Disques · ${node}`), [list, detail], [], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  const smart = async (dev: string) => {
    try {
      const s = await proxmox.api<{ health?: string; type?: string; text?: string; attributes?: { id?: string; name: string; value?: string | number; worst?: string | number; threshold?: string | number; raw?: string; fail?: string }[] }>(p.id, 'GET', `/nodes/${node}/disks/smart`, { disk: dev });
      detail.replaceChildren(h('h3', {}, `SMART · ${dev} · ${s.health ?? '?'}`), s.attributes?.length
        ? table([t('Attribute', 'Attribut'), t('Value', 'Valeur'), t('Worst', 'Pire'), t('Threshold', 'Seuil'), t('Raw', 'Brut')],
          s.attributes.map((a) => h('tr', { class: a.fail && a.fail !== '-' ? 'danger-text' : '' }, h('td', {}, a.name), h('td', {}, String(a.value ?? '')), h('td', {}, String(a.worst ?? '')), h('td', {}, String(a.threshold ?? '')), h('td', { class: 'mono small' }, a.raw ?? ''))))
        : h('pre', { class: 'pve-log' }, s.text ?? t('No SMART data.', 'Aucune donnée SMART.')));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  dialog.showModal();
  try {
    const disks = await proxmox.api<{ devpath: string; type?: string; model?: string; serial?: string; size?: number; used?: string; health?: string; wearout?: number | string; gpt?: number }[]>(p.id, 'GET', `/nodes/${node}/disks/list`);
    list.replaceChildren(disks.length
      ? table([t('Device', 'Périphérique'), t('Type', 'Type'), t('Model', 'Modèle'), t('Size', 'Taille'), t('Usage', 'Usage'), t('Health', 'Santé'), ''],
        disks.sort((a, b) => a.devpath.localeCompare(b.devpath)).map((d) => {
          const wear = typeof d.wearout === 'number' ? t(` · wear ${100 - d.wearout} %`, ` · usure ${100 - d.wearout} %`) : '';
          const bad = d.health && !['PASSED', 'OK', 'UNKNOWN'].includes(d.health.toUpperCase());
          return h('tr', {},
            h('td', { class: 'mono small' }, d.devpath),
            h('td', {}, d.type ?? ''),
            h('td', { class: 'small', title: d.serial ?? '' }, d.model ?? ''),
            h('td', {}, bytes(d.size)),
            h('td', { class: 'small' }, d.used ?? t('unused', 'inutilisé')),
            h('td', { class: bad ? 'danger-text' : '' }, `${d.health ?? '?'}${wear}`),
            h('td', { class: 'pve-actions' }, h('button', { type: 'button', class: 'btn sm', onclick: () => smart(d.devpath) }, 'SMART')));
        }))
      : h('p', { class: 'muted' }, t('No disk listed.', 'Aucun disque listé.')));
  } catch (e) {
    error.textContent = errorText(e);
  }
}

