// Contrôle le latest.json d'une release : plateformes attendues, URL cohérentes, signatures.
// Usage : node scripts/check-latest-json.mjs latest.json [--tag v1.2.3]   |   node scripts/check-latest-json.mjs --self-test
// Avec --tag : la version doit valoir le tag sans « v » initial, et chaque URL contenir /download/<tag>/.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'];

// Fonction pure : renvoie la liste des problèmes (vide si latest.json est correct).
export function checkLatest(latest, tag) {
  const errors = [];
  const platforms = latest && typeof latest === 'object' ? latest.platforms : undefined;
  if (!platforms || typeof platforms !== 'object') return ['champ « platforms » absent'];

  for (const name of REQUIRED) {
    const entry = platforms[name];
    if (!entry) { errors.push(`plateforme manquante : ${name}`); continue; }
    if (typeof entry.url !== 'string' || !entry.url) { errors.push(`${name} : url absente`); continue; }
    if (typeof entry.signature !== 'string' || !entry.signature) errors.push(`${name} : signature absente`);
    const file = entry.url.split('?')[0];
    if (name.startsWith('windows') && !file.endsWith('-setup.exe')) errors.push(`${name} : l'URL ne finit pas par -setup.exe (${entry.url})`);
    if (name.startsWith('darwin') && !file.endsWith('.app.tar.gz')) errors.push(`${name} : l'URL ne finit pas par .app.tar.gz (${entry.url})`);
  }
  if (tag) {
    if (latest.version !== tag.replace(/^v/, '')) errors.push(`version « ${latest.version} » différente du tag ${tag}`);
    for (const name of REQUIRED) {
      const url = platforms[name]?.url;
      if (typeof url === 'string' && !url.includes(`/download/${tag}/`)) errors.push(`${name} : l'URL ne pointe pas la release ${tag} (${url})`);
    }
  }
  const arm = platforms['darwin-aarch64']?.url;
  const intel = platforms['darwin-x86_64']?.url;
  if (arm && intel && arm !== intel) errors.push('darwin-aarch64 et darwin-x86_64 devraient pointer la même archive universelle');
  return errors;
}

function selfTest() {
  const sig = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZw==';
  const base = 'https://example.test/releases/download/v1.0.0';
  const valid = {
    version: '1.0.0',
    platforms: {
      'windows-x86_64': { url: `${base}/Portunia_1.0.0_x64-setup.exe`, signature: sig },
      'darwin-aarch64': { url: `${base}/Portunia_universal.app.tar.gz`, signature: sig },
      'darwin-x86_64': { url: `${base}/Portunia_universal.app.tar.gz`, signature: sig },
    },
  };
  const missingMac = structuredClone(valid);
  delete missingMac.platforms['darwin-x86_64'];
  const wrongUrl = structuredClone(valid);
  wrongUrl.platforms['darwin-aarch64'].url = `${base}/Portunia_1.0.0_x64-setup.exe`;

  const noSig = structuredClone(valid);
  delete noSig.platforms['darwin-x86_64'].signature;
  const winNoSetup = structuredClone(valid);
  winNoSetup.platforms['windows-x86_64'].url = `${base}/Portunia_1.0.0_x64.msi`;
  const otherTag = structuredClone(valid);
  otherTag.platforms['windows-x86_64'].url = 'https://example.test/releases/download/v0.9.0/Portunia_1.0.0_x64-setup.exe';

  const cases = [
    ['JSON valide accepté', valid, 0],
    ['plateforme darwin manquante refusée', missingMac, 1],
    ['URL darwin pointant le setup.exe de Windows refusée', wrongUrl, 1],
    ['signature absente refusée', noSig, 1],
    ['URL Windows sans -setup.exe refusée', winNoSetup, 1],
    ['JSON valide avec le bon tag accepté', valid, 0, 'v1.0.0'],
    ['version différente du tag refusée', valid, 1, 'v1.0.1'],
    ["URL d'un autre tag refusée", otherTag, 1, 'v1.0.0'],
  ];
  let failed = 0;
  for (const [label, json, expectErrors, tag] of cases) {
    const errors = checkLatest(json, tag);
    const ok = expectErrors === 0 ? errors.length === 0 : errors.length >= expectErrors;
    console.log(`${ok ? 'OK   ' : 'ECHEC'} ${label}${errors.length ? ` -> ${errors.join(' ; ')}` : ''}`);
    if (!ok) failed++;
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tagIdx = args.indexOf('--tag');
  const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;
  if (tagIdx !== -1 && !tag) { console.error('--tag exige une valeur'); process.exit(2); }
  const arg = args[0];
  if (arg === '--self-test') process.exit(selfTest());
  if (!arg) { console.error('Usage : check-latest-json.mjs <latest.json> | --self-test'); process.exit(2); }
  let latest;
  try { latest = JSON.parse(readFileSync(arg, 'utf8')); } catch (e) { console.error(`Lecture impossible : ${e.message}`); process.exit(2); }
  const errors = checkLatest(latest, tag);
  if (errors.length) { for (const e of errors) console.error(`latest.json : ${e}`); process.exit(1); }
  console.log(`latest.json conforme (${REQUIRED.join(', ')})`);
}
