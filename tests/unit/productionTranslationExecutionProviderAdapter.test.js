import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionTranslationExecutionProvider } from '../../src/infrastructure/productionTranslationExecutionProvider.js';

test('constructor throws when resolver is missing', () => {
  assert.throws(
    () => createProductionTranslationExecutionProvider(),
    /translation provider resolver is required/
  );
  assert.throws(
    () => createProductionTranslationExecutionProvider({}),
    /translation provider resolver is required/
  );
  assert.throws(
    () => createProductionTranslationExecutionProvider({ resolver: null }),
    /translation provider resolver is required/
  );
});

test('constructor throws when resolver contract is invalid', () => {
  assert.throws(
    () => createProductionTranslationExecutionProvider({ resolver: {} }),
    /translation provider resolver\.resolve must be a function/
  );
  assert.throws(
    () => createProductionTranslationExecutionProvider({ resolver: { resolve: 'not-a-function' } }),
    /translation provider resolver\.resolve must be a function/
  );
});

test('passes explicit providerKey unchanged to resolver and resolves once', async () => {
  const provider = translationProvider();
  const resolveCalls = [];
  const adapter = createProductionTranslationExecutionProvider({
    resolver: {
      resolve(options) {
        resolveCalls.push(options);
        return provider;
      }
    }
  });

  await adapter.execute(executionInput({ providerKey: ' Gemini.Custom ' }));

  assert.deepEqual(resolveCalls, [{ providerKey: ' Gemini.Custom ' }]);
});

test('executes resolved provider once with provider input only', async () => {
  const translateCalls = [];
  const adapter = createProductionTranslationExecutionProvider({
    resolver: resolverFor(
      translationProvider({
        translate(input) {
          translateCalls.push(input);
          return providerResult();
        }
      })
    )
  });

  await adapter.execute(executionInput());

  assert.deepEqual(translateCalls, [
    {
      sourceText: 'Hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      requestId: 'request-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      providerIdempotencyKey: 'translation-execution:execution-1'
    }
  ]);
  assert.equal(Object.hasOwn(translateCalls[0], 'providerKey'), false);
});

test('optional metadata remains undefined when omitted', async () => {
  let receivedInput;
  const adapter = createProductionTranslationExecutionProvider({
    resolver: resolverFor(
      translationProvider({
        translate(input) {
          receivedInput = input;
          return providerResult();
        }
      })
    )
  });

  await adapter.execute(executionInput({
    requestId: undefined,
    sessionId: undefined,
    executionId: undefined,
    providerIdempotencyKey: undefined
  }));

  assert.equal(Object.hasOwn(receivedInput, 'requestId'), true);
  assert.equal(Object.hasOwn(receivedInput, 'sessionId'), true);
  assert.equal(Object.hasOwn(receivedInput, 'executionId'), true);
  assert.equal(receivedInput.requestId, undefined);
  assert.equal(receivedInput.sessionId, undefined);
  assert.equal(receivedInput.executionId, undefined);
  assert.equal(Object.hasOwn(receivedInput, 'providerIdempotencyKey'), false);
});

test('returns provider result unchanged', async () => {
  const result = providerResult();
  const adapter = createProductionTranslationExecutionProvider({
    resolver: resolverFor(translationProvider({ result }))
  });

  const actualResult = await adapter.execute(executionInput());

  assert.strictEqual(actualResult, result);
});

test('supports async resolver and async provider', async () => {
  const result = providerResult({ translatedText: 'Salut' });
  let resolveCount = 0;
  let translateCount = 0;
  const adapter = createProductionTranslationExecutionProvider({
    resolver: {
      async resolve(options) {
        resolveCount += 1;
        assert.deepEqual(options, { providerKey: 'gemini' });
        return translationProvider({
          async translate(input) {
            translateCount += 1;
            assert.equal(input.sourceText, 'Hello');
            return result;
          }
        });
      }
    }
  });

  const actualResult = await adapter.execute(executionInput({ providerKey: 'gemini' }));

  assert.equal(resolveCount, 1);
  assert.equal(translateCount, 1);
  assert.strictEqual(actualResult, result);
});

test('throws when resolved provider contract is invalid', async () => {
  const adapter = createProductionTranslationExecutionProvider({
    resolver: resolverFor({})
  });

  await assert.rejects(
    () => adapter.execute(executionInput()),
    /resolved translation provider\.translate must be a function/
  );
});

test('propagates resolver error unchanged', async () => {
  const error = new Error('resolver failed');
  const adapter = createProductionTranslationExecutionProvider({
    resolver: {
      resolve() {
        throw error;
      }
    }
  });

  await assert.rejects(
    () => adapter.execute(executionInput()),
    (actualError) => actualError === error
  );
});

test('propagates provider error unchanged', async () => {
  const error = new Error('provider failed');
  const adapter = createProductionTranslationExecutionProvider({
    resolver: resolverFor(
      translationProvider({
        translate() {
          throw error;
        }
      })
    )
  });

  await assert.rejects(
    () => adapter.execute(executionInput()),
    (actualError) => actualError === error
  );
});

function resolverFor(provider) {
  return {
    resolve() {
      return provider;
    }
  };
}

function translationProvider({ result = providerResult(), translate } = {}) {
  return Object.freeze({
    translate: translate ?? (() => result)
  });
}

function executionInput(overrides = {}) {
  return {
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'fake',
    requestId: 'request-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    providerIdempotencyKey: 'translation-execution:execution-1',
    ...overrides
  };
}

function providerResult(overrides = {}) {
  return Object.freeze({
    translatedText: 'Bonjour',
    detectedSourceLanguageCode: 'en',
    ...overrides
  });
}
