import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductionTranslationExecutionProvider } from '../../src/application/translation/productionTranslationExecutionProvider.js';

test('rejects missing implementation', () => {
  assert.throws(
    () => new ProductionTranslationExecutionProvider(),
    /productionTranslationExecutionProvider implementation is required/
  );
  assert.throws(
    () => new ProductionTranslationExecutionProvider(null),
    /productionTranslationExecutionProvider implementation is required/
  );
});

test('rejects missing execute', () => {
  assert.throws(
    () => new ProductionTranslationExecutionProvider({}),
    /productionTranslationExecutionProvider\.execute must be a function/
  );
});

test('rejects non-function execute', () => {
  assert.throws(
    () => new ProductionTranslationExecutionProvider({ execute: 'not-a-function' }),
    /productionTranslationExecutionProvider\.execute must be a function/
  );
});

test('execute calls implementation once with input unchanged', async () => {
  const input = Object.freeze({
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'gemini'
  });
  let callCount = 0;
  let receivedInput;
  const provider = new ProductionTranslationExecutionProvider({
    async execute(inputValue) {
      callCount += 1;
      receivedInput = inputValue;
      return providerResult();
    }
  });

  await provider.execute(input);

  assert.equal(callCount, 1);
  assert.strictEqual(receivedInput, input);
});

test('execute returns implementation result unchanged', async () => {
  const result = providerResult();
  const provider = new ProductionTranslationExecutionProvider({
    async execute() {
      return result;
    }
  });

  const actualResult = await provider.execute({
    sourceText: 'Hello',
    targetLanguageCode: 'fr'
  });

  assert.strictEqual(actualResult, result);
});

test('execute remains asynchronous for synchronous implementation result', async () => {
  const result = providerResult();
  const provider = new ProductionTranslationExecutionProvider({
    execute() {
      return result;
    }
  });

  const actualResult = provider.execute({
    sourceText: 'Hello',
    targetLanguageCode: 'fr'
  });

  assert.equal(typeof actualResult.then, 'function');
  assert.strictEqual(await actualResult, result);
});

test('execute propagates implementation errors unchanged', async () => {
  const error = new Error('provider failed');
  const provider = new ProductionTranslationExecutionProvider({
    async execute() {
      throw error;
    }
  });

  await assert.rejects(
    () => provider.execute({
      sourceText: 'Hello',
      targetLanguageCode: 'fr'
    }),
    (actualError) => actualError === error
  );
});

function providerResult(overrides = {}) {
  return Object.freeze({
    translatedText: 'Bonjour',
    detectedSourceLanguageCode: 'en',
    ...overrides
  });
}
