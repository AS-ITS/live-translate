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
  const found = repository.findRequestById('request-1');
  const updated = repository.updateTranslationRequest(
    new TranslationRequest({
      ...requestPayload({ targetLanguageCode: 'de' }),
      sourceTranscriptSnapshot: { revisionId: 'source-revision-2', items: [] }
    })
  );
  const detail = sessionRepository.getSessionRecord('session-1');

  assert.equal(created instanceof TranslationRequest, true);
  assert.equal(fetched instanceof TranslationRequest, true);
  assert.equal(found instanceof TranslationRequest, true);
  assert.notStrictEqual(found, fetched);
  assert.equal(found.id, 'request-1');
  assert.equal(updated.targetLanguageCode, 'de');
  assert.deepEqual(input, before);
  assert.equal(detail.sessionRecord.metadata.preserved, true);
  assert.deepEqual(detail.sessionRecord.transcriptSummary, { totalItems: 1, translationFinalCount: 1 });
  assert.deepEqual(detail.transcriptItems, []);
  assert.deepEqual(detail.sessionRecord.translationCommandState.requests.map((request) => request.id), ['request-1']);

  assert.throws(() => {
    fetched.sourceTranscriptSnapshot.items[0].nested.preserved = false;
  }, TypeError);
  assert.throws(() => {
    found.sourceTranscriptSnapshot.items[0].nested.preserved = false;
  }, TypeError);
  assert.equal(repository.getTranslationRequest('request-1').sourceTranscriptSnapshot.revisionId, 'source-revision-2');
});

test('lists only TranslationRequests for a session in deterministic insertion order', () => {
  const repository = createTranslationRepositoryAdapter({
    sessionRepository: legacySessionRepository({
      sessions: [sessionRecord({ id: 'session-1' }), sessionRecord({ id: 'session-2' })]
    })
  });

  repository.createTranslationRequest(requestPayload({ id: 'request-1', sessionId: 'session-1' }));
  repository.createTranslationRequest(requestPayload({ id: 'request-2', sessionId: 'session-2' }));
  repository.createTranslationRequest(requestPayload({ id: 'request-3', sessionId: 'session-1' }));

  assert.deepEqual(
    repository.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-1', 'request-3']
  );
  assert.deepEqual(
    repository.listTranslationRequestsBySession('session-2').map((request) => request.id),
    ['request-2']
  );
  assert.deepEqual(repository.listTranslationRequestsBySession('missing-session'), []);
  assert.throws(() => repository.listTranslationRequestsBySession(''), /sessionId must not be empty/);
});

test('request missing session, missing entity, duplicate, and conflicting identity behavior is deterministic', () => {
  const repository = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });

  assert.throws(
    () => repository.createTranslationRequest(requestPayload({ sessionId: 'missing-session' })),
    /Session record not found: missing-session/
  );
  assert.equal(repository.getTranslationRequest('missing-request'), null);
  assert.equal(repository.findRequestById('missing-request'), null);
  assert.equal(repository.updateTranslationRequest(requestPayload({ id: 'missing-request' })), null);

  repository.createTranslationRequest(requestPayload());
  assert.throws(() => repository.createTranslationRequest(requestPayload()), /TranslationRequest already exists: request-1/);
  assert.throws(
    () => repository.updateTranslationRequest(requestPayload({ sessionId: 'session-2' })),
    /cannot change sessionId/
  );
});

test('creates, gets, and updates TranslationExecution while preserving lifecycle fields', () => {
  const sessionRepository = legacySessionRepository();
  const repository = createTranslationRepositoryAdapter({ sessionRepository });
  repository.createTranslationRequest(requestPayload());
  const executionInput = executionPayload();
  const before = structuredClone(executionInput);

  const created = repository.createTranslationExecution(executionInput);
  const fetched = repository.getTranslationExecution('execution-1');
  const found = repository.findExecutionById('execution-1');
  const updated = repository.updateTranslationExecution(
    new TranslationExecution({
      ...executionPayload(),
      status: 'failed',
      completedAt: '2026-07-14T01:03:00.000Z',
      failureInfo: { reason: 'provider_error', nested: { code: 'x' } }
    })
  );

  assert.equal(created instanceof TranslationExecution, true);
  assert.equal(fetched.status, 'created');
  assert.equal(found instanceof TranslationExecution, true);
  assert.notStrictEqual(found, fetched);
  assert.equal(found.id, 'execution-1');
  assert.equal(found.status, 'created');
  assert.equal(updated.status, 'failed');
  assert.equal(created.providerIdempotencyKey, 'translation-execution:execution-1');
  assert.equal(fetched.providerIdempotencyKey, created.providerIdempotencyKey);
  assert.equal(updated.providerIdempotencyKey, created.providerIdempotencyKey);
  assert.equal(
    sessionRepository.getSessionRecord('session-1').sessionRecord.translationCommandState.executions[0].providerIdempotencyKey,
    created.providerIdempotencyKey
  );
  assert.equal(updated.startedAt, '2026-07-14T01:01:00.000Z');
  assert.equal(updated.completedAt, '2026-07-14T01:03:00.000Z');
  assert.deepEqual(updated.failureInfo, { reason: 'provider_error', nested: { code: 'x' } });
  assert.deepEqual(executionInput, before);

  assert.throws(() => {
    updated.failureInfo.nested.code = 'mutated';
  }, TypeError);
  assert.equal(repository.getTranslationExecution('execution-1').failureInfo.nested.code, 'x');
});

test('reconstitutes legacy persisted executions without an idempotency key deterministically', () => {
  const legacyExecution = executionPayload();
  const sessionRepository = legacySessionRepository({
    sessions: [
      sessionRecord({
        translationCommandState: {
          requests: [requestPayload()],
          executions: [legacyExecution],
          outputs: []
        }
      })
    ]
  });
  const repository = createTranslationRepositoryAdapter({
    sessionRepository
  });

  const execution = repository.getTranslationExecution('execution-1');

  assert.equal(execution.providerIdempotencyKey, 'translation-execution:execution-1');
  assert.equal(execution.providerAttemptStatus, 'not_started');
  assert.equal(execution.providerAttemptedAt, null);
  assert.equal(execution.providerCompletedAt, null);
  assert.deepEqual(
    sessionRepository.getSessionRecord('session-1').sessionRecord.translationCommandState.executions,
    [legacyExecution]
  );
});

test('lists only TranslationExecutions for a request and keeps unrelated executions unchanged on update', () => {
  const repository = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });

  repository.createTranslationRequest(requestPayload({ id: 'request-1' }));
  repository.createTranslationRequest(requestPayload({ id: 'request-2' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-1', translationRequestId: 'request-1' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-2', translationRequestId: 'request-2' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-3', translationRequestId: 'request-1' }));

  const updated = repository.updateTranslationExecution(
    new TranslationExecution({
      ...executionPayload({ id: 'execution-1', translationRequestId: 'request-1' }),
      status: 'completed',
      completedAt: '2026-07-14T01:04:00.000Z'
    })
  );

  assert.equal(updated.status, 'completed');
  assert.equal(repository.getTranslationExecution('execution-2').status, 'created');
  assert.deepEqual(
    repository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.id),
    ['execution-1', 'execution-3']
  );
  assert.deepEqual(
    repository.listTranslationExecutionsByRequest('request-2').map((execution) => execution.id),
    ['execution-2']
  );
  assert.deepEqual(repository.listTranslationExecutionsByRequest('missing-request'), []);
  assert.throws(() => repository.listTranslationExecutionsByRequest(null), /requestId must be a string/);
});

test('execution missing request, missing entity, duplicate, and conflicting identity behavior is deterministic', () => {
  const repository = seededRepository();

  assert.throws(
    () => repository.createTranslationExecution(executionPayload({ translationRequestId: 'missing-request' })),
    /TranslationRequest missing-request was not found/
  );
  assert.equal(repository.getTranslationExecution('missing-execution'), null);
  assert.equal(repository.findExecutionById('missing-execution'), null);
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

test('creates, lists, and gets one TranslationOutput per execution with defensive copies', () => {
  const repository = seededRepositoryWithExecution();
  repository.createTranslationExecution(executionPayload({ id: 'execution-2' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-3' }));
  const outputs = [
    outputPayload({ id: 'output-b', sequence: 2, createdAt: '2026-07-14T01:06:02.000Z' }),
    outputPayload({ id: 'output-c', executionId: 'execution-2', sequence: 1, createdAt: '2026-07-14T01:06:02.000Z' }),
    outputPayload({ id: 'output-a', executionId: 'execution-3', sequence: 1, createdAt: '2026-07-14T01:06:01.000Z' })
  ];
  const before = structuredClone(outputs);

  for (const output of outputs) {
    const created = repository.createTranslationOutput(output);
    assert.equal(created instanceof TranslationOutput, true);
  }

  const listed = repository.listTranslationOutputsByExecution('execution-1');
  const fetched = repository.getTranslationOutput('output-b');

  assert.deepEqual(listed.map((output) => output.id), ['output-b']);
  assert.equal(fetched.translatedText, 'Bonjour');
  assert.deepEqual(outputs, before);

  assert.throws(() => {
    fetched.providerMetadata.nested.value = false;
  }, TypeError);
  assert.equal(repository.getTranslationOutput('missing-output'), null);
  assert.deepEqual(repository.listTranslationOutputsByExecution('missing-execution'), []);
});

test('lists TranslationOutputs by session and request without collapsing same-language versions', () => {
  const repository = createTranslationRepositoryAdapter({
    sessionRepository: legacySessionRepository({
      sessions: [sessionRecord({ id: 'session-1' }), sessionRecord({ id: 'session-2' })]
    })
  });

  repository.createTranslationRequest(requestPayload({ id: 'request-1', sessionId: 'session-1', targetLanguageCode: 'fr' }));
  repository.createTranslationRequest(requestPayload({ id: 'request-2', sessionId: 'session-1', targetLanguageCode: 'fr' }));
  repository.createTranslationRequest(requestPayload({ id: 'request-3', sessionId: 'session-2', targetLanguageCode: 'fr' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-1', translationRequestId: 'request-1' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-2', translationRequestId: 'request-1' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-3', translationRequestId: 'request-2' }));
  repository.createTranslationExecution(executionPayload({ id: 'execution-4', translationRequestId: 'request-3' }));
  repository.createTranslationOutput(
    outputPayload({ id: 'output-2', executionId: 'execution-2', sequence: 1, targetLanguageCode: 'fr' })
  );
  repository.createTranslationOutput(
    outputPayload({ id: 'output-1', executionId: 'execution-1', sequence: 0, targetLanguageCode: 'fr' })
  );
  repository.createTranslationOutput(
    outputPayload({ id: 'output-3', executionId: 'execution-3', sequence: 2, targetLanguageCode: 'fr' })
  );
  repository.createTranslationOutput(
    outputPayload({ id: 'output-4', executionId: 'execution-4', sequence: 3, targetLanguageCode: 'fr' })
  );

  assert.deepEqual(
    repository.listTranslationOutputsBySession('session-1').map((output) => output.id),
    ['output-1', 'output-2', 'output-3']
  );
  assert.deepEqual(
    repository.listTranslationOutputsBySession('session-2').map((output) => output.id),
    ['output-4']
  );
  assert.deepEqual(
    repository.listTranslationOutputsByRequest('request-1').map((output) => output.id),
    ['output-1', 'output-2']
  );
  assert.deepEqual(
    repository.listTranslationOutputsByRequest('request-2').map((output) => output.id),
    ['output-3']
  );
  assert.deepEqual(repository.listTranslationOutputsBySession('missing-session'), []);
  assert.deepEqual(repository.listTranslationOutputsByRequest('missing-request'), []);
  assert.throws(() => repository.listTranslationOutputsBySession('   '), /sessionId must not be empty/);
  assert.throws(() => repository.listTranslationOutputsByRequest(undefined), /requestId must be a string/);
});

test('deletes TranslationOutput by id without removing requests or executions', () => {
  const repository = seededRepositoryWithExecution();
  repository.createTranslationOutput(outputPayload());

  assert.equal(repository.deleteTranslationOutput('output-1'), true);
  assert.equal(repository.getTranslationOutput('output-1'), null);
  assert.deepEqual(repository.listTranslationOutputsByExecution('execution-1'), []);
  assert.deepEqual(repository.listTranslationOutputsByRequest('request-1'), []);
  assert.deepEqual(repository.listTranslationOutputsBySession('session-1'), []);
  assert.equal(repository.getTranslationRequest('request-1').id, 'request-1');
  assert.equal(repository.getTranslationExecution('execution-1').id, 'execution-1');
  assert.equal(repository.deleteTranslationOutput('output-1'), false);
  assert.throws(() => repository.deleteTranslationOutput('   '), /outputId must not be empty/);
});

test('output missing execution and duplicate identifier behavior is deterministic', () => {
  const repository = seededRepositoryWithExecution();

  assert.throws(
    () => repository.createTranslationOutput(outputPayload({ executionId: 'missing-execution' })),
    /TranslationExecution missing-execution was not found/
  );

  repository.createTranslationOutput(outputPayload());
  repository.createTranslationExecution(executionPayload({ id: 'execution-2' }));
  assert.throws(
    () => repository.createTranslationOutput(outputPayload({ executionId: 'execution-2' })),
    /TranslationOutput already exists: output-1/
  );
});

test('output creation is idempotent by execution and preserves the original persisted output', () => {
  const repository = seededRepositoryWithExecution();
  const first = outputPayload({
    id: 'output-first',
    executionId: 'execution-1',
    translatedText: 'First translation',
    providerMetadata: { attempt: 1 },
    createdAt: 1000
  });
  const duplicate = outputPayload({
    id: 'output-duplicate',
    executionId: 'execution-1',
    translatedText: 'Overwritten translation',
    providerMetadata: { attempt: 2 },
    createdAt: 2000
  });

  const firstResult = repository.createTranslationOutput(first);
  const duplicateResult = repository.createTranslationOutput(duplicate);

  assert.deepEqual(firstResult, new TranslationOutput(first));
  assert.deepEqual(duplicateResult, new TranslationOutput(first));
  assert.deepEqual(repository.listTranslationOutputsByExecution('execution-1'), [new TranslationOutput(first)]);
});

test('separate repository instances have isolated translation command state', () => {
  const repositoryA = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });
  const repositoryB = createTranslationRepositoryAdapter({ sessionRepository: legacySessionRepository() });

  repositoryA.createTranslationRequest(requestPayload({ id: 'request-a' }));
  repositoryA.createTranslationExecution(executionPayload({ id: 'execution-a', translationRequestId: 'request-a' }));
  repositoryA.createTranslationOutput(outputPayload({ id: 'output-a', executionId: 'execution-a' }));

  repositoryB.createTranslationRequest(requestPayload({ id: 'request-b' }));

  assert.deepEqual(
    repositoryA.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-a']
  );
  assert.deepEqual(
    repositoryB.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-b']
  );
  assert.equal(repositoryB.getTranslationExecution('execution-a'), null);
  assert.equal(repositoryB.findExecutionById('execution-a'), null);
  assert.deepEqual(repositoryB.listTranslationOutputsBySession('session-1'), []);
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
  assert.equal((await repository.findRequestById('request-async')).id, 'request-async');

  await repository.createTranslationExecution(executionPayload({ id: 'execution-async', translationRequestId: 'request-async' }));
  assert.equal((await repository.findExecutionById('execution-async')).id, 'execution-async');
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
    status: 'created',
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
