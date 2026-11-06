// Nom du magasin de mots de passe cité dans l'écran d'import / export.
// security.ts / importexport.ts importent des types de api.ts sans « import type », ce que node refuse : on remplace
// api.ts et les modules Tauri par de petits faux pour charger importexport.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKES: Record<string, string> = {
  '@tauri-apps/api/core': 'export const invoke = async () => { throw new Error("hors Tauri"); };',
  './api': 'export const errorText = String; export const security = {}; export const api = {}; export const Edition = undefined, LicenseStatus = undefined, LockStatus = undefined, ImportCandidate = undefined, ImportSource = undefined;',
  '@tauri-apps/plugin-dialog': 'export const open = async () => null; export const save = async () => null;',
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in FAKES) return { url: `data:text/javascript,${encodeURIComponent(FAKES[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { passwordStoreNote } = await import('../../src/importexport.ts');

test('import / export : le Mac parle du Trousseau macOS, jamais du Gestionnaire Windows', () => {
  const note = passwordStoreNote(true);
  assert.match(note, /macOS Keychain/);
  assert.doesNotMatch(note, /Windows|Credential Manager/);
});

test('import / export : le texte Windows est inchangé', () => {
  assert.equal(passwordStoreNote(false), 'Passwords are never imported or exported: they stay in the Windows Credential Manager.');
});
