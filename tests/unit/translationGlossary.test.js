import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  assert.deepEqual(await glossary.entriesFor('ja'), [{ source: 'Codex', target: 'コーデックス', replacementAliases: [] }]);
  assert.deepEqual(await glossary.entriesFor('zh-Hant'), [
    { source: 'Codex', target: 'Codex', replacementAliases: [] },
    { source: 'Live Translate', target: '即時翻譯系統', replacementAliases: [] }
  ]);
});

test('glossary returns source as the primary replacement term and keeps legacy aliases for the requested target language only', async () => {
  const glossary = createGlossary({
    entries: [
      {
        source: 'microphone',
        translations: { en: 'Alan speak', ja: 'アランスピーク' },
        replacementAliases: { en: ['mic'], ja: ['マイク'] },
        scope: 'both'
      }
    ]
  });

  assert.deepEqual(await glossary.entriesFor('en', { scope: 'live' }), [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }
  ]);
  assert.deepEqual(await glossary.entriesFor('ja', { scope: 'history' }), [
    { source: 'microphone', target: 'アランスピーク', replacementAliases: ['マイク'] }
  ]);
});

test('glossary defaults legacy entries to history and filters requested scope', async () => {
  const glossary = createGlossary({
    entries: [
      { source: 'Legacy', translations: { ja: 'レガシー' } },
      { source: 'Live', scope: 'live', translations: { ja: 'ライブ' } },
      { source: 'History', scope: 'history', translations: { ja: '履歴' } },
      { source: 'Both', scope: 'both', translations: { ja: '両方' } }
    ]
  });

  assert.deepEqual(await glossary.entriesFor('ja'), [
    { source: 'Legacy', target: 'レガシー', replacementAliases: [] },
    { source: 'Live', target: 'ライブ', replacementAliases: [] },
    { source: 'History', target: '履歴', replacementAliases: [] },
    { source: 'Both', target: '両方', replacementAliases: [] }
  ]);
  assert.deepEqual(await glossary.entriesFor('ja', { scope: 'live' }), [
    { source: 'Live', target: 'ライブ', replacementAliases: [] },
    { source: 'Both', target: '両方', replacementAliases: [] }
  ]);
  assert.deepEqual(await glossary.entriesFor('ja', { scope: 'history' }), [
    { source: 'Legacy', target: 'レガシー', replacementAliases: [] },
    { source: 'History', target: '履歴', replacementAliases: [] },
    { source: 'Both', target: '両方', replacementAliases: [] }
  ]);
});

test('glossary rejects invalid scope values', async () => {
  await assert.rejects(
    createGlossary({ entries: [{ source: 'Codex', scope: 'archive', translations: { ja: '用語' } }] }).entriesFor('ja'),
    /scope/
  );
  await assert.rejects(
    createGlossary({ entries: [] }).entriesFor('ja', { scope: 'archive' }),
    /scope/
  );
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
    { entries: [{ source: 'Codex', translations: [] }] },
    { entries: [{ source: 'Codex', translations: { ja: '用語' }, replacementAliases: [] }] },
    { entries: [{ source: 'Codex', translations: { ja: '用語' }, replacementAliases: { xx: ['term'] } }] },
    { entries: [{ source: 'Codex', translations: { ja: '用語' }, replacementAliases: { ja: 'term' } }] },
    { entries: [{ source: 'Codex', translations: { ja: '用語' }, replacementAliases: { ja: [' '] } }] }
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

test('glossary CRUD persists entries and updates cached provider entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({
    filePath,
    fileSystem: fs,
    idFactory: () => 'entry-1',
    clock: () => 1000
  });

  assert.deepEqual(await glossary.entriesFor('ja'), []);

  const created = await glossary.createEntry({ source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'both' });
  assert.equal(created.id, 'entry-1');
  assert.equal(created.scope, 'both');
  assert.equal(Object.hasOwn(created, 'replacementAliases'), false);
  assert.deepEqual(await glossary.entriesFor('ja'), [{ source: 'Codex', target: 'コーデックス', replacementAliases: [] }]);

  await glossary.updateEntry('entry-1', {
    source: 'Codex',
    translations: { ja: 'コードエックス', fr: 'Codex' },
    replacementAliases: { ja: ['コード X'] },
    scope: 'history'
  });
  assert.deepEqual(await glossary.entriesFor('ja'), [{ source: 'Codex', target: 'コードエックス', replacementAliases: ['コード X'] }]);
  assert.deepEqual(await glossary.listEntries(), [
    {
      id: 'entry-1',
      source: 'Codex',
      sourceLanguageCode: 'zh-Hant',
      translations: { ja: 'コードエックス', fr: 'Codex' },
      replacementAliases: { ja: ['コード X'] },
      scope: 'history',
      category: 'other',
      tags: [],
      enabled: true,
      notes: '',
      createdAt: 1000,
      updatedAt: 1000
    }
  ]);

  await glossary.deleteEntry('entry-1');
  assert.deepEqual(await glossary.entriesFor('ja'), []);
});

test('glossary categories support stable IDs, ordering, and reassignment on delete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-categories-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => 'project' });
  assert.deepEqual((await glossary.listCategories()).map((category) => category.id), ['product', 'department', 'abbreviation', 'meeting', 'technical', 'other']);
  await glossary.createCategory({ label: '專案名詞' });
  await glossary.createEntry({ source: 'term', translations: { en: 'term' }, category: 'project' });
  await glossary.reorderCategories(['project', 'product', 'department', 'abbreviation', 'meeting', 'technical', 'other']);
  await glossary.updateCategory('project', { label: '專案詞彙' });
  await assert.rejects(glossary.createCategory({ label: '專案詞彙' }), /already exists/);
  await assert.rejects(glossary.deleteCategory('other'), /cannot be deleted/);
  const deleted = await glossary.deleteCategory('project');
  assert.equal(deleted.reassignedEntryCount, 1);
  assert.equal((await glossary.listEntries())[0].category, 'other');
  await assert.rejects(
    glossary.createEntry({ source: 'invalid', translations: { en: 'invalid' }, category: 'project' }),
    (error) => error.code === 'invalid_request'
  );
  assert.deepEqual((await glossary.listCategories()).map((category) => category.id), ['product', 'department', 'abbreviation', 'meeting', 'technical', 'other']);
});

test('glossary import previews CSV rows and commits selected conflicts atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  let nextId = 0;
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => `import-${++nextId}`, clock: () => 2000 });
  await glossary.createEntry({ source: 'Existing', translations: { en: 'Old' }, scope: 'both' });
  const content = 'source,sourceLanguageCode,translation.en,scope\nExisting,zh-Hant,New,both\nFresh,zh-Hant,Fresh,both\n';
  const preview = await glossary.previewImport({ format: 'csv', content });
  assert.deepEqual(preview.summary, { total: 2, valid: 2, invalid: 0, creates: 1, updates: 1, duplicates: 1 });
  assert.equal(preview.rows[0].status, 'conflict');
  const result = await glossary.importEntries({ format: 'csv', content, baseRevision: preview.baseRevision, resolutions: { 2: 'update', 3: 'skip' } });
  assert.deepEqual(result, { createdCount: 1, updatedCount: 1, skippedCount: 0, total: 2 });
  assert.equal((await glossary.listEntries()).find((entry) => entry.source === 'Existing').translations.en, 'New');
  await assert.rejects(glossary.importEntries({ format: 'csv', content, baseRevision: 'stale', resolutions: { 2: 'update' } }), (error) => error.code === 'glossary_revision_conflict');
});

test('glossary import rejects the complete batch when any row is invalid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-invalid-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => 'import-1' });
  const content = JSON.stringify({ entries: [{ source: 'Good', translations: { en: 'Good' } }, { source: 'Bad', translations: { xx: 'Bad' } }] });
  const preview = await glossary.previewImport({ format: 'json', content });
  assert.equal(preview.summary.invalid, 1);
  await assert.rejects(glossary.importEntries({ format: 'json', content, baseRevision: preview.baseRevision }), (error) => error.code === 'glossary_import_invalid');
  assert.deepEqual(await glossary.listEntries(), []);
});

function createGlossary(value) {
  return createGlossaryContent(JSON.stringify(value));
}

function createGlossaryContent(content) {
  return createTranslationGlossary({ filePath: 'glossary.json', fileSystem: { async readFile() { return content; } } });
}
