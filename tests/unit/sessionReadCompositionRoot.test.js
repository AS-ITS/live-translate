import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApplicationDependencies, createSessionReadDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';

test('composition root assembles the session read dependency chain', () => {
  const dependencies = createSessionReadDependencies({
    sessionReadRepository: readRepository()
  });

  assert.equal(typeof dependencies.sessionReadRepository.listSessionHistory, 'function');
  assert.equal(typeof dependencies.sessionQueryService.listSessionHistory, 'function');
  assert.equal(typeof dependencies.sessionReadController.listSessions, 'function');
});

test('application dependencies expose the assembled session read controller', () => {
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository()
  });

  assert.equal(typeof dependencies.sessionReadController.listSessions, 'function');
  assert.equal(typeof dependencies.sessionReadController.getSession, 'function');
});

test('application dependencies compose the HTTP request handler from the assembled controller', () => {
  let injectedController;
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    requestHandlerFactory({ sessionReadController }) {
      injectedController = sessionReadController;

      return function requestHandler() {};
    }
  });

  assert.strictEqual(injectedController, dependencies.sessionReadController);
  assert.equal(typeof dependencies.requestHandler, 'function');
});

test('application dependencies enable glossary routes with the default writable file', async () => {
  const writes = [];
  const dependencies = createApplicationDependencies({
    requestHandlerFactory: createRequestHandler,
    sessionReadRepository: readRepository(),
    translationGlossaryFileSystem: {
      async readFile() {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      async mkdir(path) {
        writes.push(['mkdir', path]);
      },
      async writeFile(path, content) {
        writes.push(['writeFile', path, JSON.parse(content)]);
      },
      async rename(from, to) {
        writes.push(['rename', from, to]);
      }
    },
    idGenerator: createStaticIdGenerator(),
    clock: () => 1000
  });

  const listResponse = await request(dependencies.requestHandler, { method: 'GET', url: '/api/glossary' });
  const createResponse = await request(dependencies.requestHandler, {
    method: 'POST',
    url: '/api/glossary/entries',
    body: JSON.stringify({ source: 'Codex', translations: { ja: 'コーデックス' }, scope: 'live' })
  });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.json(), { entries: [] });
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.json().entry.scope, 'live');
  assert.deepEqual(writes, [
    ['mkdir', '.'],
    ['writeFile', 'translation-glossary.json.tmp', {
      entries: [
        {
          id: 'glossary-entry-1',
          source: 'Codex',
          translations: { ja: 'コーデックス' },
          replacementAliases: {},
          scope: 'live',
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    }],
    ['rename', 'translation-glossary.json.tmp', 'translation-glossary.json']
  ]);
});

test('assembled controller can list sessions and get session detail', () => {
  const history = [historyItem({ id: 'session-1' })];
  const detail = detailDTO({ id: 'session-1' });
  const dependencies = createSessionReadDependencies({
    sessionReadRepository: readRepository({ history, detail })
  });

  assert.strictEqual(dependencies.sessionReadController.listSessions(), history);
  assert.strictEqual(dependencies.sessionReadController.getSession('session-1'), detail);
});

test('HTTP requests delegate to the injected sessionReadRepository through the composition root', async () => {
  const calls = [];
  const history = [historyItem({ id: 'session-1' })];
  const detail = detailDTO({ id: 'session-1' });
  const dependencies = createApplicationDependencies({
    requestHandlerFactory: createRequestHandler,
    sessionReadRepository: readRepository({
      listSessionHistory() {
        calls.push(['list']);
        return history;
      },
      getSessionDetail(sessionId) {
        calls.push(['detail', sessionId]);
        return detail;
      }
    })
  });

  const listResponse = await request(dependencies.requestHandler, { method: 'GET', url: '/api/sessions' });
  const detailResponse = await request(dependencies.requestHandler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.json(), history);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(detailResponse.json(), detail);
  assert.deepEqual(calls, [['list'], ['detail', 'session-1']]);
});

test('controller does not bypass the application service to call legacy repository methods', async () => {
  let legacyListCalls = 0;
  let legacyDetailCalls = 0;
  const dependencies = createSessionReadDependencies({
    sessionRepository: {
      listSessionRecords() {
        legacyListCalls += 1;
        throw new Error('legacy list bypass');
      },
      getSessionRecord() {
        legacyDetailCalls += 1;
        throw new Error('legacy detail bypass');
      }
    },
    sessionReadRepository: readRepository({
      history: [historyItem({ id: 'session-1' })],
      detail: detailDTO({ id: 'session-1' })
    })
  });

  assert.equal(dependencies.sessionReadController.listSessions()[0].id, 'session-1');
  assert.equal(dependencies.sessionReadController.getSession('session-1').session.id, 'session-1');
  assert.equal(legacyListCalls, 0);
  assert.equal(legacyDetailCalls, 0);
});

test('composition root can build the read repository from the legacy persistence dependency', () => {
  const calls = [];
  const dependencies = createSessionReadDependencies({
    sessionRepository: {
      listSessionRecords() {
        calls.push(['listSessionRecords']);
        return [legacySessionRecord({ id: 'session-1' })];
      },
      getSessionRecord(sessionId) {
        calls.push(['getSessionRecord', sessionId]);
        return legacySessionDetail({ id: sessionId });
      }
    }
  });

  const history = dependencies.sessionReadController.listSessions();
  const detail = dependencies.sessionReadController.getSession('session-1');

  assert.deepEqual(calls, [['listSessionRecords'], ['getSessionRecord', 'session-1']]);
  assert.equal(history[0].id, 'session-1');
  assert.equal(detail.session.id, 'session-1');
});

test('repository DTO and null behavior preserve WP3 and WP4 contracts', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const dependencies = createApplicationDependencies({
    requestHandlerFactory: createRequestHandler,
    sessionReadRepository: readRepository({ history, detail: null })
  });

  const listResponse = await request(dependencies.requestHandler, { method: 'GET', url: '/api/sessions' });
  const missingResponse = await request(dependencies.requestHandler, { method: 'GET', url: '/api/sessions/missing' });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.json(), history);
  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.json().error.code, 'session_not_found');
});

test('unexpected repository errors keep existing internal error handling', async () => {
  const dependencies = createApplicationDependencies({
    requestHandlerFactory: createRequestHandler,
    sessionReadRepository: readRepository({
      getSessionDetail() {
        throw new Error('read storage failed');
      }
    })
  });

  const response = await request(dependencies.requestHandler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(response.status, 500);
  assert.equal(response.json().error.code, 'internal_error');
});

function readRepository(overrides = {}) {
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

function createStaticIdGenerator() {
  return function idGenerator(prefix) {
    return `${prefix}-entry-1`;
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
    transcriptSummary: overrides.transcriptSummary || emptyTranscriptSummary(),
    legacy: true
  };
}

function detailDTO(overrides = {}) {
  const id = overrides.id || 'session-1';

  return {
    session: {
      id,
      status: overrides.status || 'completed'
    },
    sourceTranscript: {
      id: `source:${id}`,
      sessionId: id,
      items: []
    },
    translationOutputs: [],
    selectedTranslationOutput: null,
    legacy: true
  };
}

function legacySessionRecord(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    targetLanguageCode: 'fr',
    targetLanguageLabel: 'French',
    failureReason: null,
    failureCategory: null,
    transcriptSummary: emptyTranscriptSummary()
  };
}

function legacySessionDetail(overrides = {}) {
  const id = overrides.id || 'session-1';

  return {
    sessionRecord: legacySessionRecord({ id }),
    transcriptItems: []
  };
}

function emptyTranscriptSummary() {
  return {
    totalItems: 0,
    sourceFinalCount: 0,
    translationFinalCount: 0,
    sourcePartialCount: 0,
    translationPartialCount: 0,
    hasTranscript: false
  };
}
