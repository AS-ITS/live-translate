import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlossaryApiClient } from '../../src/lib/glossaryApiClient.js';

test('glossary API client lists, creates, updates, and deletes entries', async () => {
  const calls = [];
  const client = createGlossaryApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') return ok({ entries: [{ id: 'entry-1', source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'history' }] });
      if (options.method === 'DELETE') return ok({ entry: { id: 'entry-1', source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'history' } });
      return ok({ entry: { id: 'entry-1', ...JSON.parse(options.body) } });
    }
  });

  assert.deepEqual(await client.listEntries(), [{ id: 'entry-1', source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'history' }]);
  assert.equal((await client.createEntry({ source: 'OpenAI', translations: { ja: 'OpenAI' }, scope: 'live' })).scope, 'live');
  assert.equal((await client.updateEntry('entry 1', { source: 'Codex', translations: { ja: 'コードエックス' }, scope: 'both' })).scope, 'both');
  assert.equal((await client.deleteEntry('entry 1')).entry.id, 'entry-1');

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/glossary', 'GET'],
    ['/api/glossary/entries', 'POST'],
    ['/api/glossary/entries/entry%201', 'PUT'],
    ['/api/glossary/entries/entry%201', 'DELETE']
  ]);
});

test('glossary API client rejects malformed responses and failed requests', async () => {
  const client = createGlossaryApiClient({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'glossary_not_configured', message: '字典未設定。' } }) }) });
  await assert.rejects(client.listEntries(), (error) => error.status === 503 && error.code === 'glossary_not_configured' && error.message === '字典未設定。');

  const malformed = createGlossaryApiClient({ fetchImpl: async () => ok({ entries: {} }) });
  await assert.rejects(malformed.listEntries(), /entries array/);
});

test('glossary API client gives an actionable message when import routes are unavailable', async () => {
  const client = createGlossaryApiClient({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: 'Route not found.' } }) }) });

  await assert.rejects(
    client.previewImport({ format: 'xlsx', content: 'base64-workbook', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', category: 'other' }),
    (error) => error.status === 404 && error.message.includes('重新啟動後端服務')
  );
});

test('glossary API client preserves import validation details', async () => {
  const client = createGlossaryApiClient({ fetchImpl: async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { code: 'glossary_import_invalid', message: 'Glossary import contains invalid data.', details: [{ rowNumber: 3, errors: ['translation is required'] }] } })
  }) });

  await assert.rejects(client.previewImport({}), (error) => error.details?.[0]?.rowNumber === 3);
});

test('glossary API client manages categories with the expected methods and payloads', async () => {
  const calls = [];
  const client = createGlossaryApiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return ok({ categories: [{ id: 'other', label: '其他' }] });
    if (options.method === 'DELETE') return ok({ category: { id: 'project' }, reassignedEntryCount: 1 });
    if (url.endsWith('/order')) return ok({ categories: [{ id: 'other', label: '其他' }] });
    return ok({ category: { id: 'project', label: JSON.parse(options.body).label } });
  }});
  assert.deepEqual(await client.listCategories(), [{ id: 'other', label: '其他' }]);
  assert.equal((await client.createCategory({ label: '專案' })).id, 'project');
  assert.equal((await client.updateCategory('project', { label: '專案詞彙' })).label, '專案詞彙');
  assert.equal((await client.reorderCategories(['project', 'other'])).length, 1);
  assert.equal((await client.deleteCategory('project')).reassignedEntryCount, 1);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['/api/glossary/categories', 'GET'],
    ['/api/glossary/categories', 'POST'],
    ['/api/glossary/categories/project', 'PUT'],
    ['/api/glossary/categories/order', 'PUT'],
    ['/api/glossary/categories/project', 'DELETE']
  ]);
});

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}
