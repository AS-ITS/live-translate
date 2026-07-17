import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';

test('createTranslationExecution persists created then queued and returns queued execution', async () => {
  const calls = [];
  const dependencies = serviceDependencies({ calls });

  const result = await dependencies.service.createTranslationExecution(executionPayload());

  assert.equal(result instanceof TranslationExecution, true);
  assert.equal(result.status, 'queued');
  assert.deepEqual(callNames(calls), ['createTranslationExecution', 'updateTranslationExecution', 'queue.enqueue']);
  assert.deepEqual(executionStatuses(calls), ['created', 'queued']);
});

test('queue enqueue is called once with execution and request identifiers only', async () => {
  const queueJobs = [];
  const dependencies = serviceDependencies({
    translationExecutionQueue: {
      enqueue(job) {
        queueJobs.push(job);
      },
      dequeue() {
        return undefined;
      },
      isEmpty() {
        return true;
      },
      size() {
        return 0;
      }
    }
  });

  await dependencies.service.createTranslationExecution(
    executionPayload({
      id: 'execution-42',
      translationRequestId: 'request-42'
    })
  );

  assert.deepEqual(queueJobs, [
    {
      executionId: 'execution-42',
      requestId: 'request-42'
    }
  ]);
  assert.deepEqual(Object.keys(queueJobs[0]), ['executionId', 'requestId']);
});

test('provider resolver provider dispatcher and runner are not called during request submission', async () => {
  const calls = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionDispatcher: {
      dispatch() {
        calls.push(['dispatcher.dispatch']);
        throw new Error('dispatcher should not be called');
      }
    },
    translationExecutionProviderResolver: {
      resolve() {
        calls.push(['resolver.resolve']);
        throw new Error('resolver should not be called');
      }
    },
    translationExecutionRunner: {
      execute() {
        calls.push(['runner.execute']);
        throw new Error('runner should not be called');
      }
    }
  });

  await dependencies.service.createTranslationExecution(executionPayload());

  assert.equal(calls.some((call) => call[0] === 'dispatcher.dispatch'), false);
  assert.equal(calls.some((call) => call[0] === 'resolver.resolve'), false);
  assert.equal(calls.some((call) => call[0] === 'provider.execute'), false);
  assert.equal(calls.some((call) => call[0] === 'runner.execute'), false);
});

test('request submission does not create output or write running completed or failed states', async () => {
  const calls = [];
  const dependencies = serviceDependencies({ calls });

  await dependencies.service.createTranslationExecution(executionPayload());

  assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);
  assert.equal(executionStatuses(calls).includes('running'), false);
  assert.equal(executionStatuses(calls).includes('completed'), false);
  assert.equal(executionStatuses(calls).includes('failed'), false);
});

test('enqueue error propagates unchanged after created and queued persistence', async () => {
  const enqueueError = new Error('queue unavailable');
  const calls = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionQueue: {
      enqueue(job) {
        calls.push(['queue.enqueue', job]);
        throw enqueueError;
      },
      dequeue() {
        return undefined;
      },
      isEmpty() {
        return true;
      },
      size() {
        return 0;
      }
    }
  });

  await assert.rejects(
    dependencies.service.createTranslationExecution(executionPayload()),
    (actualError) => actualError === enqueueError
  );

  assert.deepEqual(callNames(calls), ['createTranslationExecution', 'updateTranslationExecution', 'queue.enqueue']);
  assert.deepEqual(executionStatuses(calls), ['created', 'queued']);
  assert.equal(executionStatuses(calls).includes('failed'), false);
});

test('repository create receives the unchanged created execution domain object', async () => {
  let createdExecution;
  const dependencies = serviceDependencies({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        createdExecution = execution;
        return execution;
      }
    })
  });
  const payload = executionPayload({
    id: 'execution-created',
    translationRequestId: 'request-created',
    startedAt: 2000,
    providerKey: 'gemini'
  });

  await dependencies.service.createTranslationExecution(payload);

  assert.equal(createdExecution instanceof TranslationExecution, true);
  assert.equal(createdExecution.id, 'execution-created');
  assert.equal(createdExecution.translationRequestId, 'request-created');
  assert.equal(createdExecution.startedAt, 2000);
  assert.equal(createdExecution.providerKey, 'gemini');
  assert.equal(createdExecution.status, 'created');
});

function serviceDependencies(options = {}) {
  const calls = options.calls ?? [];
  const repository = options.translationRepository ?? translationRepository({ calls });
  const queue =
    options.translationExecutionQueue ??
    {
      enqueue(job) {
        calls.push(['queue.enqueue', job]);
      },
      dequeue() {
        return undefined;
      },
      isEmpty() {
        return true;
      },
      size() {
        return 0;
      }
    };
  const service = createTranslationCommandService({
    translationRepository: repository,
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: options.translationExecutionDispatcher,
    translationExecutionQueue: queue,
    translationExecutionProviderResolver: options.translationExecutionProviderResolver,
    translationExecutionRunner: options.translationExecutionRunner,
    retryPolicy: options.retryPolicy
  });

  return { calls, repository, queue, service };
}

function translationRepository(overrides = {}) {
  const calls = overrides.calls ?? [];

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
        calls.push(['createTranslationExecution', execution]);
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
        calls.push(['updateTranslationExecution', execution]);
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
        calls.push(['createTranslationOutput', output]);
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

function domainEventPublisher() {
  return {
    publish() {
      return undefined;
    }
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    ...overrides
  };
}

function callNames(calls) {
  return calls.map((call) => call[0]);
}

function executionStatuses(calls) {
  return calls
    .filter((call) => ['createTranslationExecution', 'updateTranslationExecution'].includes(call[0]))
    .map((call) => call[1].status);
}
