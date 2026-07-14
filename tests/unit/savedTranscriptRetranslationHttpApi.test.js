import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';

test('POST /api/saved-transcripts/:sessionId/translations delegates once and returns HTTP 201', async () => {
  const calls = [];
  const result = translationResult();
  const handler = createHandler({
    translateSavedTranscript(input) {
      calls.push({ input, argumentCount: arguments.length });
      return result;
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/saved-transcripts/session-1/translations',
    body: JSON.stringify({
      sourceLanguageCode: 'en',
      targetLanguageCode: 'zh-TW'
    })
  });

  assert.equal(response.status, 201);
  assert.match(response.headers['Content-Type'], /^application\/json/);
  assert.deepEqual(response.json(), result);
  assert.deepEqual(calls, [
    {
      input: {
        sessionId: 'session-1',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'zh-TW'
      },
      argumentCount: 1
    }
  ]);
});

test('POST /api/saved-transcripts/:sessionId/translations awaits service completion before responding', async () => {
  const deferred = createDeferred();
  const response = responseRecorder();
  const handler = createHandler({
    translateSavedTranscript() {
      return deferred.promise;
    }
  });
  const requestPromise = handler(
    req({
      method: 'POST',
      url: '/api/saved-transcripts/session-1/translations',
      body: JSON.stringify({
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr'
      })
    }),
    response
  );

  await Promise.resolve();

  assert.equal(response.statusCode, null);
  assert.equal(response.body, '');

  deferred.resolve(translationResult({ targetLanguageCode: 'fr' }));
  await requestPromise;

  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).output.targetLanguageCode, 'fr');
});

test('saved transcript re-translation route rejects invalid transport input without calling service', async () => {
  const cases = [
    ['blank sessionId', '/api/saved-transcripts/%20/translations', { sourceLanguageCode: 'en', targetLanguageCode: 'fr' }],
    ['missing body', '/api/saved-transcripts/session-1/translations', undefined],
    ['null body', '/api/saved-transcripts/session-1/translations', null],
    ['array body', '/api/saved-transcripts/session-1/translations', []],
    ['missing sourceLanguageCode', '/api/saved-transcripts/session-1/translations', { targetLanguageCode: 'fr' }],
    ['blank sourceLanguageCode', '/api/saved-transcripts/session-1/translations', { sourceLanguageCode: ' ', targetLanguageCode: 'fr' }],
    ['missing targetLanguageCode', '/api/saved-transcripts/session-1/translations', { sourceLanguageCode: 'en' }],
    ['blank targetLanguageCode', '/api/saved-transcripts/session-1/translations', { sourceLanguageCode: 'en', targetLanguageCode: ' ' }]
  ];

  for (const [name, url, body] of cases) {
    const calls = [];
    const handler = createHandler({
      translateSavedTranscript(input) {
        calls.push(input);
        return translationResult();
      }
    });
    const response = await request(handler, {
      method: 'POST',
      url,
      body: body === undefined ? '' : JSON.stringify(body)
    });

    assert.equal(response.status, 400, name);
    assert.equal(response.json().error.code, 'invalid_request', name);
    assert.deepEqual(calls, [], name);
  }
});

test('malformed JSON on saved transcript re-translation route returns existing invalid_json response', async () => {
  const calls = [];
  const handler = createHandler({
    translateSavedTranscript(input) {
      calls.push(input);
      return translationResult();
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/saved-transcripts/session-1/translations',
    body: '{"sourceLanguageCode":'
  });

  assert.equal(response.status, 400);
  assert.equal(response.json().error.code, 'invalid_json');
  assert.deepEqual(calls, []);
});

test('saved transcript re-translation route returns HTTP 503 when optional capability is unavailable', async () => {
  const dependencies = createApplicationDependencies({
    requestHandlerFactory: createRequestHandler
  });

  const response = await request(dependencies.requestHandler, {
    method: 'POST',
    url: '/api/saved-transcripts/session-1/translations',
    body: JSON.stringify({
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    })
  });

  assert.equal(Object.hasOwn(dependencies, 'savedTranscriptRetranslationService'), false);
  assert.equal(Object.hasOwn(dependencies, 'savedTranscriptRetranslationController'), false);
  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, 'saved_transcript_retranslation_unavailable');
});

test('saved transcript not-found application failure maps to HTTP 404', async () => {
  const handler = createHandler({
    translateSavedTranscript() {
      throw new Error('Session record not found: missing-session');
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/saved-transcripts/missing-session/translations',
    body: JSON.stringify({
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    })
  });

  assert.equal(response.status, 404);
  assert.equal(response.json().error.code, 'session_not_found');
});

test('unexpected synchronous service failures map to HTTP 500 without retry or detail leakage', async () => {
  let calls = 0;
  const handler = createHandler({
    translateSavedTranscript() {
      calls += 1;
      throw new Error('provider secret failure detail');
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/saved-transcripts/session-1/translations',
    body: JSON.stringify({
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    })
  });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal_error');
  assert.equal(body.error.message, 'Unexpected server error.');
  assert.equal(JSON.stringify(body).includes('provider secret failure detail'), false);
  assert.equal(calls, 1);
});

test('unexpected rejected service failures map to HTTP 500 without retry or detail leakage', async () => {
  let calls = 0;
  const handler = createHandler({
    translateSavedTranscript() {
      calls += 1;
      return Promise.reject(new Error('repository secret failure detail'));
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/saved-transcripts/session-1/translations',
    body: JSON.stringify({
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    })
  });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal_error');
  assert.equal(body.error.message, 'Unexpected server error.');
  assert.equal(JSON.stringify(body).includes('repository secret failure detail'), false);
  assert.equal(calls, 1);
});

test('saved transcript re-translation input preserves caller body and forwards only validated fields', async () => {
  const calls = [];
  const originalBody = {
    sourceLanguageCode: 'EN-us',
    targetLanguageCode: 'zh-TW',
    extra: 'not forwarded'
  };
  const before = structuredClone(originalBody);
  const handler = createHandler({
    translateSavedTranscript(input) {
      calls.push(input);
      return translationResult({ targetLanguageCode: input.targetLanguageCode });
    }
  });

  const response = await request(handler, {
    method: 'POST',
    url: '/api/saved-transcripts/session-1/translations',
    body: JSON.stringify(originalBody)
  });

  assert.equal(response.status, 201);
  assert.deepEqual(originalBody, before);
  assert.deepEqual(calls, [
    {
      sessionId: 'session-1',
      sourceLanguageCode: 'EN-us',
      targetLanguageCode: 'zh-TW'
    }
  ]);
});

function createHandler(serviceOverrides = {}) {
  return createRequestHandler({
    sessionReadController: sessionReadController(),
    translationCommandController: translationCommandController(),
    savedTranscriptRetranslationController: {
      translateSavedTranscript:
        serviceOverrides.translateSavedTranscript ||
        function translateSavedTranscript() {
          return translationResult();
        }
    }
  });
}

function sessionReadController() {
  return {
    listSessions() {
      return [];
    },
    getSession() {
      return null;
    }
  };
}

function translationCommandController() {
  return {
    createTranslationRequest(input) {
      return input;
    },
    createTranslationExecution(input) {
      return input;
    },
    updateTranslationExecution(input) {
      return input;
    },
    createTranslationOutput(input) {
      return input;
    }
  };
}

async function request(handler, { method = 'POST', url = '/api/saved-transcripts/session-1/translations', body = '', headers = {} } = {}) {
  const response = responseRecorder();

  await handler(req({ method, url, body, headers }), response);

  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body || '{}')
  };
}

function req({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const request = Readable.from(body ? [body] : []);
  request.method = method;
  request.url = url;
  request.headers = headers;
  request.socket = { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' };
  return request;
}

function responseRecorder() {
  return {
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
}

function translationResult(overrides = {}) {
  const targetLanguageCode = overrides.targetLanguageCode || 'zh-TW';

  return {
    request: {
      id: 'request-1',
      sessionId: 'session-1',
      sourceTranscriptRevisionId: 'source-revision:session-1:final',
      sourceTranscriptSnapshot: { revisionId: 'source-revision:session-1:final', items: [] },
      targetLanguageCode,
      createdAt: 1000
    },
    execution: {
      id: 'execution-1',
      translationRequestId: 'request-1',
      status: 'completed',
      startedAt: 1001,
      completedAt: 1002,
      failureInfo: null
    },
    output: {
      id: 'output-1',
      executionId: 'execution-1',
      sequence: 0,
      translatedText: 'Bonjour',
      targetLanguageCode,
      providerMetadata: null,
      providerMetadataAvailable: false,
      createdAt: 1003
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}
