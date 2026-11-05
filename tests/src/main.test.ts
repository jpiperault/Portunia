// main.ts démarre toute l'application à l'import et ne se charge pas sous node : on teste les helpers qu'il
// appelle au démarrage et dans ses gestionnaires (libellés de raccourcis de index.html, raccourcis globaux).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appShortcut, localizeShortcutTitles, runUnlessBusy } from '../../src/platform.ts';

const page = (dialogOpen: boolean) => ({ querySelector: (sel: string) => (sel === 'dialog[open]' && dialogOpen ? {} : null) });

test('menu natif : refusé si l\'application est verrouillée', () => {
  let ran = 0;
  assert.equal(runUnlessBusy(page(false), () => true, () => { ran++; }), false);
  assert.equal(ran, 0);
});

test('menu natif : refusé si une boîte de dialogue est ouverte', () => {
  let ran = 0;
  assert.equal(runUnlessBusy(page(true), () => false, () => { ran++; }), false);
  assert.equal(ran, 0);
});

test('menu natif : exécuté sinon', () => {
  let ran = 0;
  assert.equal(runUnlessBusy(page(false), () => false, () => { ran++; }), true);
  assert.equal(ran, 1);
});

class FakeEl {
  private title: string;
  constructor(title: string) { this.title = title; }
  getAttribute(name: string) { return name === 'title' ? this.title : null; }
  setAttribute(name: string, value: string) { if (name === 'title') this.title = value; }
  get value() { return this.title; }
}
const root = (...titles: string[]) => {
  const els = titles.map((x) => new FakeEl(x));
  return { els, node: { querySelectorAll: () => els } as unknown as ParentNode };
};

// Titres réels de index.html.
const QUICK = 'Connexion rapide : adresse, identifiant et mot de passe (Ctrl Maj Q)';
const NEW = 'Nouvelle session (Ctrl Maj N)';
const FILTER = 'Filtrer les sessions (Ctrl Maj K) ; ↓ pour parcourir, Entrée ouvre la première. « user@hôte », « rdp hôte »… : connexion rapide. Palette : Ctrl Maj O';

test('titres de index.html : Mac les réécrit en ⌘, la connexion rapide devient ⌘K', () => {
  const { els, node } = root(QUICK, NEW, FILTER);
  localizeShortcutTitles(node, true);
  assert.equal(els[0].value, 'Connexion rapide : adresse, identifiant et mot de passe (⌘K)');
  assert.equal(els[1].value, 'Nouvelle session (⇧⌘N)');
  assert.match(els[2].value, /\(⇧⌘K\).*Palette : ⇧⌘O$/);
});

test('titres de index.html : Windows strictement inchangés', () => {
  const { els, node } = root(QUICK, NEW, FILTER);
  localizeShortcutTitles(node, false);
  assert.deepEqual(els.map((e) => e.value), [QUICK, NEW, FILTER]);
});

test('raccourcis globaux : même table qu\'avant sous Windows, ⌘⇧Q exclu sur Mac', () => {
  const ev = (key: string, o: object) => ({ key, ctrlKey: false, metaKey: false, shiftKey: true, ...o });
  const names = ['k', 'n', 'q', 't', 'w', 'f', 'b', 'p', 'l', 'o'].map((k) => appShortcut(ev(k, { ctrlKey: true }), false));
  assert.deepEqual(names, ['search-sessions', 'new-session', 'quick-connect', 'local-shell', 'close-tab', 'find', 'broadcast', 'commands', 'lock', 'palette']);
  assert.equal(appShortcut(ev('q', { metaKey: true }), true), null);
  assert.equal(appShortcut(ev('l', { metaKey: true }), true), 'lock');
});
