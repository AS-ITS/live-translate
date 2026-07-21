import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService as createRawTranslationCommandService } from '../../src/application/translationCommandService.js';
import { createCancelQueuedTranslationExecutionService } from '../../src/application/translation/cancelQueuedTranslationExecutionService.js';
import { createManualRetryFailedTranslationExecutionService } from '../../src/application/translation/manualRetryFailedTranslationExecutionService.js';
import {
  TranslationExecution,
  TranslationOutput,
  TranslationRequest
} from '../../src/domain/translation/index.js';

const SERVICE_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

function createTranslationCommandService(options = {}) {
  return createRawTranslationCommandService({
    domainEventPublisher: domainEventPublisher(),
    ...options
  });
}

test('factory throws TypeError when translationRepository is missing', () => {
  assert.throws(() => createTranslationCommandService(), TypeError);
});

test('factory throws TypeError when any required repository method is missing', () => {
  const requiredMethods = [
    'createTranslationRequest', 'getTranslationRequest', 'updateTranslationRequest', 'listTranslationRequestsBySession',
    'createTranslationExecution', 'getTranslationExecution', 'updateTranslationExecution', 'listTranslationExecutionsByRequest',
    'createTranslationOutput', 'listTranslationOutputsByExecution', 'listTranslationOutputsBySession',
    'listTranslationOutputsByRequest', 'getTranslationOutput'
  ];
  for (const missingMethod of requiredMethods) {
    const repository = translationRepository();
    delete repository[missingMethod];

    assert.throws(
      () => createTranslationCommandService({ translationRepository: repository }),
      new RegExp(`translationRepository\\.${missingMethod}`)
    );
  }
});

test('factory throws TypeError when domainEventPublisher publish contract is missing', () => {
  const repository = translationRepository();

  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository }),
    /domainEventPublisher is required/
  );
  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository, domainEventPublisher: null }),
    /domainEventPublisher is required/
  );
  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository, domainEventPublisher: {} }),
    /domainEventPublisher\.publish must be a function/
  );
  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository, domainEventPublisher: { publish: true } }),
    /domainEventPublisher\.publish must be a function/
  );
});

test('service object is frozen and only exposes command methods', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository()
  });

  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(Object.keys(service), SERVICE_METHODS);

  for (const method of SERVICE_METHODS) {
    assert.equal(typeof service[method], 'function');
  }

  assert.throws(() => {
    service.getTranslationRequest = () => null;
  }, TypeError);
});

test('createTranslationRequest creates domain object and returns repository result unchanged', () => {
  const calls = [];
  const repositoryResult = { id: 'stored-request-1' };
  const payload = requestPayload({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ text: 'hello', sequence: 0 }]
    }
  });
  const payloadBefore = structuredClone(payload);
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationRequest(request) {
        calls.push(request);
        return repositoryResult;
      }
    })
  });

  const result = service.createTranslationRequest(payload);

  assert.strictEqual(result, repositoryResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0] instanceof TranslationRequest, true);
  assert.equal(calls[0].targetLanguageCode, 'ZH-hant-custom');
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.deepEqual(payload, payloadBefore);
});

test('createTranslationRequest does not swallow domain validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        throw new Error('repository should not be called');
      }
    })
  });

  assert.throws(
    () =>
      service.createTranslationRequest({
        ...requestPayload(),
        targetLanguageCode: ''
      }),
    /targetLanguageCode/
  );
});

test('createTranslationExecution persists created and queued executions, enqueues the job, and returns queued execution', async () => {
  const calls = [];
  const jobs = [];
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        calls.push(['createTranslationExecution', execution]);
        return execution;
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return execution;
      }
    }),
    translationExecutionQueue: { enqueue(job) { jobs.push(job); }, dequeue() { return null; }, size() { return 0; } }
  });

  const result = await service.createTranslationExecution(executionPayload());

  assert.equal(result.status, 'queued');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'createTranslationExecution');
  assert.equal(calls[0][1] instanceof TranslationExecution, true);
  assert.equal(Object.isFrozen(calls[0][1]), true);
  assert.equal(calls[0][1].status, 'created');
  assert.equal(calls[1][1].status, 'queued');
  assert.deepEqual(jobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('createTranslationExecution forwards providerKey to TranslationExecution', async () => {
  let createdExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        createdExecution = execution;
        return execution;
      }
    })
  });

  const result = await service.createTranslationExecution(executionPayload({ providerKey: 'gemini' }));

  assert.equal(result.status, 'queued');
  assert.equal(createdExecution instanceof TranslationExecution, true);
  assert.equal(createdExecution.providerKey, 'gemini');
  assert.equal(createdExecution.status, 'created');
});

test('createTranslationExecution preserves undefined providerKey', async () => {
  let createdExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        createdExecution = execution;
        return execution;
      }
    })
  });

  await service.createTranslationExecution(executionPayload());

  assert.equal(createdExecution.providerKey, undefined);
});

test('createTranslationExecution propagates providerKey validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution() {
        throw new Error('repository should not be called');
      }
    })
  });

  assert.throws(() => service.createTranslationExecution(executionPayload({ providerKey: '' })), {
    name: 'RangeError',
    message: 'providerKey must not be empty'
  });
});

test('createTranslationExecution does not swallow domain validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository()
  });

  assert.throws(
    () =>
      service.createTranslationExecution({
        ...executionPayload(),
        startedAt: undefined
      }),
    /startedAt/
  );
});

test('updateTranslationExecution reads, transitions, updates, and returns repository result unchanged', () => {
  const originalExecution = new TranslationExecution(executionPayload());
  const repositoryResult = { id: 'updated-execution-1' };
  const calls = [];
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution(executionId) {
        calls.push(['getTranslationExecution', executionId]);
        return originalExecution;
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return repositoryResult;
      }
    })
  });

  const result = service.updateTranslationExecution({
    executionId: 'execution-1',
    transition: 'start',
    startedAt: 1100
  });

  assert.strictEqual(result, repositoryResult);
  assert.deepEqual(calls[0], ['getTranslationExecution', 'execution-1']);
  assert.equal(calls[1][0], 'updateTranslationExecution');
  assert.equal(calls[1][1] instanceof TranslationExecution, true);
  assert.notStrictEqual(calls[1][1], originalExecution);
  assert.equal(calls[1][1].status, 'running');
  assert.equal(calls[1][1].startedAt, 1100);
  assert.equal(Object.isFrozen(calls[1][1]), true);
  assert.equal(originalExecution.status, 'created');
  assert.equal(originalExecution.startedAt, 1000);
});

test('updateTranslationExecution supports complete and fail transition payloads', () => {
  const runningExecution = new TranslationExecution(executionPayload()).start(1100);

  assert.equal(runTransition(runningExecution, { transition: 'complete', completedAt: 1200 }).status, 'completed');
  assert.equal(
    runTransition(runningExecution, {
      transition: 'fail',
      failureInfo: { reason: 'provider_error' },
      completedAt: 1200
    }).status,
    'failed'
  );
  assert.equal(runningExecution.status, 'running');
});

test('updateTranslationExecution throws deterministic error when execution is not found', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return null;
      }
    })
  });

  assert.throws(
    () =>
      service.updateTranslationExecution({
        executionId: 'execution-missing',
        transition: 'start',
        startedAt: 1100
      }),
    /TranslationExecution execution-missing was not found/
  );
});

test('updateTranslationExecution fails for unsupported transition name', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return new TranslationExecution(executionPayload());
      }
    })
  });

  assert.throws(
    () =>
      service.updateTranslationExecution({
        executionId: 'execution-1',
        transition: 'transitionTo',
        status: 'running'
      }),
    /Unsupported TranslationExecution transition/
  );
});

test('updateTranslationExecution does not swallow illegal domain transitions', () => {
  const completedExecution = new TranslationExecution({
    ...executionPayload(),
    status: 'completed',
    completedAt: 1200
  });
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return completedExecution;
      }
    })
  });

  assert.throws(
    () =>
      service.updateTranslationExecution({
        executionId: 'execution-1',
        transition: 'fail',
        failureInfo: { reason: 'later' },
        completedAt: 1300
      }),
    /transition/
  );
  assert.equal(completedExecution.status, 'completed');
});

test('updateTranslationExecution propagates repository read and update errors unchanged', async () => {
  const readError = new Error('read failed');
  const updateError = new Error('update failed');
  const asyncReadError = new Error('async read failed');
  const asyncUpdateError = new Error('async update failed');

  assert.throws(
    () =>
      createTranslationCommandService({
        translationRepository: translationRepository({
          getTranslationExecution() {
            throw readError;
          }
        })
      }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    readError
  );

  assert.throws(
    () =>
      createTranslationCommandService({
        translationRepository: translationRepository({
          getTranslationExecution() {
            return new TranslationExecution(executionPayload());
          },
          updateTranslationExecution() {
            throw updateError;
          }
        })
      }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    updateError
  );

  await assert.rejects(
    createTranslationCommandService({
      translationRepository: translationRepository({
        getTranslationExecution() {
          return Promise.reject(asyncReadError);
        }
      })
    }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    asyncReadError
  );

  await assert.rejects(
    createTranslationCommandService({
      translationRepository: translationRepository({
        getTranslationExecution() {
          return Promise.resolve(new TranslationExecution(executionPayload()));
        },
        updateTranslationExecution() {
          return Promise.reject(asyncUpdateError);
        }
      })
    }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    asyncUpdateError
  );
});

test('updateTranslationExecution supports async repository read and update path', async () => {
  const repositoryResult = { id: 'async-updated-execution-1' };
  const calls = [];
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution(executionId) {
        calls.push(['getTranslationExecution', executionId]);
        return Promise.resolve(new TranslationExecution(executionPayload()));
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return Promise.resolve(repositoryResult);
      }
    })
  });

  const resultPromise = service.updateTranslationExecution({
    executionId: 'execution-1',
    transition: 'start',
    startedAt: 1100
  });

  assert.equal(typeof resultPromise.then, 'function');
  assert.strictEqual(await resultPromise, repositoryResult);
  assert.deepEqual(calls[0], ['getTranslationExecution', 'execution-1']);
  assert.equal(calls[1][1].status, 'running');
});

test('createTranslationOutput creates domain object and returns repository result unchanged', () => {
  const calls = [];
  const repositoryResult = { id: 'stored-output-1' };
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationOutput(output) {
        calls.push(['createTranslationOutput', output]);
        return repositoryResult;
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return null;
      }
    })
  });

  const result = service.createTranslationOutput(outputPayload());

  assert.strictEqual(result, repositoryResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'createTranslationOutput');
  assert.equal(calls[0][1] instanceof TranslationOutput, true);
  assert.equal(Object.isFrozen(calls[0][1]), true);
});

test('createTranslationOutput does not swallow domain validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository()
  });

  assert.throws(
    () =>
      service.createTranslationOutput({
        ...outputPayload(),
        translatedText: ''
      }),
    /translatedText/
  );
});

test('cancel queued execution persists the immutable cancelled transition without operating the queue', async () => {
  const queued = new TranslationExecution(executionPayload({ providerKey: 'gemini' })).queue();
  let updatedExecution;
  const queue = queueSpy();
  const service = createCancelQueuedTranslationExecutionService({
    translationRepository: {
      findExecutionById(id) {
        assert.equal(id, queued.id);
        return queued;
      },
      updateTranslationExecution(execution) {
        updatedExecution = execution;
        return execution;
      }
    },
    clock: () => 1200
  });

  const result = await service.cancelQueuedExecution({ executionId: queued.id });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.completedAt, 1200);
  assert.equal(result.providerKey, 'gemini');
  assert.equal(result.providerIdempotencyKey, queued.providerIdempotencyKey);
  assert.equal(updatedExecution, result);
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queue.calls, []); // Durable/active queue removal is intentionally deferred.
});

test('cancel queued execution preserves deterministic failures and does not rewrite non-queued or missing executions', async () => {
  for (const execution of [
    new TranslationExecution(executionPayload()),
    new TranslationExecution(executionPayload()).queue().start(1100),
    new TranslationExecution(executionPayload()).queue().start(1100).complete(1200),
    new TranslationExecution(executionPayload()).queue().start(1100).fail({ reason: 'provider_error' }, 1200),
    new TranslationExecution(executionPayload()).queue().cancel(1200)
  ]) {
    let updates = 0;
    const service = createCancelQueuedTranslationExecutionService({
      translationRepository: {
        findExecutionById() { return execution; },
        updateTranslationExecution() { updates += 1; }
      },
      clock: () => 1300
    });
    await assert.rejects(
      service.cancelQueuedExecution({ executionId: execution.id }),
      /status transition from .* to cancelled is not allowed/
    );
    assert.equal(updates, 0);
  }

  const service = createCancelQueuedTranslationExecutionService({
    translationRepository: { findExecutionById() { return null; }, updateTranslationExecution() { assert.fail('must not update'); } },
    clock: () => 1300
  });
  await assert.rejects(service.cancelQueuedExecution({ executionId: 'missing-execution' }), /TranslationExecution missing-execution was not found/);
});

test('manual retry persists a distinct queued execution, then enqueues only its identifiers without rewriting the failed source', async () => {
  const failed = new TranslationExecution(executionPayload({ providerKey: 'gemini' }))
    .queue()
    .start(1100)
    .markProviderAttemptInFlight(1110)
    .markProviderAttemptFailed(1150)
    .fail({ reason: 'provider_error', attempt: 1 }, 1200);
  const request = new TranslationRequest(requestPayload());
  const created = [];
  const jobs = [];
  const service = createManualRetryFailedTranslationExecutionService({
    translationRepository: {
      findExecutionById() { return failed; },
      findRequestById() { return request; },
      createTranslationExecution(execution) { created.push(execution); return execution; }
    },
    translationExecutionQueue: queueSpy({ enqueue(job) { jobs.push(job); } }),
    idGenerator: () => 'execution-retry-1',
    clock: () => 1300
  });

  const retry = await service.retryFailedExecution({ executionId: failed.id });

  assert.equal(retry.status, 'queued');
  assert.equal(retry.id, 'execution-retry-1');
  assert.notEqual(retry.id, failed.id);
  assert.equal(retry.translationRequestId, failed.translationRequestId);
  assert.equal(retry.providerKey, failed.providerKey);
  assert.equal(retry.providerIdempotencyKey, 'translation-execution:execution-retry-1');
  assert.deepEqual(created, [retry]);
  assert.deepEqual(jobs, [{ executionId: retry.id, requestId: failed.translationRequestId }]);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failureInfo, { reason: 'provider_error', attempt: 1 });
  assert.equal(failed.providerAttemptStatus, 'failed');
  assert.equal(failed.providerAttemptedAt, 1110);
  assert.equal(failed.providerCompletedAt, 1150);
});

test('manual retry rejects ineligible, missing execution, and missing request sources without persistence or queue activity', async () => {
  for (const execution of [
    new TranslationExecution(executionPayload()),
    new TranslationExecution(executionPayload()).queue(),
    new TranslationExecution(executionPayload()).queue().start(1100),
    new TranslationExecution(executionPayload()).queue().start(1100).complete(1200),
    new TranslationExecution(executionPayload()).queue().cancel(1200)
  ]) {
    const calls = [];
    const service = retryService({ execution, calls });
    await assert.rejects(service.retryFailedExecution({ executionId: execution.id }), /is not eligible for manual retry/);
    assert.deepEqual(calls, [['findExecutionById', execution.id]]);
  }

  const missingExecutionCalls = [];
  await assert.rejects(retryService({ execution: null, calls: missingExecutionCalls }).retryFailedExecution({ executionId: 'missing-execution' }), /TranslationExecution missing-execution was not found/);
  assert.deepEqual(missingExecutionCalls, [['findExecutionById', 'missing-execution']]);

  const missingRequestCalls = [];
  const failed = new TranslationExecution(executionPayload()).queue().start(1100).fail({ reason: 'provider_error' }, 1200);
  await assert.rejects(retryService({ execution: failed, request: null, calls: missingRequestCalls }).retryFailedExecution({ executionId: failed.id }), /TranslationRequest request-1 was not found/);
  assert.deepEqual(missingRequestCalls, [['findExecutionById', failed.id], ['findRequestById', 'request-1']]);
});

test('manual retry retains the queued execution and propagates queue enqueue failure, matching submission persistence ordering', async () => {
  const failed = new TranslationExecution(executionPayload()).queue().start(1100).fail({ reason: 'provider_error' }, 1200);
  const created = [];
  const enqueueError = new Error('queue unavailable');
  const service = createManualRetryFailedTranslationExecutionService({
    translationRepository: {
      findExecutionById() { return failed; },
      findRequestById() { return new TranslationRequest(requestPayload()); },
      createTranslationExecution(execution) { created.push(execution); return execution; }
    },
    translationExecutionQueue: queueSpy({ enqueue() { throw enqueueError; } }),
    idGenerator: () => 'execution-retry-1',
    clock: () => 1300
  });

  await assert.rejects(service.retryFailedExecution({ executionId: failed.id }), enqueueError);
  assert.deepEqual(created.map((execution) => ({ id: execution.id, status: execution.status })), [
    { id: 'execution-retry-1', status: 'queued' }
  ]);
});

test('create methods preserve sync and async repository behavior', async () => {
  const requestResult = { id: 'sync-request-result' };
  const executionResult = { id: 'async-execution-result' };
  const outputResult = { id: 'async-output-result' };
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        return requestResult;
      },
      createTranslationExecution() {
        return Promise.resolve(executionResult);
      },
      createTranslationOutput() {
        return Promise.resolve(outputResult);
      }
    })
  });

  assert.strictEqual(service.createTranslationRequest(requestPayload()), requestResult);
  assert.equal((await service.createTranslationExecution(executionPayload())).status, 'queued');
  assert.strictEqual(await service.createTranslationOutput(outputPayload()), outputResult);
});

function runTransition(execution, transitionPayload) {
  let updatedExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return execution;
      },
      updateTranslationExecution(nextExecution) {
        updatedExecution = nextExecution;
        return nextExecution;
      }
    })
  });

  service.updateTranslationExecution({
    executionId: execution.id,
    ...transitionPayload
  });

  return updatedExecution;
}

function translationRepository(overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      function createTranslationRequest(request) {
        return request;
      },
    getTranslationRequest:
      overrides.getTranslationRequest ||
      function getTranslationRequest() {
        return null;
      },
    updateTranslationRequest:
      overrides.updateTranslationRequest ||
      function updateTranslationRequest(request) {
        return request;
      },
    listTranslationRequestsBySession:
      overrides.listTranslationRequestsBySession ||
      function listTranslationRequestsBySession() {
        return [];
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      function createTranslationExecution(execution) {
        return execution;
      },
    getTranslationExecution:
      overrides.getTranslationExecution ||
      function getTranslationExecution() {
        return null;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      function updateTranslationExecution(execution) {
        return execution;
      },
    listTranslationExecutionsByRequest:
      overrides.listTranslationExecutionsByRequest ||
      function listTranslationExecutionsByRequest() {
        return [];
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      function createTranslationOutput(output) {
        return output;
      },
    listTranslationOutputsByExecution:
      overrides.listTranslationOutputsByExecution ||
      function listTranslationOutputsByExecution() {
        return [];
      },
    listTranslationOutputsBySession:
      overrides.listTranslationOutputsBySession ||
      function listTranslationOutputsBySession() {
        return [];
      },
    listTranslationOutputsByRequest:
      overrides.listTranslationOutputsByRequest ||
      function listTranslationOutputsByRequest() {
        return [];
      },
    getTranslationOutput:
      overrides.getTranslationOutput ||
      function getTranslationOutput() {
        return null;
      }
  };
}

function domainEventPublisher(overrides = {}) {
  return {
    publish:
      overrides.publish ||
      function publish() {
        return undefined;
      }
  };
}

function queueSpy(overrides = {}) {
  const calls = [];
  return {
    calls,
    enqueue(job) {
      calls.push(['enqueue', job]);
      return overrides.enqueue?.(job);
    },
    dequeue() { calls.push(['dequeue']); return null; },
    size() { calls.push(['size']); return 0; }
  };
}

function retryService({ execution, request = new TranslationRequest(requestPayload()), calls }) {
  return createManualRetryFailedTranslationExecutionService({
    translationRepository: {
      findExecutionById(executionId) { calls.push(['findExecutionById', executionId]); return execution; },
      findRequestById(requestId) { calls.push(['findRequestById', requestId]); return request; },
      createTranslationExecution() { calls.push(['createTranslationExecution']); }
    },
    translationExecutionQueue: queueSpy({ enqueue() { calls.push(['enqueue']); } }),
    idGenerator: () => 'execution-retry-1',
    clock: () => 1300
  });
}

function requestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'ZH-hant-custom',
    createdAt: 1000,
    ...overrides
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
  };
}

function outputPayload(overrides = {}) {
  return {
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'translated text',
    targetLanguageCode: 'ja',
    createdAt: 1000,
    ...overrides
  };
}
