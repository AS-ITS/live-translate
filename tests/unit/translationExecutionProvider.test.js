import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionProvider } from '../../src/application/translation/translationExecutionProvider.js';

test('accepts a valid implementation', () => {
  const provider = createTranslationExecutionProvider({
    async execute() {
      return providerResult();
    }
  });

  assert.equal(typeof provider, 'object');
  assert.notEqual(provider, null);
  assert.deepEqual(Object.keys(provider), ['execute', 'idempotency']);
  assert.deepEqual(provider.idempotency, { mode: 'unknown' });
  assert.equal(typeof provider.execute, 'function');
  assert.equal(provider.execute.length, 1);
  assert.equal(Object.isFrozen(provider), true);
});

test('rejects missing implementation', () => {
  assert.throws(() => createTranslationExecutionProvider(), /translationExecutionProvider implementation is required/);
  assert.throws(() => createTranslationExecutionProvider(null), /translationExecutionProvider implementation is required/);
});

test('rejects missing execute', () => {
  assert.throws(
    () => createTranslationExecutionProvider({}),
    /translationExecutionProvider\.execute must be a function/
  );
});

test('rejects non-function execute', () => {
  assert.throws(
    () => createTranslationExecutionProvider({ execute: 'not-a-function' }),
    /translationExecutionProvider\.execute must be a function/
  );
});

test('execute forwards arguments unchanged', async () => {
  const input = Object.freeze({
    execution: Object.freeze({ id: 'execution-1' }),
    request: Object.freeze({ id: 'request-1' })
  });
  let receivedInput;
  const provider = createTranslationExecutionProvider({
    async execute(inputValue) {
      receivedInput = inputValue;
      return providerResult();
    }
  });

  await provider.execute(input);

  assert.strictEqual(receivedInput, input);
});

test('execute returns provider result unchanged', async () => {
  const result = providerResult();
  const provider = createTranslationExecutionProvider({
    async execute() {
      return result;
    }
  });

  const actualResult = await provider.execute({
    execution: Object.freeze({ id: 'execution-1' }),
    request: Object.freeze({ id: 'request-1' })
  });

  assert.strictEqual(actualResult, result);
});

test('execute remains asynchronous', async () => {
  const result = providerResult();
  const provider = createTranslationExecutionProvider({
    execute() {
      return result;
    }
  });

  const actualResult = provider.execute({
    execution: Object.freeze({ id: 'execution-1' }),
    request: Object.freeze({ id: 'request-1' })
  });

  assert.equal(typeof actualResult.then, 'function');
  assert.strictEqual(await actualResult, result);
});

function providerResult(overrides = {}) {
  return Object.freeze({
    translatedText: 'Bonjour',
    detectedSourceLanguageCode: 'en',
    ...overrides
  });
}
