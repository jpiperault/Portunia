// multiexec.ts construit des éléments DOM à l'import et ne se charge pas sous node : on teste le helper
// qu'il appelle pour lancer la commande (⌘+Entrée sur Mac, Ctrl+Entrée sous Windows) et son libellé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMod, keys } from '../../src/platform.ts';

const enter = (mods: { ctrlKey?: boolean; metaKey?: boolean }) => ({ key: 'Enter', ctrlKey: false, metaKey: false, ...mods }) as KeyboardEvent;

test('lancer : ⌘+Entrée sur Mac, Ctrl+Entrée sous Windows', () => {
  assert.equal(isMod(enter({ metaKey: true }), true), true);
  assert.equal(isMod(enter({ ctrlKey: true }), true), false);
  assert.equal(isMod(enter({ ctrlKey: true }), false), true);
});

test('libellé du raccourci de lancement', () => {
  const hint = 'Choisissez des serveurs, tapez une commande, puis « Lancer » (Ctrl+Entrée).';
  assert.equal(keys(hint, false), hint);
  assert.equal(keys(hint, true), 'Choisissez des serveurs, tapez une commande, puis « Lancer » (⌘+Entrée).');
});
