import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProductionApplicationDependencies,
  createProductionSavedTranscriptTranslationProvider
} from '../../server/compositionRoot.js';

test('production composition assembles Gemini provider and injects it into saved transcript retranslation service', () => {
  const calls = [];
  const env = { GEMINI_API_KEY: 'unused-by-mock', GEMINI_MODEL: 'unused-by-mock' };
  const googleClient = { models: { generateContent() {} } };
  const geminiClient = { generateContent() {} };
  const geminiProvider = { translate() {} };
  const resolvedProvider = { translate() {} };
  const configuration = { defaultProviderKey: 'configured-provider' };
  const service = { translateSavedTranscript() {} };
  let resolverResolveCallCount = 0;
  let configurationCallCount = 0;
  let geminiProviderCallCount = 0;

  const dependencies = createProductionApplicationDependencies({
    env: { ...env, TRANSLATION_PROVIDER: configuration.defaultProviderKey },
    sessionRepository: repository(),
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'exact-api-key', model: 'exact-model' };
    },
    googleGenAIClientFactory(options) {
      calls.push(['googleClient', options]);
      return googleClient;
    },
    geminiClientAdapterFactory(options) {
      calls.push(['adapter', options]);
      return geminiClient;
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      geminiProviderCallCount += 1;
      calls.push(['providerComposition', options]);
      return { savedTranscriptTranslationProvider: geminiProvider };
    },
    translationProviderConfigurationFactory(options) {
      configurationCallCount += 1;
      calls.push(['providerConfiguration', options]);
      return configuration;
    },
    translationProviderResolutionCompositionFactory(options) {
      calls.push(['providerResolutionComposition', options]);
      return {
        registry: { get() {}, has() {}, list() {} },
        resolver: {
          resolve(...resolveArgs) {
            resolverResolveCallCount += 1;
            calls.push(['resolverResolve', resolveArgs]);
            return resolvedProvider;
          }
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      calls.push(['service', options]);
      return service;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, service);
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'providerConfiguration',
    'googleClient',
    'adapter',
    'providerComposition',
    'providerResolutionComposition',
    'resolverResolve',
    'service'
  ]);
  assert.deepEqual(calls[0][1], { env: { ...env, TRANSLATION_PROVIDER: configuration.defaultProviderKey } });
  assert.deepEqual(calls[1][1], { environment: { ...env, TRANSLATION_PROVIDER: configuration.defaultProviderKey } });
  assert.deepEqual(calls[2][1], { apiKey: 'exact-api-key' });
  assert.deepEqual(calls[3][1], { client: googleClient });
  assert.deepEqual(calls[4][1], {
    client: geminiClient,
    model: 'exact-model'
  });
  assert.equal(configurationCallCount, 1);
  assert.equal(geminiProviderCallCount, 1);
  assert.deepEqual(calls[5][1], {
    providers: {
      gemini: geminiProvider
    },
    defaultProviderKey: configuration.defaultProviderKey
  });
  assert.strictEqual(calls[5][1].defaultProviderKey, configuration.defaultProviderKey);
  assert.strictEqual(calls[5][1].providers.gemini, geminiProvider);
  assert.equal(resolverResolveCallCount, 1);
  assert.deepEqual(calls[6][1], []);
  assert.strictEqual(calls[7][1].savedTranscriptTranslationProvider, resolvedProvider);
  assert.notStrictEqual(calls[7][1].savedTranscriptTranslationProvider, geminiProvider);
  assert.ok(!Object.hasOwn(calls[7][1], 'configuration'));
  assert.strictEqual(calls[7][1].translationCommandService, dependencies.translationCommandService);
  assert.strictEqual(calls[7][1].sessionRepository, dependencies.sessionRepository);
  assert.equal(typeof calls[7][1].idGenerator, 'function');
  assert.equal(typeof calls[7][1].clock, 'function');
});

test('production Gemini provider factory returns resolver output exactly once', () => {
  const calls = [];
  const geminiProvider = { translate() {} };
  const resolvedProvider = { translate() {} };
  const configuration = { defaultProviderKey: 'configured-provider' };
  let resolverResolveCallCount = 0;
  let configurationCallCount = 0;
  let geminiProviderCallCount = 0;
  const result = createProductionSavedTranscriptTranslationProvider({
    env: { GEMINI_API_KEY: 'unused-by-mock', TRANSLATION_PROVIDER: configuration.defaultProviderKey },
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'api-key', model: 'model-name' };
    },
    googleGenAIClientFactory(options) {
      calls.push(['googleClient', options]);
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory(options) {
      calls.push(['adapter', options]);
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      geminiProviderCallCount += 1;
      calls.push(['providerComposition', options]);
      return { savedTranscriptTranslationProvider: geminiProvider };
    },
    translationProviderConfigurationFactory(options) {
      configurationCallCount += 1;
      calls.push(['providerConfiguration', options]);
      return configuration;
    },
    translationProviderResolutionCompositionFactory(options) {
      calls.push(['providerResolutionComposition', options]);
      return {
        resolver: {
          resolve(...resolveArgs) {
            resolverResolveCallCount += 1;
            calls.push(['resolverResolve', resolveArgs]);
            return resolvedProvider;
          }
        }
      };
    }
  });

  assert.strictEqual(result, resolvedProvider);
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'providerConfiguration',
    'googleClient',
    'adapter',
    'providerComposition',
    'providerResolutionComposition',
    'resolverResolve'
  ]);
  assert.equal(configurationCallCount, 1);
  assert.equal(geminiProviderCallCount, 1);
  assert.deepEqual(calls[5][1], {
    providers: {
      gemini: geminiProvider
    },
    defaultProviderKey: configuration.defaultProviderKey
  });
  assert.strictEqual(calls[5][1].defaultProviderKey, configuration.defaultProviderKey);
  assert.equal(resolverResolveCallCount, 1);
  assert.deepEqual(calls[6][1], []);
});

test('production Gemini environment validation errors propagate without wrapping', () => {
  const validationError = new Error('Missing GEMINI_API_KEY');

  assert.throws(
    () =>
      createProductionSavedTranscriptTranslationProvider({
        env: {},
        geminiEnvironmentFactory() {
          throw validationError;
        },
        googleGenAIClientFactory() {
          throw new Error('must not be called');
        },
        geminiClientAdapterFactory() {
          throw new Error('must not be called');
        },
        geminiSavedTranscriptTranslationCompositionFactory() {
          throw new Error('must not be called');
        },
        translationProviderConfigurationFactory() {
          throw new Error('must not be called');
        },
        translationProviderResolutionCompositionFactory() {
          throw new Error('must not be called');
        }
      }),
    (error) => error === validationError
  );
});

function repository() {
  return {
    createSessionRecord() {},
    updateSessionRecord() {},
    appendTranscriptItem() {},
    finalizeSessionRecord() {},
    listSessionRecords() {
      return [];
    },
    getSessionRecord() {
      return null;
    },
    deleteSessionRecord() {}
  };
}
