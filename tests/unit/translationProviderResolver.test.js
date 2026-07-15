import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationProviderResolver } from '../../src/infrastructure/translationProviderResolver.js';

test('creates a resolver with a valid registry and registered default provider', () => {
  const geminiProvider = translationProvider();
  const registry = fakeRegistry({
    gemini: geminiProvider
  });

  const resolver = createTranslationProviderResolver({
    registry,
    defaultProviderKey: 'gemini'
  });

  assert.equal(resolver.resolve(), geminiProvider);
});

test('returned resolver object is frozen and exposes only resolve', () => {
  const resolver = createResolver();

  assert.equal(Object.isFrozen(resolver), true);
  assert.deepEqual(Object.keys(resolver), ['resolve']);
  assert.throws(() => {
    resolver.registry = fakeRegistry();
  }, TypeError);
});

test('rejects missing factory options', () => {
  assert.throws(() => createTranslationProviderResolver(), /factory input must be an object/);
  assert.throws(() => createTranslationProviderResolver(null), /factory input must be an object/);
  assert.throws(() => createTranslationProviderResolver([]), /factory input must be an object/);
  assert.throws(() => createTranslationProviderResolver('gemini'), /factory input must be an object/);
});

test('rejects missing registry', () => {
  assert.throws(
    () => createTranslationProviderResolver({ defaultProviderKey: 'gemini' }),
    /registry must be an object/
  );
});

test('rejects invalid registry shapes', () => {
  assert.throws(
    () => createTranslationProviderResolver({ registry: null, defaultProviderKey: 'gemini' }),
    /registry must be an object/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry: [], defaultProviderKey: 'gemini' }),
    /registry must be an object/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry: 'registry', defaultProviderKey: 'gemini' }),
    /registry must be an object/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry: {}, defaultProviderKey: 'gemini' }),
    /registry\.get must be a function/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry: { get: 'get', has() {} }, defaultProviderKey: 'gemini' }),
    /registry\.get must be a function/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry: { get() {} }, defaultProviderKey: 'gemini' }),
    /registry\.has must be a function/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry: { get() {}, has: true }, defaultProviderKey: 'gemini' }),
    /registry\.has must be a function/
  );
});

test('rejects missing default provider key', () => {
  assert.throws(
    () => createTranslationProviderResolver({ registry: fakeRegistry() }),
    /defaultProviderKey must be a string/
  );
});

test('rejects invalid default provider key shapes', () => {
  const registry = fakeRegistry();

  assert.throws(() => createTranslationProviderResolver({ registry, defaultProviderKey: null }), /defaultProviderKey must be a string/);
  assert.throws(() => createTranslationProviderResolver({ registry, defaultProviderKey: 1 }), /defaultProviderKey must be a string/);
  assert.throws(() => createTranslationProviderResolver({ registry, defaultProviderKey: '' }), /defaultProviderKey must be a non-empty string/);
  assert.throws(() => createTranslationProviderResolver({ registry, defaultProviderKey: '   ' }), /defaultProviderKey must be a non-empty string/);
  assert.throws(
    () => createTranslationProviderResolver({ registry, defaultProviderKey: ' gemini' }),
    /defaultProviderKey must not include surrounding whitespace/
  );
  assert.throws(
    () => createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini ' }),
    /defaultProviderKey must not include surrounding whitespace/
  );
});

test('rejects an unregistered default provider key', () => {
  const registry = fakeRegistry({
    gemini: translationProvider()
  });

  assert.throws(
    () => createTranslationProviderResolver({ registry, defaultProviderKey: 'fake' }),
    /defaultProviderKey is not registered: fake/
  );
});

test('checks default availability through the registry contract', () => {
  const calls = [];
  const registry = {
    get(providerKey) {
      calls.push(['get', providerKey]);
      return translationProvider();
    },
    has(providerKey) {
      calls.push(['has', providerKey]);
      return true;
    },
    list() {
      calls.push(['list']);
      return ['gemini'];
    }
  };

  createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.deepEqual(calls, [['has', 'gemini']]);
});

test('resolve resolves the configured default provider when providerKey is omitted or undefined', () => {
  const geminiProvider = translationProvider();
  const registry = fakeRegistry({
    gemini: geminiProvider
  });
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.equal(resolver.resolve(), geminiProvider);
  assert.equal(resolver.resolve({}), geminiProvider);
  assert.equal(resolver.resolve({ providerKey: undefined }), geminiProvider);
});

test('resolve passes the exact default key to registry.get and returns the exact provider instance', () => {
  const geminiProvider = translationProvider();
  const calls = [];
  const registry = fakeRegistry(
    {
      Gemini: geminiProvider
    },
    calls
  );
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'Gemini' });

  assert.equal(resolver.resolve(), geminiProvider);
  assert.deepEqual(calls, [
    ['has', 'Gemini'],
    ['get', 'Gemini']
  ]);
});

test('resolves a registered explicitly requested provider', () => {
  const fakeProvider = translationProvider();
  const resolver = createResolver({
    providers: {
      gemini: translationProvider(),
      fake: fakeProvider
    }
  });

  assert.equal(resolver.resolve({ providerKey: 'fake' }), fakeProvider);
});

test('passes the explicit provider key unchanged to registry.get', () => {
  const selectedProvider = translationProvider();
  const calls = [];
  const registry = fakeRegistry(
    {
      gemini: translationProvider(),
      'gemini.saved-transcript': selectedProvider
    },
    calls
  );
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.equal(resolver.resolve({ providerKey: 'gemini.saved-transcript' }), selectedProvider);
  assert.deepEqual(calls, [
    ['has', 'gemini'],
    ['get', 'gemini.saved-transcript']
  ]);
});

test('preserves case-sensitive exact matching', () => {
  const lowerProvider = translationProvider();
  const upperProvider = translationProvider();
  const resolver = createResolver({
    providers: {
      gemini: lowerProvider,
      Gemini: upperProvider
    }
  });

  assert.equal(resolver.resolve({ providerKey: 'gemini' }), lowerProvider);
  assert.equal(resolver.resolve({ providerKey: 'Gemini' }), upperProvider);
});

test('explicit selection overrides the configured default and returns the exact selected provider instance', () => {
  const geminiProvider = translationProvider();
  const fakeProvider = translationProvider();
  const resolver = createResolver({
    providers: {
      gemini: geminiProvider,
      fake: fakeProvider
    }
  });

  assert.equal(resolver.resolve({ providerKey: 'fake' }), fakeProvider);
});

test('rejects invalid resolve input', () => {
  const resolver = createResolver();

  assert.throws(() => resolver.resolve(null), /resolve options must be an object/);
  assert.throws(() => resolver.resolve([]), /resolve options must be an object/);
  assert.throws(() => resolver.resolve('gemini'), /resolve options must be an object/);
  assert.throws(() => resolver.resolve(123), /resolve options must be an object/);
  assert.throws(() => resolver.resolve(true), /resolve options must be an object/);
});

test('rejects unsupported resolve option names', () => {
  const resolver = createResolver();

  assert.throws(() => resolver.resolve({ provider: 'gemini' }), /unsupported resolve option: provider/);
  assert.throws(() => resolver.resolve({ name: 'gemini' }), /unsupported resolve option: name/);
  assert.throws(() => resolver.resolve({ type: 'gemini' }), /unsupported resolve option: type/);
  assert.throws(
    () => resolver.resolve({ translationProvider: 'gemini' }),
    /unsupported resolve option: translationProvider/
  );
});

test('rejects invalid explicit provider key types', () => {
  const resolver = createResolver();

  assert.throws(() => resolver.resolve({ providerKey: null }), /providerKey must be a string/);
  assert.throws(() => resolver.resolve({ providerKey: 1 }), /providerKey must be a string/);
  assert.throws(() => resolver.resolve({ providerKey: true }), /providerKey must be a string/);
});

test('rejects empty or whitespace-only provider keys', () => {
  const resolver = createResolver();

  assert.throws(() => resolver.resolve({ providerKey: '' }), /providerKey must be a non-empty string/);
  assert.throws(() => resolver.resolve({ providerKey: '   ' }), /providerKey must be a non-empty string/);
});

test('rejects provider keys with surrounding whitespace', () => {
  const resolver = createResolver();

  assert.throws(() => resolver.resolve({ providerKey: ' gemini' }), /providerKey must not include surrounding whitespace/);
  assert.throws(() => resolver.resolve({ providerKey: 'gemini ' }), /providerKey must not include surrounding whitespace/);
});

test('does not trim or normalize explicit keys', () => {
  const registryError = new Error('translation provider not found: GEMINI');
  const calls = [];
  const registry = {
    get(providerKey) {
      calls.push(['get', providerKey]);
      throw registryError;
    },
    has(providerKey) {
      calls.push(['has', providerKey]);
      return providerKey === 'gemini';
    }
  };
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.throws(() => resolver.resolve({ providerKey: 'GEMINI' }), registryError);
  assert.deepEqual(calls, [
    ['has', 'gemini'],
    ['get', 'GEMINI']
  ]);
});

test('explicit unknown provider does not fall back to the default', () => {
  const calls = [];
  const registry = fakeRegistry(
    {
      gemini: translationProvider()
    },
    calls
  );
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.throws(() => resolver.resolve({ providerKey: 'missing-provider' }), /translation provider not found: missing-provider/);
  assert.deepEqual(calls, [
    ['has', 'gemini'],
    ['get', 'missing-provider']
  ]);
});

test('preserves the exact error thrown by registry.get', () => {
  const registryError = new Error('custom registry lookup failure');
  const registry = {
    get() {
      throw registryError;
    },
    has() {
      return true;
    }
  };
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  try {
    resolver.resolve({ providerKey: 'missing-provider' });
    assert.fail('expected registry.get to throw');
  } catch (error) {
    assert.equal(error, registryError);
  }
});

test('does not call registry.get with the default after explicit lookup failure', () => {
  const calls = [];
  const registry = {
    get(providerKey) {
      calls.push(['get', providerKey]);
      throw new Error(`translation provider not found: ${providerKey}`);
    },
    has(providerKey) {
      calls.push(['has', providerKey]);
      return providerKey === 'gemini';
    }
  };
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.throws(() => resolver.resolve({ providerKey: 'fake' }), /translation provider not found: fake/);
  assert.deepEqual(calls, [
    ['has', 'gemini'],
    ['get', 'fake']
  ]);
});

test('does not call provider.translate', () => {
  let translateCallCount = 0;
  const provider = translationProvider({
    translate() {
      translateCallCount += 1;
      return Promise.resolve({ translatedText: 'translated' });
    }
  });
  const resolver = createResolver({
    providers: {
      gemini: provider
    }
  });

  assert.equal(resolver.resolve(), provider);
  assert.equal(translateCallCount, 0);
});

test('does not mutate the supplied resolve options', () => {
  const resolver = createResolver({
    providers: {
      gemini: translationProvider(),
      fake: translationProvider()
    }
  });
  const options = Object.freeze({ providerKey: 'fake' });

  resolver.resolve(options);

  assert.deepEqual(options, { providerKey: 'fake' });
});

test('does not mutate the registry', () => {
  const registry = Object.freeze(fakeRegistry({
    gemini: translationProvider()
  }));

  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  resolver.resolve();
  assert.equal(Object.isFrozen(registry), true);
  assert.deepEqual(Object.keys(registry), ['get', 'has']);
});

test('performs no SDK, environment, HTTP, persistence, retry, or fallback behavior', () => {
  let getCallCount = 0;
  const registry = {
    get(providerKey) {
      getCallCount += 1;
      return providers[providerKey];
    },
    has(providerKey) {
      return Object.hasOwn(providers, providerKey);
    }
  };
  const providers = {
    gemini: translationProvider()
  };
  const resolver = createTranslationProviderResolver({ registry, defaultProviderKey: 'gemini' });

  assert.equal(resolver.resolve(), providers.gemini);
  assert.equal(resolver.resolve(), providers.gemini);
  assert.equal(getCallCount, 2);
});

function createResolver({ providers = { gemini: translationProvider() }, defaultProviderKey = 'gemini' } = {}) {
  return createTranslationProviderResolver({
    registry: fakeRegistry(providers),
    defaultProviderKey
  });
}

function fakeRegistry(providers = {}, calls = []) {
  return {
    get(providerKey) {
      calls.push(['get', providerKey]);

      if (!Object.hasOwn(providers, providerKey)) {
        throw new Error(`translation provider not found: ${providerKey}`);
      }

      return providers[providerKey];
    },
    has(providerKey) {
      calls.push(['has', providerKey]);
      return Object.hasOwn(providers, providerKey);
    }
  };
}

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
