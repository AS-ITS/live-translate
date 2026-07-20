import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProductionApplicationDependencies,
  createProductionSavedTranscriptTranslationProvider
} from '../../server/compositionRoot.js';

test('production composition assembles Gemini provider and injects saved transcript provider resolver', () => {
  const calls = [];
  const env = { GEMINI_API_KEY: 'unused-by-mock', GEMINI_MODEL: 'unused-by-mock' };
  const googleClient = { models: { generateContent() {} } };
  const geminiClient = { generateContent() {} };
  const geminiProvider = { translate() {} };
  const resolvedProvider = { translate() {} };
  const configuredProviderKey = 'configured-provider';
  const configuration = { defaultProviderKey: configuredProviderKey };
  const service = { translateSavedTranscript() {} };
  const savedTranscriptRetranslationController = { translateSavedTranscript() {} };
  const requestHandler = function requestHandler() {};
  let resolverResolveCallCount = 0;
  let configurationCallCount = 0;
  let geminiProviderCallCount = 0;
  let resolveSavedTranscriptTranslationProvider;

  const dependencies = createProductionApplicationDependencies({
    env: { ...env, TRANSLATION_PROVIDER: configuredProviderKey },
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
        },
        resolve(resolveOptions) {
          resolverResolveCallCount += 1;
          calls.push(['resolverResolve', resolveOptions]);
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      calls.push(['service', options]);
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
      return service;
    },
    savedTranscriptRetranslationControllerFactory(options) {
      calls.push(['controller', options]);
      return savedTranscriptRetranslationController;
    },
    requestHandlerFactory(options) {
      calls.push(['requestHandler', options]);
      return requestHandler;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, service);
  assert.strictEqual(dependencies.savedTranscriptRetranslationController, savedTranscriptRetranslationController);
  assert.strictEqual(dependencies.requestHandler, requestHandler);
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'providerConfiguration',
    'googleClient',
    'adapter',
    'providerComposition',
    'providerResolutionComposition',
    'service',
    'controller',
    'requestHandler'
  ]);
  assert.deepEqual(calls[0][1], { env: { ...env, TRANSLATION_PROVIDER: configuredProviderKey } });
  assert.deepEqual(calls[1][1], { environment: { ...env, TRANSLATION_PROVIDER: configuredProviderKey } });
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
    configuration
  });
  assert.strictEqual(calls[5][1].configuration, configuration);
  assert.ok(!Object.hasOwn(calls[5][1], 'defaultProviderKey'));
  assert.strictEqual(calls[5][1].providers.gemini, geminiProvider);
  assert.equal(resolverResolveCallCount, 0);
  assert.equal(typeof resolveSavedTranscriptTranslationProvider, 'function');
  assert.strictEqual(calls[6][1].resolveSavedTranscriptTranslationProvider, resolveSavedTranscriptTranslationProvider);
  assert.ok(!Object.hasOwn(calls[6][1], 'savedTranscriptTranslationProvider'));
  assert.ok(!Object.hasOwn(calls[6][1], 'configuration'));
  assert.strictEqual(calls[6][1].translationCommandService, dependencies.translationCommandService);
  assert.strictEqual(calls[6][1].sessionRepository, dependencies.sessionRepository);
  assert.equal(typeof calls[6][1].idGenerator, 'function');
  assert.equal(typeof calls[6][1].clock, 'function');
  assert.deepEqual(calls[7][1], { savedTranscriptRetranslationService: service });
  assert.deepEqual(calls[8][1], {
    sessionReadController: dependencies.sessionReadController,
    sessionRepository: dependencies.sessionRepository,
    translationCommandController: dependencies.translationCommandController,
    savedTranscriptRetranslationController
  });
  assert.ok(!Object.hasOwn(calls[8][1], 'configuration'));
  assert.ok(!Object.hasOwn(calls[8][1], 'defaultProviderKey'));

  assert.strictEqual(resolveSavedTranscriptTranslationProvider({ providerKey: 'fake' }), resolvedProvider);
  assert.equal(resolverResolveCallCount, 1);
  assert.deepEqual(calls[9][1], {
    providerKey: 'fake',
    configuration
  });
});

test('production Gemini provider factory returns resolver output exactly once', () => {
  const calls = [];
  const geminiProvider = { translate() {} };
  const resolvedProvider = { translate() {} };
  const configuredProviderKey = 'configured-provider';
  const configuration = { defaultProviderKey: configuredProviderKey };
  let resolverResolveCallCount = 0;
  let configurationCallCount = 0;
  let geminiProviderCallCount = 0;
  const result = createProductionSavedTranscriptTranslationProvider({
    env: { GEMINI_API_KEY: 'unused-by-mock', TRANSLATION_PROVIDER: configuredProviderKey },
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
        },
        resolve(resolveOptions) {
          resolverResolveCallCount += 1;
          calls.push(['resolverResolve', resolveOptions]);
          return resolvedProvider;
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
    configuration
  });
  assert.strictEqual(calls[5][1].configuration, configuration);
  assert.ok(!Object.hasOwn(calls[5][1], 'defaultProviderKey'));
  assert.equal(resolverResolveCallCount, 1);
  assert.deepEqual(calls[6][1], {
    providerKey: undefined,
    configuration
  });
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
