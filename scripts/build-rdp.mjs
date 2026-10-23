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
