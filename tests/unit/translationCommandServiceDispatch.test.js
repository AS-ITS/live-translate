import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';

test('createTranslationExecution persists created then queued, enqueues, and does not dispatch', async () => {
  const calls = [];
  let persistedExecution;
  const jobs = [];
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        calls.push('repository.createTranslationExecution');
        return execution;
      }
    }),
    domainEventPublisher: domainEventPublisher({
      publish() {
        calls.push('domainEventPublisher.publish');
      }
    }),
    translationExecutionQueue: {
      enqueue(job) { jobs.push(job); calls.push('queue.enqueue'); },
      dequeue() { return null; },
      size() { return 0; }
    },
    translationExecutionDispatcher: {
      async dispatch(execution) {
        dispatchedExecution = execution;
        calls.push('translationExecutionDispatcher.dispatch');
        return { ignored: true };
      }
    }
  });

  const result = await service.createTranslationExecution(executionPayload());

  assert.deepEqual(calls, ['repository.createTranslationExecution', 'domainEventPublisher.publish', 'domainEventPublisher.publish', 'queue.enqueue']);
  assert.equal(persistedExecution instanceof TranslationExecution, true);
  assert.equal(persistedExecution.status, 'created');
  assert.equal(result.status, 'queued');
  assert.deepEqual(jobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('submission does not invoke the dispatcher', async () => {
  let dispatchCalls = 0;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) { return execution; }
    }),
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: {
      async dispatch(...args) {
        void args;
        dispatchCalls += 1;
      }
    }
  });

  await service.createTranslationExecution(executionPayload());

  assert.equal(dispatchCalls, 0);
});

test('repository failure prevents queue enqueue', async () => {
  const repositoryError = new Error('repository failed');
  let enqueueCalls = 0;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution() {
        throw repositoryError;
      }
    }),
    domainEventPublisher: domainEventPublisher(),
    translationExecutionQueue: { enqueue() { enqueueCalls += 1; }, dequeue() { return null; }, size() { return 0; } }
  });

  assert.throws(() => service.createTranslationExecution(executionPayload()), repositoryError);
  assert.equal(enqueueCalls, 0);
});

test('async repository failure prevents queue enqueue', async () => {
  const repositoryError = new Error('async repository failed');
  let enqueueCalls = 0;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution() {
        return Promise.reject(repositoryError);
      }
    }),
    domainEventPublisher: domainEventPublisher(),
    translationExecutionQueue: { enqueue() { enqueueCalls += 1; }, dequeue() { return null; }, size() { return 0; } }
  });

  await assert.rejects(service.createTranslationExecution(executionPayload()), repositoryError);
  assert.equal(enqueueCalls, 0);
});

test('queue failure propagates after created and queued persistence without retry or rollback', async () => {
  const queueError = new Error('queue failed');
  const calls = [];
  let persistedExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        calls.push('createTranslationExecution');
        return execution;
      },
      updateTranslationExecution() {
        calls.push('updateTranslationExecution');
      }
    }),
    domainEventPublisher: domainEventPublisher({
      publish() {
        calls.push('publish');
      }
    }),
    translationExecutionQueue: { enqueue() { calls.push('enqueue'); throw queueError; }, dequeue() { return null; }, size() { return 0; } }
  });

  await assert.rejects(service.createTranslationExecution(executionPayload()), queueError);

  assert.deepEqual(calls, ['createTranslationExecution', 'publish', 'updateTranslationExecution', 'publish', 'enqueue']);
});

test('service waits for queue enqueue before resolving', async () => {
  const deferredEnqueue = createDeferred();
  const calls = [];
  let resolved = false;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        calls.push('createTranslationExecution');
        return execution;
      }
    }),
    domainEventPublisher: domainEventPublisher({
      publish() {
        calls.push('publish');
      }
    }),
    translationExecutionQueue: { enqueue() { calls.push('enqueue'); return deferredEnqueue.promise; }, dequeue() { return null; }, size() { return 0; } }
  });

  const resultPromise = service.createTranslationExecution(executionPayload()).then((result) => {
    resolved = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ['createTranslationExecution', 'publish', 'publish']);
  assert.equal(resolved, false);

  deferredEnqueue.resolve();

  const result = await resultPromise;
  assert.equal(result instanceof TranslationExecution, true);
  assert.deepEqual(calls, ['createTranslationExecution', 'publish', 'publish', 'enqueue']);
  assert.equal(resolved, true);
});

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

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
