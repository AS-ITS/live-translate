import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
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
