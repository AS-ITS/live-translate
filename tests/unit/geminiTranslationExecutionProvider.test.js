import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionProvider } from '../../src/application/translation/translationExecutionProvider.js';
import { createGeminiTranslationExecutionProvider } from '../../src/infrastructure/geminiTranslationExecutionProvider.js';

test('creates a frozen provider with the TranslationExecutionProvider contract', () => {
  const provider = createGeminiTranslationExecutionProvider({ client: client() });

  assert.equal(Object.isFrozen(provider), true);
  assert.deepEqual(Object.keys(provider), ['idempotency', 'execute']);
  assert.deepEqual(provider.idempotency, { mode: 'unknown' });
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
    /client\.translate must be a function/
  );
  assert.throws(
    () => createGeminiTranslationExecutionProvider({ client: { translate: 'not-a-function' } }),
    /client\.translate must be a function/
  );
  assert.throws(
    () => createGeminiTranslationExecutionProvider({ client: { execute: 'not-a-function' } }),
    /client\.translate must be a function/
  );
});

test('execute calls GeminiClient.translate once and maps request and response', async () => {
  const calls = [];
  const result = providerResult({ ignored: 'metadata' });
  const provider = createGeminiTranslationExecutionProvider({
    client: client({
      translate(request) {
        calls.push(request);
        return result;
      }
    })
  });

  const input = Object.freeze(
    translationInput({
      requestId: 'request-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      providerIdempotencyKey: 'translation-execution:execution-1',
      ignoredField: 'ignored'
    })
  );
  const actualResult = provider.execute(input);

  assert.equal(typeof actualResult.then, 'function');
  assert.deepEqual(await actualResult, {
    translatedText: 'Bonjour',
    detectedSourceLanguageCode: 'en'
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    requestId: 'request-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    providerIdempotencyKey: 'translation-execution:execution-1'
  });
  assert.equal(Object.hasOwn(calls[0], 'providerKey'), false);
  assert.equal(Object.hasOwn(calls[0], 'ignoredField'), false);
});

test('execute omits undefined optional request fields', async () => {
  const calls = [];
  const provider = createGeminiTranslationExecutionProvider({
    client: client({
      translate(request) {
        calls.push(request);
        return providerResult();
      }
    })
  });

  await provider.execute(
    translationInput({
      sourceLanguageCode: undefined,
      requestId: undefined,
      sessionId: undefined,
      executionId: undefined,
      providerIdempotencyKey: undefined
    })
  );

  assert.deepEqual(calls, [
    {
      sourceText: 'Hello',
      targetLanguageCode: 'fr'
    }
  ]);
});

test('execute preserves subtitle resegmentation mode and items for Gemini', async () => {
  const calls = [];
  const provider = createGeminiTranslationExecutionProvider({
    client: client({
      translate(request) {
        calls.push(request);
        return providerResult({ refinedCues: [{ sourceCueIds: ['cue-1'], refinedSource: '你好', refinedTranslation: 'Hello' }] });
      }
    })
  });

  await provider.execute(translationInput({
    operation: 'transcript_polishing',
    mode: 'subtitle_resegment',
    items: [{ cueId: 'cue-1', sequence: 1, rawSource: '你好', rawTranslation: 'Hello' }],
    refinementItems: [{ cueId: 'cue-1' }],
    polishingItems: [{ cueId: 'cue-1' }],
    refinementTargets: [{ targetCueId: 'cue-1' }]
  }));

  assert.deepEqual(calls[0].mode, 'subtitle_resegment');
  assert.deepEqual(calls[0].items, [{ cueId: 'cue-1', sequence: 1, rawSource: '你好', rawTranslation: 'Hello' }]);
  assert.deepEqual(calls[0].refinementItems, [{ cueId: 'cue-1' }]);
  assert.deepEqual(calls[0].polishingItems, [{ cueId: 'cue-1' }]);
  assert.deepEqual(calls[0].refinementTargets, [{ targetCueId: 'cue-1' }]);
});

test('execute rethrows GeminiClient.translate errors unchanged', async () => {
  const error = new Error('client failed');
  error.name = 'GeminiClientError';
  const provider = createGeminiTranslationExecutionProvider({
    client: client({
      translate() {
        throw error;
      }
    })
  });

  await assert.rejects(provider.execute(translationInput()), (actualError) => {
    assert.strictEqual(actualError, error);
    assert.equal(actualError.name, 'GeminiClientError');
    assert.equal(actualError.message, 'client failed');
    return true;
  });
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
  const geminiProvider = createGeminiTranslationExecutionProvider({
    client: client({
      translate() {
        return providerResult({ translatedText: 'Salut' });
      }
    })
  });
  const provider = createTranslationExecutionProvider(geminiProvider);

  const actualResult = await provider.execute(translationInput());

  assert.deepEqual(actualResult, {
    translatedText: 'Salut',
    detectedSourceLanguageCode: 'en'
  });
});

test('uses legacy client.execute when translate is unavailable with the same mapping', async () => {
  const calls = [];
  const provider = createGeminiTranslationExecutionProvider({
    client: Object.freeze({
      execute(request) {
        calls.push(request);
        return providerResult({ translatedText: 'Salut' });
      }
    })
  });

  const actualResult = await provider.execute(
    translationInput({
      requestId: 'request-legacy',
      sessionId: 'session-legacy',
      executionId: 'execution-legacy',
      providerIdempotencyKey: 'translation-execution:execution-legacy'
    })
  );

  assert.deepEqual(actualResult, {
    translatedText: 'Salut',
    detectedSourceLanguageCode: 'en'
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    requestId: 'request-legacy',
    sessionId: 'session-legacy',
    executionId: 'execution-legacy',
    providerIdempotencyKey: 'translation-execution:execution-legacy'
  });
});

function client({ result = providerResult(), translate } = {}) {
  return Object.freeze({
    translate: translate ?? (() => result)
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
