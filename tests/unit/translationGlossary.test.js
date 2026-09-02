import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import ExcelJS from 'exceljs';
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
  const content = 'source,translation\nExisting,New\nFresh,Fresh\n';
  const preview = await glossary.previewImport({ format: 'csv', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', category: 'other' });
  assert.deepEqual(preview.summary, { total: 2, valid: 2, invalid: 0, creates: 1, updates: 1, duplicates: 1 });
  assert.equal(preview.rows[0].status, 'conflict');
  const result = await glossary.importEntries({ format: 'csv', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', category: 'other', baseRevision: preview.baseRevision, resolutions: { 2: 'update', 3: 'skip' } });
  assert.deepEqual(result, { createdCount: 1, updatedCount: 1, skippedCount: 0, total: 2 });
  assert.equal((await glossary.listEntries()).find((entry) => entry.source === 'Existing').translations.ja, 'New');
  await assert.rejects(glossary.importEntries({ format: 'csv', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', category: 'other', baseRevision: 'stale', resolutions: { 2: 'update' } }), (error) => error.code === 'glossary_revision_conflict');
});

test('glossary import reports duplicate source rows separately from invalid rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-duplicate-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: (() => { let index = 0; return () => `import-${++index}`; })() });
  const content = 'source,translation\n重複詞,First\n重複詞,Second\n';

  const preview = await glossary.previewImport({ format: 'csv', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });
  assert.deepEqual(preview.summary, { total: 2, valid: 1, invalid: 0, creates: 1, updates: 0, duplicates: 1 });
  assert.equal(preview.rows[1].status, 'duplicate');
  assert.deepEqual(preview.rows[1].errors, []);
  assert.deepEqual(preview.rows[1].warnings, ['Import contains a duplicate source term.']);

  const result = await glossary.importEntries({ format: 'csv', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other', baseRevision: preview.baseRevision, selectedRows: [2, 3] });
  assert.deepEqual(result, { createdCount: 1, updatedCount: 0, skippedCount: 1, total: 2 });
  assert.equal((await glossary.listEntries()).length, 1);
});

test('glossary import applies selected languages and category to every row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-category-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: (() => { let index = 0; return () => `import-${++index}`; })() });
  await glossary.createCategory({ id: 'project', label: '專案' });
  const content = 'source,translation\n未分類,Uncategorized\n已有分類,Categorized\n';

  const preview = await glossary.previewImport({ format: 'csv', content, sourceLanguageCode: 'en', targetLanguageCode: 'ja', category: 'project' });
  assert.deepEqual(preview.rows[0].entry, { source: '未分類', sourceLanguageCode: 'en', translations: { ja: 'Uncategorized' }, category: 'project' });
  assert.deepEqual(preview.rows[1].entry, { source: '已有分類', sourceLanguageCode: 'en', translations: { ja: 'Categorized' }, category: 'project' });

  await glossary.importEntries({ format: 'csv', content, sourceLanguageCode: 'en', targetLanguageCode: 'ja', category: 'project', baseRevision: preview.baseRevision });
  assert.deepEqual((await glossary.listEntries()).map((entry) => [entry.sourceLanguageCode, entry.translations, entry.category]), [
    ['en', { ja: 'Uncategorized' }, 'project'],
    ['en', { ja: 'Categorized' }, 'project']
  ]);
});

test('glossary import rejects the complete batch when any row is invalid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-invalid-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => 'import-1' });
  const content = JSON.stringify({ entries: [{ source: 'Good', translation: 'Good' }, { source: 'Bad' }] });
  const preview = await glossary.previewImport({ format: 'json', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });
  assert.equal(preview.summary.invalid, 1);
  await assert.rejects(glossary.importEntries({ format: 'json', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other', baseRevision: preview.baseRevision }), (error) => error.code === 'glossary_import_invalid');
  assert.deepEqual(await glossary.listEntries(), []);
});

test('glossary import can skip invalid rows when selected rows are provided', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-selected-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => 'import-1' });
  const content = JSON.stringify({ entries: [{ source: 'Good', translation: 'Good' }, { source: 'Bad' }] });
  const preview = await glossary.previewImport({ format: 'json', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });

  const result = await glossary.importEntries({
    format: 'json', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other',
    baseRevision: preview.baseRevision, resolutions: {}, selectedRows: [1]
  });

  assert.deepEqual(result, { createdCount: 1, updatedCount: 0, skippedCount: 0, total: 1 });
  assert.deepEqual((await glossary.listEntries()).map((entry) => entry.source), ['Good']);
});

test('glossary import still rejects a selected invalid row atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-selected-invalid-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => 'import-1' });
  const content = JSON.stringify({ entries: [{ source: 'Good', translation: 'Good' }, { source: 'Bad' }] });
  const preview = await glossary.previewImport({ format: 'json', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });

  await assert.rejects(
    glossary.importEntries({ format: 'json', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other', baseRevision: preview.baseRevision, selectedRows: [1, 2] }),
    (error) => error.code === 'glossary_import_invalid' && error.details.some((detail) => detail.rowNumber === 2)
  );
  assert.deepEqual(await glossary.listEntries(), []);
});

test('glossary import requires the documented JSON entries wrapper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-format-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs });

  await assert.rejects(
    glossary.previewImport({ format: 'json', content: JSON.stringify([{ source: 'Term', translation: 'Term' }]), sourceLanguageCode: 'en', targetLanguageCode: 'ja', category: 'other' }),
    (error) => error.code === 'glossary_import_invalid'
  );
});

test('glossary import previews the first XLSX worksheet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-xlsx-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Glossary');
  worksheet.addRows([
    ['表格 1'],
    ['source', 'translation'],
    [],
    ['產品名稱', 'Product name'],
    ['會議室', 'Meeting room'],
    []
  ]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs });

  const preview = await glossary.previewImport({ format: 'xlsx', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'product' });
  assert.deepEqual(preview.rows.map((row) => row.entry), [
    { source: '產品名稱', sourceLanguageCode: 'zh-Hant', translations: { en: 'Product name' }, category: 'product' },
    { source: '會議室', sourceLanguageCode: 'zh-Hant', translations: { en: 'Meeting room' }, category: 'product' }
  ]);
});

test('glossary import finds the header after a worksheet title row', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('工作表 1');
  worksheet.addRows([
    ['表格 1'],
    ['source', 'translation'],
    ['哈囉', 'Hi'],
    ['測試', 'Sadfsdfas']
  ]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  const glossary = createTranslationGlossary({ filePath: 'glossary.json', fileSystem: { async readFile() { return JSON.stringify({ entries: [] }); } } });

  const preview = await glossary.previewImport({ format: 'xlsx', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });
  assert.deepEqual(preview.rows.map(({ rowNumber, entry }) => [rowNumber, entry.source, entry.translations.en]), [
    [3, '哈囉', 'Hi'],
    [4, '測試', 'Sadfsdfas']
  ]);
});

test('glossary import ignores blank XLSX rows but preserves invalid source rows', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Glossary');
  worksheet.addRows([
    ['source', 'translation'],
    [],
    ['只有原文', '']
  ]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  const glossary = createTranslationGlossary({ filePath: 'glossary.json', fileSystem: { async readFile() { return JSON.stringify({ entries: [] }); } } });

  const preview = await glossary.previewImport({ format: 'xlsx', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].rowNumber, 3);
  assert.deepEqual(preview.rows[0].errors.length, 1);
});

test('glossary import does not write blank XLSX rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-glossary-import-blank-rows-'));
  const filePath = join(directory, 'glossary.json');
  const fs = await import('node:fs/promises');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Glossary');
  worksheet.addRows([
    ['source', 'translation'],
    [],
    ['產品名稱', 'Product name'],
    []
  ]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  const glossary = createTranslationGlossary({ filePath, fileSystem: fs, idFactory: () => 'import-1' });
  const preview = await glossary.previewImport({ format: 'xlsx', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' });

  const result = await glossary.importEntries({ format: 'xlsx', content, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other', baseRevision: preview.baseRevision });
  assert.deepEqual(result, { createdCount: 1, updatedCount: 0, skippedCount: 0, total: 1 });
  assert.deepEqual((await glossary.listEntries()).map(({ source, translations }) => ({ source, translations })), [
    { source: '產品名稱', translations: { en: 'Product name' } }
  ]);
});

test('glossary import rejects an invalid XLSX workbook', async () => {
  const glossary = createTranslationGlossary({ filePath: 'glossary.json', fileSystem: { async readFile() { return JSON.stringify({ entries: [] }); } } });

  await assert.rejects(
    glossary.previewImport({ format: 'xlsx', content: Buffer.from('not an xlsx workbook').toString('base64'), sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' }),
    (error) => error.code === 'glossary_import_invalid'
  );
});

function createGlossary(value) {
  return createGlossaryContent(JSON.stringify(value));
}

function createGlossaryContent(content) {
  return createTranslationGlossary({ filePath: 'glossary.json', fileSystem: { async readFile() { return content; } } });
}
