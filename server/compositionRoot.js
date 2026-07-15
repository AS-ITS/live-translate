import { createSessionQueryService } from '../src/application/sessionQueryService.js';
import { createSavedTranscriptRetranslationService as createDefaultSavedTranscriptRetranslationService } from '../src/application/translation/index.js';
import { createTranslationCommandService as createDefaultTranslationCommandService } from '../src/application/translationCommandService.js';
import { createGeminiClientAdapter } from '../src/infrastructure/geminiClientAdapter.js';
import { createGeminiEnvironment } from '../src/infrastructure/geminiEnvironment.js';
import { createGeminiSavedTranscriptTranslationComposition } from '../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createDefaultGoogleGenAIClient } from '../src/infrastructure/googleGenAIClient.js';
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
    translationDomainEventHandlers,
    savedTranscriptTranslationProvider,
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
    translationDomainEventHandlers,
    translationCommandServiceFactory,
    translationCommandControllerFactory
  });
  const savedTranscriptRetranslationService = savedTranscriptTranslationProvider
    ? createSavedTranscriptRetranslationDependencies({
        translationCommandService: translationCommandDependencies.translationCommandService,
        savedTranscriptTranslationProvider,
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
    savedTranscriptTranslationProvider,
    geminiEnvironmentFactory = createGeminiEnvironment,
    googleGenAIClientFactory = createDefaultGoogleGenAIClient,
    geminiClientAdapterFactory = createGeminiClientAdapter,
    geminiSavedTranscriptTranslationCompositionFactory = createGeminiSavedTranscriptTranslationComposition,
    translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition,
    ...applicationOptions
  } = options;
  const resolvedSavedTranscriptTranslationProvider = Object.prototype.hasOwnProperty.call(
    options,
    'savedTranscriptTranslationProvider'
  )
    ? savedTranscriptTranslationProvider
    : createProductionSavedTranscriptTranslationProvider({
        env,
        geminiEnvironmentFactory,
        googleGenAIClientFactory,
        geminiClientAdapterFactory,
        geminiSavedTranscriptTranslationCompositionFactory,
        translationProviderResolutionCompositionFactory
      });

  return createApplicationDependencies({
    ...applicationOptions,
    savedTranscriptTranslationProvider: resolvedSavedTranscriptTranslationProvider
  });
}

export function createProductionSavedTranscriptTranslationProvider({
  env = process.env,
  geminiEnvironmentFactory = createGeminiEnvironment,
  googleGenAIClientFactory = createDefaultGoogleGenAIClient,
  geminiClientAdapterFactory = createGeminiClientAdapter,
  geminiSavedTranscriptTranslationCompositionFactory = createGeminiSavedTranscriptTranslationComposition,
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition
} = {}) {
  assertFactory(geminiEnvironmentFactory, 'geminiEnvironmentFactory');
  assertFactory(googleGenAIClientFactory, 'googleGenAIClientFactory');
  assertFactory(geminiClientAdapterFactory, 'geminiClientAdapterFactory');
  assertFactory(geminiSavedTranscriptTranslationCompositionFactory, 'geminiSavedTranscriptTranslationCompositionFactory');
  assertFactory(translationProviderResolutionCompositionFactory, 'translationProviderResolutionCompositionFactory');

  const environment = geminiEnvironmentFactory({
    env
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
      gemini: geminiProvider
    },
    defaultProviderKey: 'gemini'
  });
  const provider = providerResolutionComposition.resolver.resolve();

  return provider;
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
  const translationCommandService = translationCommandServiceFactory({
    translationRepository,
    domainEventPublisher: resolvedDomainEventPublisher
  });
  const translationCommandController = translationCommandControllerFactory({
    translationCommandService
  });

  return {
    translationRepository,
    domainEventPublisher: resolvedDomainEventPublisher,
    translationCommandService,
    translationCommandController,
    unsubscribeTranslationDomainEvents: translationDomainEventInfrastructure.unsubscribeTranslationDomainEvents
  };
}

export function createSavedTranscriptRetranslationDependencies({
  translationCommandService,
  savedTranscriptTranslationProvider,
  sessionRepository,
  idGenerator = createDefaultIdGenerator(),
  clock = () => Date.now(),
  savedTranscriptRetranslationServiceFactory = createDefaultSavedTranscriptRetranslationService
} = {}) {
  assertFactory(savedTranscriptRetranslationServiceFactory, 'savedTranscriptRetranslationServiceFactory');

  const savedTranscriptRetranslationService = savedTranscriptRetranslationServiceFactory({
    translationCommandService,
    savedTranscriptTranslationProvider,
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

function assertFactory(factory, name) {
  if (typeof factory !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}

function createDefaultIdGenerator() {
  let sequence = 0;

  return function defaultIdGenerator(prefix = 'id') {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  };
}
