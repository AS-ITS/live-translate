import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

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
