import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationProviderResolutionComposition } from '../../src/infrastructure/translationProviderResolutionComposition.js';

test('creates a frozen composition with registry and resolver APIs', () => {
  const composition = createComposition();

  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Object.keys(composition), ['registry', 'resolver']);
  assert.equal(typeof composition.registry.get, 'function');
  assert.equal(typeof composition.registry.has, 'function');
  assert.equal(typeof composition.registry.list, 'function');
  assert.equal(typeof composition.resolver.resolve, 'function');
});

test('registry contains all supplied providers in insertion order', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      fake: fakeProvider,
      gemini: geminiProvider
    }
  });

  assert.deepEqual(composition.registry.list(), ['fake', 'gemini']);
});

test('registry preserves provider identity', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      fake: fakeProvider,
      gemini: geminiProvider
    }
  });

  assert.equal(composition.registry.get('fake'), fakeProvider);
  assert.equal(composition.registry.get('gemini'), geminiProvider);
});

test('resolver uses the configured default provider', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      fake: fakeProvider,
      gemini: geminiProvider
    },
    defaultProviderKey: 'gemini'
  });

  assert.equal(composition.resolver.resolve(), geminiProvider);
});

test('resolver supports explicit provider selection', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      fake: fakeProvider,
      gemini: geminiProvider
    },
    defaultProviderKey: 'gemini'
  });

  assert.equal(composition.resolver.resolve({ providerKey: 'fake' }), fakeProvider);
});

test('explicit provider selection overrides the configured default', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      fake: fakeProvider,
      gemini: geminiProvider
    },
    defaultProviderKey: 'gemini'
  });

  const selectedProvider = composition.resolver.resolve({ providerKey: 'fake' });

  assert.equal(selectedProvider, fakeProvider);
  assert.notEqual(selectedProvider, geminiProvider);
});

test('missing explicit provider does not fall back to the default', () => {
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      gemini: geminiProvider
    },
    defaultProviderKey: 'gemini'
  });

  assert.throws(
    () => composition.resolver.resolve({ providerKey: 'missing' }),
    /translation provider not found: missing/
  );
  assert.equal(composition.resolver.resolve(), geminiProvider);
});

test('unregistered default provider fails during construction', () => {
  assert.throws(
    () =>
      createTranslationProviderResolutionComposition({
        providers: {
          gemini: translationProvider()
        },
        defaultProviderKey: 'missing'
      }),
    /defaultProviderKey is not registered: missing/
  );
});

test('invalid providers input preserves registry validation', () => {
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers: undefined, defaultProviderKey: 'gemini' }),
    /providers must be a plain object/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers: null, defaultProviderKey: 'gemini' }),
    /providers must be a plain object/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers: [], defaultProviderKey: 'gemini' }),
    /providers must be a plain object/
  );
});

test('invalid default provider key preserves resolver validation', () => {
  const providers = {
    gemini: translationProvider()
  };

  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers, defaultProviderKey: undefined }),
    /defaultProviderKey must be a string/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers, defaultProviderKey: null }),
    /defaultProviderKey must be a string/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers, defaultProviderKey: '' }),
    /defaultProviderKey must be a non-empty string/
  );
});

test('provider keys remain exact and case-sensitive', () => {
  const composition = createComposition({
    providers: {
      gemini: translationProvider()
    },
    defaultProviderKey: 'gemini'
  });

  assert.throws(
    () => composition.resolver.resolve({ providerKey: 'Gemini' }),
    /translation provider not found: Gemini/
  );
});

test('composition does not mutate provider input', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const providers = {
    fake: fakeProvider,
    gemini: geminiProvider
  };

  createComposition({
    providers,
    defaultProviderKey: 'gemini'
  });

  assert.deepEqual(Object.keys(providers), ['fake', 'gemini']);
  assert.equal(providers.fake, fakeProvider);
  assert.equal(providers.gemini, geminiProvider);
});

test('composition object immutability does not freeze provider objects', () => {
  const provider = translationProvider();
  const composition = createComposition({
    providers: {
      gemini: provider
    }
  });

  assert.equal(Object.isFrozen(composition), true);
  assert.equal(Object.isFrozen(provider), false);
});

test('resolver and returned registry share the same registered provider state', () => {
  const fakeProvider = translationProvider();
  const geminiProvider = translationProvider();
  const composition = createComposition({
    providers: {
      fake: fakeProvider,
      gemini: geminiProvider
    },
    defaultProviderKey: 'gemini'
  });

  assert.deepEqual(composition.registry.list(), ['fake', 'gemini']);
  assert.equal(composition.registry.get('fake'), fakeProvider);
  assert.equal(composition.registry.get('gemini'), geminiProvider);
  assert.equal(composition.resolver.resolve(), composition.registry.get('gemini'));
  assert.equal(composition.resolver.resolve({ providerKey: 'fake' }), composition.registry.get('fake'));
});

test('composition exposes neither providers nor defaultProviderKey', () => {
  const composition = createComposition();

  assert.equal(Object.hasOwn(composition, 'providers'), false);
  assert.equal(Object.hasOwn(composition, 'defaultProviderKey'), false);
});

test('composition does not call provider.translate', () => {
  let translateCallCount = 0;
  const provider = translationProvider({
    translate() {
      translateCallCount += 1;
      return Promise.resolve({
        translatedText: 'translated',
        detectedSourceLanguageCode: 'en'
      });
    }
  });

  const composition = createComposition({
    providers: {
      gemini: provider
    }
  });

  assert.equal(composition.resolver.resolve(), provider);
  assert.equal(translateCallCount, 0);
});

function createComposition({ providers = { gemini: translationProvider() }, defaultProviderKey = 'gemini' } = {}) {
  return createTranslationProviderResolutionComposition({
    providers,
    defaultProviderKey
  });
}

function translationProvider(overrides = {}) {
  return {
    async translate() {
      return {
        translatedText: 'translated',
        detectedSourceLanguageCode: 'en'
      };
    },
    ...overrides
  };
}
