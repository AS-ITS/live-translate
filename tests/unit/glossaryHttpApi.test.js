import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createRequestHandler } from '../../server/index.js';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';

test('production glossary composition generates IDs accepted by the glossary store', () => {
  let glossaryFactoryOptions;
  createProductionApplicationDependencies({
    env: {},
    translationExecutionProvider: { execute() {} },
    resolveSavedTranscriptTranslationProvider() { return { translate() {} }; },
    savedTranscriptRetranslationServiceFactory() { return { translateSavedTranscript() {} }; },
    translationGlossaryFactory(options) {
      glossaryFactoryOptions = options;
      return {
        listEntries() { return []; }, listCategories() { return []; },
        createCategory() {}, updateCategory() {}, reorderCategories() {}, deleteCategory() {},
        createEntry() {}, updateEntry() {}, deleteEntry() {}
      };
    }
  });

  assert.match(glossaryFactoryOptions.idFactory(), /^glossary-[0-9a-f-]{36}$/);
});

test('glossary HTTP routes list, create, update, and delete entries', async () => {
  const calls = [];
  const handler = createRequestHandler({
    glossaryController: {
      async listEntries() {
        calls.push(['listEntries']);
        return [{ id: 'entry-1', source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'history' }];
      },
      async createEntry(input) {
        calls.push(['createEntry', input]);
        return { id: 'entry-2', ...input };
      },
      async updateEntry(input) {
        calls.push(['updateEntry', input]);
        return input;
      },
      async deleteEntry(input) {
        calls.push(['deleteEntry', input]);
        return { id: input.id, source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'history' };
      }
    }
  });

  assert.equal((await request(handler, { method: 'GET', url: '/api/glossary' })).statusCode, 200);
  assert.equal((await request(handler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: { source: 'microphone', translations: { en: 'Alan speak' }, scope: 'live' }
  })).statusCode, 201);
  assert.equal((await request(handler, { method: 'PUT', url: '/api/glossary/entries/entry-1', body: { source: 'Codex', translations: { ja: 'コードエックス' } } })).statusCode, 200);
  assert.equal((await request(handler, { method: 'DELETE', url: '/api/glossary/entries/entry-1' })).statusCode, 200);

  assert.deepEqual(calls, [
    ['listEntries'],
    ['createEntry', { source: 'microphone', sourceLanguageCode: 'zh-Hant', translations: { en: 'Alan speak' }, scope: 'live', category: 'other', tags: [], enabled: true, notes: '' }],
    ['updateEntry', { id: 'entry-1', source: 'Codex', sourceLanguageCode: 'zh-Hant', translations: { ja: 'コードエックス' }, scope: 'history', category: 'other', tags: [], enabled: true, notes: '' }],
    ['deleteEntry', { id: 'entry-1' }]
  ]);
});

test('glossary HTTP import routes accept XLSX payloads with import settings', async () => {
  const calls = [];
  const handler = createRequestHandler({
    glossaryController: {
      async previewImport(input) { calls.push(['previewImport', input]); return { rows: [], summary: {} }; },
      async importEntries(input) { calls.push(['importEntries', input]); return { createdCount: 0, updatedCount: 0, skippedCount: 0, total: 0 }; }
    }
  });
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Glossary');
  worksheet.addRows([['source', 'translation'], ['產品名稱', 'Product name']]);
  const importSettings = { format: 'xlsx', content: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'), sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'product' };

  assert.equal((await request(handler, { method: 'POST', url: '/api/glossary/import/preview', body: importSettings })).statusCode, 200);
  assert.equal((await request(handler, { method: 'POST', url: '/api/glossary/import', body: { ...importSettings, baseRevision: 'revision-1', resolutions: {}, selectedRows: [2] } })).statusCode, 200);
  assert.deepEqual(calls, [
    ['previewImport', importSettings],
    ['importEntries', { ...importSettings, baseRevision: 'revision-1', resolutions: {}, selectedRows: [2] }]
  ]);
});

test('meeting glossary preview route accepts private entries without committing them', async () => {
  const calls = [];
  const handler = createRequestHandler({
    glossaryController: {
      async previewPrivateImport(input) { calls.push(input); return { rows: [], summary: { total: 0 } }; }
    }
  });
  const body = {
    format: 'csv',
    content: 'source,translation\nTerm,Translation',
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    existingEntries: [{ source: 'Existing', translations: { en: 'Existing' } }]
  };
  const response = await request(handler, { method: 'POST', url: '/api/meetings/glossary/import/preview', body });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [body]);
});

test('glossary HTTP import route returns validation details', async () => {
  const validationError = new Error('Import contains invalid rows.');
  validationError.code = 'glossary_import_invalid';
  validationError.details = [{ rowNumber: 3, errors: ['Translation glossary entry 2.translations must not be empty.'] }];
  const handler = createRequestHandler({ glossaryController: { async previewImport() { throw validationError; } } });

  const response = await request(handler, { method: 'POST', url: '/api/glossary/import/preview', body: { format: 'xlsx', content: 'base64-workbook', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body.error.details, validationError.details);
});

test('glossary HTTP routes still accept legacy replacement aliases', async () => {
  const calls = [];
  const handler = createRequestHandler({
    glossaryController: {
      async listEntries() { return []; },
      async createEntry(input) {
        calls.push(input);
        return { id: 'entry-1', ...input };
      },
      async updateEntry() { return {}; },
      async deleteEntry() { return {}; }
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: { source: 'microphone', translations: { en: 'Alan speak' }, replacementAliases: { en: ['mic'] }, scope: 'live' }
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls, [
    { source: 'microphone', sourceLanguageCode: 'zh-Hant', translations: { en: 'Alan speak' }, replacementAliases: { en: ['mic'] }, scope: 'live', category: 'other', tags: [], enabled: true, notes: '' }
  ]);
});

test('glossary HTTP category routes accept label and categoryIds contracts', async () => {
  const calls = [];
  const handler = createRequestHandler({
    glossaryController: {
      async listCategories() { return [{ id: 'other', label: '其他' }, { id: 'glossary-project', label: '專案' }]; },
      async createCategory(input) { calls.push(['createCategory', input]); return { id: 'glossary-new', ...input }; },
      async reorderCategories(categoryIds) { calls.push(['reorderCategories', categoryIds]); return categoryIds.map((id) => ({ id, label: id })); }
    }
  });

  const created = await request(handler, {
    method: 'POST',
    url: '/api/glossary/categories',
    body: { label: '新分類' }
  });
  const reordered = await request(handler, {
    method: 'PUT',
    url: '/api/glossary/categories/order',
    body: { categoryIds: ['glossary-project', 'other'] }
  });

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.category, { id: 'glossary-new', label: '新分類', system: false });
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(reordered.body.categories.map((category) => category.id), ['glossary-project', 'other']);
  assert.deepEqual(calls, [
    ['createCategory', { label: '新分類', system: false }],
    ['reorderCategories', ['glossary-project', 'other']]
  ]);
});

test('glossary entry routes accept a custom category ID', async () => {
  let received;
  const handler = createRequestHandler({
    glossaryController: {
      async createEntry(input) { received = input; return { id: 'entry-1', ...input }; }
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: { source: 'Codex', translations: { en: 'Codex' }, category: 'glossary-project' }
  });

  assert.equal(response.statusCode, 201);
  assert.equal(received.category, 'glossary-project');
});

test('glossary entry routes accept a cloud category UUID', async () => {
  let received;
  const handler = createRequestHandler({
    glossaryController: {
      async createEntry(input) { received = input; return { id: 'entry-1', ...input }; }
    }
  });
  const category = '6342fd3a-859d-4307-816a-d2df220f736d';

  const response = await request(handler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: { source: 'cvvvc', translations: { en: 'fder' }, category }
  });

  assert.equal(response.statusCode, 201);
  assert.equal(received.category, category);
});

test('glossary HTTP routes reject invalid replacement aliases', async () => {
  const handler = createRequestHandler({
    glossaryController: {
      async listEntries() { return []; },
      async createEntry() { return {}; },
      async updateEntry() { return {}; },
      async deleteEntry() { return {}; }
    }
  });

  for (const body of [
    { source: 'OpenAI', translations: { ja: 'OpenAI' }, replacementAliases: [] },
    { source: 'OpenAI', translations: { ja: 'OpenAI' }, replacementAliases: { ja: 'open ai' } },
    { source: 'OpenAI', translations: { ja: 'OpenAI' }, replacementAliases: { ja: [' '] } }
  ]) {
    const response = await request(handler, { method: 'POST', url: '/api/glossary/entries', body });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'invalid_request');
  }

  const unsupported = await request(handler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: { source: 'OpenAI', translations: { ja: 'OpenAI' }, replacementAliases: { xx: ['open ai'] } }
  });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.body.error.code, 'unsupported_language');
});

test('glossary HTTP routes reject invalid scope', async () => {
  const handler = createRequestHandler({
    glossaryController: {
      async listEntries() { return []; },
      async createEntry() { return {}; },
      async updateEntry() { return {}; },
      async deleteEntry() { return {}; }
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: { source: 'OpenAI', translations: { ja: 'OpenAI' }, scope: 'archive' }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, 'invalid_request');
});

test('glossary HTTP routes return 503 when glossary is not configured', async () => {
  const handler = createRequestHandler();
  const response = await request(handler, { method: 'GET', url: '/api/glossary' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'glossary_not_configured');
});

async function request(handler, { method = 'GET', url = '/api/glossary', body, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  req[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined) yield JSON.stringify(body);
  };

  const chunks = [];
  const res = {
    statusCode: 0,
    writeHead(statusCode, responseHeaders) {
      this.statusCode = statusCode;
      this.headers = responseHeaders;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await handler(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return { statusCode: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null };
}
