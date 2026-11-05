import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMod, modLabel, keys, parentDir, joinPath, localName, baseName, sshAgentNote, externalRdpName, canElevate, appShortcut, termShortcut, fileManagerName, IS_MAC } from '../../src/platform.ts';

const press = (o: { ctrlKey?: boolean; metaKey?: boolean }) => ({ ctrlKey: false, metaKey: false, ...o }) as KeyboardEvent;

test('isMod : Cmd sur Mac, Ctrl ailleurs', () => {
  assert.equal(isMod(press({ metaKey: true }), true), true);
  assert.equal(isMod(press({ ctrlKey: true }), true), false, 'Ctrl+touche reste au shell sur Mac');
  assert.equal(isMod(press({ ctrlKey: true }), false), true);
  assert.equal(isMod(press({ metaKey: true }), false), false, 'la touche Windows n\'est pas un raccourci');
});

test('modLabel', () => {
  assert.equal(modLabel(true), '⌘');
  assert.equal(modLabel(false), 'Ctrl');
});

test('keys : Windows inchangé, Mac en symboles', () => {
  for (const s of ['Ctrl Shift K', 'Ctrl+Maj+F', 'Ctrl + wheel', 'Enter']) assert.equal(keys(s, false), s);
  assert.equal(keys('Filter (Ctrl Shift K)', true), 'Filter (⇧⌘K)');
  assert.equal(keys('Ctrl+Maj+C / V copier / coller', true), '⇧⌘C / V copier / coller');
  assert.equal(keys('Ctrl Shift O', true), '⇧⌘O');
  assert.equal(keys('Ctrl+Alt+Shift+X', true), '⌥⇧⌘X');
  assert.equal(keys('Ctrl+clic sur un lien', true), '⌘+clic sur un lien');
  assert.equal(keys('Ctrl + molette', true), '⌘ + molette');
});

test('IS_MAC a une valeur booléenne avant initPlatform (repli sur l\'agent)', () => {
  assert.equal(typeof IS_MAC, 'boolean');
});

test('fileManagerName', () => {
  assert.equal(fileManagerName(true), 'Finder');
  assert.equal(fileManagerName(false), 'Explorer'); // langue de test : anglais
});

test('parentDir : POSIX sur Mac', () => {
  assert.equal(parentDir('/Users/moi/Documents', true), '/Users/moi');
  assert.equal(parentDir('/Users', true), '/');
  assert.equal(parentDir('/', true), '/');
  assert.equal(parentDir('/Users/moi/', true), '/Users');
});

test('parentDir : Windows inchangé', () => {
  assert.equal(parentDir('C:\\Users\\moi', false), 'C:\\Users');
  assert.equal(parentDir('C:\\Users', false), 'C:\\');
  assert.equal(parentDir('C:\\', false), '');
  assert.equal(parentDir('C:', false), '');
});

test('joinPath', () => {
  assert.equal(joinPath('/Users/moi', 'a.txt', true), '/Users/moi/a.txt');
  assert.equal(joinPath('/', 'a.txt', true), '/a.txt');
  assert.equal(joinPath('C:\\Users', 'a.txt', false), 'C:\\Users\\a.txt');
  assert.equal(joinPath('C:\\', 'a.txt', false), 'C:\\a.txt');
});

test('localName : règle des caractères réservés seulement sous Windows', () => {
  assert.equal(localName('a:b?c*.txt', false), 'a_b_c_.txt');
  assert.equal(localName('fin. ', false), 'fin');
  assert.equal(localName('..', false), '_');
  assert.equal(localName('a:b?c*.txt', true), 'a:b?c*.txt');
  assert.equal(localName('dossier/fichier', true), 'dossier_fichier');
  assert.equal(localName('..', true), '_');
  assert.equal(localName('', true), '_');
  assert.equal(localName('fin.', true), 'fin.');
});

test('baseName : un chemin Finder n\'est pas analysé comme un chemin Windows', () => {
  assert.equal(baseName('/Users/moi/a\\b.txt', true), 'a\\b.txt');
  assert.equal(baseName('/Users/moi/dossier/', true), 'dossier');
  assert.equal(baseName('C:\\Users\\moi\\a.txt', false), 'a.txt');
  assert.equal(baseName('C:/Users/moi/a.txt', false), 'a.txt');
});

test('keys : la connexion rapide est ⌘K sur Mac (⌘⇧Q est la déconnexion du système)', () => {
  assert.equal(keys('Quick connect: address, login and password (Ctrl Shift Q)', true), 'Quick connect: address, login and password (⌘K)');
  assert.equal(keys('Quick connect (Ctrl+Maj+Q)', false), 'Quick connect (Ctrl+Maj+Q)');
  assert.equal(keys('Filter (Ctrl Shift K)', true), 'Filter (⇧⌘K)');
});

test('sshAgentNote : Pageant n\'existe pas sur Mac', () => {
  assert.match(sshAgentNote(true), /SSH_AUTH_SOCK/);
  assert.doesNotMatch(sshAgentNote(true), /Pageant/);
  assert.match(sshAgentNote(false), /Pageant/);
});

test('externalRdpName : « Windows App » sur Mac, « mstsc » sous Windows', () => {
  assert.equal(externalRdpName(true), 'Windows App (Microsoft)');
  assert.equal(externalRdpName(false), 'mstsc');
});

const chord = (key: string, o: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

test('appShortcut : Windows garde Ctrl+Maj+…, y compris Q', () => {
  assert.equal(appShortcut(chord('Q', { ctrlKey: true, shiftKey: true }), false), 'quick-connect');
  assert.equal(appShortcut(chord('k', { ctrlKey: true, shiftKey: true }), false), 'search-sessions');
  assert.equal(appShortcut(chord('w', { ctrlKey: true, shiftKey: true }), false), 'close-tab');
  assert.equal(appShortcut(chord('k', { ctrlKey: true }), false), null, 'Ctrl+K reste au terminal');
  assert.equal(appShortcut(chord('k', { metaKey: true, shiftKey: true }), false), null);
});

test('appShortcut : Mac = ⌘⇧…, jamais ⌘⇧Q, et Ctrl+Maj reste au shell', () => {
  assert.equal(appShortcut(chord('K', { metaKey: true, shiftKey: true }), true), 'search-sessions');
  assert.equal(appShortcut(chord('n', { metaKey: true, shiftKey: true }), true), 'new-session');
  assert.equal(appShortcut(chord('q', { metaKey: true, shiftKey: true }), true), null, '⌘⇧Q = déconnexion macOS');
  assert.equal(appShortcut(chord('k', { metaKey: true }), true), null, '⌘K passe par le menu natif, pas par ce gestionnaire');
  assert.equal(appShortcut(chord('k', { ctrlKey: true, shiftKey: true }), true), null);
});

test('termShortcut Windows : Ctrl+Maj+C/V/F inchangés, le reste va à xterm', () => {
  const ev = (key: string, o = {}, type = 'keydown') => ({ type, key, ctrlKey: true, metaKey: false, shiftKey: true, ...o });
  assert.deepEqual(termShortcut(ev('C'), false, true), { pass: false, action: 'copy' });
  assert.deepEqual(termShortcut(ev('C'), false, false), { pass: false });
  assert.deepEqual(termShortcut(ev('V'), false, false), { pass: false, action: 'paste' });
  assert.deepEqual(termShortcut(ev('F'), false, false), { pass: false, action: 'search' });
  assert.deepEqual(termShortcut(ev('V', {}, 'keyup'), false, false), { pass: false });
  assert.deepEqual(termShortcut(ev('c', { shiftKey: false }), false, true), { pass: true }, 'Ctrl+C = interruption');
});

test('termShortcut Mac : ⌘C copie la sélection, ⌘V laisse le collage natif, Ctrl+C reste au shell', () => {
  const ev = (key: string, o = {}, type = 'keydown') => ({ type, key, ctrlKey: false, metaKey: true, shiftKey: false, ...o });
  assert.deepEqual(termShortcut(ev('c'), true, true), { pass: false, action: 'copy' });
  assert.deepEqual(termShortcut(ev('c'), true, false), { pass: false });
  assert.deepEqual(termShortcut(ev('v'), true, false), { pass: false }, 'pas d\'action : l\'événement paste natif colle (sinon double collage)');
  assert.deepEqual(termShortcut(ev('k'), true, false), { pass: false });
  assert.deepEqual(termShortcut(ev('c', { metaKey: false, ctrlKey: true }), true, true), { pass: true });
  assert.deepEqual(termShortcut(ev('V', { shiftKey: true }), true, false), { pass: false, action: 'paste' });
});

test('canElevate : vrai sauf si le cœur dit elevatable === false', () => {
  assert.equal(canElevate({}), true);
  assert.equal(canElevate({ elevatable: true }), true);
  assert.equal(canElevate({ elevatable: false }), false);
});
