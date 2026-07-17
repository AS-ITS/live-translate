import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionProvider } from '../../src/application/translation/translationExecutionProvider.js';
import { createGeminiTranslationExecutionProvider } from '../../src/infrastructure/geminiTranslationExecutionProvider.js';

test('creates a frozen provider with the TranslationExecutionProvider contract', () => {
  const provider = createGeminiTranslationExecutionProvider({ client: client() });

  assert.equal(Object.isFrozen(provider), true);
  assert.deepEqual(Object.keys(provider), ['execute']);
  assert.equal(typeof provider.execute, 'function');
  assert.equal(provider.execute.length, 1);
  assert.throws(() => {
    provider.configure = () => {};
  }, TypeError);
});

test('rejects invalid client dependencies', () => {
  assert.throws(() => createGeminiTranslationExecutionProvider(), /client is required/);
  assert.throws(() => createGeminiTranslationExecutionProvider({ client: null }), /client is required/);
  assert.throws(() => createGeminiTranslationExecutionProvider({ client: [] }), /client is required/);
  assert.throws(
    () => createGeminiTranslationExecutionProvider({ client: {} }),
    /client\.execute must be a function/
  );
  assert.throws(
    () => createGeminiTranslationExecutionProvider({ client: { execute: 'not-a-function' } }),
    /client\.execute must be a function/
  );
});

test('execute is async and returns the client result unchanged', async () => {
  const result = providerResult();
  const provider = createGeminiTranslationExecutionProvider({
    client: client({ result })
  });

  const actualResult = provider.execute(translationInput());

  assert.equal(typeof actualResult.then, 'function');
  assert.strictEqual(await actualResult, result);
});

test('execute calls the client once with the original input object', async () => {
  const calls = [];
  const input = Object.freeze(
    translationInput({
      requestId: 'request-1',
      sessionId: 'session-1',
      executionId: 'execution-1'
    })
  );
  const provider = createGeminiTranslationExecutionProvider({
    client: client({
      execute(inputValue) {
        calls.push(inputValue);
        return providerResult();
      }
    })
  });

  await provider.execute(input);

  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0], input);
});

test('execute propagates client errors unchanged', async () => {
  const error = new Error('client failed');
  const provider = createGeminiTranslationExecutionProvider({
    client: client({
      execute() {
        throw error;
      }
    })
  });

  await assert.rejects(provider.execute(translationInput()), (actualError) => actualError === error);
});

test('execute does not mutate input', async () => {
  const input = Object.freeze(
    translationInput({
      requestId: 'request-1',
      sessionId: 'session-1',
      executionId: 'execution-1'
    })
  );
  const before = structuredClone(input);
  const provider = createGeminiTranslationExecutionProvider({ client: client() });

  await provider.execute(input);

  assert.deepEqual(input, before);
});

test('works through TranslationExecutionProvider without changing the result', async () => {
  const result = providerResult({ translatedText: 'Salut' });
  const geminiProvider = createGeminiTranslationExecutionProvider({
    client: client({ result })
  });
  const provider = createTranslationExecutionProvider(geminiProvider);

  const actualResult = await provider.execute(translationInput());

  assert.strictEqual(actualResult, result);
});

function client({ result = providerResult(), execute } = {}) {
  return Object.freeze({
    execute: execute ?? (() => result)
  });
}

function translationInput(overrides = {}) {
  return {
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'gemini',
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
