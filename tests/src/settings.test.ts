// settings.ts ne se charge pas sous node (propriétés de paramètre de ses dépendances, non gérées par
// le retrait de types) : on teste ici le helper que l'écran des réglages appelle pour ses textes de raccourcis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keys } from '../../src/platform.ts';

const HINT_FR = 'Raccourcis : Ctrl+Maj+F rechercher dans le terminal · Ctrl+clic sur un lien pour l\'ouvrir · Ctrl+Maj+C / V copier / coller.';
const SIZE_FR = 'Taille (Ctrl + molette dans le terminal)';

test('réglages : textes de raccourcis en forme ⌘ sur Mac, intacts sous Windows', () => {
  assert.equal(keys(HINT_FR, false), HINT_FR);
  assert.equal(keys(SIZE_FR, false), SIZE_FR);
  assert.equal(keys(HINT_FR, true), 'Raccourcis : ⇧⌘F rechercher dans le terminal · ⌘+clic sur un lien pour l\'ouvrir · ⇧⌘C / V copier / coller.');
  assert.equal(keys(SIZE_FR, true), 'Taille (⌘ + molette dans le terminal)');
});
