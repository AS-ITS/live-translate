import { promises as fileSystem } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createSessionQueryService } from '../src/application/sessionQueryService.js';
import { createSavedTranscriptRetranslationService as createDefaultSavedTranscriptRetranslationService } from '../src/application/translation/index.js';
import { createStartupTranslationExecutionQueueRecovery as createDefaultStartupTranslationExecutionQueueRecovery } from '../src/application/translation/startupTranslationExecutionQueueRecovery.js';
import { createTranslationCommandService as createDefaultTranslationCommandService } from '../src/application/translationCommandService.js';
import { createTranslationExecutionRunner as createDefaultTranslationExecutionRunner } from '../src/application/translationExecutionRunner.js';
import { createTranslationExecutionWorker as createDefaultTranslationExecutionWorker } from '../src/application/translationExecutionWorker.js';
import { assertTranslationExecutionQueue } from '../src/application/translation/translationExecutionQueue.js';
import { createRetryPolicy } from '../src/application/translation/retryPolicy.js';
import { createGeminiClient } from '../src/infrastructure/geminiClient.js';
import { createGeminiClientAdapter } from '../src/infrastructure/geminiClientAdapter.js';
import { createGeminiEnvironment } from '../src/infrastructure/geminiEnvironment.js';
import { createGeminiSavedTranscriptTranslationComposition } from '../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createGeminiTranslationExecutionProvider } from '../src/infrastructure/geminiTranslationExecutionProvider.js';
import { createDefaultGoogleGenAIClient } from '../src/infrastructure/googleGenAIClient.js';
import { createFakeTranslationExecutionDispatcher } from '../src/infrastructure/fakeTranslationExecutionDispatcher.js';
import { createFakeTranslationExecutionProviderResolver } from '../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { createDualWriteTranslationExecutionQueue } from '../src/infrastructure/dualWriteTranslationExecutionQueue.js';
import { createFileDurableTranslationExecutionQueueRepository } from '../src/infrastructure/fileDurableTranslationExecutionQueueRepository.js';
import { createInMemoryTranslationExecutionQueue } from '../src/infrastructure/inMemoryTranslationExecutionQueue.js';
import { createSystemClock } from '../src/infrastructure/systemClock.js';
import { createTranslationExecutionWorkerRuntime as createDefaultTranslationExecutionWorkerRuntime } from '../src/infrastructure/translationExecutionWorkerRuntime.js';
import { createTranslationQueueConfiguration } from '../src/infrastructure/translationQueueConfiguration.js';
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
    translationExecutionQueue,
    translationExecutionRunner,
    translationExecutionWorker,
    translationExecutionWorkerRuntime,
    durableTranslationExecutionQueueRepository,
    translationQueueLeaseMs,
    translationQueueClock,
    translationQueueLeaseIdFactory,
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
    translationExecutionRunnerFactory = createDefaultTranslationExecutionRunner,
    translationExecutionWorkerFactory = createDefaultTranslationExecutionWorker,
    translationExecutionWorkerRuntimeFactory = createDefaultTranslationExecutionWorkerRuntime,
    ...sessionReadOptions
  } = options;
  const sessionReadDependencies = createSessionReadDependencies(sessionReadOptions);
  const translationCommandDependencies = createTranslationCommandDependencies({
    translationRepository: Object.prototype.hasOwnProperty.call(options, 'translationRepository')
      ? translationRepository
      : createTranslationRepositoryAdapter({ sessionRepository: sessionReadDependencies.sessionRepository }),
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionQueue,
    translationExecutionRunner,
    translationExecutionWorker,
    translationExecutionWorkerRuntime,
    durableTranslationExecutionQueueRepository,
    translationQueueLeaseMs,
    translationQueueClock,
    translationQueueLeaseIdFactory,
    translationExecutionProvider,
    translationExecutionProviderResolver,
    translationDomainEventHandlers,
    translationCommandServiceFactory,
    translationCommandControllerFactory,
    translationExecutionRunnerFactory,
    translationExecutionWorkerFactory,
    translationExecutionWorkerRuntimeFactory
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
      sessionRepository: sessionReadDependencies.sessionRepository,
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
    translationQueueConfigurationFactory = createTranslationQueueConfiguration,
    fileDurableTranslationExecutionQueueRepositoryFactory = createFileDurableTranslationExecutionQueueRepository,
    dualWriteTranslationExecutionQueueFactory = createDualWriteTranslationExecutionQueue,
    startupTranslationExecutionQueueRecoveryFactory = createDefaultStartupTranslationExecutionQueueRecovery,
    durableQueueFileSystem = fileSystem,
    translationQueueClock = createSystemClock(),
    translationQueueLeaseIdFactory = randomUUID,
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
  const needsProductionProviderComposition =
    !(hasSavedTranscriptTranslationProvider || hasResolveSavedTranscriptTranslationProvider) ||
    !(hasTranslationExecutionProvider || hasTranslationExecutionProviderResolver);
  const productionEnvironment = needsProductionProviderComposition
    ? geminiEnvironmentFactory({ env })
    : undefined;
  const productionProviderConfiguration = needsProductionProviderComposition
    ? translationProviderConfigurationFactory({ environment: env })
    : undefined;
  const productionProviderResolutionComposition =
    hasSavedTranscriptTranslationProvider || hasResolveSavedTranscriptTranslationProvider
      ? undefined
      : createProductionProviderResolutionComposition({
          env,
          environment: productionEnvironment,
          configuration: productionProviderConfiguration,
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
          environment: productionEnvironment,
          configuration: productionProviderConfiguration,
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
  const queueConfiguration = translationQueueConfigurationFactory({
    environment: env
  });
  const durableTranslationExecutionQueueRepository = queueConfiguration.durableQueueEnabled
    ? fileDurableTranslationExecutionQueueRepositoryFactory({
        fileSystem: durableQueueFileSystem,
        filePath: queueConfiguration.durableQueueFilePath
      })
    : undefined;
  const primaryTranslationExecutionQueue =
    durableTranslationExecutionQueueRepository !== undefined
      ? Object.prototype.hasOwnProperty.call(applicationOptions, 'translationExecutionQueue')
        ? applicationOptions.translationExecutionQueue
        : createInMemoryTranslationExecutionQueue()
      : undefined;
  const activeTranslationExecutionQueue =
    durableTranslationExecutionQueueRepository !== undefined
      ? dualWriteTranslationExecutionQueueFactory({
          primaryQueue: primaryTranslationExecutionQueue,
          durableRepository: durableTranslationExecutionQueueRepository,
          clock: translationQueueClock
        })
      : applicationOptions.translationExecutionQueue;
  const applicationDependencies = createApplicationDependencies({
    ...applicationOptions,
    ...(activeTranslationExecutionQueue !== undefined
      ? { translationExecutionQueue: activeTranslationExecutionQueue }
      : {}),
    ...(durableTranslationExecutionQueueRepository !== undefined
      ? { durableTranslationExecutionQueueRepository }
      : {}),
    translationQueueLeaseMs: queueConfiguration.leaseMs,
    translationQueueClock,
    translationQueueLeaseIdFactory,
    translationExecutionProvider: resolvedTranslationExecutionProvider,
    translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver,
    ...resolvedProviderDependencies
  });
  const startupTranslationExecutionQueueRecovery =
    durableTranslationExecutionQueueRepository !== undefined
      ? startupTranslationExecutionQueueRecoveryFactory({
          durableRepository: durableTranslationExecutionQueueRepository,
          activeQueue: primaryTranslationExecutionQueue,
          translationRepository: applicationDependencies.translationRepository,
          translationCommandService: applicationDependencies.translationCommandService,
          clock: translationQueueClock.now.bind(translationQueueClock)
        })
      : undefined;
  const translationExecutionWorkerRuntime =
    startupTranslationExecutionQueueRecovery !== undefined &&
    applicationDependencies.translationExecutionWorkerRuntime !== undefined
      ? createRecoveryBackedWorkerRuntime({
          startupTranslationExecutionQueueRecovery,
          translationExecutionWorkerRuntime: applicationDependencies.translationExecutionWorkerRuntime
        })
      : applicationDependencies.translationExecutionWorkerRuntime;

  return {
    ...applicationDependencies,
    ...(translationExecutionWorkerRuntime !== undefined ? { translationExecutionWorkerRuntime } : {}),
    ...(durableTranslationExecutionQueueRepository !== undefined
      ? { durableTranslationExecutionQueueRepository }
      : {}),
    ...(startupTranslationExecutionQueueRecovery !== undefined
      ? { startupTranslationExecutionQueueRecovery }
      : {})
  };
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
  translationExecutionQueue,
  translationExecutionRunner,
  translationExecutionWorker,
  translationExecutionWorkerRuntime,
  durableTranslationExecutionQueueRepository,
  translationQueueLeaseMs,
  translationQueueClock,
  translationQueueLeaseIdFactory,
  translationExecutionProvider,
  translationExecutionProviderResolver,
  translationDomainEventHandlers,
  translationCommandServiceFactory = createDefaultTranslationCommandService,
  translationCommandControllerFactory = createDefaultTranslationCommandController,
  translationExecutionRunnerFactory = createDefaultTranslationExecutionRunner,
  translationExecutionWorkerFactory = createDefaultTranslationExecutionWorker,
  translationExecutionWorkerRuntimeFactory = createDefaultTranslationExecutionWorkerRuntime
} = {}) {
  assertFactory(translationCommandServiceFactory, 'translationCommandServiceFactory');
  assertFactory(translationCommandControllerFactory, 'translationCommandControllerFactory');
  assertFactory(translationExecutionRunnerFactory, 'translationExecutionRunnerFactory');
  assertFactory(translationExecutionWorkerFactory, 'translationExecutionWorkerFactory');
  assertFactory(translationExecutionWorkerRuntimeFactory, 'translationExecutionWorkerRuntimeFactory');

  const translationDomainEventInfrastructure = createTranslationDomainEventInfrastructure({
    domainEventPublisher,
    translationDomainEventHandlers
  });
  const resolvedDomainEventPublisher = translationDomainEventInfrastructure.domainEventPublisher;
  const resolvedTranslationExecutionDispatcher =
    translationExecutionDispatcher ?? createFakeTranslationExecutionDispatcher();
  const resolvedTranslationExecutionQueue = translationExecutionQueue ?? createInMemoryTranslationExecutionQueue();
  assertTranslationExecutionQueue(resolvedTranslationExecutionQueue);
  const resolvedTranslationExecutionProviderResolver =
    translationExecutionProviderResolver ??
    (translationExecutionProvider !== undefined
      ? createFakeTranslationExecutionProviderResolver({ translationExecutionProvider })
      : undefined);
  const resolvedRetryPolicy = resolvedTranslationExecutionProviderResolver !== undefined ? createRetryPolicy() : undefined;
  const resolvedTranslationExecutionRunner =
    translationExecutionRunner ??
    (resolvedTranslationExecutionProviderResolver !== undefined
      ? translationExecutionRunnerFactory({
          translationRepository,
          translationExecutionProvider: createResolverBackedTranslationExecutionProvider(
            resolvedTranslationExecutionProviderResolver
          ),
          retryPolicy: resolvedRetryPolicy
        })
      : undefined);
  const resolvedWorkerTranslationExecutionRunner =
    resolvedTranslationExecutionRunner === undefined
      ? undefined
      : createWorkerTranslationExecutionRunner({
          translationExecutionRunner: resolvedTranslationExecutionRunner,
          translationRepository
        });
  const resolvedTranslationExecutionWorker =
    translationExecutionWorker ??
    (resolvedWorkerTranslationExecutionRunner !== undefined
      ? translationExecutionWorkerFactory({
          translationExecutionQueue: resolvedTranslationExecutionQueue,
          translationRepository,
          translationExecutionRunner: resolvedWorkerTranslationExecutionRunner,
          ...(durableTranslationExecutionQueueRepository !== undefined
            ? { durableTranslationExecutionQueueRepository }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueLeaseMs !== undefined
            ? { leaseDurationMs: translationQueueLeaseMs }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueClock !== undefined
            ? { clock: translationQueueClock.now.bind(translationQueueClock) }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueLeaseIdFactory !== undefined
            ? { leaseIdFactory: translationQueueLeaseIdFactory }
            : {})
        })
      : undefined);
  const resolvedTranslationExecutionWorkerRuntime =
    translationExecutionWorkerRuntime ??
    (resolvedTranslationExecutionWorker !== undefined
      ? translationExecutionWorkerRuntimeFactory({
          translationExecutionWorker: resolvedTranslationExecutionWorker,
          translationExecutionQueue: resolvedTranslationExecutionQueue
        })
      : undefined);
  const translationCommandService = translationCommandServiceFactory({
    translationRepository,
    domainEventPublisher: resolvedDomainEventPublisher,
    translationExecutionDispatcher: resolvedTranslationExecutionDispatcher,
    translationExecutionQueue: resolvedTranslationExecutionQueue,
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
    translationExecutionQueue: resolvedTranslationExecutionQueue,
    ...(translationExecutionProvider !== undefined ? { translationExecutionProvider } : {}),
    ...(resolvedTranslationExecutionProviderResolver !== undefined
      ? { translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver }
      : {}),
    ...(resolvedRetryPolicy !== undefined ? { retryPolicy: resolvedRetryPolicy } : {}),
    ...(resolvedTranslationExecutionRunner !== undefined
      ? { translationExecutionRunner: resolvedTranslationExecutionRunner }
      : {}),
    ...(resolvedTranslationExecutionWorker !== undefined
      ? { translationExecutionWorker: resolvedTranslationExecutionWorker }
      : {}),
    ...(resolvedTranslationExecutionWorkerRuntime !== undefined
      ? { translationExecutionWorkerRuntime: resolvedTranslationExecutionWorkerRuntime }
      : {}),
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

function createResolverBackedTranslationExecutionProvider(translationExecutionProviderResolver) {
  return Object.freeze({
    async execute(input) {
      const provider = await translationExecutionProviderResolver.resolve(input?.providerKey);

      return provider.execute(input);
    }
  });
}

function createWorkerTranslationExecutionRunner({ translationExecutionRunner, translationRepository }) {
  return Object.freeze({
    execute(input) {
      return translationExecutionRunner.execute(input);
    },

    async run({ execution, request } = {}) {
      const runningExecution = execution.start(execution.startedAt);
      const repositoryResult = await translationRepository.updateTranslationExecution(runningExecution);

      return translationExecutionRunner.execute({
        execution: runningExecution,
        payload: createTranslationExecutionPayloadFromPersistedState({ execution, request }),
        repositoryResult
      });
    }
  });
}

function createRecoveryBackedWorkerRuntime({ startupTranslationExecutionQueueRecovery, translationExecutionWorkerRuntime }) {
  return Object.freeze({
    async start() {
      await startupTranslationExecutionQueueRecovery.recover();
      return translationExecutionWorkerRuntime.start();
    },

    stop() {
      return translationExecutionWorkerRuntime.stop();
    },

    isRunning() {
      return translationExecutionWorkerRuntime.isRunning();
    }
  });
}

function createTranslationExecutionPayloadFromPersistedState({ execution, request }) {
  const sourceTranscriptSnapshot = request.sourceTranscriptSnapshot ?? {};

  return {
    requestId: request.id,
    sessionId: request.sessionId,
    executionId: execution.id,
    sourceText: sourceTextFromSnapshot(sourceTranscriptSnapshot),
    sourceLanguageCode: sourceTranscriptSnapshot.sourceLanguageCode,
    targetLanguageCode: request.targetLanguageCode,
    providerKey: execution.providerKey,
    completedAt: execution.startedAt
  };
}

function sourceTextFromSnapshot(sourceTranscriptSnapshot) {
  if (typeof sourceTranscriptSnapshot.sourceText === 'string') {
    return sourceTranscriptSnapshot.sourceText;
  }

  if (typeof sourceTranscriptSnapshot.text === 'string') {
    return sourceTranscriptSnapshot.text;
  }

  if (Array.isArray(sourceTranscriptSnapshot.items)) {
    return sourceTranscriptSnapshot.items
      .map((item) => item?.text)
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n');
  }

  return undefined;
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
  environment,
  configuration,
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

  const resolvedEnvironment = environment ?? geminiEnvironmentFactory({ env });
  const resolvedConfiguration = configuration ?? translationProviderConfigurationFactory({ environment: env });
  const httpClient = geminiHttpClientFactory({
    apiKey: resolvedEnvironment.apiKey
  });
  const geminiClient = geminiClientFactory({
    httpClient,
    model: resolvedEnvironment.model
  });
  const geminiProvider = geminiTranslationExecutionProviderFactory({
    client: geminiClient
  });
  const resolver = createProductionTranslationExecutionProviderResolver({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: geminiProvider
    },
    configuration: resolvedConfiguration
  });

  return Object.freeze({
    configuration: resolvedConfiguration,
    geminiClient,
    geminiProvider,
    resolver
  });
}

function createProductionProviderResolutionComposition({
  env = process.env,
  environment,
  configuration,
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

  const resolvedEnvironment = environment ?? geminiEnvironmentFactory({ env });
  const resolvedConfiguration = configuration ?? translationProviderConfigurationFactory({ environment: env });
  const googleClient = googleGenAIClientFactory({
    apiKey: resolvedEnvironment.apiKey
  });
  const geminiClient = geminiClientAdapterFactory({
    client: googleClient
  });
  const geminiProvider = geminiSavedTranscriptTranslationCompositionFactory({
    client: geminiClient,
    model: resolvedEnvironment.model
  }).savedTranscriptTranslationProvider;
  const providerResolutionComposition = translationProviderResolutionCompositionFactory({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: geminiProvider
    },
    configuration: resolvedConfiguration
  });

  return Object.freeze({
    ...providerResolutionComposition,
    configuration: resolvedConfiguration
  });
}

function createProductionTranslationExecutionProviderResolver({ providers, configuration }) {
  assertExecutionProviderMap(providers);
  assertProviderConfiguration(configuration);

  return Object.freeze({
    resolve(providerKey) {
      const defaultProviderKey = configuration.defaultProviderKey;
      assertProviderKey(defaultProviderKey, 'configuration.defaultProviderKey');
      const resolvedProviderKey = providerKey ?? defaultProviderKey;
      assertProviderKey(resolvedProviderKey, 'providerKey');

      if (!Object.hasOwn(providers, resolvedProviderKey)) {
        throw new Error(`translation execution provider not found: ${resolvedProviderKey}`);
      }

      return providers[resolvedProviderKey];
    }
  });
}

function assertProviderConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || !Object.hasOwn(configuration, 'defaultProviderKey')) {
    throw new TypeError('configuration.defaultProviderKey is required.');
  }
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
