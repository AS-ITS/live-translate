import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import { TranslationExecution, TranslationOutput } from '../../src/domain/translation/index.js';

test('success persists created queued running completed lifecycle around provider and output', async () => {
  const calls = [];
  const providerInputs = [];
  const resolverInputs = [];
  const resolvedProvider = {
    async execute(input) {
      calls.push(['provider.execute', input]);
      providerInputs.push(input);
      return providerResult({ translatedText: 'Bonjour' });
    }
  };
  const dependencies = serviceDependencies({
    calls,
    translationExecutionProviderResolver: {
      resolve(providerKey) {
        calls.push(['resolver.resolve', providerKey]);
        resolverInputs.push(providerKey);
        return resolvedProvider;
      }
    }
  });
  const payload = executionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'fake'
  });

  const result = await dependencies.service.createTranslationExecution(payload);

  assert.deepEqual(resolverInputs, ['fake']);
  assert.equal(providerInputs.length, 1);
  assert.deepEqual(providerInputs[0], {
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'fake'
  });
  assert.equal(result instanceof TranslationExecution, true);
  assert.deepEqual(callNames(calls), [
    'createTranslationExecution',
    'updateTranslationExecution',
    'updateTranslationExecution',
    'resolver.resolve',
    'provider.execute',
    'createTranslationOutput',
    'updateTranslationExecution'
  ]);
  assert.deepEqual(executionStatuses(calls), ['created', 'queued', 'running', 'completed']);
  assert.equal(callIndex(calls, 'provider.execute') > statusCallIndex(calls, 'running'), true);
  assert.equal(callIndex(calls, 'createTranslationOutput') < statusCallIndex(calls, 'completed'), true);

  const createdExecution = calls[0][1];
  const queuedExecution = calls[1][1];
  const runningExecution = calls[2][1];
  const output = calls[5][1];
  const completedExecution = calls[6][1];

  assert.equal(createdExecution.status, 'created');
  assert.equal(queuedExecution.status, 'queued');
  assert.equal(runningExecution.status, 'running');
  assert.equal(output instanceof TranslationOutput, true);
  assert.equal(output.translatedText, 'Bonjour');
  assert.equal(output.targetLanguageCode, 'fr');
  assert.equal(completedExecution instanceof TranslationExecution, true);
  assert.equal(completedExecution.status, 'completed');
  assert.equal(completedExecution.completedAt, payload.startedAt);
});

test('preserves omitted optional provider input fields as undefined', async () => {
  let providerInput;
  const dependencies = serviceDependencies({
    translationExecutionProviderResolver: {
      resolve() {
        return {
          async execute(input) {
            providerInput = input;
            return providerResult();
          }
        };
      }
    }
  });

  const payload = executionPayload({
    sourceText: 'hello',
    targetLanguageCode: 'fr'
  });
  delete payload.sourceLanguageCode;

  await dependencies.service.createTranslationExecution(payload);

  assert.deepEqual(providerInput, {
    sourceText: 'hello',
    sourceLanguageCode: undefined,
    targetLanguageCode: 'fr',
    providerKey: undefined
  });
  assert.equal(Object.hasOwn(providerInput, 'sourceLanguageCode'), true);
  assert.equal(Object.hasOwn(providerInput, 'providerKey'), true);
});

test('uses provider-returned translatedText without modification', async () => {
  let createdOutput;
  const dependencies = serviceDependencies({
    translationRepository: translationRepository({
      createTranslationOutput(output) {
        createdOutput = output;
        return output;
      }
    }),
    translationExecutionProviderResolver: {
      resolve() {
        return {
          async execute() {
            return providerResult({ translatedText: '  Provider text  ' });
          }
        };
      }
    }
  });

  await dependencies.service.createTranslationExecution(executionPayload());

  assert.equal(createdOutput.translatedText, '  Provider text  ');
});

test('provider failures follow queued running failed lifecycle, skip output, and propagate original error', async () => {
  const error = new Error('provider failed');
  const calls = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionProviderResolver: {
      resolve(providerKey) {
        calls.push(['resolver.resolve', providerKey]);
        return {
          async execute() {
            calls.push(['provider.execute']);
            throw error;
          }
        };
      }
    }
  });

  await assert.rejects(dependencies.service.createTranslationExecution(executionPayload()), (actualError) => {
    return actualError === error;
  });

  assert.deepEqual(callNames(calls), [
    'createTranslationExecution',
    'updateTranslationExecution',
    'updateTranslationExecution',
    'resolver.resolve',
    'provider.execute',
    'updateTranslationExecution'
  ]);
  assert.deepEqual(executionStatuses(calls), ['created', 'queued', 'running', 'failed']);
  assert.equal(callIndex(calls, 'provider.execute') > statusCallIndex(calls, 'running'), true);
  assert.deepEqual(calls[3], ['resolver.resolve', undefined]);
  assert.equal(calls.filter((call) => call[0] === 'provider.execute').length, 1);
  assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);

  const createdExecution = calls[0][1];
  const queuedExecution = calls[1][1];
  const runningExecution = calls[2][1];
  const failedExecution = calls[5][1];

  assert.equal(createdExecution.status, 'created');
  assert.equal(queuedExecution.status, 'queued');
  assert.equal(runningExecution.status, 'running');
  assert.equal(failedExecution instanceof TranslationExecution, true);
  assert.equal(failedExecution.status, 'failed');
  assert.notEqual(failedExecution.status, 'completed');
  assert.deepEqual(failedExecution.failureInfo, { reason: 'provider_execution_failed' });
});

test('resolver failures mark execution failed, skip provider and output, and propagate original error', async () => {
  const error = new Error('translation execution provider not found: missing');
  const calls = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionProviderResolver: {
      resolve(providerKey) {
        calls.push(['resolver.resolve', providerKey]);
        throw error;
      }
    }
  });

  await assert.rejects(
    dependencies.service.createTranslationExecution(
      executionPayload({
        providerKey: 'missing'
      })
    ),
    (actualError) => actualError === error
  );

  assert.deepEqual(callNames(calls), [
    'createTranslationExecution',
    'updateTranslationExecution',
    'updateTranslationExecution',
    'resolver.resolve',
    'updateTranslationExecution'
  ]);
  assert.deepEqual(calls[3], ['resolver.resolve', 'missing']);
  assert.equal(calls.some((call) => call[0] === 'provider.execute'), false);
  assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);

  const failedExecution = calls[4][1];
  assert.equal(failedExecution instanceof TranslationExecution, true);
  assert.equal(failedExecution.status, 'failed');
  assert.deepEqual(failedExecution.failureInfo, { reason: 'provider_execution_failed' });
});

test('resolves provider during execution orchestration without dispatching', async () => {
  const calls = [];
  const resolvedProvider = {
    async execute(input) {
      calls.push(['provider.execute', input]);
      return providerResult();
    }
  };
  const dependencies = serviceDependencies({
    calls,
    translationExecutionDispatcher: {
      async dispatch() {
        calls.push(['dispatcher.dispatch']);
        throw new Error('dispatcher should not be called');
      }
    },
    translationExecutionProviderResolver: {
      resolve(providerKey) {
        calls.push(['resolver.resolve', providerKey]);
        return resolvedProvider;
      }
    }
  });

  await dependencies.service.createTranslationExecution(
    executionPayload({
      providerKey: 'unregistered-provider',
      sourceText: 'hello',
      targetLanguageCode: 'fr'
    })
  );

  assert.equal(calls.some((call) => call[0] === 'dispatcher.dispatch'), false);
  assert.deepEqual(callNames(calls), [
    'createTranslationExecution',
    'updateTranslationExecution',
    'updateTranslationExecution',
    'resolver.resolve',
    'provider.execute',
    'createTranslationOutput',
    'updateTranslationExecution'
  ]);
  assert.deepEqual(calls[3], ['resolver.resolve', 'unregistered-provider']);
});

test('delegates provider execution orchestration to translationExecutionRunner', async () => {
  const calls = [];
  let runnerInput;
  const dependencies = serviceDependencies({
    calls,
    translationExecutionProviderResolver: {
      resolve() {
        throw new Error('resolver should not be called when explicit runner is supplied');
      }
    },
    translationExecutionRunner: {
      async execute(input) {
        calls.push(['runner.execute', input]);
        runnerInput = input;
        return input.repositoryResult;
      }
    }
  });
  const payload = executionPayload();

  const result = await dependencies.service.createTranslationExecution(payload);

  assert.equal(calls.filter((call) => call[0] === 'runner.execute').length, 1);
  assert.equal(calls.some((call) => call[0] === 'provider.execute'), false);
  assert.equal(runnerInput.execution instanceof TranslationExecution, true);
  assert.equal(runnerInput.execution.status, 'running');
  assert.strictEqual(runnerInput.payload, payload);
  assert.strictEqual(result, calls[0][1]);
});

function serviceDependencies(options = {}) {
  const calls = options.calls ?? [];
  const repository = options.translationRepository ?? translationRepository({ calls });
  const service = createTranslationCommandService({
    translationRepository: repository,
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: options.translationExecutionDispatcher,
    translationExecutionProviderResolver: options.translationExecutionProviderResolver,
    translationExecutionRunner: options.translationExecutionRunner,
    retryPolicy: options.retryPolicy
  });

  return { calls, repository, service };
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

function providerResult(overrides = {}) {
  return {
    translatedText: 'translated text',
    detectedSourceLanguageCode: 'en',
    ...overrides
  };
}

function callNames(calls) {
  return calls.map((call) => call[0]);
}

function callIndex(calls, name) {
  return callNames(calls).indexOf(name);
}

function executionStatuses(calls) {
  return calls
    .filter((call) => ['createTranslationExecution', 'updateTranslationExecution'].includes(call[0]))
    .map((call) => call[1].status);
}

function statusCallIndex(calls, status) {
  return calls.findIndex(
    (call) => ['createTranslationExecution', 'updateTranslationExecution'].includes(call[0]) && call[1].status === status
  );
}
