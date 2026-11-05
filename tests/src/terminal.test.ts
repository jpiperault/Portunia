// terminal.ts dépend de xterm (DOM) et ne se charge pas sous node : on teste la logique de touches qu'il
// délègue à platform.ts (termShortcut, isMod) sur les scénarios du terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMod, termShortcut } from '../../src/platform.ts';

const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) =>
  ({ type: 'keydown', key: k, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

test('Mac : Ctrl+C part au shell (interruption), ⌘C copie', () => {
  assert.equal(termShortcut(key('c', { ctrlKey: true }), true, true).pass, true);
  assert.deepEqual(termShortcut(key('c', { metaKey: true }), true, true), { pass: false, action: 'copy' });
});

test('Mac : ⌘V ne déclenche aucun collage par le clavier (événement paste natif), donc pas de double collage', () => {
  assert.equal(termShortcut(key('v', { metaKey: true }), true, false).action, undefined);
});

test('Windows : Ctrl+V seul reste au shell, Ctrl+Maj+V colle', () => {
  assert.equal(termShortcut(key('v', { ctrlKey: true }), false, false).pass, true);
  assert.equal(termShortcut(key('v', { ctrlKey: true, shiftKey: true }), false, false).action, 'paste');
});

test('lien et molette : ⌘ sur Mac, Ctrl sous Windows', () => {
  assert.equal(isMod({ metaKey: true, ctrlKey: false } as MouseEvent, true), true);
  assert.equal(isMod({ metaKey: false, ctrlKey: true } as WheelEvent, true), false);
  assert.equal(isMod({ metaKey: false, ctrlKey: true } as MouseEvent, false), true);
});
