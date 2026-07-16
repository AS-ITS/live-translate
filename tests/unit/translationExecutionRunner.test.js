import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionRunner } from '../../src/application/translationExecutionRunner.js';
import { createRetryPolicy } from '../../src/application/translation/retryPolicy.js';
import { TranslationExecution, TranslationOutput } from '../../src/domain/translation/index.js';

test('runner invokes provider exactly once with unchanged input', async () => {
  const providerInputs = [];
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository(),
    translationExecutionProvider: {
      async execute(input) {
        providerInputs.push(input);
        return providerResult();
      }
    }
  });

  await runner.execute(runnerInput({ payload: executionPayload({ providerKey: 'fake' }) }));

  assert.equal(providerInputs.length, 1);
  assert.deepEqual(providerInputs[0], {
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'fake'
  });
});

test('successful execution creates one TranslationOutput', async () => {
  const calls = [];
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: provider({ translatedText: 'Bonjour' })
  });

  await runner.execute(runnerInput());

  const outputCalls = calls.filter((call) => call[0] === 'createTranslationOutput');
  assert.equal(outputCalls.length, 1);
  assert.equal(outputCalls[0][1] instanceof TranslationOutput, true);
  assert.equal(outputCalls[0][1].translatedText, 'Bonjour');
  assert.equal(outputCalls[0][1].targetLanguageCode, 'fr');
});

test('successful execution marks execution completed', async () => {
  const calls = [];
  const payload = executionPayload({ completedAt: 2000 });
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: provider()
  });

  await runner.execute(runnerInput({ payload }));

  const updateCalls = calls.filter((call) => call[0] === 'updateTranslationExecution');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1] instanceof TranslationExecution, true);
  assert.equal(updateCalls[0][1].status, 'completed');
  assert.equal(updateCalls[0][1].completedAt, 2000);
});

test('provider failure marks execution failed and skips output creation', async () => {
  const calls = [];
  const error = new Error('provider failed');
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: {
      async execute() {
        calls.push(['provider.execute']);
        throw error;
      }
    }
  });

  await assert.rejects(runner.execute(runnerInput()), error);

  assert.equal(calls.filter((call) => call[0] === 'provider.execute').length, 1);
  assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);

  const updateCalls = calls.filter((call) => call[0] === 'updateTranslationExecution');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1].status, 'failed');
  assert.deepEqual(updateCalls[0][1].failureInfo, { reason: 'provider_execution_failed' });
});

test('provider failure rethrows the original provider error', async () => {
  const error = new Error('original provider error');
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository(),
    translationExecutionProvider: {
      async execute() {
        throw error;
      }
    }
  });

  await assert.rejects(runner.execute(runnerInput()), (actualError) => actualError === error);
});

test('retryPolicy is accepted but does not alter execution behavior', async () => {
  let canRetryCalls = 0;
  let nextDelayCalls = 0;
  const retryPolicy = Object.freeze({
    maxRetries: 5,
    canRetry() {
      canRetryCalls += 1;
      throw new Error('retry policy should not be evaluated yet');
    },
    nextDelay() {
      nextDelayCalls += 1;
      throw new Error('retry delay should not be evaluated yet');
    }
  });
  const calls = [];
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: provider(),
    retryPolicy
  });

  await runner.execute(runnerInput());

  assert.equal(canRetryCalls, 0);
  assert.equal(nextDelayCalls, 0);
  assert.equal(calls.filter((call) => call[0] === 'createTranslationOutput').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'updateTranslationExecution').length, 1);
});

test('provider is never executed more than once with default retry policy', async () => {
  let providerCalls = 0;
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository(),
    translationExecutionProvider: {
      async execute() {
        providerCalls += 1;
        throw new Error('provider failed');
      }
    },
    retryPolicy: createRetryPolicy()
  });

  await assert.rejects(runner.execute(runnerInput()), /provider failed/);

  assert.equal(providerCalls, 1);
});

function runnerInput(overrides = {}) {
  const payload = overrides.payload ?? executionPayload();
  const { completedAt, outputCreatedAt, outputId, outputSequence, sourceText, sourceLanguageCode, targetLanguageCode, ...executionInput } =
    payload;
  return {
    execution: new TranslationExecution(executionInput),
    payload,
    repositoryResult: overrides.repositoryResult ?? new TranslationExecution(executionInput),
    ...overrides
  };
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

function provider(overrides = {}) {
  return {
    async execute() {
      return providerResult(overrides);
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
