import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import { TranslationExecution, TranslationOutput } from '../../src/domain/translation/index.js';

test('executes provider once with unchanged input and completes persistence flow', async () => {
  const calls = [];
  const providerInputs = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionProvider: {
      async execute(input) {
        calls.push(['provider.execute', input]);
        providerInputs.push(input);
        return providerResult({ translatedText: 'Bonjour' });
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

  assert.equal(providerInputs.length, 1);
  assert.deepEqual(providerInputs[0], {
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'fake'
  });
  assert.equal(result instanceof TranslationExecution, true);
  assert.deepEqual(calls.map((call) => call[0]), [
    'createTranslationExecution',
    'provider.execute',
    'createTranslationOutput',
    'updateTranslationExecution'
  ]);

  const output = calls[2][1];
  const completedExecution = calls[3][1];

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
    translationExecutionProvider: {
      async execute(input) {
        providerInput = input;
        return providerResult();
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
    translationExecutionProvider: {
      async execute() {
        return providerResult({ translatedText: '  Provider text  ' });
      }
    }
  });

  await dependencies.service.createTranslationExecution(executionPayload());

  assert.equal(createdOutput.translatedText, '  Provider text  ');
});

test('provider failures mark execution failed, skip output, and propagate original error', async () => {
  const error = new Error('provider failed');
  const calls = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionProvider: {
      async execute() {
        calls.push(['provider.execute']);
        throw error;
      }
    }
  });

  await assert.rejects(dependencies.service.createTranslationExecution(executionPayload()), (actualError) => {
    return actualError === error;
  });

  assert.deepEqual(calls.map((call) => call[0]), [
    'createTranslationExecution',
    'provider.execute',
    'updateTranslationExecution'
  ]);
  assert.equal(calls.filter((call) => call[0] === 'provider.execute').length, 1);
  assert.equal(calls.some((call) => call[0] === 'createTranslationOutput'), false);

  const failedExecution = calls[2][1];
  assert.equal(failedExecution instanceof TranslationExecution, true);
  assert.equal(failedExecution.status, 'failed');
  assert.notEqual(failedExecution.status, 'completed');
  assert.deepEqual(failedExecution.failureInfo, { reason: 'provider_execution_failed' });
});

test('does not dispatch or resolve providers during provider execution orchestration', async () => {
  const calls = [];
  const dependencies = serviceDependencies({
    calls,
    translationExecutionDispatcher: {
      async dispatch() {
        calls.push(['dispatcher.dispatch']);
        throw new Error('dispatcher should not be called');
      }
    },
    translationExecutionProvider: {
      async execute(input) {
        calls.push(['provider.execute', input]);
        return providerResult();
      }
    },
    translationProviderResolver: {
      resolve() {
        calls.push(['resolver.resolve']);
        throw new Error('resolver should not be called');
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
  assert.equal(calls.some((call) => call[0] === 'resolver.resolve'), false);
  assert.deepEqual(calls.map((call) => call[0]), [
    'createTranslationExecution',
    'provider.execute',
    'createTranslationOutput',
    'updateTranslationExecution'
  ]);
});

function serviceDependencies(options = {}) {
  const calls = options.calls ?? [];
  const repository = options.translationRepository ?? translationRepository({ calls });
  const service = createTranslationCommandService({
    translationRepository: repository,
    domainEventPublisher: domainEventPublisher(),
    translationExecutionDispatcher: options.translationExecutionDispatcher,
    translationExecutionProvider: options.translationExecutionProvider,
    translationProviderResolver: options.translationProviderResolver
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
