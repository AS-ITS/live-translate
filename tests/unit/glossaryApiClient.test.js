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
  const client = createGlossaryApiClient({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(client.listEntries(), /HTTP 503/);

  const malformed = createGlossaryApiClient({ fetchImpl: async () => ok({ entries: {} }) });
  await assert.rejects(malformed.listEntries(), /entries array/);
});

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}
