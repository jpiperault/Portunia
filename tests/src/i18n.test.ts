import { test } from 'node:test';
import assert from 'node:assert/strict';

// Système en français : la langue « auto » doit suivre navigator.languages, que ce soit Windows ou macOS.
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', languages: ['fr-FR', 'en'] }, configurable: true });
const { t, LANG } = await import('../../src/i18n.ts');

test('langue automatique : suit la langue du système (ici macOS en français)', () => {
  assert.equal(LANG, 'fr');
  assert.equal(t('Finder', 'Explorateur'), 'Explorateur');
});
