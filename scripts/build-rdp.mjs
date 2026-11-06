// Compile le moteur RDP (rdp-helper) et le place là où Tauri l'attend
// pour l'embarquer à côté de Portunia (« externalBin »).
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const triple = execSync('rustc -vV').toString().match(/host: (\S+)/)[1];
const ext = process.platform === 'win32' ? '.exe' : '';
// Mac universel (Intel + Apple Silicon) : « --target universal-apple-darwin » ou PORTUNIA_RDP_UNIVERSAL=1.
const targetArg = process.argv.indexOf('--target');
const universal = process.env.PORTUNIA_RDP_UNIVERSAL === '1'
  || (targetArg !== -1 && process.argv[targetArg + 1] === 'universal-apple-darwin');

if (universal) {
  if (process.platform !== 'darwin') throw new Error('Le moteur RDP universel ne se compile que sur macOS');
  const manifest = join(root, 'rdp-helper', 'Cargo.toml');
  const binaries = join(root, 'src-tauri', 'binaries');
  mkdirSync(binaries, { recursive: true });
  const slices = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map((t) => {
    execSync(`cargo build ${release ? '--release ' : ''}--target ${t} --manifest-path "${manifest}"`, { stdio: 'inherit' });
    const slice = join(root, 'rdp-helper', 'target', t, profile, 'portunia-rdp');
    // « tauri build --target universal-apple-darwin » compile Portunia une fois par architecture :
    // chacune exige aussi son propre moteur (portunia-rdp-<triplet>), en plus de l'universel.
    copyFileSync(slice, join(binaries, `portunia-rdp-${t}`));
    return slice;
  });
  const out = join(binaries, 'portunia-rdp-universal-apple-darwin');
  execSync(`lipo -create ${slices.map((s) => `"${s}"`).join(' ')} -output "${out}"`, { stdio: 'inherit' });
  console.log(`Moteur RDP universel : ${execSync(`lipo -archs "${out}"`).toString().trim()} -> ${out}`);
  process.exit(0);
}

execSync(`cargo build ${release ? '--release ' : ''}--manifest-path "${join(root, 'rdp-helper', 'Cargo.toml')}"`, { stdio: 'inherit' });

const source = join(root, 'rdp-helper', 'target', profile, `portunia-rdp${ext}`);
const target = join(root, 'src-tauri', 'binaries', `portunia-rdp-${triple}${ext}`);
mkdirSync(dirname(target), { recursive: true });
// Ne recopie que si le moteur a changé (évite de relancer la compilation de Portunia).
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
