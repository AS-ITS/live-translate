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
    'createDeadLetterQueueApplicationService',
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
  assert.strictEqual(calls[2][1].executionControlController, dependencies.executionControlController);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), [
    'executionControlController',
    'glossaryController',
    'liveTokenCreator',
    'meetingCheckpointService',
    'meetingDeletionService',
    'meetingReadController',
    'meetingRepository',
    'recorderLeaseService',
    'savedTranscriptRetranslationController',
    'sessionApplicationService',
    'sessionAudioArtifactRepository',
    'sessionReadController',
    'sessionRepository',
    'translationCommandController',
    'translationExecutionMetrics',
    'translationHistoryController',
    'translationRepository'
  ]);
});

test('production composition wires request-scoped provider resolver through provider resolution', () => {
  const calls = [];
  const geminiProvider = provider();
  const resolvedProvider = provider();
  const configuredProviderKey = 'configured-provider';
  const requestedProviderKey = 'alternate-provider';
  const configuration = { defaultProviderKey: configuredProviderKey };
  const savedTranscriptRetranslationService = { translateSavedTranscript() {} };
  let providerResolveCallCount = 0;
  let configurationCallCount = 0;
  let resolveSavedTranscriptTranslationProvider;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      TRANSLATION_PROVIDER: configuredProviderKey
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'api-key' };
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
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
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
  assert.equal(providerResolveCallCount, 0);
  assert.equal(typeof resolveSavedTranscriptTranslationProvider, 'function');
  assert.deepEqual(Object.keys(calls[6][1]), [
    'translationCommandService',
    'resolveSavedTranscriptTranslationProvider',
    'sessionRepository',
    'idGenerator',
    'clock'
  ]);
  assert.ok(!Object.hasOwn(calls[6][1], 'savedTranscriptTranslationProvider'));

  const actualProvider = resolveSavedTranscriptTranslationProvider({
    providerKey: requestedProviderKey
  });

  assert.strictEqual(actualProvider, resolvedProvider);
  assert.equal(providerResolveCallCount, 1);
  assert.deepEqual(calls[7][1], {
    providerKey: requestedProviderKey,
    configuration
  });
});

test('production request-scoped resolver forwards omitted providerKey as undefined with the complete configuration', () => {
  const configuration = { defaultProviderKey: 'configured-provider' };
  const resolvedProvider = provider();
  const calls = [];
  let resolveSavedTranscriptTranslationProvider;

  createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      TRANSLATION_PROVIDER: 'configured-provider'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key' };
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
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
      assert.ok(!Object.hasOwn(options, 'savedTranscriptTranslationProvider'));
      return { translateSavedTranscript() {} };
    }
  });

  const actualProvider = resolveSavedTranscriptTranslationProvider();

  assert.strictEqual(actualProvider, resolvedProvider);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    providerKey: undefined,
    configuration
  });
});

test('production request-scoped resolver returns the resolved provider object unchanged', () => {
  const resolvedProvider = provider();
  let resolveSavedTranscriptTranslationProvider;

  createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key' };
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
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(resolveSavedTranscriptTranslationProvider({ providerKey: 'fake' }), resolvedProvider);
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
      GEMINI_API_KEY: 'unused-by-mock'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key' };
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
      assert.strictEqual(options.resolveSavedTranscriptTranslationProvider(), resolvedProvider);
      return { translateSavedTranscript() {} };
    }
  });
});

test('production request-scoped resolver propagates provider resolution errors unchanged without fallback', () => {
  const resolutionError = new Error('resolution failed');
  let serviceFactoryCallCount = 0;
  let resolveSavedTranscriptTranslationProvider;

  createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock'
    },
    sessionRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key' };
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
    savedTranscriptRetranslationServiceFactory(options) {
      serviceFactoryCallCount += 1;
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
      return { translateSavedTranscript() {} };
    }
  });

  assert.throws(
    () => resolveSavedTranscriptTranslationProvider({ providerKey: 'missing-provider' }),
    resolutionError
  );
  assert.equal(serviceFactoryCallCount, 1);
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
