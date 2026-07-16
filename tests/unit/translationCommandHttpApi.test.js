import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

const REQUIRED_CONTROLLER_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

test('request handler throws TypeError when translationCommandController is explicitly missing', () => {
  assert.throws(
    () =>
      createRequestHandler({
        sessionReadController: sessionReadController(),
        translationCommandController: undefined
      }),
    TypeError
  );
});

test('request handler throws TypeError when any required controller method is missing', () => {
  for (const missingMethod of REQUIRED_CONTROLLER_METHODS) {
    const controller = translationCommandController();
    delete controller[missingMethod];

    assert.throws(
      () =>
        createRequestHandler({
          sessionReadController: sessionReadController(),
          translationCommandController: controller
        }),
      new RegExp(`translationCommandController\\.${missingMethod}`)
    );
  }
});

test('request handler accepts a valid translation command controller', () => {
  assert.equal(
    typeof createRequestHandler({
      sessionReadController: sessionReadController(),
      translationCommandController: translationCommandController()
    }),
    'function'
  );
});

test('POST /api/translation-requests delegates body once and returns HTTP 201 with controller result', async () => {
  const calls = [];
  const result = { id: 'request-1', stored: true };
  const body = { id: 'request-1', targetLanguageCode: 'ja' };
  const handler = createHandler({
    createTranslationRequest(input) {
      calls.push(['createTranslationRequest', input]);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-requests',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 201);
  assert.match(response.headers['Content-Type'], /^application\/json/);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [['createTranslationRequest', body]]);
});

test('POST /api/translation-executions delegates once and returns HTTP 201 with controller result', async () => {
  const calls = [];
  const result = { id: 'execution-1', status: 'pending' };
  const body = { id: 'execution-1', translationRequestId: 'request-1' };
  const handler = createHandler({
    createTranslationExecution(input) {
      calls.push(['createTranslationExecution', input]);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-executions',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [['createTranslationExecution', body]]);
});

test('POST /api/translation-executions forwards explicit providerKey unchanged', async () => {
  const calls = [];
  const result = { id: 'execution-1', status: 'pending' };
  const body = {
    executionId: 'execution-1',
    requestId: 'request-1',
    providerKey: 'gemini'
  };
  const handler = createHandler({
    createTranslationExecution(input) {
      calls.push(input);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-executions',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [body]);
  assert.equal(calls[0].providerKey, 'gemini');
});

test('POST /api/translation-executions preserves omitted providerKey as undefined', async () => {
  const calls = [];
  const result = { id: 'execution-1', status: 'pending' };
  const body = {
    executionId: 'execution-1',
    requestId: 'request-1'
  };
  const handler = createHandler({
    createTranslationExecution(input) {
      calls.push(input);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-executions',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [body]);
  assert.equal(calls[0].providerKey, undefined);
  assert.equal(Object.hasOwn(calls[0], 'providerKey'), false);
});

test('POST /api/translation-executions does not validate providerKey at HTTP boundary', async () => {
  const calls = [];
  const result = { id: 'execution-1', status: 'pending' };
  const body = {
    executionId: 'execution-1',
    requestId: 'request-1',
    providerKey: 123
  };
  const handler = createHandler({
    createTranslationExecution(input) {
      calls.push(input);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-executions',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [body]);
  assert.equal(calls[0].providerKey, 123);
});

test('PATCH /api/translation-executions/:executionId URL-decodes and overrides body execution identifiers', async () => {
  const calls = [];
  const result = { id: 'execution/one', status: 'running' };
  const body = { id: 'body-id', executionId: 'body-execution-id', transition: 'start', startedAt: 1100 };
  const handler = createHandler({
    updateTranslationExecution(input) {
      calls.push(['updateTranslationExecution', input]);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'PATCH',
    url: '/api/translation-executions/execution%2Fone',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [
    [
      'updateTranslationExecution',
      {
        id: 'execution/one',
        executionId: 'execution/one',
        transition: 'start',
        startedAt: 1100
      }
    ]
  ]);
});

test('POST /api/translation-outputs delegates once and returns HTTP 201 with controller result', async () => {
  const calls = [];
  const result = { id: 'output-1', created: true };
  const body = { id: 'output-1', executionId: 'execution-1', translatedText: 'Bonjour' };
  const handler = createHandler({
    createTranslationOutput(input) {
      calls.push(['createTranslationOutput', input]);
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-outputs',
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [['createTranslationOutput', body]]);
});

test('translation command routes preserve synchronous and Promise-based controller results', async () => {
  const asyncResult = { id: 'async-output' };
  const handler = createHandler({
    createTranslationRequest() {
      return { id: 'sync-request' };
    },
    createTranslationOutput() {
      return Promise.resolve(asyncResult);
    }
  });

  const syncResponse = await request(handler, {
    method: 'POST',
    url: '/api/translation-requests',
    body: JSON.stringify({ id: 'request-1' })
  });
  const asyncResponse = await request(handler, {
    method: 'POST',
    url: '/api/translation-outputs',
    body: JSON.stringify({ id: 'output-1' })
  });

  assert.equal(syncResponse.status, 201);
  assert.deepEqual(syncResponse.json(), { id: 'sync-request' });
  assert.equal(asyncResponse.status, 201);
  assert.deepEqual(asyncResponse.json(), asyncResult);
});

test('malformed JSON on translation command routes returns existing invalid_json response', async () => {
  const calls = [];
  const handler = createHandler({
    createTranslationRequest(input) {
      calls.push(input);
      return { id: 'request-1' };
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-requests',
    body: '{"id":'
  });
  const body = response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_json');
  assert.equal(body.error.message, 'Request body must be valid JSON.');
  assert.deepEqual(calls, []);
});

test('synchronous controller errors follow existing internal error handling', async () => {
  const handler = createHandler({
    createTranslationExecution() {
      throw new Error('domain failed');
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-executions',
    body: JSON.stringify({ id: 'execution-1' })
  });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal_error');
});

test('Promise controller rejections follow existing internal error handling', async () => {
  const handler = createHandler({
    createTranslationOutput() {
      return Promise.reject(new Error('repository failed'));
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/translation-outputs',
    body: JSON.stringify({ id: 'output-1' })
  });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal_error');
});

test('unrelated health and session read routes remain unaffected without translation controller', async () => {
  const history = [{ id: 'session-1' }];
  const handler = createRequestHandler({
    sessionReadController: sessionReadController({
      listSessions() {
        return history;
      }
    })
  });

  const healthResponse = await request(handler, { method: 'GET', url: '/healthz' });
  const sessionsResponse = await request(handler, { method: 'GET', url: '/api/sessions' });

  assert.equal(healthResponse.status, 200);
  assert.deepEqual(healthResponse.json().ok, true);
  assert.equal(sessionsResponse.status, 200);
  assert.deepEqual(sessionsResponse.json(), history);
});

function createHandler(controllerOverrides = {}) {
  return createRequestHandler({
    sessionReadController: sessionReadController(),
    translationCommandController: translationCommandController(controllerOverrides)
  });
}

function translationCommandController(overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      function createTranslationRequest(input) {
        return input;
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      function createTranslationExecution(input) {
        return input;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      function updateTranslationExecution(input) {
        return input;
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      function createTranslationOutput(input) {
        return input;
      }
  };
}

function sessionReadController(overrides = {}) {
  return {
    listSessions:
      overrides.listSessions ||
      function listSessions() {
        return [];
      },
    getSession:
      overrides.getSession ||
      function getSession() {
        return null;
      }
  };
}

async function request(handler, { method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' };

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, nextHeaders) {
      this.statusCode = statusCode;
      this.headers = nextHeaders;
    },
    end(nextBody = '') {
      this.body = nextBody;
    }
  };

  await handler(req, response);

  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body || '{}')
  };
}
