import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionProvider } from '../../src/application/translation/translationExecutionProvider.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';

test('exposes an execute function', () => {
  const provider = createFakeTranslationExecutionProvider();

  assert.equal(Object.isFrozen(provider), true);
  assert.deepEqual(Object.keys(provider), ['execute']);
  assert.equal(typeof provider.execute, 'function');
  assert.equal(provider.execute.length, 1);
});

test('returns a promise-compatible result', async () => {
  const provider = createFakeTranslationExecutionProvider();
  const result = provider.execute(translationInput());

  assert.equal(typeof result.then, 'function');
  assert.deepEqual(await result, providerResult());
});

test('returns deterministic translated text', async () => {
  const provider = createFakeTranslationExecutionProvider();

  const result = await provider.execute(
    translationInput({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'zh-TW'
    })
  );

  assert.deepEqual(result, {
    translatedText: '[fake] hello',
    detectedSourceLanguageCode: 'en'
  });
});

test('preserves omitted source language', async () => {
  const provider = createFakeTranslationExecutionProvider();
  const input = translationInput();
  delete input.sourceLanguageCode;

  const result = await provider.execute(input);

  assert.equal(result.detectedSourceLanguageCode, undefined);
  assert.deepEqual(result, {
    translatedText: '[fake] hello',
    detectedSourceLanguageCode: undefined
  });
});

test('remains deterministic for equivalent inputs', async () => {
  const provider = createFakeTranslationExecutionProvider();
  const firstInput = translationInput();
  const secondInput = translationInput();

  const firstResult = await provider.execute(firstInput);
  const secondResult = await provider.execute(secondInput);

  assert.deepEqual(firstResult, secondResult);
  assert.notStrictEqual(firstResult, secondResult);
});

test('does not mutate input', async () => {
  const provider = createFakeTranslationExecutionProvider();
  const input = Object.freeze(
    translationInput({
      requestId: 'request-1',
      sessionId: 'session-1',
      executionId: 'execution-1'
    })
  );
  const before = structuredClone(input);

  await provider.execute(input);

  assert.deepEqual(input, before);
});

test('works through TranslationExecutionProvider without changing the result', async () => {
  const fakeProvider = createFakeTranslationExecutionProvider();
  const provider = createTranslationExecutionProvider(fakeProvider);
  const result = await provider.execute(translationInput());

  assert.deepEqual(result, providerResult());
});

test('TranslationExecutionProvider propagates implementation errors unchanged', async () => {
  const error = new Error('sentinel provider failure');
  const provider = createTranslationExecutionProvider({
    async execute() {
      throw error;
    }
  });

  await assert.rejects(provider.execute(translationInput()), (actualError) => actualError === error);
});

function translationInput(overrides = {}) {
  return {
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'zh-TW',
    ...overrides
  };
}

function providerResult(overrides = {}) {
  return {
    translatedText: '[fake] hello',
    detectedSourceLanguageCode: 'en',
    ...overrides
  };
}
