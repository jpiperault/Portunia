// localshells.ts ne se charge pas sous node : on teste canElevate, qui décide d'afficher « Ouvrir en administrateur »
// pour un shell détecté (champ `elevatable` fourni par le cœur sur Mac, absent sur les anciens cœurs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canElevate } from '../../src/platform.ts';

test('un shell détecté sans champ elevatable reste élevable (compatibilité)', () => {
  assert.equal(canElevate({ id: 'pwsh', name: 'PowerShell', command: 'pwsh', args: [], cwd: '', icon: 'pwsh' }), true);
});

test('un shell avec elevatable: false n\'offre pas l\'élévation', () => {
  assert.equal(canElevate({ id: 'zsh', name: 'zsh', command: '/bin/zsh', args: [], cwd: '', icon: 'custom', elevatable: false }), false);
});
