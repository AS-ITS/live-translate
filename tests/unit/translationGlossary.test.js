import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationGlossary } from '../../src/infrastructure/translationGlossary.js';

test('missing or unconfigured glossary is empty and remains optional', async () => {
  const unconfigured = createTranslationGlossary();
  const missing = createTranslationGlossary({
    filePath: 'missing.json',
    fileSystem: { async readFile() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } }
  });

  assert.deepEqual(await unconfigured.entriesFor('ja'), []);
  assert.deepEqual(await missing.entriesFor('ja'), []);
});

test('glossary selects only translations for the requested supported target language', async () => {
  const glossary = createGlossary({
    entries: [
      { source: 'Codex', translations: { 'zh-Hant': 'Codex', ja: 'コーデックス' } },
      { source: 'Live Translate', translations: { 'zh-Hant': '即時翻譯系統' } }
    ]
  });

  assert.deepEqual(await glossary.entriesFor('ja'), [{ source: 'Codex', target: 'コーデックス' }]);
  assert.deepEqual(await glossary.entriesFor('zh-Hant'), [
    { source: 'Codex', target: 'Codex' },
    { source: 'Live Translate', target: '即時翻譯系統' }
  ]);
});

test('glossary rejects invalid JSON and invalid entry shapes deterministically', async () => {
  await assert.rejects(createGlossaryContent('{').entriesFor('ja'), /JSON is invalid/);

  for (const glossary of [
    {},
    { entries: [{}] },
    { entries: [{ source: 1, translations: { ja: '用語' } }] },
    { entries: [{ source: ' ', translations: { ja: '用語' } }] },
    { entries: [{ source: 'Codex', translations: '用語' }] },
    { entries: [{ source: 'Codex', translations: { ja: 1 } }] },
    { entries: [{ source: 'Codex', translations: { ja: ' ' } }] },
    { entries: [{ source: 'Codex', translations: { 'xx': 'term' } }] },
    { entries: [{ source: 'Codex', translations: [] }] }
  ]) {
    await assert.rejects(createGlossary(glossary).entriesFor('ja'));
  }

  await assert.rejects(createGlossary({ entries: [] }).entriesFor('xx'), /Unsupported targetLanguageCode/);
});

test('glossary loads its file once and returns immutable selected entries', async () => {
  let reads = 0;
  const glossary = createTranslationGlossary({
    filePath: 'glossary.json',
    fileSystem: {
      async readFile() {
        reads += 1;
        return JSON.stringify({ entries: [{ source: 'Codex', translations: { ja: 'コーデックス' } }] });
      }
    }
  });

  const entries = await glossary.entriesFor('ja');
  await glossary.entriesFor('ja');
  assert.equal(reads, 1);
  assert.equal(Object.isFrozen(entries), true);
  assert.equal(Object.isFrozen(entries[0]), true);
});

function createGlossary(value) {
  return createGlossaryContent(JSON.stringify(value));
}

function createGlossaryContent(content) {
  return createTranslationGlossary({ filePath: 'glossary.json', fileSystem: { async readFile() { return content; } } });
}
