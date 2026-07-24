import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createSessionReadController } from '../../server/sessionReadController.js';

test('GET /api/sessions calls listSessionHistory exactly once', async () => {
  let listCalls = 0;
  const handler = createHandler({
    listSessionHistory() {
      listCalls += 1;
      return [];
    }
  });

  await request(handler, { method: 'GET', url: '/api/sessions' });

  assert.equal(listCalls, 1);
});

test('GET /api/sessions returns the service result unchanged as JSON', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const handler = createHandler({
    listSessionHistory() {
      return history;
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), history);
});

test('GET /api/sessions/:sessionId passes the exact sessionId to getSessionDetail', async () => {
  const calls = [];
  const handler = createHandler({
    getSessionDetail(sessionId) {
      calls.push(sessionId);
      return detailDTO({ id: sessionId });
    }
  });

  await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.deepEqual(calls, ['session-1']);
});

test('GET /api/sessions/:sessionId returns HTTP 200 with the DTO unchanged as JSON', async () => {
  const detail = detailDTO({ id: 'session-1' });
  const handler = createHandler({
    getSessionDetail() {
      return detail;
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), detail);
});

test('GET /api/sessions/:sessionId returns HTTP 404 when service returns null', async () => {
  const handler = createHandler({
    getSessionDetail() {
      return null;
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/missing' });
  const body = response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'session_not_found');
});

test('GET /api/sessions/:sessionId does not expose completed formal retranslation outputs on the original session', async () => {
  const liveOutput = formalOutput({ id: 'live-output:session-1:ja', targetLanguageCode: 'ja', translatedText: 'Live article', version: 1 });
  const retranslationOutput = formalOutput({ id: 'output-fr-1', executionId: 'execution-fr-1', requestId: 'request-fr-1', targetLanguageCode: 'fr', translatedText: 'Bonjour terminé', version: 1 });
  const handler = createHandler({
    getSessionDetail() {
      return detailDTO({ id: 'session-1' });
    },
    translationHistory: {
      outputs: [liveOutput, retranslationOutput],
      executions: []
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.translationHistory.outputs, []);
});

test('GET /api/sessions/:sessionId keeps live output as the primary article read model', async () => {
  const liveOutput = formalOutput({ id: 'live-output:session-1:ja', targetLanguageCode: 'ja', translatedText: 'Live article', version: 1 });
  const retranslationOutput = formalOutput({ id: 'output-fr-1', targetLanguageCode: 'fr', translatedText: 'Bonjour terminé', version: 1 });
  const handler = createHandler({
    getSessionDetail() {
      return detailDTO({ id: 'session-1' });
    },
    translationHistory: {
      outputs: [retranslationOutput, liveOutput],
      executions: []
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.readingContent.translationArticle.text, 'Live article');
  assert.equal(body.selectedTranslationOutput.id, 'live-output:session-1:ja');
  assert.deepEqual(body.translationHistory.outputs, []);
});

test('GET /api/sessions/:sessionId falls back to legacy translation outputs only when no formal retranslation outputs exist', async () => {
  const handler = createHandler({
    getSessionDetail() {
      return detailDTO({
        id: 'session-1',
        translationOutputs: [{
          id: 'legacy-output-1',
          targetLanguageCode: 'ja',
          items: [{ text: 'Legacy line one' }, { text: 'Legacy line two' }],
          completedAt: '2026-07-21T00:00:00.000Z'
        }]
      });
    },
    translationHistory: {
      outputs: [formalOutput({ id: 'live-output:session-1:ja', targetLanguageCode: 'ja', translatedText: 'Live article', version: 1 })],
      executions: []
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.translationHistory.outputs, [{
    id: 'legacy-output-1',
    targetLanguageCode: 'ja',
    version: null,
    source: 'legacy',
    translatedText: 'Legacy line one\nLegacy line two',
    completedAt: '2026-07-21T00:00:00.000Z'
  }]);
});

test('unexpected service errors are not converted into HTTP 404', async () => {
  const handler = createHandler({
    getSessionDetail() {
      throw new Error('storage unavailable');
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal_error');
});

test('missing sessionQueryService throws TypeError', () => {
  assert.throws(() => createSessionReadController(), TypeError);
});

test('missing listSessionHistory throws TypeError', () => {
  assert.throws(
    () =>
      createSessionReadController({
        sessionQueryService: {
          getSessionDetail() {
            return null;
          }
        }
      }),
    TypeError
  );
});

test('missing getSessionDetail throws TypeError', () => {
  assert.throws(
    () =>
      createSessionReadController({
        sessionQueryService: {
          listSessionHistory() {
            return [];
          }
        }
      }),
    TypeError
  );
});

test('Promise-returning service methods work through the HTTP route handler', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const detail = detailDTO({ id: 'session-1' });
  const handler = createHandler({
    listSessionHistory() {
      return Promise.resolve(history);
    },
    getSessionDetail(sessionId) {
      return Promise.resolve(sessionId === 'session-1' ? detail : null);
    }
  });

  const listResponse = await request(handler, { method: 'GET', url: '/api/sessions' });
  const detailResponse = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.json(), history);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(detailResponse.json(), detail);
});

test('controller delegates without reconstructing service DTOs', () => {
  const history = [historyItem({ id: 'session-1' })];
  const detail = detailDTO({ id: 'session-1' });
  const controller = createSessionReadController({
    sessionQueryService: createService({ history, detail })
  });

  assert.strictEqual(controller.listSessions(), history);
  assert.strictEqual(controller.getSession('session-1'), detail);
});

function createHandler(serviceOverrides = {}) {
  const sessionQueryService = createService(serviceOverrides);
  const sessionReadController = createSessionReadController({ sessionQueryService });

  return createRequestHandler({
    sessionReadController,
    ...(serviceOverrides.translationHistory
      ? { translationHistoryController: createTranslationHistoryController(serviceOverrides.translationHistory) }
      : {})
  });
}

function createService(overrides = {}) {
  const history = overrides.history ?? [];
  const detail = overrides.detail ?? null;

  return {
    listSessionHistory:
      overrides.listSessionHistory ||
      function listSessionHistory() {
        return history;
      },
    getSessionDetail:
      overrides.getSessionDetail ||
      function getSessionDetail() {
        return detail;
      }
  };
}

async function request(handler, { method = 'GET', url = '/api/sessions', body = '', headers = {} } = {}) {
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
    json: () => JSON.parse(response.body || '{}')
  };
}

function historyItem(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    status: overrides.status || 'completed',
    startedAt: overrides.startedAt ?? 1000,
    endedAt: overrides.endedAt ?? 2000,
    durationMs: overrides.durationMs ?? 1000,
    targetLanguageCode: overrides.targetLanguageCode || 'fr',
    targetLanguageLabel: overrides.targetLanguageLabel || 'French',
    failureReason: overrides.failureReason ?? null,
    failureCategory: overrides.failureCategory ?? null,
    transcriptSummary: overrides.transcriptSummary || {
      totalItems: 0,
      sourceFinalCount: 0,
      translationFinalCount: 0,
      sourcePartialCount: 0,
      translationPartialCount: 0,
      hasTranscript: false
    },
    legacy: true
  };
}

function detailDTO(overrides = {}) {
  const id = overrides.id || 'session-1';

  const detail = {
    session: {
      id,
      status: overrides.status || 'completed'
    },
    sourceTranscript: {
      id: `source:${id}`,
      sessionId: id,
      items: []
    },
    translationOutputs: overrides.translationOutputs || [],
    selectedTranslationOutput: null,
    legacy: true
  };

  if (Object.hasOwn(overrides, 'readingContent')) {
    detail.readingContent = overrides.readingContent;
  }

  return detail;
}

function createTranslationHistoryController(translationHistory) {
  return {
    listSessionTranslations({ sessionId, includeReadModel }) {
      assert.equal(sessionId, 'session-1');
      assert.equal(includeReadModel, true);
      return { translationHistory };
    }
  };
}

function formalOutput(overrides = {}) {
  return {
    id: overrides.id || 'output-1',
    executionId: overrides.executionId || null,
    requestId: overrides.requestId || null,
    targetLanguageCode: overrides.targetLanguageCode || 'fr',
    version: overrides.version ?? 1,
    source: overrides.source || 'formal',
    translatedText: overrides.translatedText || 'Translated article',
    createdAt: overrides.createdAt || '2026-07-21T00:00:00.000Z',
    completedAt: overrides.completedAt || '2026-07-21T00:00:02.000Z'
  };
}
