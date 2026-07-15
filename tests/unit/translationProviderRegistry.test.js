import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationProviderRegistry } from '../../src/infrastructure/translationProviderRegistry.js';

test('can create an empty registry', () => {
  const registry = createTranslationProviderRegistry({ providers: {} });

  assert.deepEqual(registry.list(), []);
});

test('can create a registry with one provider', () => {
  const provider = translationProvider();
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: provider
    }
  });

  assert.equal(registry.get('gemini'), provider);
});

test('can create a registry with multiple providers', () => {
  const geminiProvider = translationProvider();
  const fakeProvider = translationProvider();
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: geminiProvider,
      fake: fakeProvider
    }
  });

  assert.equal(registry.get('gemini'), geminiProvider);
  assert.equal(registry.get('fake'), fakeProvider);
  assert.deepEqual(registry.list(), ['gemini', 'fake']);
});

test('rejects invalid factory input', () => {
  assert.throws(() => createTranslationProviderRegistry(), /factory input/);
  assert.throws(() => createTranslationProviderRegistry(null), /factory input/);
  assert.throws(() => createTranslationProviderRegistry([]), /factory input/);
  assert.throws(() => createTranslationProviderRegistry({}), /providers is required/);
});

test('rejects non plain-object providers input', () => {
  assert.throws(() => createTranslationProviderRegistry({ providers: null }), /providers must be a plain object/);
  assert.throws(() => createTranslationProviderRegistry({ providers: [] }), /providers must be a plain object/);
  assert.throws(() => createTranslationProviderRegistry({ providers: 'gemini' }), /providers must be a plain object/);
  assert.throws(() => createTranslationProviderRegistry({ providers: new Map() }), /providers must be a plain object/);
});

test('rejects invalid provider keys at construction time', () => {
  const provider = translationProvider();

  assert.throws(() => createTranslationProviderRegistry({ providers: { '': provider } }), /provider key must be a non-empty string/);
  assert.throws(() => createTranslationProviderRegistry({ providers: { '   ': provider } }), /provider key must be a non-empty string/);
  assert.throws(() => createTranslationProviderRegistry({ providers: { ' gemini': provider } }), /provider key must not include surrounding whitespace/);
  assert.throws(() => createTranslationProviderRegistry({ providers: { 'gemini ': provider } }), /provider key must not include surrounding whitespace/);
});

test('rejects symbol provider keys at construction time', () => {
  const providers = {
    gemini: translationProvider(),
    [Symbol('provider')]: translationProvider()
  };

  assert.throws(() => createTranslationProviderRegistry({ providers }), /provider key must be a string/);
});

test('rejects invalid provider implementations at construction time', () => {
  assert.throws(() => createTranslationProviderRegistry({ providers: { gemini: null } }), /translation provider must be an object: gemini/);
  assert.throws(() => createTranslationProviderRegistry({ providers: { gemini: {} } }), /translation provider translate must be a function: gemini/);
  assert.throws(
    () => createTranslationProviderRegistry({ providers: { gemini: { translate: 'not-a-function' } } }),
    /translation provider translate must be a function: gemini/
  );
});

test('get returns the exact registered provider instance without invoking translate', () => {
  let callCount = 0;
  const provider = translationProvider({
    translate() {
      callCount += 1;
      return Promise.resolve({
        translatedText: 'translated',
        detectedSourceLanguageCode: 'en'
      });
    }
  });
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: provider
    }
  });

  assert.equal(registry.get('gemini'), provider);
  assert.equal(callCount, 0);
});

test('get throws clearly for unregistered providers', () => {
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: translationProvider()
    }
  });

  assert.throws(() => registry.get('fake'), /translation provider not found: fake/);
});

test('get rejects blank or malformed lookup keys', () => {
  const registry = createTranslationProviderRegistry({ providers: {} });

  assert.throws(() => registry.get(''), /provider key must be a non-empty string/);
  assert.throws(() => registry.get('   '), /provider key must be a non-empty string/);
  assert.throws(() => registry.get(' gemini'), /provider key must not include surrounding whitespace/);
  assert.throws(() => registry.get('gemini '), /provider key must not include surrounding whitespace/);
  assert.throws(() => registry.get(null), /provider key must be a string/);
});

test('get uses exact match without case normalization', () => {
  const provider = translationProvider();
  const registry = createTranslationProviderRegistry({
    providers: {
      Gemini: provider
    }
  });

  assert.equal(registry.get('Gemini'), provider);
  assert.throws(() => registry.get('gemini'), /translation provider not found: gemini/);
});

test('has returns true only for registered providers', () => {
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: translationProvider()
    }
  });

  assert.equal(registry.has('gemini'), true);
  assert.equal(registry.has('fake'), false);
});

test('has rejects invalid lookup keys', () => {
  const registry = createTranslationProviderRegistry({ providers: {} });

  assert.throws(() => registry.has(''), /provider key must be a non-empty string/);
  assert.throws(() => registry.has(' gemini'), /provider key must not include surrounding whitespace/);
  assert.throws(() => registry.has(undefined), /provider key must be a string/);
});

test('list returns provider keys in insertion order without provider instances', () => {
  const geminiProvider = translationProvider();
  const fakeProvider = translationProvider();
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: geminiProvider,
      'gemini.saved-transcript': translationProvider(),
      fake: fakeProvider
    }
  });

  assert.deepEqual(registry.list(), ['gemini', 'gemini.saved-transcript', 'fake']);
  assert.equal(registry.list().includes(geminiProvider), false);
  assert.equal(registry.list().includes(fakeProvider), false);
});

test('list result is protected and does not affect later list calls', () => {
  const registry = createTranslationProviderRegistry({
    providers: {
      gemini: translationProvider(),
      fake: translationProvider()
    }
  });
  const listedKeys = registry.list();

  assert.equal(Object.isFrozen(listedKeys), true);
  assert.throws(() => {
    listedKeys.push('openai');
  }, TypeError);
  assert.deepEqual(registry.list(), ['gemini', 'fake']);
});

test('registry object is frozen and only exposes get, has, and list', () => {
  const registry = createTranslationProviderRegistry({ providers: {} });

  assert.equal(Object.isFrozen(registry), true);
  assert.deepEqual(Object.keys(registry), ['get', 'has', 'list']);
  assert.throws(() => {
    registry.register = () => {};
  }, TypeError);
});

test('registry is not affected by later additions to the original providers object', () => {
  const providers = {
    gemini: translationProvider()
  };
  const registry = createTranslationProviderRegistry({ providers });

  providers.fake = translationProvider();

  assert.equal(registry.has('fake'), false);
  assert.deepEqual(registry.list(), ['gemini']);
});

test('registry keeps original provider when source property is replaced or deleted', () => {
  const geminiProvider = translationProvider();
  const replacementProvider = translationProvider();
  const providers = {
    gemini: geminiProvider
  };
  const registry = createTranslationProviderRegistry({ providers });

  providers.gemini = replacementProvider;
  assert.equal(registry.get('gemini'), geminiProvider);

  delete providers.gemini;
  assert.equal(registry.get('gemini'), geminiProvider);
});

function translationProvider(overrides = {}) {
  return {
    async translate(input) {
      return {
        translatedText: input?.sourceText ?? 'translated',
        detectedSourceLanguageCode: input?.sourceLanguageCode ?? 'en'
      };
    },
    ...overrides
  };
}
