import { createSessionQueryService } from '../src/application/sessionQueryService.js';
import { createSavedTranscriptRetranslationService as createDefaultSavedTranscriptRetranslationService } from '../src/application/translation/index.js';
import { createTranslationCommandService as createDefaultTranslationCommandService } from '../src/application/translationCommandService.js';
import { createRetryPolicy } from '../src/application/translation/retryPolicy.js';
import { createGeminiClient } from '../src/infrastructure/geminiClient.js';
import { createGeminiClientAdapter } from '../src/infrastructure/geminiClientAdapter.js';
import { createGeminiEnvironment } from '../src/infrastructure/geminiEnvironment.js';
import { createGeminiSavedTranscriptTranslationComposition } from '../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createGeminiTranslationExecutionProvider } from '../src/infrastructure/geminiTranslationExecutionProvider.js';
import { createDefaultGoogleGenAIClient } from '../src/infrastructure/googleGenAIClient.js';
import { createFakeTranslationExecutionDispatcher } from '../src/infrastructure/fakeTranslationExecutionDispatcher.js';
import { createFakeTranslationExecutionProviderResolver } from '../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import {
  DEFAULT_TRANSLATION_PROVIDER,
  createTranslationProviderConfiguration
} from '../src/infrastructure/translationProviderConfiguration.js';
import { createTranslationProviderResolutionComposition } from '../src/infrastructure/translationProviderResolutionComposition.js';
import { createTranslationDomainEventPublisherAdapter } from '../src/infrastructure/translationDomainEventPublisherAdapter.js';
import { createTranslationDomainEventSubscriber } from '../src/infrastructure/translationDomainEventSubscriber.js';
import { createInMemoryDomainEventBus } from '../src/infrastructure/inMemoryDomainEventBus.js';
import { createTranslationRepositoryAdapter } from '../src/infrastructure/translationRepositoryAdapter.js';
import { createMemorySessionRepository } from '../src/lib/sessionRepository.js';
import { createSessionReadRepository } from '../src/repositories/sessionReadRepository.js';
import { createSavedTranscriptRetranslationController as createDefaultSavedTranscriptRetranslationController } from './savedTranscriptRetranslationController.js';
import { createSessionReadController } from './sessionReadController.js';
import { createTranslationCommandController as createDefaultTranslationCommandController } from './translationCommandController.js';

export function createApplicationDependencies(options = {}) {
  const {
    requestHandlerFactory,
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionProvider,
    translationExecutionProviderResolver,
    translationDomainEventHandlers,
    savedTranscriptTranslationProvider,
    resolveSavedTranscriptTranslationProvider,
    savedTranscriptRetranslationServiceFactory = createDefaultSavedTranscriptRetranslationService,
    savedTranscriptRetranslationControllerFactory = createDefaultSavedTranscriptRetranslationController,
    idGenerator = createDefaultIdGenerator(),
    clock = () => Date.now(),
    translationCommandServiceFactory = createDefaultTranslationCommandService,
    translationCommandControllerFactory = createDefaultTranslationCommandController,
    ...sessionReadOptions
  } = options;
  const sessionReadDependencies = createSessionReadDependencies(sessionReadOptions);
  const translationCommandDependencies = createTranslationCommandDependencies({
    translationRepository: Object.prototype.hasOwnProperty.call(options, 'translationRepository')
      ? translationRepository
      : createTranslationRepositoryAdapter({ sessionRepository: sessionReadDependencies.sessionRepository }),
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionProvider,
    translationExecutionProviderResolver,
    translationDomainEventHandlers,
    translationCommandServiceFactory,
    translationCommandControllerFactory
  });
  const shouldCreateSavedTranscriptRetranslationService =
    Object.prototype.hasOwnProperty.call(options, 'savedTranscriptTranslationProvider') ||
    Object.prototype.hasOwnProperty.call(options, 'resolveSavedTranscriptTranslationProvider');
  const savedTranscriptRetranslationService = shouldCreateSavedTranscriptRetranslationService
    ? createSavedTranscriptRetranslationDependencies({
        translationCommandService: translationCommandDependencies.translationCommandService,
        savedTranscriptTranslationProvider,
        resolveSavedTranscriptTranslationProvider,
        sessionRepository: sessionReadDependencies.sessionRepository,
        idGenerator,
        clock,
        savedTranscriptRetranslationServiceFactory
      }).savedTranscriptRetranslationService
    : undefined;
  const savedTranscriptRetranslationController = savedTranscriptRetranslationService
    ? savedTranscriptRetranslationControllerFactory({ savedTranscriptRetranslationService })
    : undefined;
  const requestHandler = requestHandlerFactory
    ? requestHandlerFactory({
        sessionReadController: sessionReadDependencies.sessionReadController,
        translationCommandController: translationCommandDependencies.translationCommandController,
        ...(savedTranscriptRetranslationController ? { savedTranscriptRetranslationController } : {})
      })
    : undefined;

  return {
    ...sessionReadDependencies,
    ...translationCommandDependencies,
    ...(savedTranscriptRetranslationService ? { savedTranscriptRetranslationService } : {}),
    ...(savedTranscriptRetranslationController ? { savedTranscriptRetranslationController } : {}),
    ...(requestHandler ? { requestHandler } : {})
  };
}

export function createProductionApplicationDependencies(options = {}) {
  const {
    env = process.env,
    translationExecutionProvider,
    translationExecutionProviderResolver,
    savedTranscriptTranslationProvider,
    resolveSavedTranscriptTranslationProvider,
    geminiEnvironmentFactory = createGeminiEnvironment,
    geminiHttpClientFactory = createGeminiHttpClient,
    geminiClientFactory = createGeminiClient,
    geminiTranslationExecutionProviderFactory = createGeminiTranslationExecutionProvider,
    googleGenAIClientFactory = createDefaultGoogleGenAIClient,
    geminiClientAdapterFactory = createGeminiClientAdapter,
    geminiSavedTranscriptTranslationCompositionFactory = createGeminiSavedTranscriptTranslationComposition,
    translationProviderConfigurationFactory = createTranslationProviderConfiguration,
    translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition,
    ...applicationOptions
  } = options;

  const hasTranslationExecutionProvider = Object.prototype.hasOwnProperty.call(options, 'translationExecutionProvider');
  const hasTranslationExecutionProviderResolver = Object.prototype.hasOwnProperty.call(
    options,
    'translationExecutionProviderResolver'
  );
  const hasSavedTranscriptTranslationProvider = Object.prototype.hasOwnProperty.call(
    options,
    'savedTranscriptTranslationProvider'
  );
  const hasResolveSavedTranscriptTranslationProvider = Object.prototype.hasOwnProperty.call(
    options,
    'resolveSavedTranscriptTranslationProvider'
  );
  const productionProviderResolutionComposition =
    hasSavedTranscriptTranslationProvider || hasResolveSavedTranscriptTranslationProvider
      ? undefined
      : createProductionProviderResolutionComposition({
          env,
          geminiEnvironmentFactory,
          googleGenAIClientFactory,
          geminiClientAdapterFactory,
          geminiSavedTranscriptTranslationCompositionFactory,
          translationProviderConfigurationFactory,
          translationProviderResolutionCompositionFactory
        });
  const productionTranslationExecutionProviderResolutionComposition =
    hasTranslationExecutionProvider || hasTranslationExecutionProviderResolver
      ? undefined
      : createProductionTranslationExecutionProviderResolutionComposition({
          env,
          geminiEnvironmentFactory,
          geminiHttpClientFactory,
          geminiClientFactory,
          geminiTranslationExecutionProviderFactory,
          translationProviderConfigurationFactory
        });
  const resolvedTranslationExecutionProvider = hasTranslationExecutionProvider
    ? translationExecutionProvider
    : undefined;
  const resolvedTranslationExecutionProviderResolver = hasTranslationExecutionProviderResolver
    ? translationExecutionProviderResolver
    : hasTranslationExecutionProvider
      ? createFakeTranslationExecutionProviderResolver({
          translationExecutionProvider: resolvedTranslationExecutionProvider,
          providerKey: 'fake'
        })
      : productionTranslationExecutionProviderResolutionComposition.resolver;
  const resolvedProviderDependencies = resolveSavedTranscriptProviderDependencies({
    hasSavedTranscriptTranslationProvider,
    savedTranscriptTranslationProvider,
    hasResolveSavedTranscriptTranslationProvider,
    resolveSavedTranscriptTranslationProvider,
    productionOptions: {
      env,
      geminiEnvironmentFactory,
      geminiHttpClientFactory,
      geminiClientFactory,
      geminiTranslationExecutionProviderFactory,
      googleGenAIClientFactory,
      geminiClientAdapterFactory,
      geminiSavedTranscriptTranslationCompositionFactory,
      translationProviderConfigurationFactory,
      translationProviderResolutionCompositionFactory
    },
    providerResolutionComposition: productionProviderResolutionComposition
  });

  return createApplicationDependencies({
    ...applicationOptions,
    translationExecutionProvider: resolvedTranslationExecutionProvider,
    translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver,
    ...resolvedProviderDependencies
  });
}

export function createProductionSavedTranscriptTranslationProvider({
  env = process.env,
  providerKey,
  geminiEnvironmentFactory = createGeminiEnvironment,
  googleGenAIClientFactory = createDefaultGoogleGenAIClient,
  geminiClientAdapterFactory = createGeminiClientAdapter,
  geminiSavedTranscriptTranslationCompositionFactory = createGeminiSavedTranscriptTranslationComposition,
  translationProviderConfigurationFactory = createTranslationProviderConfiguration,
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition
} = {}) {
  assertFactory(geminiEnvironmentFactory, 'geminiEnvironmentFactory');
  assertFactory(googleGenAIClientFactory, 'googleGenAIClientFactory');
  assertFactory(geminiClientAdapterFactory, 'geminiClientAdapterFactory');
  assertFactory(geminiSavedTranscriptTranslationCompositionFactory, 'geminiSavedTranscriptTranslationCompositionFactory');
  assertFactory(translationProviderConfigurationFactory, 'translationProviderConfigurationFactory');
  assertFactory(translationProviderResolutionCompositionFactory, 'translationProviderResolutionCompositionFactory');

  const environment = geminiEnvironmentFactory({
    env
  });
  const configuration = translationProviderConfigurationFactory({
    environment: env
  });
  const googleClient = googleGenAIClientFactory({
    apiKey: environment.apiKey
  });
  const geminiClient = geminiClientAdapterFactory({
    client: googleClient
  });
  const geminiProvider = geminiSavedTranscriptTranslationCompositionFactory({
    client: geminiClient,
    model: environment.model
  }).savedTranscriptTranslationProvider;
  const providerResolutionComposition = translationProviderResolutionCompositionFactory({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: geminiProvider
    },
    configuration
  });
  const provider = providerResolutionComposition.resolve({
    providerKey,
    configuration
  });

  return provider;
}

export function createProductionSavedTranscriptTranslationProviderResolver({
  env = process.env,
  geminiEnvironmentFactory = createGeminiEnvironment,
  googleGenAIClientFactory = createDefaultGoogleGenAIClient,
  geminiClientAdapterFactory = createGeminiClientAdapter,
  geminiSavedTranscriptTranslationCompositionFactory = createGeminiSavedTranscriptTranslationComposition,
  translationProviderConfigurationFactory = createTranslationProviderConfiguration,
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition
} = {}) {
  assertFactory(geminiEnvironmentFactory, 'geminiEnvironmentFactory');
  assertFactory(googleGenAIClientFactory, 'googleGenAIClientFactory');
  assertFactory(geminiClientAdapterFactory, 'geminiClientAdapterFactory');
  assertFactory(geminiSavedTranscriptTranslationCompositionFactory, 'geminiSavedTranscriptTranslationCompositionFactory');
  assertFactory(translationProviderConfigurationFactory, 'translationProviderConfigurationFactory');
  assertFactory(translationProviderResolutionCompositionFactory, 'translationProviderResolutionCompositionFactory');

  const environment = geminiEnvironmentFactory({
    env
  });
  const configuration = translationProviderConfigurationFactory({
    environment: env
  });
  const googleClient = googleGenAIClientFactory({
    apiKey: environment.apiKey
  });
  const geminiClient = geminiClientAdapterFactory({
    client: googleClient
  });
  const geminiProvider = geminiSavedTranscriptTranslationCompositionFactory({
    client: geminiClient,
    model: environment.model
  }).savedTranscriptTranslationProvider;
  const providerResolutionComposition = translationProviderResolutionCompositionFactory({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: geminiProvider
    },
    configuration
  });

  return function resolveSavedTranscriptTranslationProvider({ providerKey } = {}) {
    return providerResolutionComposition.resolve({
      providerKey,
      configuration
    });
  };
}

export function createSessionReadDependencies({ sessionRepository, sessionReadRepository } = {}) {
  const resolvedSessionRepository = sessionRepository || createMemorySessionRepository();
  const resolvedSessionReadRepository =
    sessionReadRepository || createSessionReadRepository({ sessionRepository: resolvedSessionRepository });
  const sessionQueryService = createSessionQueryService({
    sessionReadRepository: resolvedSessionReadRepository
  });
  const sessionReadController = createSessionReadController({
    sessionQueryService
  });

  return {
    sessionRepository: resolvedSessionRepository,
    sessionReadRepository: resolvedSessionReadRepository,
    sessionQueryService,
    sessionReadController
  };
}

export function createTranslationCommandDependencies({
  translationRepository,
  domainEventPublisher,
  translationExecutionDispatcher,
  translationExecutionProvider,
  translationExecutionProviderResolver,
  translationDomainEventHandlers,
  translationCommandServiceFactory = createDefaultTranslationCommandService,
  translationCommandControllerFactory = createDefaultTranslationCommandController
} = {}) {
  assertFactory(translationCommandServiceFactory, 'translationCommandServiceFactory');
  assertFactory(translationCommandControllerFactory, 'translationCommandControllerFactory');

  const translationDomainEventInfrastructure = createTranslationDomainEventInfrastructure({
    domainEventPublisher,
    translationDomainEventHandlers
  });
  const resolvedDomainEventPublisher = translationDomainEventInfrastructure.domainEventPublisher;
  const resolvedTranslationExecutionDispatcher =
    translationExecutionDispatcher ?? createFakeTranslationExecutionDispatcher();
  const resolvedTranslationExecutionProviderResolver =
    translationExecutionProviderResolver ??
    (translationExecutionProvider !== undefined
      ? createFakeTranslationExecutionProviderResolver({ translationExecutionProvider })
      : undefined);
  const resolvedRetryPolicy = resolvedTranslationExecutionProviderResolver !== undefined ? createRetryPolicy() : undefined;
  const translationCommandService = translationCommandServiceFactory({
    translationRepository,
    domainEventPublisher: resolvedDomainEventPublisher,
    translationExecutionDispatcher: resolvedTranslationExecutionDispatcher,
    ...(resolvedTranslationExecutionProviderResolver !== undefined
      ? { translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver }
      : {}),
    ...(resolvedRetryPolicy !== undefined ? { retryPolicy: resolvedRetryPolicy } : {})
  });
  const translationCommandController = translationCommandControllerFactory({
    translationCommandService
  });

  return {
    translationRepository,
    domainEventPublisher: resolvedDomainEventPublisher,
    translationExecutionDispatcher: resolvedTranslationExecutionDispatcher,
    ...(translationExecutionProvider !== undefined ? { translationExecutionProvider } : {}),
    ...(resolvedTranslationExecutionProviderResolver !== undefined
      ? { translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver }
      : {}),
    ...(resolvedRetryPolicy !== undefined ? { retryPolicy: resolvedRetryPolicy } : {}),
    translationCommandService,
    translationCommandController,
    unsubscribeTranslationDomainEvents: translationDomainEventInfrastructure.unsubscribeTranslationDomainEvents
  };
}

export function createSavedTranscriptRetranslationDependencies({
  translationCommandService,
  savedTranscriptTranslationProvider,
  resolveSavedTranscriptTranslationProvider,
  sessionRepository,
  idGenerator = createDefaultIdGenerator(),
  clock = () => Date.now(),
  savedTranscriptRetranslationServiceFactory = createDefaultSavedTranscriptRetranslationService
} = {}) {
  assertFactory(savedTranscriptRetranslationServiceFactory, 'savedTranscriptRetranslationServiceFactory');

  const savedTranscriptRetranslationService = savedTranscriptRetranslationServiceFactory({
    translationCommandService,
    ...(savedTranscriptTranslationProvider !== undefined ? { savedTranscriptTranslationProvider } : {}),
    ...(resolveSavedTranscriptTranslationProvider !== undefined ? { resolveSavedTranscriptTranslationProvider } : {}),
    sessionRepository,
    idGenerator,
    clock
  });

  return { savedTranscriptRetranslationService };
}

function createTranslationDomainEventInfrastructure({ domainEventPublisher, translationDomainEventHandlers } = {}) {
  const eventBus = createInMemoryDomainEventBus();
  const resolvedDomainEventPublisher = domainEventPublisher || createTranslationDomainEventPublisherAdapter({ eventBus });
  const domainEventSubscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: translationDomainEventHandlers || {}
  });
  const unsubscribeTranslationDomainEvents = domainEventSubscriber.subscribe();

  return {
    domainEventPublisher: resolvedDomainEventPublisher,
    unsubscribeTranslationDomainEvents
  };
}

function resolveSavedTranscriptProviderDependencies({
  hasSavedTranscriptTranslationProvider,
  savedTranscriptTranslationProvider,
  hasResolveSavedTranscriptTranslationProvider,
  resolveSavedTranscriptTranslationProvider,
  productionOptions,
  providerResolutionComposition
}) {
  if (hasSavedTranscriptTranslationProvider) {
    return { savedTranscriptTranslationProvider };
  }

  if (hasResolveSavedTranscriptTranslationProvider) {
    return { resolveSavedTranscriptTranslationProvider };
  }

  const resolvedProviderResolutionComposition =
    providerResolutionComposition ?? createProductionProviderResolutionComposition(productionOptions);

  return {
    resolveSavedTranscriptTranslationProvider({ providerKey } = {}) {
      return resolvedProviderResolutionComposition.resolve({
        providerKey,
        configuration: resolvedProviderResolutionComposition.configuration
      });
    }
  };
}

function createProductionTranslationExecutionProviderResolutionComposition({
  env = process.env,
  geminiEnvironmentFactory = createGeminiEnvironment,
  geminiHttpClientFactory = createGeminiHttpClient,
  geminiClientFactory = createGeminiClient,
  geminiTranslationExecutionProviderFactory = createGeminiTranslationExecutionProvider,
  translationProviderConfigurationFactory = createTranslationProviderConfiguration
} = {}) {
  assertFactory(geminiEnvironmentFactory, 'geminiEnvironmentFactory');
  assertFactory(geminiHttpClientFactory, 'geminiHttpClientFactory');
  assertFactory(geminiClientFactory, 'geminiClientFactory');
  assertFactory(geminiTranslationExecutionProviderFactory, 'geminiTranslationExecutionProviderFactory');
  assertFactory(translationProviderConfigurationFactory, 'translationProviderConfigurationFactory');

  const environment = geminiEnvironmentFactory({
    env
  });
  const configuration = translationProviderConfigurationFactory({
    environment: env
  });
  const httpClient = geminiHttpClientFactory({
    apiKey: environment.apiKey
  });
  const geminiClient = geminiClientFactory({
    httpClient,
    model: environment.model
  });
  const geminiProvider = geminiTranslationExecutionProviderFactory({
    client: geminiClient
  });
  const resolver = createProductionTranslationExecutionProviderResolver({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: geminiProvider
    },
    defaultProviderKey: configuration.defaultProviderKey
  });

  return Object.freeze({
    configuration,
    geminiClient,
    geminiProvider,
    resolver
  });
}

function createProductionProviderResolutionComposition({
  env = process.env,
  geminiEnvironmentFactory = createGeminiEnvironment,
  googleGenAIClientFactory = createDefaultGoogleGenAIClient,
  geminiClientAdapterFactory = createGeminiClientAdapter,
  geminiSavedTranscriptTranslationCompositionFactory = createGeminiSavedTranscriptTranslationComposition,
  translationProviderConfigurationFactory = createTranslationProviderConfiguration,
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition
} = {}) {
  assertFactory(geminiEnvironmentFactory, 'geminiEnvironmentFactory');
  assertFactory(googleGenAIClientFactory, 'googleGenAIClientFactory');
  assertFactory(geminiClientAdapterFactory, 'geminiClientAdapterFactory');
  assertFactory(geminiSavedTranscriptTranslationCompositionFactory, 'geminiSavedTranscriptTranslationCompositionFactory');
  assertFactory(translationProviderConfigurationFactory, 'translationProviderConfigurationFactory');
  assertFactory(translationProviderResolutionCompositionFactory, 'translationProviderResolutionCompositionFactory');

  const environment = geminiEnvironmentFactory({
    env
  });
  const configuration = translationProviderConfigurationFactory({
    environment: env
  });
  const googleClient = googleGenAIClientFactory({
    apiKey: environment.apiKey
  });
  const geminiClient = geminiClientAdapterFactory({
    client: googleClient
  });
  const geminiProvider = geminiSavedTranscriptTranslationCompositionFactory({
    client: geminiClient,
    model: environment.model
  }).savedTranscriptTranslationProvider;
  const providerResolutionComposition = translationProviderResolutionCompositionFactory({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: geminiProvider
    },
    configuration
  });

  return Object.freeze({
    ...providerResolutionComposition,
    configuration
  });
}

function createProductionTranslationExecutionProviderResolver({ providers, defaultProviderKey }) {
  assertExecutionProviderMap(providers);
  assertProviderKey(defaultProviderKey, 'defaultProviderKey');

  return Object.freeze({
    resolve(providerKey) {
      const resolvedProviderKey = providerKey ?? defaultProviderKey;
      assertProviderKey(resolvedProviderKey, 'providerKey');

      if (!Object.hasOwn(providers, resolvedProviderKey)) {
        throw new Error(`translation execution provider not found: ${resolvedProviderKey}`);
      }

      return providers[resolvedProviderKey];
    }
  });
}

function assertFactory(factory, name) {
  if (typeof factory !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}

function assertExecutionProviderMap(providers) {
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new TypeError('translation execution providers must be an object.');
  }

  for (const [providerKey, provider] of Object.entries(providers)) {
    assertProviderKey(providerKey, 'providerKey');

    if (!provider || typeof provider !== 'object' || typeof provider.execute !== 'function') {
      throw new TypeError(`translation execution provider must provide execute: ${providerKey}`);
    }
  }
}

function assertProviderKey(providerKey, fieldName) {
  if (typeof providerKey !== 'string') {
    throw new TypeError(`${fieldName} must be a string.`);
  }

  if (providerKey.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function createGeminiHttpClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://generativelanguage.googleapis.com'
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new TypeError('apiKey must be a non-empty string.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function.');
  }

  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new TypeError('baseUrl must be a non-empty string.');
  }

  const normalizedApiKey = apiKey.trim();
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  return Object.freeze({
    post(request) {
      return fetchImpl(`${normalizedBaseUrl}${request.path}`, {
        method: request.method,
        headers: {
          ...request.headers,
          'x-goog-api-key': normalizedApiKey
        },
        body: JSON.stringify(request.body)
      });
    }
  });
}

function createDefaultIdGenerator() {
  let sequence = 0;

  return function defaultIdGenerator(prefix = 'id') {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  };
}
