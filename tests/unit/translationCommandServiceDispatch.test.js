import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';

test('createTranslationExecution persists first, dispatches second, and returns the persisted execution', async () => {
  const calls = [];
  let persistedExecution;
  let dispatchedExecution;
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
    translationExecutionDispatcher: {
      async dispatch(execution) {
        dispatchedExecution = execution;
        calls.push('translationExecutionDispatcher.dispatch');
        return { ignored: true };
      }
    }
  });

  const result = await service.createTranslationExecution(executionPayload());

  assert.deepEqual(calls, [
    'repository.createTranslationExecution',
    'translationExecutionDispatcher.dispatch',
    'domainEventPublisher.publish'
  ]);
  assert.equal(persistedExecution instanceof TranslationExecution, true);
  assert.strictEqual(dispatchedExecution, persistedExecution);
  assert.strictEqual(result, persistedExecution);
});

test('dispatcher receives only the original TranslationExecution argument', async () => {
  let persistedExecution;
  let dispatchArguments;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: {
      async dispatch(...args) {
        dispatchArguments = args;
      }
    }
  });

  await service.createTranslationExecution(executionPayload());

  assert.equal(dispatchArguments.length, 1);
  assert.strictEqual(dispatchArguments[0], persistedExecution);
});

test('repository failure prevents dispatch', async () => {
  const repositoryError = new Error('repository failed');
  let dispatchCalls = 0;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution() {
        throw repositoryError;
      }
    }),
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: {
      async dispatch() {
        dispatchCalls += 1;
      }
    }
  });

  assert.throws(() => service.createTranslationExecution(executionPayload()), repositoryError);
  assert.equal(dispatchCalls, 0);
});

test('async repository failure prevents dispatch', async () => {
  const repositoryError = new Error('async repository failed');
  let dispatchCalls = 0;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution() {
        return Promise.reject(repositoryError);
      }
    }),
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: {
      async dispatch() {
        dispatchCalls += 1;
      }
    }
  });

  await assert.rejects(service.createTranslationExecution(executionPayload()), repositoryError);
  assert.equal(dispatchCalls, 0);
});

test('dispatcher failure propagates after repository success without retry or rollback', async () => {
  const dispatcherError = new Error('dispatch failed');
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
    translationExecutionDispatcher: {
      async dispatch(execution) {
        assert.strictEqual(execution, persistedExecution);
        calls.push('dispatch');
        throw dispatcherError;
      }
    }
  });

  await assert.rejects(service.createTranslationExecution(executionPayload()), dispatcherError);

  assert.deepEqual(calls, ['createTranslationExecution', 'dispatch']);
});

test('service waits for dispatch before publishing and resolving', async () => {
  const deferredDispatch = createDeferred();
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
    translationExecutionDispatcher: {
      dispatch(execution) {
        void execution;
        calls.push('dispatch');
        return deferredDispatch.promise;
      }
    }
  });

  const resultPromise = service.createTranslationExecution(executionPayload()).then((result) => {
    resolved = true;
    return result;
  });

  await Promise.resolve();

  assert.deepEqual(calls, ['createTranslationExecution', 'dispatch']);
  assert.equal(resolved, false);

  deferredDispatch.resolve();

  const result = await resultPromise;
  assert.equal(result instanceof TranslationExecution, true);
  assert.deepEqual(calls, ['createTranslationExecution', 'dispatch', 'publish']);
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
