import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
  createProductionApplicationDependencies,
  createSavedTranscriptRetranslationDependencies
} from '../../server/compositionRoot.js';

test('translation application barrel exposes only intended public factories', async () => {
  const exports = await import('../../src/application/translation/index.js');

  assert.deepEqual(Object.keys(exports).sort(), [
    'createSavedTranscriptRetranslationService',
    'createSavedTranscriptTranslationProvider',
    'createTranslationDomainEventHandlers',
    'createTranslationDomainEventPublisher'
  ]);
  assert.equal(typeof exports.createSavedTranscriptRetranslationService, 'function');
  assert.equal(typeof exports.createSavedTranscriptTranslationProvider, 'function');
});

test('saved transcript re-translation dependencies inject only the service contract graph', () => {
  const translationCommandService = commandService();
  const savedTranscriptTranslationProvider = provider();
  const sessionRepository = repository();
  const idGenerator = () => 'id-1';
  const clock = () => 1000;
  const service = { translateSavedTranscript() {} };
  let observedOptions;

  const dependencies = createSavedTranscriptRetranslationDependencies({
    translationCommandService,
    savedTranscriptTranslationProvider,
    sessionRepository,
    idGenerator,
    clock,
    savedTranscriptRetranslationServiceFactory(options) {
      observedOptions = options;
      return service;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, service);
  assert.deepEqual(Object.keys(dependencies), ['savedTranscriptRetranslationService']);
  assert.deepEqual(Object.keys(observedOptions), [
    'translationCommandService',
    'savedTranscriptTranslationProvider',
    'sessionRepository',
    'idGenerator',
    'clock'
  ]);
  assert.strictEqual(observedOptions.translationCommandService, translationCommandService);
  assert.strictEqual(observedOptions.savedTranscriptTranslationProvider, savedTranscriptTranslationProvider);
  assert.strictEqual(observedOptions.sessionRepository, sessionRepository);
  assert.strictEqual(observedOptions.idGenerator, idGenerator);
  assert.strictEqual(observedOptions.clock, clock);
});

test('application composition wires saved transcript re-translation once through controller and request handler', () => {
  const savedTranscriptTranslationProvider = provider();
  const savedTranscriptRetranslationService = { translateSavedTranscript() {} };
  const savedTranscriptRetranslationController = { translateSavedTranscript() {} };
  const requestHandler = function requestHandler() {};
  const calls = [];

  const dependencies = createApplicationDependencies({
    sessionRepository: repository(),
    savedTranscriptTranslationProvider,
    savedTranscriptRetranslationServiceFactory(options) {
      calls.push(['serviceFactory', options]);
      return savedTranscriptRetranslationService;
    },
    savedTranscriptRetranslationControllerFactory(options) {
      calls.push(['controllerFactory', options]);
      return savedTranscriptRetranslationController;
    },
    requestHandlerFactory(options) {
      calls.push(['requestHandlerFactory', options]);
      return requestHandler;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, savedTranscriptRetranslationService);
  assert.strictEqual(dependencies.savedTranscriptRetranslationController, savedTranscriptRetranslationController);
  assert.strictEqual(dependencies.requestHandler, requestHandler);

  assert.strictEqual(calls[0][1].translationCommandService, dependencies.translationCommandService);
  assert.strictEqual(calls[0][1].savedTranscriptTranslationProvider, savedTranscriptTranslationProvider);
  assert.strictEqual(calls[0][1].sessionRepository, dependencies.sessionRepository);
  assert.equal(typeof calls[0][1].idGenerator, 'function');
  assert.equal(typeof calls[0][1].clock, 'function');
  assert.deepEqual(Object.keys(calls[0][1]), [
    'translationCommandService',
    'savedTranscriptTranslationProvider',
    'sessionRepository',
    'idGenerator',
    'clock'
  ]);

  assert.deepEqual(calls[1][1], { savedTranscriptRetranslationService });
  assert.strictEqual(calls[2][1].sessionReadController, dependencies.sessionReadController);
  assert.strictEqual(calls[2][1].translationCommandController, dependencies.translationCommandController);
  assert.strictEqual(calls[2][1].savedTranscriptRetranslationController, savedTranscriptRetranslationController);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), [
    'savedTranscriptRetranslationController',
    'sessionReadController',
    'translationCommandController'
  ]);
});

test('production composition forwards explicit providerKey through provider resolution', () => {
  const calls = [];
  const geminiProvider = provider();
  const resolvedProvider = provider();
  const configuredProviderKey = 'configured-provider';
  const requestedProviderKey = 'alternate-provider';
  const configuration = { defaultProviderKey: configuredProviderKey };
  const savedTranscriptRetranslationService = { translateSavedTranscript() {} };
  let providerResolveCallCount = 0;
  let configurationCallCount = 0;

  const dependencies = createProductionApplicationDependencies({
    providerKey: requestedProviderKey,
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      GEMINI_MODEL: 'unused-by-mock',
      TRANSLATION_PROVIDER: configuredProviderKey
    },
    sessionRepository: repository(),
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
        resolve(resolveOptions) {
          providerResolveCallCount += 1;
          calls.push(['providerResolve', resolveOptions]);
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      calls.push(['serviceFactory', options]);
      return savedTranscriptRetranslationService;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, savedTranscriptRetranslationService);
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'providerConfiguration',
    'googleClient',
    'adapter',
    'providerComposition',
    'providerResolutionComposition',
    'providerResolve',
    'serviceFactory'
  ]);
  assert.equal(configurationCallCount, 1);
  assert.deepEqual(calls[5][1], {
    providers: {
      gemini: geminiProvider
    },
    configuration
  });
  assert.strictEqual(calls[5][1].configuration, configuration);
  assert.ok(!Object.hasOwn(calls[5][1], 'defaultProviderKey'));
  assert.equal(providerResolveCallCount, 1);
  assert.deepEqual(calls[6][1], {
    providerKey: requestedProviderKey,
    configuration
  });
  assert.strictEqual(calls[7][1].savedTranscriptTranslationProvider, resolvedProvider);
  assert.notStrictEqual(calls[7][1].savedTranscriptTranslationProvider, geminiProvider);
  assert.ok(!Object.hasOwn(calls[7][1], 'configuration'));
});

test('production composition forwards omitted providerKey as undefined with the complete configuration', () => {
  const configuration = { defaultProviderKey: 'configured-provider' };
  const resolvedProvider = provider();
  const calls = [];

  createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      GEMINI_MODEL: 'unused-by-mock',
      TRANSLATION_PROVIDER: 'configured-provider'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key', model: 'model-name' };
    },
    googleGenAIClientFactory() {
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory() {
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      return { savedTranscriptTranslationProvider: provider() };
    },
    translationProviderConfigurationFactory() {
      return configuration;
    },
    translationProviderResolutionCompositionFactory(options) {
      assert.strictEqual(options.configuration, configuration);
      return {
        resolve(resolveOptions) {
          calls.push(resolveOptions);
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      assert.strictEqual(options.savedTranscriptTranslationProvider, resolvedProvider);
      return { translateSavedTranscript() {} };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    providerKey: undefined,
    configuration
  });
});

test('production composition passes the resolved provider object unchanged to the service', () => {
  const resolvedProvider = provider();
  let actualProvider;

  createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      GEMINI_MODEL: 'unused-by-mock'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key', model: 'model-name' };
    },
    googleGenAIClientFactory() {
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory() {
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      return { savedTranscriptTranslationProvider: provider() };
    },
    translationProviderConfigurationFactory() {
      return { defaultProviderKey: 'gemini' };
    },
    translationProviderResolutionCompositionFactory() {
      return {
        resolve() {
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      actualProvider = options.savedTranscriptTranslationProvider;
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(actualProvider, resolvedProvider);
});

test('production composition does not extract configuration.defaultProviderKey locally', () => {
  const resolvedProvider = provider();
  const configuration = {};
  Object.defineProperty(configuration, 'defaultProviderKey', {
    enumerable: true,
    get() {
      throw new Error('defaultProviderKey should only be read by provider resolution');
    }
  });

  createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      GEMINI_MODEL: 'unused-by-mock'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key', model: 'model-name' };
    },
    googleGenAIClientFactory() {
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory() {
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      return { savedTranscriptTranslationProvider: provider() };
    },
    translationProviderConfigurationFactory() {
      return configuration;
    },
    translationProviderResolutionCompositionFactory(options) {
      assert.strictEqual(options.configuration, configuration);
      return {
        resolve() {
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      assert.strictEqual(options.savedTranscriptTranslationProvider, resolvedProvider);
      return { translateSavedTranscript() {} };
    }
  });
});

test('production composition propagates provider resolution errors unchanged without service fallback', () => {
  const resolutionError = new Error('resolution failed');
  let serviceFactoryCallCount = 0;

  assert.throws(
    () =>
      createProductionApplicationDependencies({
        providerKey: 'missing-provider',
        env: {
          GEMINI_API_KEY: 'unused-by-mock',
          GEMINI_MODEL: 'unused-by-mock'
        },
        sessionRepository: repository(),
        geminiEnvironmentFactory() {
          return { apiKey: 'api-key', model: 'model-name' };
        },
        googleGenAIClientFactory() {
          return { models: { generateContent() {} } };
        },
        geminiClientAdapterFactory() {
          return { generateContent() {} };
        },
        geminiSavedTranscriptTranslationCompositionFactory() {
          return { savedTranscriptTranslationProvider: provider() };
        },
        translationProviderConfigurationFactory() {
          return { defaultProviderKey: 'gemini' };
        },
        translationProviderResolutionCompositionFactory() {
          return {
            resolve() {
              throw resolutionError;
            }
          };
        },
        savedTranscriptRetranslationServiceFactory() {
          serviceFactoryCallCount += 1;
          return { translateSavedTranscript() {} };
        }
      }),
    resolutionError
  );
  assert.equal(serviceFactoryCallCount, 0);
});

function commandService() {
  return {
    createTranslationRequest() {},
    createTranslationExecution() {},
    updateTranslationExecution() {},
    createTranslationOutput() {}
  };
}

function provider() {
  return {
    translate() {}
  };
}

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
