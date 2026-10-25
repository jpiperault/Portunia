// Compile le moteur RDP (rdp-helper) et le place là où Tauri l'attend
// pour l'embarquer à côté de Termoria (« externalBin »).
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const triple = execSync('rustc -vV').toString().match(/host: (\S+)/)[1];
const ext = process.platform === 'win32' ? '.exe' : '';

execSync(`cargo build ${release ? '--release ' : ''}--manifest-path "${join(root, 'rdp-helper', 'Cargo.toml')}"`, { stdio: 'inherit' });

const source = join(root, 'rdp-helper', 'target', profile, `termoria-rdp${ext}`);
const target = join(root, 'src-tauri', 'binaries', `termoria-rdp-${triple}${ext}`);
mkdirSync(dirname(target), { recursive: true });
// Ne recopie que si le moteur a changé (évite de relancer la compilation de Termoria).
if (!existsSync(target) || statSync(source).mtimeMs > statSync(target).mtimeMs) {
  copyFileSync(source, target);
  console.log(`Moteur RDP copié vers ${target}`);
}

// Console de Windows Terminal (conpty.dll + OpenConsole.exe) : à côté de l'exécutable de
// développement aussi (l'installateur les embarque via « resources »).
if (process.platform === 'win32' && !release) {
  const out = join(root, 'src-tauri', 'target', 'debug');
  mkdirSync(out, { recursive: true });
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    const from = join(root, 'src-tauri', 'conpty', file);
    const to = join(out, file);
    if (!existsSync(to) || statSync(from).mtimeMs > statSync(to).mtimeMs) copyFileSync(from, to);
  }
}
