import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationProviderResolutionComposition } from '../../src/infrastructure/translationProviderResolutionComposition.js';

test('creates a frozen composition with registry and resolver APIs', () => {
  const composition = createComposition();

  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Object.keys(composition), ['registry', 'resolver', 'resolve']);
  assert.equal(typeof composition.registry.get, 'function');
  assert.equal(typeof composition.registry.has, 'function');
  assert.equal(typeof composition.registry.list, 'function');
  assert.equal(typeof composition.resolver.resolve, 'function');
  assert.equal(typeof composition.resolve, 'function');
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

test('unregistered configured default provider is resolved by the resolver', () => {
  const composition = createTranslationProviderResolutionComposition({
    providers: {
      gemini: translationProvider()
    },
    configuration: configuration('missing')
  });

  assert.throws(() => composition.resolver.resolve(), /translation provider not found: missing/);
});

test('invalid providers input preserves registry validation', () => {
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers: undefined, configuration: configuration('gemini') }),
    /providers must be a plain object/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers: null, configuration: configuration('gemini') }),
    /providers must be a plain object/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers: [], configuration: configuration('gemini') }),
    /providers must be a plain object/
  );
});

test('invalid default provider key preserves resolver validation', () => {
  const providers = {
    gemini: translationProvider()
  };

  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers, configuration: undefined }),
    /configuration must be an object/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers, configuration: null }),
    /configuration must be an object/
  );
  assert.throws(
    () => createTranslationProviderResolutionComposition({ providers, configuration: configuration('') }),
    /configuration\.defaultProviderKey must be a non-empty string/
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

test('resolve forwards explicit providerKey and configuration to the resolver', () => {
  const configurationObject = configuration('gemini');
  const resolvedProvider = translationProvider();
  const calls = [];
  const composition = createTranslationProviderResolutionComposition({
    providers: {
      gemini: translationProvider()
    },
    configuration: configurationObject,
    resolverFactory(options) {
      calls.push(['resolverFactory', options]);
      return {
        resolve(resolveOptions) {
          calls.push(['resolve', resolveOptions]);
          return resolvedProvider;
        }
      };
    }
  });

  const result = composition.resolve({ providerKey: 'gemini' });

  assert.strictEqual(result, resolvedProvider);
  assert.deepEqual(calls.map(([name]) => name), ['resolverFactory', 'resolve']);
  assert.strictEqual(calls[0][1].registry, composition.registry);
  assert.strictEqual(calls[0][1].configuration, configurationObject);
  assert.equal(calls[1][1].providerKey, 'gemini');
  assert.strictEqual(calls[1][1].configuration, configurationObject);
});

test('resolve forwards undefined providerKey and configuration without local fallback', () => {
  const configurationObject = configuration('gemini');
  const resolvedProvider = translationProvider();
  const calls = [];
  const composition = createTranslationProviderResolutionComposition({
    providers: {
      gemini: translationProvider()
    },
    configuration: configurationObject,
    resolverFactory() {
      return {
        resolve(resolveOptions) {
          calls.push(resolveOptions);
          return resolvedProvider;
        }
      };
    }
  });

  const result = composition.resolve();

  assert.strictEqual(result, resolvedProvider);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerKey, undefined);
  assert.strictEqual(calls[0].configuration, configurationObject);
});

test('resolve returns the provider returned by the default resolver', () => {
  const provider = translationProvider();
  const composition = createComposition({
    providers: {
      gemini: provider
    }
  });

  assert.strictEqual(composition.resolve({ providerKey: 'gemini' }), provider);
});

function createComposition({ providers = { gemini: translationProvider() }, defaultProviderKey = 'gemini' } = {}) {
  return createTranslationProviderResolutionComposition({
    providers,
    configuration: configuration(defaultProviderKey)
  });
}

function configuration(defaultProviderKey) {
  return {
    defaultProviderKey
  };
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
