import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRetranslationApiClient } from '../../src/lib/sessionRetranslationApiClient.js';

test('session retranslation client sends only its command body to the session route', async () => {
  const calls = [];
  const client = createSessionRetranslationApiClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return { status: 202, json: async () => ({ execution: { status: 'queued' } }) }; } });
  await client.submit('session 1', { targetLanguageCode: 'ja' });
  assert.equal(calls[0].url, '/api/sessions/session%201/retranslations');
  assert.equal(calls[0].options.body, '{"targetLanguageCode":"ja"}');
});

test('session retranslation client lists safe provider options', async () => {
  const client = createSessionRetranslationApiClient({
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/translation-providers');
      assert.deepEqual(options, { method: 'GET', headers: {} });
      return { status: 200, json: async () => ({ providers: [{ key: 'gemini', label: 'Gemini' }] }) };
    }
  });

  assert.deepEqual(await client.listProviders(), [{ key: 'gemini', label: 'Gemini' }]);
});
