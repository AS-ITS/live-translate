import { promises as fileSystem } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createSessionQueryService } from '../src/application/sessionQueryService.js';
import { createSessionApplicationService } from '../src/application/sessionApplicationService.js';
import { createMeetingMembershipService } from '../src/application/meetingMembershipService.js';
import { createProfileService } from './profileService.js';
import { createTranslationHistoryQueryService } from '../src/application/translationHistoryQueryService.js';
import { createTranslationApplicationService } from '../src/application/translationApplicationService.js';
import { createMeetingCheckpointService as createDefaultMeetingCheckpointService } from '../src/application/meetingCheckpointService.js';
import { createMeetingDeletionService } from '../src/application/meetingDeletionService.js';
import { createMeetingReadQueryService as createDefaultMeetingReadQueryService } from '../src/application/meetingReadQueryService.js';
import { createSavedTranscriptRetranslationService as createDefaultSavedTranscriptRetranslationService } from '../src/application/translation/index.js';
import { createSessionRetranslationCommandService as createDefaultSessionRetranslationCommandService } from '../src/application/translation/sessionRetranslationCommandService.js';
import { createCancelQueuedTranslationExecutionService as createDefaultCancelQueuedTranslationExecutionService } from '../src/application/translation/cancelQueuedTranslationExecutionService.js';
import { createManualRetryFailedTranslationExecutionService as createDefaultManualRetryFailedTranslationExecutionService } from '../src/application/translation/manualRetryFailedTranslationExecutionService.js';
import { createDeadLetterQueueApplicationService as createDefaultDeadLetterQueueApplicationService } from '../src/application/translation/deadLetterQueueApplicationService.js';
import { createRetranslationSessionMaterializer as createDefaultRetranslationSessionMaterializer } from '../src/application/translation/retranslationSessionMaterializer.js';
import { createStartupTranslationExecutionQueueRecovery as createDefaultStartupTranslationExecutionQueueRecovery } from '../src/application/translation/startupTranslationExecutionQueueRecovery.js';
import { createTranslationCommandService as createDefaultTranslationCommandService } from '../src/application/translationCommandService.js';
import { createTranslationExecutionRunner as createDefaultTranslationExecutionRunner } from '../src/application/translationExecutionRunner.js';
import { createTranslationExecutionFenceGuard as createDefaultTranslationExecutionFenceGuard } from '../src/application/translation/translationExecutionFenceGuard.js';
import { createTranslationExecutionWorker as createDefaultTranslationExecutionWorker } from '../src/application/translationExecutionWorker.js';
import { assertTranslationExecutionQueue } from '../src/application/translation/translationExecutionQueue.js';
import { createRetryPolicy } from '../src/application/translation/retryPolicy.js';
import { createTranscriptPolishingRateLimiter } from '../src/application/translation/transcriptPolishingRateLimiter.js';
import { createTranslationExecutionRetryPolicy } from '../src/application/translation/translationExecutionRetryPolicy.js';
import { createTranslationExecutionRetryErrorClassifier } from '../src/application/translation/translationExecutionRetryErrorClassifier.js';
import { createTranslationExecutionMetrics } from '../src/application/translation/translationExecutionMetrics.js';
import { createProductionObservability } from '../src/application/observability/productionObservability.js';
import { createObservedTranslationExecutionProvider } from '../src/application/observability/observedTranslationExecutionProvider.js';
import { createGeminiClient } from '../src/infrastructure/geminiClient.js';
import { createGeminiClientAdapter } from '../src/infrastructure/geminiClientAdapter.js';
import { createGeminiEnvironment } from '../src/infrastructure/geminiEnvironment.js';
import {
  createGeminiSavedTranscriptTranslationComposition,
  resolveSavedRetranslationModel
} from '../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createGeminiTranslationExecutionProvider } from '../src/infrastructure/geminiTranslationExecutionProvider.js';
import { createDefaultGoogleGenAIClient } from '../src/infrastructure/googleGenAIClient.js';
import { createFakeTranslationExecutionDispatcher } from '../src/infrastructure/fakeTranslationExecutionDispatcher.js';
import { createFakeTranslationExecutionProviderResolver } from '../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { createDualWriteTranslationExecutionQueue } from '../src/infrastructure/dualWriteTranslationExecutionQueue.js';
import { createFileDurableTranslationExecutionQueueRepository } from '../src/infrastructure/fileDurableTranslationExecutionQueueRepository.js';
import { createFileDeadLetterQueueRepository } from '../src/infrastructure/fileDeadLetterQueueRepository.js';
import { createInMemoryTranslationExecutionQueue } from '../src/infrastructure/inMemoryTranslationExecutionQueue.js';
import { createSystemClock } from '../src/infrastructure/systemClock.js';
import { createTranslationExecutionWorkerRuntime as createDefaultTranslationExecutionWorkerRuntime } from '../src/infrastructure/translationExecutionWorkerRuntime.js';
import { createTranslationQueueConfiguration } from '../src/infrastructure/translationQueueConfiguration.js';
import { createTranslationGlossary } from '../src/infrastructure/translationGlossary.js';
import { createFileSessionRepository } from '../src/infrastructure/fileSessionRepository.js';
import { createFileSessionAudioArtifactRepository } from '../src/infrastructure/sessionAudioArtifacts.js';
import { createFileMeetingRepository } from '../src/infrastructure/fileMeetingRepository.js';
import { createFileSessionShareService } from '../src/infrastructure/fileSessionShareService.js';
import { createFileRecorderLeaseService } from '../src/infrastructure/fileRecorderLeaseService.js';
import { createMemoryMeetingRepository } from '../src/infrastructure/meetingRepositoryAdapter.js';
import {
  DEFAULT_TRANSLATION_PROVIDER,
  createTranslationProviderConfiguration
} from '../src/infrastructure/translationProviderConfiguration.js';
import { createTranslationProviderResolutionComposition } from '../src/infrastructure/translationProviderResolutionComposition.js';
import { createTranslationDomainEventPublisherAdapter } from '../src/infrastructure/translationDomainEventPublisherAdapter.js';
import { createTranslationDomainEventSubscriber } from '../src/infrastructure/translationDomainEventSubscriber.js';
import { createExecutionEventBroadcaster, createExecutionEventRepository } from '../src/infrastructure/executionEventBroadcaster.js';
import { createInMemoryDomainEventBus } from '../src/infrastructure/inMemoryDomainEventBus.js';
import { createTranslationRepositoryAdapter } from '../src/infrastructure/translationRepositoryAdapter.js';
import { createMemorySessionRepository } from '../src/lib/sessionRepository.js';
import { createSessionReadRepository } from '../src/repositories/sessionReadRepository.js';
import { createSubtitleCueRepository } from '../src/repositories/subtitleCueRepository.js';
import { createSupabaseMeetingRepository } from '../src/infrastructure/supabaseMeetingRepository.js';
import { createSupabaseSessionRepository } from '../src/infrastructure/supabaseSessionRepository.js';
import { createSupabaseMeetingAudioService } from '../src/infrastructure/supabaseMeetingAudioService.js';
import { createSupabaseMeetingShareService } from '../src/infrastructure/supabaseMeetingShareService.js';
import { createSupabaseMeetingCueService } from '../src/infrastructure/supabaseMeetingCueService.js';
import { createSupabaseMeetingEventRepository } from '../src/infrastructure/supabaseMeetingEventRepository.js';
import { createSupabaseGlossary } from '../src/infrastructure/supabaseGlossary.js';
import { createSupabaseRecorderLeaseService } from '../src/infrastructure/supabaseRecorderLeaseService.js';
import { createSupabaseDurableTranslationExecutionQueueRepository } from '../src/infrastructure/supabaseDurableTranslationExecutionQueueRepository.js';
import { createSupabaseDeadLetterQueueRepository } from '../src/infrastructure/supabaseDeadLetterQueueRepository.js';
import { createSupabaseObservabilityMetricRepository } from '../src/infrastructure/supabaseObservabilityMetricRepository.js';
import { createSupabaseReadinessCheck } from '../src/infrastructure/supabaseReadiness.js';
import { createViewerRealtimeTokenService } from './viewerRealtimeTokenService.js';
import { createSavedTranscriptRetranslationController as createDefaultSavedTranscriptRetranslationController } from './savedTranscriptRetranslationController.js';
import { createSessionRetranslationCommandController as createDefaultSessionRetranslationCommandController } from './sessionRetranslationCommandController.js';
import { createSessionReadController } from './sessionReadController.js';
import { createMeetingReadController as createDefaultMeetingReadController } from './meetingReadController.js';
import { createTranslationCommandController as createDefaultTranslationCommandController } from './translationCommandController.js';
import { createExecutionControlController as createDefaultExecutionControlController } from './executionControlController.js';
import { createTranslationHistoryController as createDefaultTranslationHistoryController } from './translationHistoryController.js';
import { createGlossaryController as createDefaultGlossaryController } from './glossaryController.js';
import { createDeadLetterQueueController as createDefaultDeadLetterQueueController } from './deadLetterQueueController.js';
import { createLiveToken } from './tokenService.js';

export const DEFAULT_DATA_DIR = 'data';
export const DEFAULT_PRODUCTION_DATA_DIR = '/var/data';
export const DEFAULT_TRANSLATION_GLOSSARY_FILE = 'translation-glossary.json';
export const DEFAULT_SESSION_RECORDS_FILE = 'data/session-records.json';
export const DEFAULT_MEETING_RECORDS_FILE = 'meeting-records.json';
export const DEFAULT_SESSION_SHARES_FILE = 'session-shares.json';
export const DEFAULT_RECORDER_LEASES_FILE = 'recorder-leases.json';

export async function ensureDataDirectory({ env = process.env, fileSystem: storageFileSystem = fileSystem } = {}) {
  const directory = dataDirFor(env);
  await storageFileSystem.mkdir(directory, { recursive: true });
  return directory;
}

export function createApplicationDependencies(options = {}) {
  const {
    env = process.env,
    requestHandlerFactory,
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionQueue,
    translationExecutionRunner,
    translationExecutionFenceGuard,
    translationExecutionWorker,
    translationExecutionWorkerRuntime,
    durableTranslationExecutionQueueRepository,
    translationQueueLeaseMs,
    translationQueueLeaseRenewalMs,
    translationQueueClock,
    translationQueueLeaseIdFactory,
    translationQueueLeaseHeartbeatScheduler,
    translationExecutionProvider,
    translationExecutionProviderResolver,
    translationExecutionRetryPolicy,
    translationExecutionRetryErrorClassifier,
    translationExecutionMetrics,
    observabilityMetrics,
    translationDomainEventHandlers,
    executionEventBroadcaster,
    savedTranscriptTranslationProvider,
    resolveSavedTranscriptTranslationProvider,
    savedTranscriptRetranslationServiceFactory = createDefaultSavedTranscriptRetranslationService,
    savedTranscriptRetranslationControllerFactory = createDefaultSavedTranscriptRetranslationController,
    sessionRetranslationCommandServiceFactory = createDefaultSessionRetranslationCommandService,
    sessionRetranslationCommandControllerFactory = createDefaultSessionRetranslationCommandController,
    includeSessionRetranslationCommandController = false,
    idGenerator = createDefaultIdGenerator(),
    clock = () => Date.now(),
    cancelQueuedTranslationExecutionServiceFactory = createDefaultCancelQueuedTranslationExecutionService,
    manualRetryFailedTranslationExecutionServiceFactory = createDefaultManualRetryFailedTranslationExecutionService,
    deadLetterQueueRepository,
    deadLetterQueueApplicationService,
    deadLetterQueueApplicationServiceFactory = createDefaultDeadLetterQueueApplicationService,
    deadLetterQueueControllerFactory = createDefaultDeadLetterQueueController,
    executionControlControllerFactory = createDefaultExecutionControlController,
    translationCommandServiceFactory = createDefaultTranslationCommandService,
    translationCommandControllerFactory = createDefaultTranslationCommandController,
    translationExecutionRunnerFactory = createDefaultTranslationExecutionRunner,
    translationExecutionWorkerFactory = createDefaultTranslationExecutionWorker,
    translationExecutionWorkerRuntimeFactory = createDefaultTranslationExecutionWorkerRuntime,
    transcriptPolishingMaxRpm = positiveIntegerEnv(env.TRANSCRIPT_POLISHING_MAX_RPM, 15),
    translationHistoryQueryServiceFactory = createTranslationHistoryQueryService,
    translationHistoryControllerFactory = createDefaultTranslationHistoryController,
    translationApplicationService,
    translationApplicationServiceFactory = createTranslationApplicationService,
    glossaryController,
    glossaryControllerFactory = createDefaultGlossaryController,
    translationGlossaryFactory = createTranslationGlossary,
    translationGlossaryFileSystem = fileSystem,
    fileSessionRepositoryFactory = createFileSessionRepository,
    sessionRepositoryFileSystem = fileSystem,
    sessionAudioArtifactRepository,
    sessionAudioArtifactRepositoryFactory = createFileSessionAudioArtifactRepository,
    sessionAudioArtifactFileSystem = fileSystem,
    sessionShareService,
    recorderLeaseService,
    sessionApplicationService,
    sessionApplicationServiceFactory = createSessionApplicationService,
    meetingRepository,
    profileService = createProfileService({ env }),
    meetingMembershipService,
    meetingCheckpointServiceFactory = createDefaultMeetingCheckpointService,
    meetingReadQueryServiceFactory = createDefaultMeetingReadQueryService,
    meetingReadControllerFactory = createDefaultMeetingReadController,
    liveTokenCreator,
    ...sessionReadOptions
  } = options;
  const meetingAudioService = options.meetingAudioService;
  const meetingCueService = options.meetingCueService;
  const meetingEventRepository = options.meetingEventRepository;
  const viewerRealtimeTokenService = options.viewerRealtimeTokenService;
  const resolvedTranslationExecutionMetrics = translationExecutionMetrics ?? createTranslationExecutionMetrics();
  const translationGlossary = glossaryController === undefined
    ? translationGlossaryFactory({
        filePath: translationGlossaryFilePathFor(env),
        fileSystem: translationGlossaryFileSystem,
        idFactory: () => idGenerator('glossary'),
        clock
      })
    : undefined;
  const resolvedGlossaryController = glossaryController === undefined
    ? glossaryControllerFactory({ glossary: translationGlossary })
    : glossaryController;
  const resolvedLiveTokenCreator = liveTokenCreator === undefined
    ? (body) => createLiveToken(body, { glossary: translationGlossary, meetingRepository: resolvedMeetingRepository })
    : liveTokenCreator;
  const resolvedMeetingRepository = Object.prototype.hasOwnProperty.call(options, 'meetingRepository')
    ? meetingRepository
    : createMemoryMeetingRepository();
  const resolvedMeetingMembershipService = meetingMembershipService || createMeetingMembershipService({
    profileRepository: { getProfile: (userId) => profileService.getProfile({ id: userId }) },
    membershipRepository: {
      find: ({ meetingId, userId }) => profileService.findMeetingMembership(meetingId, userId),
      list: ({ meetingId, actor }) => profileService.listMeetingMembers(actor, meetingId),
    },
    meetingRepository: resolvedMeetingRepository,
  });
  const sessionReadDependencies = createSessionReadDependencies({
    ...sessionReadOptions,
    meetingRepository: resolvedMeetingRepository,
    ...(shouldUseDefaultFileSessionRepository({ requestHandlerFactory, sessionReadOptions })
      ? {
          sessionRepository: fileSessionRepositoryFactory({
            filePath: sessionRecordsFilePathFor(env),
            fileSystem: sessionRepositoryFileSystem
          })
        }
      : {})
  });
  const resolvedSessionApplicationService = sessionApplicationService ?? (
    hasSessionApplicationCommandContract(sessionReadDependencies.sessionRepository)
      ? sessionApplicationServiceFactory({
          sessionRepository: sessionReadDependencies.sessionRepository,
          sessionReadRepository: sessionReadDependencies.sessionReadRepository
        })
      : undefined
  );
  const resolvedExecutionEventBroadcaster = executionEventBroadcaster ?? createExecutionEventBroadcaster();
  const hasInjectedTranslationRepository = Object.prototype.hasOwnProperty.call(options, 'translationRepository');
  const baseTranslationRepository = hasInjectedTranslationRepository
    ? translationRepository
    : createTranslationRepositoryAdapter({
        sessionRepository: sessionReadDependencies.sessionRepository,
        executionEventBroadcaster: resolvedExecutionEventBroadcaster
      });
  const executionEventTranslationRepository = createExecutionEventRepository({
    repository: baseTranslationRepository,
    broadcaster: resolvedExecutionEventBroadcaster
  });
  const translationCommandDependencies = createTranslationCommandDependencies({
    translationRepository: executionEventTranslationRepository,
    sessionRepository: sessionReadDependencies.sessionRepository,
    meetingRepository: resolvedMeetingRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionQueue,
    translationExecutionRunner,
    translationExecutionFenceGuard,
    translationExecutionWorker,
    translationExecutionWorkerRuntime,
    durableTranslationExecutionQueueRepository,
    translationQueueLeaseMs,
    translationQueueLeaseRenewalMs,
    translationQueueClock,
    translationQueueLeaseIdFactory,
    translationQueueLeaseHeartbeatScheduler,
    translationExecutionProvider,
    translationExecutionProviderResolver,
    translationExecutionRetryPolicy,
    translationExecutionRetryErrorClassifier,
    translationExecutionMetrics: resolvedTranslationExecutionMetrics,
    observabilityMetrics,
    translationDomainEventHandlers,
    idGenerator,
    clock,
    cancelQueuedTranslationExecutionServiceFactory,
    manualRetryFailedTranslationExecutionServiceFactory,
    translationCommandServiceFactory,
    translationCommandControllerFactory,
    translationExecutionRunnerFactory,
    translationExecutionWorkerFactory,
    translationExecutionWorkerRuntimeFactory,
    transcriptPolishingMaxRpm,
    retranslationSessionMaterializerFactory: createDefaultRetranslationSessionMaterializer
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
  const sessionRetranslationCommandService = sessionRetranslationCommandServiceFactory({
    sessionRepository: sessionReadDependencies.sessionRepository,
    translationCommandService: translationCommandDependencies.translationCommandService,
    translationProviderResolver: translationExecutionProviderResolver ?? createFakeTranslationExecutionProviderResolver({
      translationExecutionProvider: translationExecutionProvider ?? { async execute() {} }
    }),
    idGenerator,
    clock
  });
  const sessionRetranslationCommandController = sessionRetranslationCommandControllerFactory({ sessionRetranslationCommandService });
  const translationHistoryQueryService = translationHistoryQueryServiceFactory({
    sessionRepository: sessionReadDependencies.sessionRepository,
    translationRepository: translationCommandDependencies.translationRepository
  });
  const resolvedTranslationApplicationService = translationApplicationService ?? translationApplicationServiceFactory({
    translationCommandService: translationCommandDependencies.translationCommandService,
    translationHistoryQueryService,
    translationRepository: translationCommandDependencies.translationRepository
  });
  const translationCommandController = translationCommandControllerFactory === createDefaultTranslationCommandController
    ? translationCommandControllerFactory({ translationApplicationService: resolvedTranslationApplicationService })
    : translationCommandDependencies.translationCommandController;
  const translationHistoryController = translationHistoryControllerFactory === createDefaultTranslationHistoryController
    ? translationHistoryControllerFactory({ translationApplicationService: resolvedTranslationApplicationService })
    : translationHistoryControllerFactory({ translationHistoryQueryService });
  const executionControlController = executionControlControllerFactory({
    cancelQueuedTranslationExecutionService: translationCommandDependencies.cancelQueuedTranslationExecutionService,
    manualRetryFailedTranslationExecutionService: translationCommandDependencies.manualRetryFailedTranslationExecutionService
  });
  const resolvedDeadLetterQueueApplicationService = deadLetterQueueApplicationService ?? (
    deadLetterQueueRepository === undefined
      ? undefined
      : deadLetterQueueApplicationServiceFactory({
          deadLetterQueueRepository,
          manualRetryFailedTranslationExecutionService: translationCommandDependencies.manualRetryFailedTranslationExecutionService
        })
  );
  const deadLetterQueueController = resolvedDeadLetterQueueApplicationService
    ? deadLetterQueueControllerFactory({ deadLetterQueueApplicationService: resolvedDeadLetterQueueApplicationService })
    : undefined;
  const meetingCheckpointService = meetingCheckpointServiceFactory({
    meetingRepository: resolvedMeetingRepository,
    sessionRepository: sessionReadDependencies.sessionRepository,
    idGenerator,
    clock
  });
  const meetingReadQueryService = meetingReadQueryServiceFactory({
    meetingRepository: resolvedMeetingRepository,
    sessionRepository: sessionReadDependencies.sessionRepository,
    meetingAudioService
  });
  const meetingReadController = meetingReadControllerFactory({ meetingReadQueryService });
  const resolvedSessionAudioArtifactRepository = Object.prototype.hasOwnProperty.call(options, 'sessionAudioArtifactRepository')
    ? sessionAudioArtifactRepository
    : sessionAudioArtifactRepositoryFactory({
        directory: sessionAudioArtifactsDirectoryFor(env),
        fileSystem: sessionAudioArtifactFileSystem,
        clock
      });
  const meetingDeletionService = createMeetingDeletionService({
    meetingRepository: resolvedMeetingRepository,
    sessionRepository: sessionReadDependencies.sessionRepository,
    sessionAudioArtifactRepository: resolvedSessionAudioArtifactRepository,
    deleteMeetingAudio: meetingAudioService
      ? (meetingId) => meetingAudioService.deleteMeetingArtifacts(meetingId)
      : undefined,
    revokeMeetingShares: sessionShareService && typeof sessionShareService.revokeMeetingShares === 'function'
      ? (meetingId) => sessionShareService.revokeMeetingShares(meetingId)
      : undefined
  });
  const requestHandler = requestHandlerFactory
    ? requestHandlerFactory({
      sessionReadController: sessionReadDependencies.sessionReadController,
      sessionRepository: sessionReadDependencies.sessionRepository,
      translationRepository: translationCommandDependencies.translationRepository,
      translationCommandController,
      executionControlController,
      ...(deadLetterQueueController ? { deadLetterQueueController } : {}),
      translationHistoryController,
      meetingRepository: resolvedMeetingRepository,
      meetingReadController,
      meetingCheckpointService,
      meetingDeletionService,
      sessionAudioArtifactRepository: resolvedSessionAudioArtifactRepository,
      ...(meetingAudioService ? { meetingAudioService } : {}),
      ...(meetingCueService ? { meetingCueService } : {}),
      ...(viewerRealtimeTokenService ? { viewerRealtimeTokenService } : {}),
      ...(sessionShareService !== undefined ? { sessionShareService } : {}),
      recorderLeaseService,
      ...(resolvedSessionApplicationService !== undefined
        ? { sessionApplicationService: resolvedSessionApplicationService }
        : {}),
      glossaryController: resolvedGlossaryController,
      liveTokenCreator: resolvedLiveTokenCreator,
      ...(translationCommandDependencies.translationExecutionWorkerRuntime
        ? { translationExecutionWorkerRuntime: translationCommandDependencies.translationExecutionWorkerRuntime }
        : {}),
      translationExecutionMetrics: resolvedTranslationExecutionMetrics,
      ...(savedTranscriptRetranslationController ? { savedTranscriptRetranslationController } : {}),
      ...(includeSessionRetranslationCommandController ? { sessionRetranslationCommandController } : {})
      })
    : undefined;

  return {
    ...sessionReadDependencies,
    ...translationCommandDependencies,
    translationExecutionMetrics: resolvedTranslationExecutionMetrics,
    executionEventBroadcaster: resolvedExecutionEventBroadcaster,
    translationApplicationService: resolvedTranslationApplicationService,
    translationCommandController,
    translationHistoryQueryService,
    translationHistoryController,
    executionControlController,
    ...(deadLetterQueueRepository !== undefined ? { deadLetterQueueRepository } : {}),
    ...(resolvedDeadLetterQueueApplicationService ? { deadLetterQueueApplicationService: resolvedDeadLetterQueueApplicationService } : {}),
    ...(deadLetterQueueController ? { deadLetterQueueController } : {}),
    meetingReadQueryService,
    meetingReadController,
    sessionAudioArtifactRepository: resolvedSessionAudioArtifactRepository,
    ...(meetingAudioService ? { meetingAudioService } : {}),
    ...(meetingCueService ? { meetingCueService } : {}),
    ...(meetingEventRepository ? { meetingEventRepository } : {}),
    ...(viewerRealtimeTokenService ? { viewerRealtimeTokenService } : {}),
    recorderLeaseService,
    meetingRepository: resolvedMeetingRepository,
    meetingCheckpointService,
    meetingDeletionService,
    meetingMembershipService: resolvedMeetingMembershipService,
    glossaryController: resolvedGlossaryController,
    ...(savedTranscriptRetranslationService ? { savedTranscriptRetranslationService } : {}),
    ...(savedTranscriptRetranslationController ? { savedTranscriptRetranslationController } : {}),
    sessionRetranslationCommandService,
    ...(resolvedSessionApplicationService !== undefined
      ? { sessionApplicationService: resolvedSessionApplicationService }
      : {}),
    sessionRetranslationCommandController,
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
    translationGlossaryFactory = createTranslationGlossary,
    glossaryControllerFactory = createDefaultGlossaryController,
    fileSessionRepositoryFactory = createFileSessionRepository,
    fileMeetingRepositoryFactory = createFileMeetingRepository,
    fileDurableTranslationExecutionQueueRepositoryFactory = createFileDurableTranslationExecutionQueueRepository,
    fileDeadLetterQueueRepositoryFactory = createFileDeadLetterQueueRepository,
    dualWriteTranslationExecutionQueueFactory = createDualWriteTranslationExecutionQueue,
    startupTranslationExecutionQueueRecoveryFactory = createDefaultStartupTranslationExecutionQueueRecovery,
    durableQueueFileSystem = fileSystem,
    translationGlossaryFileSystem = fileSystem,
    sessionRepositoryFileSystem = fileSystem,
    sessionShareServiceFileSystem = fileSystem,
    sessionShareServiceFactory = createFileSessionShareService,
    meetingRepositoryFileSystem = fileSystem,
    translationQueueClock = createSystemClock(),
    translationQueueLeaseIdFactory = randomUUID,
    translationQueueLeaseHeartbeatScheduler = createDefaultLeaseHeartbeatScheduler(),
    translationExecutionFenceGuardFactory = createDefaultTranslationExecutionFenceGuard,
    translationExecutionRetryPolicyFactory = createTranslationExecutionRetryPolicy,
    translationExecutionRetryErrorClassifierFactory = createTranslationExecutionRetryErrorClassifier,
    ...applicationOptions
  } = options;

  const translationExecutionMetrics = applicationOptions.translationExecutionMetrics
    ?? createTranslationExecutionMetrics({ clock: translationQueueClock.now.bind(translationQueueClock) });
  const observabilityMetricRepository = applicationOptions.observabilityMetricRepository
    ?? createSupabaseObservabilityMetricRepository({ env });
  const observabilityMetrics = applicationOptions.observabilityMetrics
    ?? createProductionObservability({ repository: observabilityMetricRepository, clock: () => new Date() });
  applicationOptions.observabilityMetrics = observabilityMetrics;
  applicationOptions.observabilityMetricRepository = observabilityMetricRepository;
  applicationOptions.readinessCheck ??= createSupabaseReadinessCheck({ env });

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
  const hasGlobalGeminiApiKey = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
  const canCreateProductionProviderComposition = needsProductionProviderComposition && hasGlobalGeminiApiKey;
  const cloudDataMode = Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
  const translationGlossary = cloudDataMode
    ? createSupabaseGlossary({ env, idFactory: () => `glossary-${randomUUID()}` })
    : translationGlossaryFactory({
      filePath: translationGlossaryFilePathFor(env),
      fileSystem: translationGlossaryFileSystem,
      idFactory: () => `glossary-${randomUUID()}`,
      clock: () => Date.now()
    });
  const sessionRepository = Object.prototype.hasOwnProperty.call(applicationOptions, 'sessionRepository')
    ? applicationOptions.sessionRepository
    : cloudDataMode
      ? createSupabaseSessionRepository({ env, idFactory: randomUUID })
      : fileSessionRepositoryFactory({
          filePath: sessionRecordsFilePathFor(env),
          fileSystem: sessionRepositoryFileSystem
        });
  const meetingRepository = Object.prototype.hasOwnProperty.call(applicationOptions, 'meetingRepository')
    ? applicationOptions.meetingRepository
    : cloudDataMode
      ? createSupabaseMeetingRepository({ env })
      : fileMeetingRepositoryFactory({
          filePath: meetingRecordsFilePathFor(env),
          fileSystem: meetingRepositoryFileSystem
        });
  const sessionShareService = Object.prototype.hasOwnProperty.call(applicationOptions, 'sessionShareService')
    ? applicationOptions.sessionShareService
    : cloudDataMode
      ? createSupabaseMeetingShareService({ env })
      : sessionShareServiceFactory({
      filePath: sessionSharesFilePathFor(env),
      fileSystem: sessionShareServiceFileSystem
    });
  const meetingAudioService = Object.prototype.hasOwnProperty.call(applicationOptions, 'meetingAudioService')
    ? applicationOptions.meetingAudioService
    : cloudDataMode
      ? createSupabaseMeetingAudioService({ env })
      : undefined;
  const meetingCueService = Object.prototype.hasOwnProperty.call(applicationOptions, 'meetingCueService')
    ? applicationOptions.meetingCueService
    : cloudDataMode
      ? createSupabaseMeetingCueService({ env })
      : undefined;
  const meetingEventRepository = Object.prototype.hasOwnProperty.call(applicationOptions, 'meetingEventRepository')
    ? applicationOptions.meetingEventRepository
    : cloudDataMode
      ? createSupabaseMeetingEventRepository({ env })
      : undefined;
  const viewerRealtimeTokenService = Object.prototype.hasOwnProperty.call(applicationOptions, 'viewerRealtimeTokenService')
    ? applicationOptions.viewerRealtimeTokenService
    : cloudDataMode
      ? createViewerRealtimeTokenService({ env })
      : undefined;
  const recorderLeaseService = Object.prototype.hasOwnProperty.call(applicationOptions, 'recorderLeaseService')
    ? applicationOptions.recorderLeaseService
    : cloudDataMode
      ? createSupabaseRecorderLeaseService({ env })
      : createFileRecorderLeaseService({ filePath: recorderLeasesFilePathFor(env), fileSystem: sessionShareServiceFileSystem });
  const glossaryController = glossaryControllerFactory({ glossary: translationGlossary });
  const productionEnvironment = canCreateProductionProviderComposition
    ? geminiEnvironmentFactory({ env })
    : undefined;
  const productionProviderConfiguration = canCreateProductionProviderComposition
    ? translationProviderConfigurationFactory({ environment: env })
    : undefined;
  const productionProviderResolutionComposition =
    hasSavedTranscriptTranslationProvider || hasResolveSavedTranscriptTranslationProvider
      ? undefined
      : canCreateProductionProviderComposition ? createProductionProviderResolutionComposition({
          env,
          environment: productionEnvironment,
          configuration: productionProviderConfiguration,
          geminiEnvironmentFactory,
          googleGenAIClientFactory,
          geminiClientAdapterFactory,
          geminiSavedTranscriptTranslationCompositionFactory,
          translationProviderConfigurationFactory,
          translationProviderResolutionCompositionFactory,
          glossary: translationGlossary
        }) : createUnavailableSavedTranscriptProviderResolution();
  const productionTranslationExecutionProviderResolutionComposition =
    hasTranslationExecutionProvider || hasTranslationExecutionProviderResolver
      ? undefined
  : canCreateProductionProviderComposition ? createProductionTranslationExecutionProviderResolutionComposition({
          env,
          environment: productionEnvironment,
          configuration: productionProviderConfiguration,
          geminiEnvironmentFactory,
          geminiHttpClientFactory,
          geminiClientFactory,
          geminiTranslationExecutionProviderFactory,
          translationProviderConfigurationFactory,
          glossary: translationGlossary
        }) : { resolver: createUnavailableTranslationProviderResolver() };
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
      observabilityMetrics,
      translationProviderResolutionCompositionFactory,
      glossary: translationGlossary
    },
    providerResolutionComposition: productionProviderResolutionComposition
  });
  const configuredQueue = translationQueueConfigurationFactory({ environment: env });
  const queueConfiguration = { ...configuredQueue, durableQueueEnabled: cloudDataMode || configuredQueue.durableQueueEnabled };
  const translationExecutionRetryPolicy = translationExecutionRetryPolicyFactory();
  const translationExecutionRetryErrorClassifier = translationExecutionRetryErrorClassifierFactory();
  const deadLetterQueueRepository = queueConfiguration.durableQueueEnabled
    ? cloudDataMode
      ? createSupabaseDeadLetterQueueRepository({ env })
      : fileDeadLetterQueueRepositoryFactory({ fileSystem: durableQueueFileSystem, filePath: queueConfiguration.deadLetterQueueFilePath })
    : undefined;
  const durableTranslationExecutionQueueRepository = queueConfiguration.durableQueueEnabled
    ? cloudDataMode
      ? createSupabaseDurableTranslationExecutionQueueRepository({ env })
      : fileDurableTranslationExecutionQueueRepositoryFactory({ fileSystem: durableQueueFileSystem, filePath: queueConfiguration.durableQueueFilePath, deadLetterQueueRepository })
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
  const translationExecutionFenceGuard = durableTranslationExecutionQueueRepository !== undefined
    ? translationExecutionFenceGuardFactory({
        durableTranslationExecutionQueueRepository,
        clock: translationQueueClock.now.bind(translationQueueClock)
      })
    : undefined;
  const applicationDependencies = createApplicationDependencies({
    ...applicationOptions,
    ...(cloudDataMode && !Object.prototype.hasOwnProperty.call(applicationOptions, 'idGenerator')
      ? { idGenerator: () => randomUUID() }
      : {}),
    ...(sessionRepository !== undefined ? { sessionRepository } : {}),
    ...(meetingRepository !== undefined ? { meetingRepository } : {}),
    sessionShareService,
    ...(meetingAudioService ? { meetingAudioService } : {}),
    ...(meetingCueService ? { meetingCueService } : {}),
    ...(meetingEventRepository ? { meetingEventRepository } : {}),
    ...(viewerRealtimeTokenService ? { viewerRealtimeTokenService } : {}),
    recorderLeaseService,
    ...(activeTranslationExecutionQueue !== undefined
      ? { translationExecutionQueue: activeTranslationExecutionQueue }
      : {}),
    ...(durableTranslationExecutionQueueRepository !== undefined
      ? { durableTranslationExecutionQueueRepository }
      : {}),
    ...(deadLetterQueueRepository !== undefined ? { deadLetterQueueRepository } : {}),
    ...(translationExecutionFenceGuard !== undefined ? { translationExecutionFenceGuard } : {}),
    translationQueueLeaseMs: queueConfiguration.leaseMs,
    translationQueueLeaseRenewalMs: queueConfiguration.leaseRenewalMs,
    translationQueueClock,
    translationQueueLeaseIdFactory,
    translationQueueLeaseHeartbeatScheduler,
    translationExecutionProvider: resolvedTranslationExecutionProvider,
    translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver,
    translationExecutionRetryPolicy,
    translationExecutionRetryErrorClassifier,
    translationExecutionMetrics,
    glossaryController,
    liveTokenCreator: (body, tokenOptions = {}) => createLiveToken(body, {
      ...tokenOptions,
      glossary: translationGlossary,
      meetingRepository
    }),
    ...resolvedProviderDependencies
  });
  const startupTranslationExecutionQueueRecovery =
    durableTranslationExecutionQueueRepository !== undefined
      ? startupTranslationExecutionQueueRecoveryFactory({
          durableRepository: durableTranslationExecutionQueueRepository,
          activeQueue: primaryTranslationExecutionQueue,
          translationRepository: applicationDependencies.translationRepository,
          translationCommandService: applicationDependencies.translationCommandService,
          canReplayInFlight: async (execution) => {
            const provider = await resolvedTranslationExecutionProviderResolver.resolve(execution.providerKey);
            return provider?.idempotency?.mode === 'guaranteed';
          },
          clock: translationQueueClock.now.bind(translationQueueClock),
          leaseDurationMs: queueConfiguration.leaseMs,
          leaseIdFactory: translationQueueLeaseIdFactory,
          metrics: translationExecutionMetrics,
          observabilityMetrics
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
      : {}),
    translationExecutionRetryPolicy,
    translationExecutionRetryErrorClassifier
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
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition,
  translationGlossaryFactory = createTranslationGlossary,
  translationGlossaryFileSystem = fileSystem
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
  const glossary = translationGlossaryFactory({
    filePath: translationGlossaryFilePathFor(env),
    fileSystem: translationGlossaryFileSystem
  });
  const googleClient = googleGenAIClientFactory({
    apiKey: environment.apiKey
  });
  const geminiClient = geminiClientAdapterFactory({
    client: googleClient
  });
  const geminiProvider = geminiSavedTranscriptTranslationCompositionFactory({
    client: geminiClient,
    env,
    ...(glossary === undefined ? {} : { glossary })
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
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition,
  translationGlossaryFactory = createTranslationGlossary,
  translationGlossaryFileSystem = fileSystem
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
  const glossary = translationGlossaryFactory({
    filePath: translationGlossaryFilePathFor(env),
    fileSystem: translationGlossaryFileSystem
  });
  const googleClient = googleGenAIClientFactory({
    apiKey: environment.apiKey
  });
  const geminiClient = geminiClientAdapterFactory({
    client: googleClient
  });
  const geminiProvider = geminiSavedTranscriptTranslationCompositionFactory({
    client: geminiClient,
    env,
    ...(glossary === undefined ? {} : { glossary })
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

export function createSessionReadDependencies({ sessionRepository, sessionReadRepository, meetingRepository } = {}) {
  const resolvedSessionRepository = sessionRepository || createMemorySessionRepository();
  const resolvedSessionReadRepository =
    sessionReadRepository || createSessionReadRepository({
      sessionRepository: resolvedSessionRepository,
      meetingRepository
    });
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
  sessionRepository,
  meetingRepository,
  domainEventPublisher,
  translationExecutionDispatcher,
  translationExecutionQueue,
  translationExecutionRunner,
  translationExecutionFenceGuard,
  translationExecutionWorker,
  translationExecutionWorkerRuntime,
  durableTranslationExecutionQueueRepository,
  translationQueueLeaseMs,
  translationQueueLeaseRenewalMs,
  translationQueueClock,
  translationQueueLeaseIdFactory,
  translationQueueLeaseHeartbeatScheduler,
  translationExecutionProvider,
  translationExecutionProviderResolver,
  translationExecutionRetryPolicy,
  translationExecutionRetryErrorClassifier,
  translationExecutionMetrics,
  observabilityMetrics,
  translationDomainEventHandlers,
  idGenerator = createDefaultIdGenerator(),
  clock = () => Date.now(),
  cancelQueuedTranslationExecutionServiceFactory = createDefaultCancelQueuedTranslationExecutionService,
  manualRetryFailedTranslationExecutionServiceFactory = createDefaultManualRetryFailedTranslationExecutionService,
  translationCommandServiceFactory = createDefaultTranslationCommandService,
  translationCommandControllerFactory = createDefaultTranslationCommandController,
  translationExecutionRunnerFactory = createDefaultTranslationExecutionRunner,
  translationExecutionWorkerFactory = createDefaultTranslationExecutionWorker,
  translationExecutionWorkerRuntimeFactory = createDefaultTranslationExecutionWorkerRuntime,
  transcriptPolishingMaxRpm = 15,
  retranslationSessionMaterializerFactory
} = {}) {
  assertFactory(translationCommandServiceFactory, 'translationCommandServiceFactory');
  assertFactory(translationCommandControllerFactory, 'translationCommandControllerFactory');
  assertFactory(translationExecutionRunnerFactory, 'translationExecutionRunnerFactory');
  assertFactory(translationExecutionWorkerFactory, 'translationExecutionWorkerFactory');
  assertFactory(translationExecutionWorkerRuntimeFactory, 'translationExecutionWorkerRuntimeFactory');
  assertFactory(cancelQueuedTranslationExecutionServiceFactory, 'cancelQueuedTranslationExecutionServiceFactory');
  assertFactory(manualRetryFailedTranslationExecutionServiceFactory, 'manualRetryFailedTranslationExecutionServiceFactory');
  if (retranslationSessionMaterializerFactory !== undefined) {
    assertFactory(retranslationSessionMaterializerFactory, 'retranslationSessionMaterializerFactory');
  }

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
          retryPolicy: resolvedRetryPolicy,
      transcriptPolishingRateLimiter: createTranscriptPolishingRateLimiter({ maxRequestsPerMinute: transcriptPolishingMaxRpm }),
      observabilityMetrics,
          ...(translationExecutionFenceGuard !== undefined ? { executionFenceGuard: translationExecutionFenceGuard } : {})
        })
      : undefined);
  const retranslationSessionMaterializer = retranslationSessionMaterializerFactory === undefined || !supportsRetranslationSessionMaterializer(sessionRepository)
    ? undefined
    : retranslationSessionMaterializerFactory({ sessionRepository, clock });
  const resolvedWorkerTranslationExecutionRunner =
    resolvedTranslationExecutionRunner === undefined
      ? undefined
      : createWorkerTranslationExecutionRunner({
          translationExecutionRunner: resolvedTranslationExecutionRunner,
          translationRepository,
          translationExecutionProviderResolver: resolvedTranslationExecutionProviderResolver,
          retranslationSessionMaterializer,
          ...(meetingRepository !== undefined ? { subtitleCueRepository: createSubtitleCueRepository({ sessionRepository, meetingRepository }) } : {})
        });
  const resolvedTranslationExecutionWorker =
    translationExecutionWorker ??
    (resolvedWorkerTranslationExecutionRunner !== undefined
      ? translationExecutionWorkerFactory({
          translationExecutionQueue: resolvedTranslationExecutionQueue,
          translationRepository,
      translationExecutionRunner: resolvedWorkerTranslationExecutionRunner,
      observabilityMetrics,
          ...(durableTranslationExecutionQueueRepository !== undefined
            ? { durableTranslationExecutionQueueRepository }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueLeaseMs !== undefined
            ? { leaseDurationMs: translationQueueLeaseMs }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueLeaseRenewalMs !== undefined
            ? { leaseRenewalMs: translationQueueLeaseRenewalMs }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueClock !== undefined
            ? { clock: translationQueueClock.now.bind(translationQueueClock) }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueLeaseIdFactory !== undefined
            ? { leaseIdFactory: translationQueueLeaseIdFactory }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationQueueLeaseHeartbeatScheduler !== undefined
            ? { leaseHeartbeatScheduler: translationQueueLeaseHeartbeatScheduler }
            : {}),
          ...(durableTranslationExecutionQueueRepository !== undefined && translationExecutionRetryPolicy !== undefined
            ? {
                translationExecutionRetryPolicy,
                translationExecutionRetryErrorClassifier
              }
            : {}),
          ...(translationExecutionMetrics !== undefined ? { metrics: translationExecutionMetrics } : {}),
        })
      : undefined);
  const resolvedTranslationExecutionWorkerRuntime =
    translationExecutionWorkerRuntime ??
    (resolvedTranslationExecutionWorker !== undefined
      ? translationExecutionWorkerRuntimeFactory({
          translationExecutionWorker: resolvedTranslationExecutionWorker,
          translationExecutionQueue: resolvedTranslationExecutionQueue,
          ...(durableTranslationExecutionQueueRepository !== undefined
            ? {
                durableRepository: durableTranslationExecutionQueueRepository,
                ...(translationQueueClock !== undefined ? { clock: translationQueueClock.now.bind(translationQueueClock) } : {})
              }
            : {}),
          ...(translationExecutionMetrics !== undefined ? { metrics: translationExecutionMetrics } : {}),
          observabilityMetrics
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
  const cancelQueuedTranslationExecutionService = cancelQueuedTranslationExecutionServiceFactory({
    translationRepository,
    clock
  });
  const manualRetryFailedTranslationExecutionService = manualRetryFailedTranslationExecutionServiceFactory({
    translationRepository,
    translationExecutionQueue: resolvedTranslationExecutionQueue,
    idGenerator,
    clock
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
    ...(translationExecutionRetryPolicy !== undefined ? { translationExecutionRetryPolicy } : {}),
    ...(translationExecutionRetryErrorClassifier !== undefined ? { translationExecutionRetryErrorClassifier } : {}),
    ...(resolvedTranslationExecutionRunner !== undefined
      ? { translationExecutionRunner: resolvedTranslationExecutionRunner }
      : {}),
    ...(retranslationSessionMaterializer !== undefined
      ? { retranslationSessionMaterializer }
      : {}),
    ...(resolvedTranslationExecutionWorker !== undefined
      ? { translationExecutionWorker: resolvedTranslationExecutionWorker }
      : {}),
    ...(resolvedTranslationExecutionWorkerRuntime !== undefined
      ? { translationExecutionWorkerRuntime: resolvedTranslationExecutionWorkerRuntime }
      : {}),
    translationCommandService,
    translationCommandController,
    cancelQueuedTranslationExecutionService,
    manualRetryFailedTranslationExecutionService,
    unsubscribeTranslationDomainEvents: translationDomainEventInfrastructure.unsubscribeTranslationDomainEvents
  };
}

function createDefaultLeaseHeartbeatScheduler() {
  return Object.freeze({
    set(callback, delayMs) { return setTimeout(callback, delayMs); },
    clear(handle) { clearTimeout(handle); }
  });
}

function supportsRetranslationSessionMaterializer(sessionRepository) {
  return Boolean(sessionRepository) &&
    ['createSessionRecord', 'appendTranscriptItem', 'finalizeSessionRecord', 'getSessionRecord']
      .every((methodName) => typeof sessionRepository[methodName] === 'function');
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

function createWorkerTranslationExecutionRunner({ translationExecutionRunner, translationRepository, translationExecutionProviderResolver, retranslationSessionMaterializer, subtitleCueRepository }) {
  const onTranslationOutputCreated = async ({ output }) => {
    if (retranslationSessionMaterializer !== undefined) await retranslationSessionMaterializer.materialize({ output });
    if (subtitleCueRepository !== undefined && output?.operation === 'transcript_polishing' && output.sessionId) {
      const snapshot = output.sourceTranscriptMetadata?.sourceTranscriptSnapshot || {};
      const targets = output.refinementTargets || snapshot.refinementTargets || [];
      const targetByCueId = new Map(targets.map((target) => [target.targetCueId, target]));
      const results = [
        ...(Array.isArray(output.polishedItems) ? output.polishedItems.map((item) => ({ ...item, targetCueId: item.targetCueId || targetByCueId.get(item.cueId)?.targetCueId, fields: item.fields || targetByCueId.get(item.targetCueId || item.cueId)?.fields || ['translation'] })) : []),
        ...(Array.isArray(output.refinedItems) ? output.refinedItems.map((item) => ({ ...item, targetCueId: item.targetCueId || targetByCueId.get(item.cueId)?.targetCueId, fields: item.fields || targetByCueId.get(item.targetCueId || item.cueId)?.fields || ['source', 'translation'] })) : [])
      ].filter((item) => item.targetCueId && targetByCueId.has(item.targetCueId)).map((item) => ({
        ...item,
        sessionId: targetByCueId.get(item.targetCueId)?.sessionId || output.sessionId,
        segmentId: targetByCueId.get(item.targetCueId)?.segmentId || snapshot.segmentId || snapshot.items?.find((candidate) => candidate.cueId === item.targetCueId)?.segmentId,
        refinementJobId: targetByCueId.get(item.targetCueId)?.refinementJobId || output.executionId,
        requestId: targetByCueId.get(item.targetCueId)?.requestId || output.requestId,
        connectionEpoch: targetByCueId.get(item.targetCueId)?.connectionEpoch ?? null,
        version: item.version ?? targetByCueId.get(item.targetCueId)?.version,
        inputHash: item.inputHash ?? targetByCueId.get(item.targetCueId)?.inputHash
      }));
      if (results.length > 0) {
        await subtitleCueRepository.applyRefinementResults({
          sessionId: output.sessionId,
          refinementJobId: output.executionId,
          requestId: output.requestId,
          connectionEpoch: targets[0]?.connectionEpoch ?? null,
          results,
          completedAt: output.completedAt
        });
      }
    }
    if (subtitleCueRepository !== undefined && output?.operation === 'transcript_polishing' && Array.isArray(output.refinedCues)) {
      const snapshot = output.sourceTranscriptMetadata?.sourceTranscriptSnapshot || {};
      if (output.sessionId) {
        await subtitleCueRepository.saveRefinedSubtitleCues({
          sessionId: output.sessionId,
          sourceCueIds: snapshot.items?.map((item) => item.cueId) || [],
          refinedCues: output.refinedCues,
          inputHash: output.inputHash,
          completedAt: output.completedAt
        });
      }
    }
  };

  return Object.freeze({
    execute(input) {
      return translationExecutionRunner.execute(input);
    },

    async canReplayInFlight(execution) {
      const provider = await translationExecutionProviderResolver.resolve(execution.providerKey);
      return provider?.idempotency?.mode === 'guaranteed';
    },

    async run({ execution, request, executionFence, deferProviderFailure } = {}) {
      if (execution.providerAttemptStatus === 'succeeded') {
        return translationExecutionRunner.reconcileSucceeded({
          execution,
          payload: createTranslationExecutionPayloadFromPersistedState({ execution, request }),
          ...(onTranslationOutputCreated === undefined ? {} : { onTranslationOutputCreated }),
          ...(executionFence !== undefined ? { executionFence } : {})
        });
      }

      const runningExecution = execution.start(execution.startedAt);
      const repositoryResult = await translationRepository.updateTranslationExecution(runningExecution);

      return translationExecutionRunner.execute({
        execution: runningExecution,
        payload: createTranslationExecutionPayloadFromPersistedState({ execution, request }),
        repositoryResult,
        ...(onTranslationOutputCreated === undefined ? {} : { onTranslationOutputCreated }),
        ...(executionFence !== undefined ? { executionFence } : {}),
        ...(deferProviderFailure === true ? { deferProviderFailure: true } : {})
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

    wake() {
      return translationExecutionWorkerRuntime.wake?.();
    },

    runOnce(options) {
      return translationExecutionWorkerRuntime.runOnce(options);
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
    cueId: sourceTranscriptSnapshot.cueId,
    sourceText: sourceTextFromSnapshot(sourceTranscriptSnapshot),
    operation: request.operation,
    polishingItems: sourceTranscriptSnapshot.polishingItems,
    refinementItems: sourceTranscriptSnapshot.refinementItems,
    refinementTargets: sourceTranscriptSnapshot.refinementTargets,
    items: sourceTranscriptSnapshot.items,
    mode: sourceTranscriptSnapshot.mode,
    refinementVersion: sourceTranscriptSnapshot.refinementVersion,
    segmentRange: request.segmentRange,
    inputHash: request.inputHash,
    model: request.model ?? (request.operation === 'transcript_polishing' ? transcriptPolishingModelFor(process.env) : undefined),
    sourceLanguageCode: sourceTranscriptSnapshot.sourceLanguageCode,
    sourceLanguageMetadata: sourceTranscriptSnapshot.sourceLanguageDetection,
    sourceTranscriptMetadata: {
      revisionId: request.sourceTranscriptRevisionId,
      sourceTranscriptSnapshot
    },
    glossaryEntries: Array.isArray(sourceTranscriptSnapshot.glossaryEntries)
      ? sourceTranscriptSnapshot.glossaryEntries
      : undefined,
    targetLanguageCode: request.targetLanguageCode,
    providerKey: execution.providerKey,
    completedAt: execution.startedAt
  };
}

function sourceTextFromSnapshot(sourceTranscriptSnapshot) {
  if (Array.isArray(sourceTranscriptSnapshot.refinementItems)) {
    return sourceTranscriptSnapshot.refinementItems
      .map((item) => item?.rawSource || item?.sourceText || item?.text)
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n');
  }
  if (Array.isArray(sourceTranscriptSnapshot.polishingItems)) {
    return sourceTranscriptSnapshot.polishingItems
      .map((item) => item?.translationText || item?.text)
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n');
  }
  if (typeof sourceTranscriptSnapshot.sourceText === 'string') {
    return sourceTranscriptSnapshot.sourceText;
  }

  if (typeof sourceTranscriptSnapshot.text === 'string') {
    return sourceTranscriptSnapshot.text;
  }

  if (Array.isArray(sourceTranscriptSnapshot.items)) {
    return sourceTranscriptSnapshot.items
      .map((item) => item?.rawSource || item?.sourceText || item?.text)
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n');
  }

  return undefined;
}

function transcriptPolishingModelFor(env = process.env) {
  const value = env.TRANSCRIPT_POLISHING_MODEL;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'gemini-3.5-flash';
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

function createUnavailableSavedTranscriptProviderResolution() {
  return Object.freeze({
    configuration: null,
    resolve() {
      throw cloudCredentialProviderError();
    }
  });
}

function createUnavailableTranslationProviderResolver() {
  return Object.freeze({
    resolve() {
      throw cloudCredentialProviderError();
    }
  });
}

function cloudCredentialProviderError() {
  const error = new Error('A user-scoped Gemini credential is required for this operation.');
  error.code = 'gemini_credential_not_configured';
  error.status = 409;
  return error;
}

function createProductionTranslationExecutionProviderResolutionComposition({
  env = process.env,
  environment,
  configuration,
  geminiEnvironmentFactory = createGeminiEnvironment,
  geminiHttpClientFactory = createGeminiHttpClient,
  geminiClientFactory = createGeminiClient,
  geminiTranslationExecutionProviderFactory = createGeminiTranslationExecutionProvider,
  translationProviderConfigurationFactory = createTranslationProviderConfiguration,
  observabilityMetrics,
  glossary
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
    model: resolveSavedRetranslationModel(env),
    ...(glossary === undefined ? {} : { glossary })
  });
  const geminiProvider = geminiTranslationExecutionProviderFactory({
    client: geminiClient
  });
  const observedGeminiProvider = createObservedTranslationExecutionProvider({ provider: geminiProvider, observabilityMetrics });
  const resolver = createProductionTranslationExecutionProviderResolver({
    providers: {
      [DEFAULT_TRANSLATION_PROVIDER]: observedGeminiProvider
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
  translationProviderResolutionCompositionFactory = createTranslationProviderResolutionComposition,
  glossary
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
    env,
    ...(glossary === undefined ? {} : { glossary })
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

function positiveIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertFactory(factory, name) {
  if (typeof factory !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}

function translationGlossaryFilePathFor(env = {}) {
  return env.TRANSLATION_GLOSSARY_FILE ?? join(dataDirFor(env), DEFAULT_TRANSLATION_GLOSSARY_FILE);
}

function sessionRecordsFilePathFor(env = {}) {
  return env.SESSION_RECORDS_FILE ?? join(dataDirFor(env), 'session-records.json');
}

function meetingRecordsFilePathFor(env = {}) {
  return env.MEETING_RECORDS_FILE ?? join(dataDirFor(env), DEFAULT_MEETING_RECORDS_FILE);
}

function sessionSharesFilePathFor(env = {}) {
  return env.SESSION_SHARES_FILE ?? join(dataDirFor(env), DEFAULT_SESSION_SHARES_FILE);
}

function recorderLeasesFilePathFor(env = {}) {
  return env.RECORDER_LEASES_FILE ?? join(dataDirFor(env), DEFAULT_RECORDER_LEASES_FILE);
}

function sessionAudioArtifactsDirectoryFor(env = {}) {
  if (typeof env.SESSION_AUDIO_DIR === 'string' && env.SESSION_AUDIO_DIR.trim().length > 0) {
    return env.SESSION_AUDIO_DIR;
  }
  if (typeof env.SESSION_RECORDS_FILE === 'string' && env.SESSION_RECORDS_FILE.trim().length > 0) {
    return join(dirname(env.SESSION_RECORDS_FILE), 'session-audio');
  }
  return join(dataDirFor(env), 'session-audio');
}

function dataDirFor(env = {}) {
  if (typeof env.DATA_DIR === 'string' && env.DATA_DIR.trim().length > 0) {
    return env.DATA_DIR;
  }

  return env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_DATA_DIR : DEFAULT_DATA_DIR;
}

function shouldUseDefaultFileSessionRepository({ requestHandlerFactory, sessionReadOptions }) {
  return Boolean(requestHandlerFactory) &&
    !Object.prototype.hasOwnProperty.call(sessionReadOptions, 'sessionRepository') &&
    !Object.prototype.hasOwnProperty.call(sessionReadOptions, 'sessionReadRepository');
}

function hasSessionApplicationCommandContract(repository) {
  return repository && ['createSessionRecord', 'updateSessionRecord', 'finalizeSessionRecord']
    .every((method) => typeof repository[method] === 'function');
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
  return function defaultIdGenerator() {
    return randomUUID();
  };
}
