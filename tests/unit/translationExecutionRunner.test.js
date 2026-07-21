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

test('idempotent output persistence retains one original output across repeated runner execution', async () => {
  const outputs = [];
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({
      createTranslationOutput(output) {
        const existingOutput = outputs.find((candidate) => candidate.executionId === output.executionId);
        if (existingOutput !== undefined) {
          return existingOutput;
        }

        outputs.push(output);
        return output;
      }
    }),
    translationExecutionProvider: provider({ translatedText: 'First translation' })
  });
  const input = runnerInput();

  await runner.execute(input);
  await runner.execute({
    ...input,
    payload: { ...input.payload, outputId: 'execution-1-output-duplicate', outputCreatedAt: 2000 }
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].id, 'execution-1-output-0');
  assert.equal(outputs[0].translatedText, 'First translation');
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

test('successful retry persists one output, completes once, and never marks failed', async () => {
  const calls = [];
  const providerCalls = [];
  const retryPolicy = createRetryPolicy({ maxRetries: 2 });
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: {
      async execute() {
        const attempt = providerCalls.length + 1;
        providerCalls.push(attempt);

        if (attempt < 3) {
          throw new Error(`attempt ${attempt} failed`);
        }

        return providerResult({ translatedText: 'successful attempt 3' });
      }
    },
    retryPolicy
  });

  await runner.execute(runnerInput());

  const outputCalls = calls.filter((call) => call[0] === 'createTranslationOutput');
  const updateCalls = calls.filter((call) => call[0] === 'updateTranslationExecution');

  assert.deepEqual(providerCalls, [1, 2, 3]);
  assert.equal(outputCalls.length, 1);
  assert.equal(outputCalls[0][1].translatedText, 'successful attempt 3');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1].status, 'completed');
  assert.equal(updateCalls.some((call) => call[1].status === 'failed'), false);
});

test('default production retry policy executes once, fails execution, and rethrows original error', async () => {
  const calls = [];
  const error = new Error('default policy provider failure');
  let providerCalls = 0;
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: {
      async execute() {
        providerCalls += 1;
        throw error;
      }
    },
    retryPolicy: createRetryPolicy({ maxRetries: 0 })
  });

  await assert.rejects(runner.execute(runnerInput()), (actualError) => actualError === error);

  const updateCalls = calls.filter((call) => call[0] === 'updateTranslationExecution');
  assert.equal(providerCalls, 1);
  assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1].status, 'failed');
  assert.equal(updateCalls.some((call) => call[1].status === 'completed'), false);
});

test('exhausted retry marks failed once, creates no output, and rethrows final provider error', async () => {
  const calls = [];
  const errors = [new Error('attempt 1 failed'), new Error('attempt 2 failed'), new Error('attempt 3 failed')];
  const providerCalls = [];
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: {
      async execute() {
        const attempt = providerCalls.length + 1;
        providerCalls.push(attempt);

        assert.equal(calls.some((call) => call[0] === 'updateTranslationExecution'), false);
        assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);

        throw errors[attempt - 1];
      }
    },
    retryPolicy: createRetryPolicy({ maxRetries: 2 })
  });

  await assert.rejects(runner.execute(runnerInput()), (actualError) => actualError === errors[2]);

  const outputCalls = calls.filter((call) => call[0] === 'createTranslationOutput');
  const updateCalls = calls.filter((call) => call[0] === 'updateTranslationExecution');

  assert.deepEqual(providerCalls, [1, 2, 3]);
  assert.equal(outputCalls.length, 0);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1].status, 'failed');
  assert.deepEqual(updateCalls[0][1].failureInfo, { reason: 'provider_execution_failed' });
  assert.equal(updateCalls.some((call) => call[1].status === 'completed'), false);
});

test('retryable intermediate failures do not persist failed, completed, or output state', async () => {
  const calls = [];
  const observedCallsDuringRetries = [];
  let providerCalls = 0;
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: {
      async execute() {
        providerCalls += 1;

        if (providerCalls <= 2) {
          observedCallsDuringRetries.push([...calls]);
          throw new Error(`retryable failure ${providerCalls}`);
        }

        assert.deepEqual(observedCallsDuringRetries, [[], []]);
        assert.equal(calls.length, 0);

        return providerResult({ translatedText: 'third attempt succeeded' });
      }
    },
    retryPolicy: createRetryPolicy({ maxRetries: 2 })
  });

  await runner.execute(runnerInput());

  const outputCalls = calls.filter((call) => call[0] === 'createTranslationOutput');
  const updateCalls = calls.filter((call) => call[0] === 'updateTranslationExecution');

  assert.equal(providerCalls, 3);
  assert.equal(outputCalls.length, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1].status, 'completed');
});

test('retry attempt boundary is exactly one provider execution plus maxRetries', async () => {
  for (const maxRetries of [0, 1, 2]) {
    const error = new Error(`maxRetries ${maxRetries} terminal failure`);
    let providerCalls = 0;
    const runner = createTranslationExecutionRunner({
      translationRepository: translationRepository(),
      translationExecutionProvider: {
        async execute() {
          providerCalls += 1;
          throw error;
        }
      },
      retryPolicy: createRetryPolicy({ maxRetries })
    });

    await assert.rejects(runner.execute(runnerInput()), (actualError) => actualError === error);

    assert.equal(providerCalls, 1 + maxRetries);
  }
});

test('retry stops immediately after first successful execution', async () => {
  let providerCalls = 0;
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository(),
    translationExecutionProvider: {
      async execute() {
        providerCalls += 1;

        if (providerCalls === 1) {
          throw new Error('first attempt failed');
        }

        if (providerCalls === 2) {
          return providerResult({ translatedText: 'second attempt succeeded' });
        }

        throw new Error('third execution should never occur');
      }
    },
    retryPolicy: createRetryPolicy({ maxRetries: 3 })
  });

  await runner.execute(runnerInput());

  assert.equal(providerCalls, 2);
});

test('retry policy is consulted after failures and delay value does not affect execution', async () => {
  const canRetryAttempts = [];
  const nextDelayAttempts = [];
  let providerCalls = 0;
  const retryPolicy = Object.freeze({
    canRetry(attempt) {
      canRetryAttempts.push(attempt);
      return attempt === 1;
    },
    nextDelay(attempt) {
      nextDelayAttempts.push(attempt);
      return 60000;
    }
  });
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository(),
    translationExecutionProvider: {
      async execute() {
        providerCalls += 1;

        if (providerCalls === 1) {
          throw new Error('first attempt failed');
        }

        return providerResult({ translatedText: 'retried without waiting' });
      }
    },
    retryPolicy
  });

  await runner.execute(runnerInput());

  assert.deepEqual(canRetryAttempts, [1]);
  assert.deepEqual(nextDelayAttempts, [1]);
  assert.equal(providerCalls, 2);
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
    findRequestById:
      overrides.findRequestById ||
      function findRequestById() {
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
    findExecutionById:
      overrides.findExecutionById ||
      function findExecutionById() {
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

test('fenced runner checks before output and completed writes in existing order', async () => {
  const calls = [];
  const guard = { async assertWritable(input) { calls.push(['guard', input]); } };
  const runner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls }),
    translationExecutionProvider: provider(),
    executionFenceGuard: guard
  });

  await runner.execute({ ...runnerInput(), executionFence: { executionId: 'execution-1', leaseId: 'lease-1', fenceToken: 1 } });

  assert.deepEqual(calls.map(([name]) => name), ['guard', 'createTranslationOutput', 'guard', 'updateTranslationExecution']);
  assert.deepEqual(calls[0][1], { executionId: 'execution-1', claim: { leaseId: 'lease-1', fenceToken: 1 } });
});

test('fence rejection prevents the corresponding success and failure persistence writes', async () => {
  const outputError = new Error('output ownership lost');
  const outputCalls = [];
  const outputRunner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls: outputCalls }),
    translationExecutionProvider: provider(),
    executionFenceGuard: { async assertWritable() { throw outputError; } }
  });
  await assert.rejects(
    () => outputRunner.execute({ ...runnerInput(), executionFence: { leaseId: 'lease-1', fenceToken: 1 } }),
    (error) => error === outputError
  );
  assert.deepEqual(outputCalls, []);

  const completedError = new Error('completed ownership lost');
  const completedCalls = [];
  let guardCalls = 0;
  const completedRunner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls: completedCalls }),
    translationExecutionProvider: provider(),
    executionFenceGuard: { async assertWritable() { guardCalls += 1; if (guardCalls === 2) throw completedError; } }
  });
  await assert.rejects(
    () => completedRunner.execute({ ...runnerInput(), executionFence: { leaseId: 'lease-1', fenceToken: 1 } }),
    (error) => error === completedError
  );
  assert.deepEqual(completedCalls.map(([name]) => name), ['createTranslationOutput']);

  const failedError = new Error('failed ownership lost');
  const failedCalls = [];
  const failedRunner = createTranslationExecutionRunner({
    translationRepository: translationRepository({ calls: failedCalls }),
    translationExecutionProvider: { async execute() { throw new Error('provider failed'); } },
    executionFenceGuard: { async assertWritable() { throw failedError; } }
  });
  await assert.rejects(
    () => failedRunner.execute({ ...runnerInput(), executionFence: { leaseId: 'lease-1', fenceToken: 1 } }),
    (error) => error === failedError
  );
  assert.deepEqual(failedCalls, []);
});
