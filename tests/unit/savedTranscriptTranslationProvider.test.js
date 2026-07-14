import assert from 'node:assert/strict';
import test from 'node:test';
import { createSavedTranscriptTranslationProvider } from '../../src/application/translation/index.js';
import { createSavedTranscriptTranslationProvider as createSavedTranscriptTranslationProviderFromModule } from '../../src/application/translation/savedTranscriptTranslationProvider.js';

const NOT_IMPLEMENTED_ERROR = /Saved transcript translation provider is not implemented/;

test('factory returns a provider object with the translate contract', () => {
  const provider = createSavedTranscriptTranslationProvider();

  assert.equal(typeof provider, 'object');
  assert.notEqual(provider, null);
  assert.deepEqual(Object.keys(provider), ['translate']);
  assert.equal(typeof provider.translate, 'function');
});

test('provider object is immutable and only exposes translate', () => {
  const provider = createSavedTranscriptTranslationProvider();

  assert.equal(Object.isFrozen(provider), true);
  assert.equal(Object.hasOwn(provider, 'translate'), true);
  assert.equal(Object.hasOwn(provider, 'provider'), false);
  assert.equal(Object.hasOwn(provider, 'model'), false);
  assert.equal(Object.hasOwn(provider, 'configure'), false);
  assert.equal(Object.hasOwn(provider, 'getCalls'), false);

  assert.throws(() => {
    provider.translate = () => Promise.resolve();
  }, TypeError);
  assert.throws(() => {
    provider.detectLanguage = () => null;
  }, TypeError);
});

test('translate accepts one input argument', () => {
  const provider = createSavedTranscriptTranslationProvider();

  assert.equal(provider.translate.length, 1);
  assert.throws(
    () =>
      provider.translate({
        sourceText: 'Hello',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr'
      }),
    NOT_IMPLEMENTED_ERROR
  );
});

test('translate throws a synchronous unimplemented error', () => {
  const provider = createSavedTranscriptTranslationProvider();
  const input = translationInput();

  assert.throws(() => provider.translate(input), NOT_IMPLEMENTED_ERROR);
  assert.throws(() => provider.translate(), NOT_IMPLEMENTED_ERROR);
  assert.doesNotReject(async () => undefined);
});

test('translate does not mutate the original input before throwing', () => {
  const provider = createSavedTranscriptTranslationProvider();
  const input = translationInput({ metadata: { nested: { preserved: true } } });
  const before = structuredClone(input);

  assert.throws(() => provider.translate(input), NOT_IMPLEMENTED_ERROR);

  assert.deepEqual(input, before);
});

test('separate provider instances are independent frozen objects', () => {
  const firstProvider = createSavedTranscriptTranslationProvider();
  const secondProvider = createSavedTranscriptTranslationProvider();

  assert.notEqual(firstProvider, secondProvider);
  assert.equal(Object.isFrozen(firstProvider), true);
  assert.equal(Object.isFrozen(secondProvider), true);
  assert.throws(() => firstProvider.translate(translationInput()), NOT_IMPLEMENTED_ERROR);
  assert.throws(() => secondProvider.translate(translationInput()), NOT_IMPLEMENTED_ERROR);
});

test('module and application barrel export the same factory', () => {
  assert.equal(createSavedTranscriptTranslationProvider, createSavedTranscriptTranslationProviderFromModule);
});

function translationInput(overrides = {}) {
  return {
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    ...overrides
  };
}
