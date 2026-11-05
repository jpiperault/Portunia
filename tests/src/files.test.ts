// files.ts ne se charge pas sous node (propriétés de paramètre dans ses constructeurs, non gérées par le
// retrait de types). On teste donc les deux helpers qu'il appelle : la touche de sélection multiple (isMod)
// et le nom de fichier d'un glisser-déposer (baseName).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMod, baseName } from '../../src/platform.ts';

const click = (mods: { metaKey?: boolean; ctrlKey?: boolean }) => ({ metaKey: false, ctrlKey: false, ...mods }) as MouseEvent;

test('sélection multiple : ⌘+clic sur Mac (Ctrl+clic y est un clic droit), Ctrl+clic sous Windows', () => {
  assert.equal(isMod(click({ metaKey: true }), true), true);
  assert.equal(isMod(click({ ctrlKey: true }), true), false);
  assert.equal(isMod(click({ ctrlKey: true }), false), true);
});

test('glisser-déposer depuis le Finder : chemins POSIX de Tauri, noms avec « \\ » conservés', () => {
  assert.equal(baseName('/Users/moi/Bureau/rapport final.pdf', true), 'rapport final.pdf');
  assert.equal(baseName('/Users/moi/odd\\name.txt', true), 'odd\\name.txt');
});

test('glisser-déposer depuis l\'Explorateur : chemins Windows analysés comme avant', () => {
  assert.equal(baseName('C:\\Users\\moi\\rapport.pdf', false), 'rapport.pdf');
});
