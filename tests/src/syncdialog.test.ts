// syncdialog.ts construit du DOM et ne se charge pas sous node : on teste le helper qui compose les chemins locaux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localPathUnder } from '../../src/platform.ts';

test('Windows : chemin identique à l\'ancien `${racine}\\${parties}` (séparateur \\)', () => {
  assert.equal(localPathUnder('C:\\Users\\moi\\Docs', ['sous', 'fichier.txt'], false), 'C:\\Users\\moi\\Docs\\sous\\fichier.txt');
  assert.equal(localPathUnder('C:', ['a.txt'], false), 'C:\\a.txt');
});

test('Mac : chemin POSIX, y compris depuis la racine (racine vide après retrait du « / » final)', () => {
  assert.equal(localPathUnder('/Users/moi/Docs', ['sous', 'fichier.txt'], true), '/Users/moi/Docs/sous/fichier.txt');
  assert.equal(localPathUnder('', ['a.txt'], true), '/a.txt');
});
