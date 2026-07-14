import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeSavedTranscriptTranslationProvider } from '../../src/infrastructure/fakeSavedTranscriptTranslationProvider.js';

test('factory returns a frozen fake provider with translate and call inspection', () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: providerResult() });

  assert.equal(Object.isFrozen(provider), true);
  assert.deepEqual(Object.keys(provider), ['translate', 'getCalls']);
  assert.equal(typeof provider.translate, 'function');
  assert.equal(typeof provider.getCalls, 'function');
  assert.throws(() => {
    provider.calls = [];
  }, TypeError);
});

test('successful translation resolves the configured result and preserves identity', async () => {
  const result = providerResult();
  const provider = createFakeSavedTranscriptTranslationProvider({ result });

  await assert.doesNotReject(provider.translate(translationInput()));
  assert.strictEqual(await provider.translate(translationInput({ sourceText: 'Again' })), result);
});

test('configured Promise result identity is preserved through Promise.resolve semantics', () => {
  const resultPromise = Promise.resolve(providerResult());
  const provider = createFakeSavedTranscriptTranslationProvider({ result: resultPromise });

  assert.strictEqual(provider.translate(translationInput()), resultPromise);
});

test('received input reference is preserved in call history', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: providerResult() });
  const input = translationInput();

  await provider.translate(input);

  assert.strictEqual(provider.getCalls()[0], input);
});

test('calls are recorded in invocation order', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: providerResult() });
  const firstInput = translationInput({ sourceText: 'First' });
  const secondInput = translationInput({ sourceText: 'Second' });
  const thirdInput = translationInput({ sourceText: 'Third' });

  await provider.translate(firstInput);
  await provider.translate(secondInput);
  await provider.translate(thirdInput);

  assert.deepEqual(provider.getCalls(), [firstInput, secondInput, thirdInput]);
});

test('inspection returns a defensive snapshot of call history', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: providerResult() });
  const input = translationInput();

  await provider.translate(input);
  const calls = provider.getCalls();
  calls.push(translationInput({ sourceText: 'External mutation' }));

  assert.deepEqual(provider.getCalls(), [input]);
  assert.notStrictEqual(provider.getCalls(), provider.getCalls());
});

test('external mutation of an inspection result does not alter internal call history', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: providerResult() });
  const firstInput = translationInput({ sourceText: 'First' });
  const secondInput = translationInput({ sourceText: 'Second' });

  await provider.translate(firstInput);
  const calls = provider.getCalls();
  calls[0] = secondInput;

  assert.deepEqual(provider.getCalls(), [firstInput]);
});

test('configured asynchronous rejection propagates the exact error', async () => {
  const error = new Error('provider rejected');
  const provider = createFakeSavedTranscriptTranslationProvider({ error });
  const input = translationInput();

  await assert.rejects(provider.translate(input), (actualError) => actualError === error);
  assert.deepEqual(provider.getCalls(), [input]);
});

test('configured synchronous throw propagates the exact error', () => {
  const error = new Error('provider threw');
  const provider = createFakeSavedTranscriptTranslationProvider({ mode: 'throw', error });
  const input = translationInput();

  assert.throws(() => provider.translate(input), (actualError) => actualError === error);
  assert.deepEqual(provider.getCalls(), [input]);
});

test('deferred manual resolution remains pending until explicitly resolved', async () => {
  const deferred = createDeferred();
  const provider = createFakeSavedTranscriptTranslationProvider({ mode: 'deferred', deferred });
  const input = translationInput();
  let settled = false;

  const translationPromise = provider.translate(input).then((value) => {
    settled = true;
    return value;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  const result = providerResult({ translatedText: 'Bonjour' });
  deferred.resolve(result);

  assert.strictEqual(await translationPromise, result);
  assert.equal(settled, true);
  assert.deepEqual(provider.getCalls(), [input]);
});

test('deferred mode returns the configured Promise identity', () => {
  const deferred = createDeferred();
  const provider = createFakeSavedTranscriptTranslationProvider({ mode: 'deferred', deferred });

  assert.strictEqual(provider.translate(translationInput()), deferred.promise);
});

test('multiple calls remain deterministic', async () => {
  const result = providerResult();
  const provider = createFakeSavedTranscriptTranslationProvider({ result });
  const firstInput = translationInput({ sourceText: 'First' });
  const secondInput = translationInput({ sourceText: 'Second' });

  assert.strictEqual(await provider.translate(firstInput), result);
  assert.strictEqual(await provider.translate(secondInput), result);
  assert.deepEqual(provider.getCalls(), [firstInput, secondInput]);
});

test('separate fake instances do not share configuration or call history', async () => {
  const firstResult = providerResult({ translatedText: 'Bonjour' });
  const secondResult = providerResult({ translatedText: 'Hola' });
  const firstProvider = createFakeSavedTranscriptTranslationProvider({ result: firstResult });
  const secondProvider = createFakeSavedTranscriptTranslationProvider({ result: secondResult });
  const firstInput = translationInput({ targetLanguageCode: 'fr' });
  const secondInput = translationInput({ targetLanguageCode: 'es' });

  assert.strictEqual(await firstProvider.translate(firstInput), firstResult);
  assert.strictEqual(await secondProvider.translate(secondInput), secondResult);
  assert.deepEqual(firstProvider.getCalls(), [firstInput]);
  assert.deepEqual(secondProvider.getCalls(), [secondInput]);
});

test('input objects are never mutated', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: providerResult() });
  const input = translationInput({
    requestId: 'request-1',
    sessionId: 'session-1',
    executionId: 'execution-1'
  });
  const before = structuredClone(input);

  await provider.translate(input);

  assert.deepEqual(input, before);
});

test('invalid or conflicting configuration fails clearly', () => {
  assert.throws(() => createFakeSavedTranscriptTranslationProvider(null), /options must be an object/);
  assert.throws(
    () =>
      createFakeSavedTranscriptTranslationProvider({
        result: providerResult(),
        error: new Error('conflict')
      }),
    /result and error cannot both be configured/
  );
  assert.throws(() => createFakeSavedTranscriptTranslationProvider({ mode: 'stream' }), /Unsupported fake/);
  assert.throws(() => createFakeSavedTranscriptTranslationProvider({ mode: 'reject' }), /error is required/);
  assert.throws(() => createFakeSavedTranscriptTranslationProvider({ mode: 'throw' }), /error is required/);
  assert.throws(() => createFakeSavedTranscriptTranslationProvider({ mode: 'deferred' }), /deferred must be an object/);
  assert.throws(
    () => createFakeSavedTranscriptTranslationProvider({ mode: 'deferred', deferred: { promise: {} } }),
    /deferred\.promise/
  );
  assert.throws(
    () =>
      createFakeSavedTranscriptTranslationProvider({
        mode: 'deferred',
        deferred: { promise: Promise.resolve(), resolve: true }
      }),
    /deferred\.resolve/
  );
  assert.throws(
    () =>
      createFakeSavedTranscriptTranslationProvider({
        mode: 'deferred',
        deferred: { promise: Promise.resolve(), reject: true }
      }),
    /deferred\.reject/
  );
});

function translationInput(overrides = {}) {
  return {
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    ...overrides
  };
}

function providerResult(overrides = {}) {
  return {
    translatedText: 'Bonjour',
    detectedSourceLanguageCode: 'en',
    ...overrides
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
