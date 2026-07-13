import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionQueryService } from '../../src/application/sessionQueryService.js';

test('factory creates a session query service', () => {
  const service = createSessionQueryService({
    sessionReadRepository: readRepository()
  });

  assert.equal(typeof service.listSessionHistory, 'function');
  assert.equal(typeof service.getSessionDetail, 'function');
});

test('factory throws when sessionReadRepository is missing', () => {
  assert.throws(() => createSessionQueryService(), TypeError);
});

test('factory throws when required repository methods are missing', () => {
  assert.throws(
    () =>
      createSessionQueryService({
        sessionReadRepository: {
          getSessionDetail() {
            return null;
          }
        }
      }),
    /listSessionHistory/
  );
  assert.throws(
    () =>
      createSessionQueryService({
        sessionReadRepository: {
          listSessionHistory() {
            return [];
          }
        }
      }),
    /getSessionDetail/
  );
});

test('listSessionHistory calls the read repository method', () => {
  const calls = [];
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({
      listSessionHistory() {
        calls.push('listSessionHistory');
        return [];
      }
    })
  });

  service.listSessionHistory();

  assert.deepEqual(calls, ['listSessionHistory']);
});

test('history DTOs are returned unchanged', () => {
  const history = [historyItem({ id: 'session-1' })];
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({ history })
  });

  assert.strictEqual(service.listSessionHistory(), history);
});

test('history order follows the read repository order', () => {
  const history = [historyItem({ id: 'session-2' }), historyItem({ id: 'session-1' })];
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({ history })
  });

  assert.deepEqual(
    service.listSessionHistory().map((item) => item.id),
    ['session-2', 'session-1']
  );
});

test('empty history array is returned unchanged', () => {
  const history = [];
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({ history })
  });

  assert.strictEqual(service.listSessionHistory(), history);
});

test('listSessionHistory preserves asynchronous repository behavior', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({
      listSessionHistory() {
        return Promise.resolve(history);
      }
    })
  });

  const result = service.listSessionHistory();

  assert.equal(typeof result.then, 'function');
  assert.strictEqual(await result, history);
});

test('getSessionDetail passes the requested sessionId to the read repository', () => {
  const calls = [];
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({
      getSessionDetail(sessionId) {
        calls.push(sessionId);
        return null;
      }
    })
  });

  service.getSessionDetail('session-1');

  assert.deepEqual(calls, ['session-1']);
});

test('detail DTO is returned unchanged', () => {
  const detail = detailDTO({ id: 'session-1' });
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({ detail })
  });

  assert.strictEqual(service.getSessionDetail('session-1'), detail);
});

test('missing session detail returns null', () => {
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({ detail: null })
  });

  assert.equal(service.getSessionDetail('missing'), null);
});

test('getSessionDetail preserves asynchronous repository behavior', async () => {
  const detail = detailDTO({ id: 'session-1' });
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({
      getSessionDetail() {
        return Promise.resolve(detail);
      }
    })
  });

  const result = service.getSessionDetail('session-1');

  assert.equal(typeof result.then, 'function');
  assert.strictEqual(await result, detail);
});

test('list repository errors pass through unchanged', async () => {
  const syncError = new Error('list failed');
  const asyncError = new Error('async list failed');
  const syncService = createSessionQueryService({
    sessionReadRepository: readRepository({
      listSessionHistory() {
        throw syncError;
      }
    })
  });
  const asyncService = createSessionQueryService({
    sessionReadRepository: readRepository({
      listSessionHistory() {
        return Promise.reject(asyncError);
      }
    })
  });

  assert.throws(() => syncService.listSessionHistory(), syncError);
  await assert.rejects(asyncService.listSessionHistory(), asyncError);
});

test('detail repository errors pass through unchanged', async () => {
  const syncError = new Error('detail failed');
  const asyncError = new Error('async detail failed');
  const syncService = createSessionQueryService({
    sessionReadRepository: readRepository({
      getSessionDetail() {
        throw syncError;
      }
    })
  });
  const asyncService = createSessionQueryService({
    sessionReadRepository: readRepository({
      getSessionDetail() {
        return Promise.reject(asyncError);
      }
    })
  });

  assert.throws(() => syncService.getSessionDetail('session-1'), syncError);
  await assert.rejects(asyncService.getSessionDetail('session-1'), asyncError);
});

test('service does not call the WP1 read-model mapper', () => {
  const history = [{ id: 'session-1', unexpectedShape: true }];
  const detail = { session: { id: 'session-1' }, unexpectedShape: true };
  const service = createSessionQueryService({
    sessionReadRepository: readRepository({ history, detail })
  });

  assert.strictEqual(service.listSessionHistory(), history);
  assert.strictEqual(service.getSessionDetail('session-1'), detail);
});

test('service does not directly depend on the legacy sessionRepository', () => {
  assert.throws(() =>
    createSessionQueryService({
      sessionReadRepository: {
        listSessionRecords() {
          return [];
        },
        getSessionRecord() {
          return null;
        }
      }
    })
  );
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
    legacy: overrides.legacy ?? true
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
