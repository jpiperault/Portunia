// localpanel.ts ne se charge pas sous node (propriétés de paramètre dans son constructeur) : on teste les
// helpers de chemin qu'il appelle, sur des cas du panneau local de chaque plateforme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentDir, joinPath, localName, places } from '../../src/platform.ts';

test('panneau local Mac : monter puis redescendre reste en POSIX, arrêt à la racine', () => {
  const start = '/Volumes/Disque/Photos';
  const up = parentDir(start, true);
  assert.equal(up, '/Volumes/Disque');
  assert.equal(joinPath(up, 'Photos', true), start);
  assert.equal(parentDir(parentDir(up, true), true), '/');
});

test('panneau local : « a:b » garde son nom sur Mac, est nettoyé sous Windows', () => {
  assert.equal(localName('rapport:v2?.txt', true), 'rapport:v2?.txt');
  assert.equal(localName('rapport:v2?.txt', false), 'rapport_v2_.txt');
});

test('raccourcis : racine et /Volumes sur Mac, aucun sous Windows (lecteurs)', () => {
  assert.deepEqual(places(true).map((p) => p.path), ['/', '/Volumes']);
  assert.deepEqual(places(false), []);
});
