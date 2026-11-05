// credentials.ts construit des éléments DOM et ne se charge pas sous node : on teste le texte de l'agent SSH
// qu'il affiche (sshAgentNote).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshAgentNote } from '../../src/platform.ts';

test('agent SSH : Mac parle de SSH_AUTH_SOCK, jamais de Pageant', () => {
  assert.match(sshAgentNote(true), /SSH_AUTH_SOCK/);
  assert.doesNotMatch(sshAgentNote(true), /Pageant|Windows/);
});

test('agent SSH : le texte Windows est inchangé', () => {
  assert.equal(sshAgentNote(false), 'Keys loaded in Pageant or the Windows OpenSSH agent are used.');
});
