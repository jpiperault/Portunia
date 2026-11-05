// screen.ts manipule un canvas et des propriétés de paramètre : il ne se charge pas sous node. On teste
// liveKey (rdpkeys.ts), la transformation d'une frappe en direct avant envoi à la session distante.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKey } from '../../src/rdpkeys.ts';

test('Mac, ⌘ → Ctrl : ⌘ enfoncée devient Contrôle, la touche suivante part avec un relâchement immédiat', () => {
  const cmd = liveKey({ code: 'MetaLeft', metaKey: true }, 0xffeb, 'ctrl', true);
  assert.deepEqual(cmd, { code: 'ControlLeft', keysym: 0xffe3, releaseNow: false });
  // WebKit n'émet pas keyup pour une touche pressée sous ⌘ : on relâche tout de suite, sans quoi elle resterait enfoncée.
  const c = liveKey({ code: 'KeyC', metaKey: true }, 0x63, 'ctrl', true);
  assert.deepEqual(c, { code: 'KeyC', keysym: 0x63, releaseNow: true });
});

test('Mac, ⌘ → Windows : la touche Windows est transmise telle quelle', () => {
  assert.deepEqual(liveKey({ code: 'MetaRight', metaKey: true }, 0xffec, 'windows', true), { code: 'MetaRight', keysym: 0xffec, releaseNow: false });
});

test('Mac : ⌥ reste Alt, sans relâchement forcé', () => {
  assert.deepEqual(liveKey({ code: 'AltLeft', metaKey: false }, 0xffe9, 'ctrl', true), { code: 'AltLeft', keysym: 0xffe9, releaseNow: false });
});

test('Windows : aucun changement, aucun relâchement forcé', () => {
  assert.deepEqual(liveKey({ code: 'KeyC', metaKey: false }, 0x63, 'ctrl', false), { code: 'KeyC', keysym: 0x63, releaseNow: false });
  assert.deepEqual(liveKey({ code: 'MetaLeft', metaKey: true }, 0xffeb, 'ctrl', false), { code: 'MetaLeft', keysym: 0xffeb, releaseNow: false });
});
