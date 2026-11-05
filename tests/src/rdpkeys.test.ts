import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remapMeta, liveKey, releaseOnMetaUp, isMacAppKey } from '../../src/rdpkeys.ts';

test('liveKey : les modificateurs ne sont jamais relâchés aussitôt (WebKit envoie leur keyup)', () => {
  for (const code of ['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'CapsLock']) {
    assert.equal(liveKey({ code, metaKey: true }, 0xffe1, 'ctrl', true).releaseNow, false, code);
  }
  // ⌘⌥X : X est relâchée aussitôt, Alt non.
  assert.equal(liveKey({ code: 'KeyX', metaKey: true }, 0x78, 'ctrl', true).releaseNow, true);
});

test('releaseOnMetaUp : relâcher ⌘ libère les touches restées enfoncées, pas le Meta lui-même', () => {
  const pressed = new Map([
    ['MetaLeft', { keysym: 0xffe3, code: 'ControlLeft' }],
    ['AltLeft', { keysym: 0xffe9, code: 'AltLeft' }],
    ['KeyX', { keysym: 0x78, code: 'KeyX' }],
  ]);
  assert.deepEqual(releaseOnMetaUp(pressed, 'MetaLeft'), [
    { keysym: 0xffe9, code: 'AltLeft', held: 'AltLeft' },
    { keysym: 0x78, code: 'KeyX', held: 'KeyX' },
  ]);
  assert.deepEqual(releaseOnMetaUp(pressed, 'KeyX'), [], 'seul le keyup d\'un Meta déclenche le nettoyage');
  const both = new Map([['MetaLeft', { keysym: 0xffe3, code: 'ControlLeft' }], ['MetaRight', { keysym: 0xffe4, code: 'ControlRight' }]]);
  assert.deepEqual(releaseOnMetaUp(both, 'MetaLeft'), [], 'l\'autre ⌘ reste enfoncée');
});

test('isMacAppKey : ⌘Q, ⌘H, ⌘M et ⌘, restent à macOS ; le reste part vers la session', () => {
  const chord = (key: string, o: object = {}) => ({ key, metaKey: true, shiftKey: false, ...o });
  for (const k of ['q', 'Q', 'h', 'm', ',']) assert.equal(isMacAppKey(chord(k), true), true, k);
  for (const k of ['c', 'v', 'w', 'k', 'a', 'z']) assert.equal(isMacAppKey(chord(k), true), false, k);
  assert.equal(isMacAppKey(chord('q', { shiftKey: true }), true), false, '⌘⇧ est traité à part (réservé à Portunia)');
  assert.equal(isMacAppKey(chord('q', { metaKey: false }), true), false);
  assert.equal(isMacAppKey(chord('q'), false), false, 'Windows : jamais');
});

test('Mac, ⌘ envoyée comme Ctrl : les touches Meta deviennent Contrôle', () => {
  assert.deepEqual(remapMeta('MetaLeft', 0xffeb, 'ctrl', true), { code: 'ControlLeft', keysym: 0xffe3 });
  assert.deepEqual(remapMeta('MetaRight', 0xffec, 'ctrl', true), { code: 'ControlRight', keysym: 0xffe4 });
});

test('Mac, ⌘ envoyée comme Windows : inchangé', () => {
  assert.deepEqual(remapMeta('MetaLeft', 0xffeb, 'windows', true), { code: 'MetaLeft', keysym: 0xffeb });
});

test('les autres touches ne changent jamais (Option = Alt reste Alt)', () => {
  assert.deepEqual(remapMeta('AltLeft', 0xffe9, 'ctrl', true), { code: 'AltLeft', keysym: 0xffe9 });
  assert.deepEqual(remapMeta('KeyC', 0x63, 'ctrl', true), { code: 'KeyC', keysym: 0x63 });
});

test('Windows : jamais de remplacement, quel que soit le réglage', () => {
  assert.deepEqual(remapMeta('MetaLeft', 0xffeb, 'ctrl', false), { code: 'MetaLeft', keysym: 0xffeb });
});
