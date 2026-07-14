import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { TranslationExecution, TranslationOutput, TranslationRequest } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';
import { createTranslationRepositoryAdapter } from '../../src/infrastructure/translationRepositoryAdapter.js';

test('factory validates dependencies, freezes repository, and exposes only formal methods', () => {
  assert.throws(() => createTranslationRepositoryAdapter(), /sessionRepository is required/);

  for (const missingMethod of ['getSessionRecord', 'updateSessionRecord', 'listSessionRecords']) {
    const sessionRepository = legacySessionRepository();
    delete sessionRepository[missingMethod];

    assert.throws(
      () => createTranslationRepositoryAdapter({ sessionRepository }),
      new RegExp(`sessionRepository\\.${missingMethod}`)
    );
  }

  const repository = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });

  assert.equal(Object.isFrozen(repository), true);
  assert.deepEqual(Object.keys(repository), TRANSLATION_REPOSITORY_METHODS);
  assert.throws(() => {
    repository.extra = () => null;
  }, TypeError);
});

test('creates, gets, and updates TranslationRequest without mutating input or unrelated SessionRecord fields', () => {
  const sessionRepository = legacySessionRepository({
    sessions: [
      sessionRecord({
        id: 'session-1',
        metadata: { preserved: true },
        transcriptSummary: { totalItems: 1, translationFinalCount: 1 }
      })
    ]
  });
  const repository = createTranslationRepositoryAdapter({ sessionRepository });
  const input = requestPayload({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ id: 'source-1', text: 'Hello', nested: { preserved: true } }]
    }
  });
  const before = structuredClone(input);

  const created = repository.createTranslationRequest(input);
  const fetched = repository.getTranslationRequest('request-1');
  const updated = repository.updateTranslationRequest(
    new TranslationRequest({
      ...requestPayload({ targetLanguageCode: 'de' }),
      sourceTranscriptSnapshot: { revisionId: 'source-revision-2', items: [] }
    })
  );
  const detail = sessionRepository.getSessionRecord('session-1');

  assert.equal(created instanceof TranslationRequest, true);
  assert.equal(fetched instanceof TranslationRequest, true);
  assert.equal(updated.targetLanguageCode, 'de');
  assert.deepEqual(input, before);
  assert.equal(detail.sessionRecord.metadata.preserved, true);
  assert.deepEqual(detail.sessionRecord.transcriptSummary, { totalItems: 1, translationFinalCount: 1 });
  assert.deepEqual(detail.transcriptItems, []);
  assert.deepEqual(detail.sessionRecord.translationCommandState.requests.map((request) => request.id), ['request-1']);

  assert.throws(() => {
    fetched.sourceTranscriptSnapshot.items[0].nested.preserved = false;
  }, TypeError);
  assert.equal(repository.getTranslationRequest('request-1').sourceTranscriptSnapshot.revisionId, 'source-revision-2');
});

test('request missing session, missing entity, duplicate, and conflicting identity behavior is deterministic', () => {
  const repository = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });

  assert.throws(
    () => repository.createTranslationRequest(requestPayload({ sessionId: 'missing-session' })),
    /Session record not found: missing-session/
  );
  assert.equal(repository.getTranslationRequest('missing-request'), null);
  assert.equal(repository.updateTranslationRequest(requestPayload({ id: 'missing-request' })), null);

  repository.createTranslationRequest(requestPayload());
  assert.throws(() => repository.createTranslationRequest(requestPayload()), /TranslationRequest already exists: request-1/);
  assert.throws(
    () => repository.updateTranslationRequest(requestPayload({ sessionId: 'session-2' })),
    /cannot change sessionId/
  );
});

test('creates, gets, and updates TranslationExecution while preserving lifecycle fields', () => {
  const repository = seededRepository();
  const executionInput = executionPayload();
  const before = structuredClone(executionInput);

  const created = repository.createTranslationExecution(executionInput);
  const fetched = repository.getTranslationExecution('execution-1');
  const updated = repository.updateTranslationExecution(
    new TranslationExecution({
      ...executionPayload(),
      status: 'failed',
      completedAt: '2026-07-14T01:03:00.000Z',
      failureInfo: { reason: 'provider_error', nested: { code: 'x' } }
    })
  );

  assert.equal(created instanceof TranslationExecution, true);
  assert.equal(fetched.status, 'pending');
  assert.equal(updated.status, 'failed');
  assert.equal(updated.startedAt, '2026-07-14T01:01:00.000Z');
  assert.equal(updated.completedAt, '2026-07-14T01:03:00.000Z');
  assert.deepEqual(updated.failureInfo, { reason: 'provider_error', nested: { code: 'x' } });
  assert.deepEqual(executionInput, before);

  assert.throws(() => {
    updated.failureInfo.nested.code = 'mutated';
  }, TypeError);
  assert.equal(repository.getTranslationExecution('execution-1').failureInfo.nested.code, 'x');
});

test('execution missing request, missing entity, duplicate, and conflicting identity behavior is deterministic', () => {
  const repository = seededRepository();

  assert.throws(
    () => repository.createTranslationExecution(executionPayload({ translationRequestId: 'missing-request' })),
    /TranslationRequest missing-request was not found/
  );
  assert.equal(repository.getTranslationExecution('missing-execution'), null);
  assert.equal(repository.updateTranslationExecution(executionPayload({ id: 'missing-execution' })), null);

  repository.createTranslationExecution(executionPayload());
  assert.throws(
    () => repository.createTranslationExecution(executionPayload()),
    /TranslationExecution already exists: execution-1/
  );
  assert.throws(
    () => repository.updateTranslationExecution(executionPayload({ translationRequestId: 'other-request' })),
    /cannot change translationRequestId/
  );
});

test('creates, lists, and gets TranslationOutput with deterministic ordering and defensive copies', () => {
  const repository = seededRepositoryWithExecution();
  const outputs = [
    outputPayload({ id: 'output-b', sequence: 2, createdAt: '2026-07-14T01:06:02.000Z' }),
    outputPayload({ id: 'output-c', sequence: 1, createdAt: '2026-07-14T01:06:02.000Z' }),
    outputPayload({ id: 'output-a', sequence: 1, createdAt: '2026-07-14T01:06:01.000Z' })
  ];
  const before = structuredClone(outputs);

  for (const output of outputs) {
    const created = repository.createTranslationOutput(output);
    assert.equal(created instanceof TranslationOutput, true);
  }

  const listed = repository.listTranslationOutputsByExecution('execution-1');
  const fetched = repository.getTranslationOutput('output-a');

  assert.deepEqual(
    listed.map((output) => output.id),
    ['output-a', 'output-c', 'output-b']
  );
  assert.equal(fetched.translatedText, 'Bonjour');
  assert.deepEqual(outputs, before);

  assert.throws(() => {
    fetched.providerMetadata.nested.value = false;
  }, TypeError);
  assert.equal(repository.getTranslationOutput('missing-output'), null);
  assert.deepEqual(repository.listTranslationOutputsByExecution('missing-execution'), []);
});

test('output missing execution and duplicate identifier behavior is deterministic', () => {
  const repository = seededRepositoryWithExecution();

  assert.throws(
    () => repository.createTranslationOutput(outputPayload({ executionId: 'missing-execution' })),
    /TranslationExecution missing-execution was not found/
  );

  repository.createTranslationOutput(outputPayload());
  assert.throws(() => repository.createTranslationOutput(outputPayload()), /TranslationOutput already exists: output-1/);
});

test('supports async legacy session repository method results', async () => {
  const sessionRepository = legacySessionRepository({
    asyncMethods: new Set(['getSessionRecord', 'updateSessionRecord', 'listSessionRecords'])
  });
  const repository = createTranslationRepositoryAdapter({ sessionRepository });

  const firstCreateResult = repository.createTranslationRequest(requestPayload());
  assert.equal(typeof firstCreateResult.then, 'function');
  await firstCreateResult;
  assert.equal((await repository.createTranslationRequest(requestPayload({ id: 'request-async' }))).id, 'request-async');
  assert.equal((await repository.getTranslationRequest('request-async')).id, 'request-async');

  await repository.createTranslationExecution(executionPayload({ id: 'execution-async', translationRequestId: 'request-async' }));
  await repository.createTranslationOutput(outputPayload({ id: 'output-async', executionId: 'execution-async' }));

  assert.deepEqual(
    (await repository.listTranslationOutputsByExecution('execution-async')).map((output) => output.id),
    ['output-async']
  );
});

test('production composition root uses adapter by default and preserves explicit repository injection', () => {
  const sessionRepository = legacySessionRepository();
  const defaultDependencies = createApplicationDependencies({ sessionRepository });

  defaultDependencies.translationRepository.createTranslationRequest(requestPayload());
  assert.equal(
    sessionRepository.getSessionRecord('session-1').sessionRecord.translationCommandState.requests[0].id,
    'request-1'
  );

  const injectedRepository = formalRepository();
  const injectedDependencies = createApplicationDependencies({
    sessionRepository,
    translationRepository: injectedRepository
  });

  assert.strictEqual(injectedDependencies.translationRepository, injectedRepository);
});

test('session read composition remains unchanged when command adapter is present', () => {
  const history = [{ id: 'read-session' }];
  const detail = { session: { id: 'read-session' }, translationOutputs: [] };
  const dependencies = createApplicationDependencies({
    sessionRepository: legacySessionRepository(),
    sessionReadRepository: {
      listSessionHistory() {
        return history;
      },
      getSessionDetail() {
        return detail;
      }
    }
  });

  assert.strictEqual(dependencies.sessionReadController.listSessions(), history);
  assert.strictEqual(dependencies.sessionReadController.getSession('read-session'), detail);
});

function seededRepository() {
  const repository = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });
  repository.createTranslationRequest(requestPayload());
  return repository;
}

function seededRepositoryWithExecution() {
  const repository = seededRepository();
  repository.createTranslationExecution(executionPayload());
  return repository;
}

function formalRepository() {
  return Object.fromEntries(TRANSLATION_REPOSITORY_METHODS.map((method) => [method, () => null]));
}

function legacySessionRepository({ sessions = [sessionRecord()], asyncMethods = new Set() } = {}) {
  const records = new Map(sessions.map((record) => [record.id, clone(record)]));
  const transcriptItems = new Map(sessions.map((record) => [record.id, []]));

  function maybeAsync(method, value) {
    return asyncMethods.has(method) ? Promise.resolve(value) : value;
  }

  return {
    getSessionRecord(id) {
      const record = records.get(id);
      return maybeAsync(
        'getSessionRecord',
        record
          ? {
              sessionRecord: clone(record),
              transcriptItems: clone(transcriptItems.get(id) || [])
            }
          : null
      );
    },

    updateSessionRecord(id, patch = {}) {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Session record not found: ${id}`);
      }

      const nextRecord = {
        ...record,
        ...clone(patch),
        id: record.id,
        createdAt: record.createdAt
      };
      records.set(id, nextRecord);
      return maybeAsync('updateSessionRecord', clone(nextRecord));
    },

    listSessionRecords() {
      return maybeAsync('listSessionRecords', Array.from(records.values(), clone));
    }
  };
}

function sessionRecord(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    startedAt: '2026-07-14T01:00:00.000Z',
    endedAt: null,
    durationMs: null,
    targetLanguageCode: 'fr',
    targetLanguageLabel: 'French',
    status: 'active',
    failureReason: null,
    failureCategory: null,
    lastLifecycleState: 'listening',
    transcriptSummary: {},
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}

function requestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    sourceTranscriptSnapshot: null,
    targetLanguageCode: 'fr',
    createdAt: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    status: 'pending',
    startedAt: '2026-07-14T01:01:00.000Z',
    completedAt: null,
    failureInfo: null,
    ...overrides
  };
}

function outputPayload(overrides = {}) {
  return {
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'Bonjour',
    targetLanguageCode: 'fr',
    providerMetadata: { nested: { value: true } },
    createdAt: '2026-07-14T01:06:00.000Z',
    ...overrides
  };
}

function clone(value) {
  return structuredClone(value);
}
