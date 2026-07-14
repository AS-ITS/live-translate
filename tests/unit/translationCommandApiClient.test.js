import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandApiClient } from '../../src/lib/translationCommandApiClient.js';

const CLIENT_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

test('factory accepts a valid fetchImpl', () => {
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      return jsonResponse({});
    }
  });

  assert.equal(typeof client.createTranslationRequest, 'function');
});

test('factory throws TypeError for missing or invalid fetchImpl', () => {
  assert.throws(() => createTranslationCommandApiClient({ fetchImpl: null }), TypeError);
  assert.throws(() => createTranslationCommandApiClient({ fetchImpl: 'fetch' }), TypeError);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  try {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: undefined
    });

    assert.throws(() => createTranslationCommandApiClient(), TypeError);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'fetch', descriptor);
    }
  }
});

test('factory returns a frozen client with exactly four public methods', () => {
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      return jsonResponse({});
    }
  });

  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Object.keys(client), CLIENT_METHODS);

  for (const method of CLIENT_METHODS) {
    assert.equal(typeof client[method], 'function');
  }

  assert.throws(() => {
    client.extraMethod = () => null;
  }, TypeError);
});

test('createTranslationRequest posts JSON to the request endpoint and returns response JSON', async () => {
  const calls = [];
  const command = {
    id: 'request-1',
    sessionId: 'session-1',
    targetLanguageCode: 'ja',
    nested: { sourceTranscriptRevisionId: 'revision-1' }
  };
  const before = JSON.stringify(command);
  const responseBody = { id: 'request-1', status: 'pending' };
  const client = createTranslationCommandApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(responseBody, { status: 201 });
    }
  });

  const result = await client.createTranslationRequest(command);

  assert.strictEqual(result, responseBody);
  assert.deepEqual(calls, [
    {
      url: '/api/translation-requests',
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: before
      }
    }
  ]);
  assert.equal(JSON.stringify(command), before);
});

test('createTranslationExecution posts JSON to the execution endpoint and returns response JSON', async () => {
  const calls = [];
  const responseBody = { id: 'execution-1', status: 'pending' };
  const client = createTranslationCommandApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(responseBody, { status: 201 });
    }
  });

  const result = await client.createTranslationExecution({ id: 'execution-1', translationRequestId: 'request-1' });

  assert.strictEqual(result, responseBody);
  assert.equal(calls[0].url, '/api/translation-executions');
  assert.equal(calls[0].options.method, 'POST');
});

test('updateTranslationExecution URL-encodes execution ID and patches the command body unchanged', async () => {
  const calls = [];
  const command = {
    status: 'running',
    nested: { provider: 'gemini' }
  };
  const before = JSON.stringify(command);
  const responseBody = { id: 'execution/日本語', status: 'running' };
  const client = createTranslationCommandApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(responseBody);
    }
  });

  const result = await client.updateTranslationExecution('execution/日本語', command);

  assert.strictEqual(result, responseBody);
  assert.deepEqual(calls, [
    {
      url: '/api/translation-executions/execution%2F%E6%97%A5%E6%9C%AC%E8%AA%9E',
      options: {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: before
      }
    }
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), command);
  assert.equal(Object.hasOwn(JSON.parse(calls[0].options.body), 'executionId'), false);
  assert.equal(JSON.stringify(command), before);
});

test('updateTranslationExecution rejects invalid execution IDs before fetch', async () => {
  let calls = 0;
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      calls += 1;
      return jsonResponse({});
    }
  });

  await assert.rejects(client.updateTranslationExecution('', { status: 'running' }), TypeError);
  await assert.rejects(client.updateTranslationExecution('   ', { status: 'running' }), TypeError);
  await assert.rejects(client.updateTranslationExecution(null, { status: 'running' }), TypeError);
  assert.equal(calls, 0);
});

test('createTranslationOutput posts JSON to the output endpoint and returns response JSON', async () => {
  const calls = [];
  const responseBody = { id: 'output-1', created: true };
  const client = createTranslationCommandApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(responseBody, { status: 201 });
    }
  });

  const result = await client.createTranslationOutput({ id: 'output-1', translationRequestId: 'request-1' });

  assert.strictEqual(result, responseBody);
  assert.equal(calls[0].url, '/api/translation-outputs');
  assert.equal(calls[0].options.method, 'POST');
});

test('non-2xx JSON responses reject with status and body', async () => {
  const body = { error: { code: 'invalid_command' } };
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      return jsonResponse(body, { status: 400 });
    }
  });

  await assert.rejects(
    client.createTranslationRequest({ id: 'request-1' }),
    (error) => error.status === 400 && error.body === body
  );
});

test('404 and 500 responses reject', async () => {
  const notFoundClient = createTranslationCommandApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'not_found' } }, { status: 404 });
    }
  });
  const serverErrorClient = createTranslationCommandApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'internal_error' } }, { status: 500 });
    }
  });

  await assert.rejects(notFoundClient.updateTranslationExecution('execution-1', { status: 'running' }), /HTTP 404/);
  await assert.rejects(serverErrorClient.createTranslationOutput({ id: 'output-1' }), /HTTP 500/);
});

test('non-2xx invalid JSON responses still reject with status', async () => {
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      return invalidJsonResponse({ status: 500 });
    }
  });

  await assert.rejects(
    client.createTranslationExecution({ id: 'execution-1' }),
    (error) => error.status === 500 && !Object.hasOwn(error, 'body')
  );
});

test('successful invalid JSON response rejects', async () => {
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      return invalidJsonResponse({ status: 201 });
    }
  });

  await assert.rejects(client.createTranslationRequest({ id: 'request-1' }), SyntaxError);
});

test('fetch rejection propagates', async () => {
  const failure = new Error('network failed');
  const client = createTranslationCommandApiClient({
    fetchImpl() {
      return Promise.reject(failure);
    }
  });

  await assert.rejects(client.createTranslationOutput({ id: 'output-1' }), (error) => error === failure);
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function invalidJsonResponse({ status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new SyntaxError('invalid json');
    }
  };
}
