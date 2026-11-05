// recordings.ts ne se charge pas sous node : on teste les libellés du bouton « afficher dans le gestionnaire de fichiers ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealLabels } from '../../src/platform.ts';

test('Windows : libellés inchangés (Explorateur)', () => {
  assert.deepEqual(revealLabels('a.cast', false), { aria: 'Show a.cast in Explorer', title: 'Show in Explorer' });
});

test('Mac : Finder', () => {
  assert.deepEqual(revealLabels('a.cast', true), { aria: 'Show a.cast in the Finder', title: 'Show in the Finder' });
});
