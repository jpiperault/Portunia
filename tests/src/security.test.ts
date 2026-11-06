// Libellés et visibilité de l'option biométrique (Touch ID sur Mac, Windows Hello sous Windows).
// security.ts / importexport.ts importent des types de api.ts sans « import type », ce que node refuse : on remplace
// api.ts et les modules Tauri par de petits faux pour charger security.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKES: Record<string, string> = {
  '@tauri-apps/api/core': 'export const invoke = async () => { throw new Error("hors Tauri"); };',
  './api': 'export const errorText = String; export const security = {}; export const api = {}; export const Edition = undefined, LicenseStatus = undefined, LockStatus = undefined, ImportCandidate = undefined, ImportSource = undefined;',
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in FAKES) return { url: `data:text/javascript,${encodeURIComponent(FAKES[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { biometricLabel, biometricOption, biometricTexts, refreshAfterFailure } = await import('../../src/security.ts');

test('libellé : Touch ID, Windows Hello, rien', () => {
  assert.equal(biometricLabel('touchid'), 'Touch ID');
  assert.equal(biometricLabel('hello'), 'Windows Hello');
  assert.equal(biometricLabel(null), '');
});

test('option masquée si aucun capteur et rien d\'activé', () => {
  assert.equal(biometricOption(null, false, true), null);
  assert.equal(biometricOption(null, false, false), null);
});

test('option visible si un capteur existe, sur Mac comme sous Windows', () => {
  assert.deepEqual(biometricOption('touchid', false, true), { kind: 'touchid', disabled: false });
  assert.deepEqual(biometricOption('hello', true, false), { kind: 'hello', disabled: false });
});

test('capteur disparu mais biométrie encore active : option visible et grisée, pour pouvoir la retirer', () => {
  assert.deepEqual(biometricOption(null, true, true), { kind: 'touchid', disabled: true });
  assert.deepEqual(biometricOption(null, true, false), { kind: 'hello', disabled: true });
});

test('textes Touch ID : jamais de Windows', () => {
  const x = biometricTexts('touchid');
  assert.equal(x.toggle, 'Unlock with Touch ID');
  assert.equal(x.cancelled, 'Touch ID check cancelled.');
  assert.match(x.unavailable, /Touch ID/);
  for (const text of Object.values(x)) assert.doesNotMatch(text, /Windows/);
});

test('textes Windows Hello : identiques à ceux d\'avant', () => {
  const x = biometricTexts('hello');
  assert.equal(x.toggle, 'Unlock with Windows Hello');
  assert.equal(x.cancelled, 'Windows Hello check cancelled.');
  assert.equal(x.hint, 'Face, fingerprint or Windows PIN.');
  assert.equal(x.unavailable, 'Windows Hello is not set up on this PC');
});

test('après une erreur, l\'état des Paramètres est relu depuis le cœur et affiché', async () => {
  const shown: string[] = [];
  await refreshAfterFailure(async () => 'etat-reel', (s) => { shown.push(s); });
  assert.deepEqual(shown, ['etat-reel']);
});

test('après une erreur, un cœur injoignable n\'écrase rien et ne lève pas', async () => {
  const shown: string[] = [];
  await refreshAfterFailure(async () => { throw new Error('indisponible'); }, (s: string) => { shown.push(s); });
  assert.deepEqual(shown, []);
});
