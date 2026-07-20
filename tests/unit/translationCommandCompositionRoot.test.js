import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
  createProductionApplicationDependencies,
  createTranslationCommandDependencies
} from '../../server/compositionRoot.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';

test('application dependencies assemble translation command graph with injected repository', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationExecutionDispatcher = dispatcher();
  const translationExecutionQueue = queue();
  const translationCommandService = service();
  const translationCommandController = controller();
  const requestHandlerResult = function requestHandler() {};
  const calls = [];

  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionQueue,
    translationCommandServiceFactory(options) {
      calls.push(['serviceFactory', options]);
      return translationCommandService;
    },
    translationCommandControllerFactory(options) {
      calls.push(['controllerFactory', options]);
      return translationCommandController;
    },
    requestHandlerFactory(options) {
      calls.push(['requestHandlerFactory', options]);
      return requestHandlerResult;
    }
  });

  assert.strictEqual(dependencies.translationRepository, translationRepository);
  assert.strictEqual(dependencies.domainEventPublisher, domainEventPublisher);
  assert.strictEqual(dependencies.translationExecutionDispatcher, translationExecutionDispatcher);
  assert.strictEqual(dependencies.translationExecutionQueue, translationExecutionQueue);
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
  assert.strictEqual(dependencies.requestHandler, requestHandlerResult);
  assert.strictEqual(calls[0][1].translationRepository, translationRepository);
  assert.strictEqual(calls[0][1].domainEventPublisher, domainEventPublisher);
  assert.strictEqual(calls[0][1].translationExecutionDispatcher, translationExecutionDispatcher);
  assert.strictEqual(calls[0][1].translationExecutionQueue, translationExecutionQueue);
  assert.deepEqual(Object.keys(calls[0][1]), [
    'translationRepository',
    'domainEventPublisher',
    'translationExecutionDispatcher',
    'translationExecutionQueue'
  ]);
  assert.strictEqual(calls[1][1].translationCommandService, translationCommandService);
  assert.deepEqual(Object.keys(calls[1][1]), ['translationCommandService']);
  assert.strictEqual(calls[2][1].translationCommandController, translationCommandController);
  assert.strictEqual(calls[2][1].sessionReadController, dependencies.sessionReadController);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), ['sessionReadController', 'sessionRepository', 'translationCommandController']);
});

test('translation command dependencies use the service factory result to build the controller', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationExecutionDispatcher = dispatcher();
  const translationExecutionQueue = queue();
  const translationCommandService = service();
  const translationCommandController = controller();
  let injectedRepository;
  let injectedPublisher;
  let injectedDispatcher;
  let injectedQueue;
  let injectedService;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationExecutionQueue,
    translationCommandServiceFactory({
      translationRepository: nextRepository,
      domainEventPublisher: nextPublisher,
      translationExecutionDispatcher: nextDispatcher,
      translationExecutionQueue: nextQueue
    }) {
      injectedRepository = nextRepository;
      injectedPublisher = nextPublisher;
      injectedDispatcher = nextDispatcher;
      injectedQueue = nextQueue;
      return translationCommandService;
    },
    translationCommandControllerFactory({ translationCommandService: nextService }) {
      injectedService = nextService;
      return translationCommandController;
    }
  });

  assert.strictEqual(injectedRepository, translationRepository);
  assert.strictEqual(injectedPublisher, domainEventPublisher);
  assert.strictEqual(injectedDispatcher, translationExecutionDispatcher);
  assert.strictEqual(injectedQueue, translationExecutionQueue);
  assert.strictEqual(injectedService, translationCommandService);
  assert.strictEqual(dependencies.domainEventPublisher, domainEventPublisher);
  assert.strictEqual(dependencies.translationExecutionDispatcher, translationExecutionDispatcher);
  assert.strictEqual(dependencies.translationExecutionQueue, translationExecutionQueue);
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
});

test('production composition injects an execution provider resolver for the production provider', () => {
  const geminiHttpClient = { post() {} };
  const geminiClient = {
    async execute() {
      return { translatedText: 'Bonjour' };
    }
  };
  const geminiProvider = {
    async execute() {
      return { translatedText: 'Bonjour' };
    }
  };
  const calls = [];
  const serviceResult = service();
  let observedServiceOptions;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory(options) {
      calls.push(['geminiHttpClient', options]);
      return geminiHttpClient;
    },
    geminiClientFactory(options) {
      calls.push(['geminiClient', options]);
      return geminiClient;
    },
    geminiTranslationExecutionProviderFactory(options) {
      calls.push(['geminiExecutionProvider', options]);
      return geminiProvider;
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
      return { savedTranscriptTranslationProvider: { translate() {} } };
    },
    translationProviderConfigurationFactory(options) {
      calls.push(['providerConfiguration', options]);
      return { defaultProviderKey: 'gemini' };
    },
    translationProviderResolutionCompositionFactory(options) {
      calls.push(['providerResolutionComposition', options]);
      return {
        resolver: {
          resolve() {
            throw new Error('saved transcript resolver should not run');
          }
        },
        resolve() {
          throw new Error('saved transcript resolver should not run');
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    },
    translationCommandServiceFactory(options) {
      observedServiceOptions = options;
      return serviceResult;
    }
  });

  assert.equal(Object.hasOwn(dependencies, 'translationExecutionProvider'), false);
  assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
  assert.equal(dependencies.retryPolicy.maxRetries, 0);
  assert.strictEqual(dependencies.translationCommandService, serviceResult);
  assert.strictEqual(
    observedServiceOptions.translationExecutionProviderResolver,
    dependencies.translationExecutionProviderResolver
  );
  assert.strictEqual(observedServiceOptions.translationExecutionProviderResolver.resolve('gemini'), geminiProvider);
  assert.strictEqual(observedServiceOptions.translationExecutionProviderResolver.resolve(undefined), geminiProvider);
  assert.throws(
    () => observedServiceOptions.translationExecutionProviderResolver.resolve('fake'),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message, 'translation execution provider not found: fake');
      return true;
    }
  );
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'providerConfiguration',
    'geminiHttpClient',
    'geminiClient',
    'geminiExecutionProvider'
  ]);
  assert.strictEqual(calls[2][1].apiKey, 'api-key-from-env');
  assert.deepEqual(calls[3][1], {
    httpClient: geminiHttpClient,
    model: 'model-from-env'
  });
  assert.deepEqual(calls[4][1], { client: geminiClient });
  assert.equal(Object.hasOwn(observedServiceOptions, 'translationProviderResolver'), false);
  assert.equal(Object.hasOwn(observedServiceOptions, 'translationExecutionProvider'), false);
  assert.equal(observedServiceOptions.retryPolicy.maxRetries, 0);
});

test('production composition wires shared queue repository runner and worker', async () => {
  const translationRepository = repository();
  const suppliedQueue = queue();
  const runner = { execute() {} };
  const worker = { processNext() {} };
  const runtime = { start() {}, stop() {}, isRunning() { return false; } };
  const geminiProviderInputs = [];
  const geminiProvider = {
    async execute(input) {
      geminiProviderInputs.push(input);
      return { translatedText: 'Bonjour' };
    }
  };
  let observedServiceOptions;
  let observedRunnerOptions;
  let observedWorkerOptions;
  let observedRuntimeOptions;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env'
    },
    sessionReadRepository: readRepository(),
    translationRepository,
    translationExecutionQueue: suppliedQueue,
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return geminiProvider;
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    },
    translationExecutionRunnerFactory(options) {
      observedRunnerOptions = options;
      return runner;
    },
    translationExecutionWorkerFactory(options) {
      observedWorkerOptions = options;
      return worker;
    },
    translationExecutionWorkerRuntimeFactory(options) {
      observedRuntimeOptions = options;
      return runtime;
    },
    translationCommandServiceFactory(options) {
      observedServiceOptions = options;
      return service();
    }
  });

  assert.strictEqual(dependencies.translationExecutionQueue, suppliedQueue);
  assert.strictEqual(dependencies.translationExecutionRunner, runner);
  assert.strictEqual(dependencies.translationExecutionWorker, worker);
  assert.strictEqual(dependencies.translationExecutionWorkerRuntime, runtime);
  assert.strictEqual(observedServiceOptions.translationExecutionQueue, suppliedQueue);
  assert.strictEqual(observedServiceOptions.translationRepository, translationRepository);
  assert.strictEqual(observedWorkerOptions.translationExecutionQueue, suppliedQueue);
  assert.strictEqual(observedWorkerOptions.translationRepository, translationRepository);
  assert.notStrictEqual(observedWorkerOptions.translationExecutionRunner, runner);
  assert.equal(typeof observedWorkerOptions.translationExecutionRunner.execute, 'function');
  assert.equal(typeof observedWorkerOptions.translationExecutionRunner.run, 'function');
  assert.strictEqual(observedRuntimeOptions.translationExecutionWorker, worker);
  assert.strictEqual(observedRuntimeOptions.translationExecutionQueue, suppliedQueue);
  assert.strictEqual(observedRunnerOptions.translationRepository, translationRepository);
  assert.strictEqual(observedRunnerOptions.retryPolicy, dependencies.retryPolicy);

  const providerResult = await observedRunnerOptions.translationExecutionProvider.execute({
    providerKey: 'gemini',
    sourceText: 'hello'
  });

  assert.deepEqual(providerResult, { translatedText: 'Bonjour' });
  assert.deepEqual(geminiProviderInputs, [{ providerKey: 'gemini', sourceText: 'hello' }]);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('gemini'), geminiProvider);
});

test('production composition creates an in-memory execution queue by default', () => {
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  assert.deepEqual(Object.keys(dependencies.translationExecutionQueue), ['enqueue', 'dequeue', 'size']);
  assert.equal(dependencies.translationExecutionQueue.size(), 0);

  const job = { executionId: 'execution-1', requestId: 'request-1' };
  dependencies.translationExecutionQueue.enqueue(job);

  assert.equal(dependencies.translationExecutionQueue.size(), 1);
  assert.strictEqual(dependencies.translationExecutionQueue.dequeue(), job);
  assert.equal(dependencies.translationExecutionQueue.size(), 0);
  assert.equal(typeof dependencies.translationExecutionWorkerRuntime.start, 'function');
  assert.equal(typeof dependencies.translationExecutionWorkerRuntime.stop, 'function');
  assert.equal(typeof dependencies.translationExecutionWorkerRuntime.isRunning, 'function');
  assert.equal(dependencies.translationExecutionWorkerRuntime.isRunning(), false);
});

test('production composition does not create durable queue repository by default', () => {
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    fileDurableTranslationExecutionQueueRepositoryFactory() {
      throw new Error('durable queue repository should not be created by default');
    },
    dualWriteTranslationExecutionQueueFactory() {
      throw new Error('dual-write queue should not be created by default');
    },
    startupTranslationExecutionQueueRecoveryFactory() {
      throw new Error('startup recovery should not be created by default');
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  assert.equal(Object.hasOwn(dependencies, 'durableTranslationExecutionQueueRepository'), false);
  assert.equal(Object.hasOwn(dependencies, 'startupTranslationExecutionQueueRecovery'), false);
});

test('production composition creates durable queue repository when feature flag is enabled', () => {
  const durableRepository = {
    enqueue() {},
    dequeue() {},
    peek() {},
    list() {},
    size() {},
    clear() {},
    updateStatus() {},
    acknowledge() {}, acknowledgeClaim() {},
    contains() {}, claim() {}, requeueExpiredProcessing() { return null; }
  };
  const fileSystem = Object.freeze({
    access() {},
    mkdir() {},
    readFile() {},
    writeFile() {}
  });
  const calls = [];
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env',
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
      TRANSLATION_DURABLE_QUEUE_FILE: '/tmp/translation-queue.json'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    durableQueueFileSystem: fileSystem,
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    fileDurableTranslationExecutionQueueRepositoryFactory(options) {
      calls.push(options);
      return durableRepository;
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  assert.strictEqual(dependencies.durableTranslationExecutionQueueRepository, durableRepository);
  assert.deepEqual(calls, [
    {
      fileSystem,
      filePath: '/tmp/translation-queue.json'
    }
  ]);
});

test('production composition uses file-backed durable repository factory when enabled', () => {
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env',
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
      TRANSLATION_DURABLE_QUEUE_FILE: '/tmp/translation-queue.json'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    durableQueueFileSystem: {
      access() {
        throw new Error('durable repository storage should not be read during composition');
      },
      mkdir() {
        throw new Error('durable repository storage should not be written during composition');
      },
      readFile() {
        throw new Error('durable repository storage should not be read during composition');
      },
      writeFile() {
        throw new Error('durable repository storage should not be written during composition');
      }
    },
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  assert.deepEqual(Object.keys(dependencies.durableTranslationExecutionQueueRepository), [
    'enqueue',
    'dequeue',
    'peek',
    'list',
    'size',
    'clear',
    'updateStatus',
    'acknowledge',
    'acknowledgeClaim',
    'contains', 'claim', 'requeueExpiredProcessing'
  ]);
  assert.equal(Object.isFrozen(dependencies.durableTranslationExecutionQueueRepository), true);
});

test('production composition dual-writes enqueue and keeps dequeue size on primary queue when enabled', async () => {
  const durableItems = [];
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env',
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    fileDurableTranslationExecutionQueueRepositoryFactory() {
      return {
        enqueue(item) {
          durableItems.push({ ...item, leasedUntil: null });
        },
        dequeue() {
          throw new Error('durable repository dequeue should not be used by active queue');
        },
        peek() {},
        list() {},
        size() {
          throw new Error('durable repository size should not be used by active queue');
        },
        clear() {},
        updateStatus() {
          throw new Error('durable repository updateStatus should not be used by active queue');
        },
        acknowledge() {
          throw new Error('durable repository acknowledge should not be used by active queue');
        },
        acknowledgeClaim() {
          throw new Error('durable repository worker acknowledgement should not be used by active queue');
        },
        contains() {
          return false;
        }, claim() {}, requeueExpiredProcessing() { return null; }
      };
    },
    translationQueueClock: {
      now() {
        return '2026-07-17T08:00:00.000Z';
      }
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  assert.deepEqual(Object.keys(dependencies.translationExecutionQueue), ['enqueue', 'dequeue', 'size']);
  assert.equal(dependencies.translationExecutionQueue.size(), 0);

  const job = { executionId: 'execution-1', requestId: 'request-1' };
  await dependencies.translationExecutionQueue.enqueue(job);

  assert.equal(dependencies.translationExecutionQueue.size(), 1);
  assert.deepEqual(durableItems, [
    {
      executionId: 'execution-1',
      requestId: 'request-1',
      enqueuedAt: '2026-07-17T08:00:00.000Z',
      status: 'queued',
      leasedUntil: null
    }
  ]);
  assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), job);
  assert.equal(dependencies.translationExecutionQueue.size(), 0);
  assert.equal(Object.hasOwn(dependencies, 'durableTranslationExecutionQueueRepository'), true);
});

test('production composition injects active dual-write queue into service worker and runtime when enabled', () => {
  const durableRepository = {
    enqueue() {},
    dequeue() {},
    peek() {},
    list() {},
    size() {},
    clear() {},
    updateStatus() {},
    acknowledge() {}, acknowledgeClaim() {},
    contains() {}, claim() {}, requeueExpiredProcessing() { return null; }
  };
  const activeQueue = queue();
  const observed = {};
  const leaseIdFactory = () => 'lease-from-composition';
  const queueClock = { now: () => '2026-07-20T00:00:00.000Z' };
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env',
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
      TRANSLATION_QUEUE_LEASE_MS: '1000',
      TRANSLATION_QUEUE_LEASE_RENEWAL_MS: '500'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    fileDurableTranslationExecutionQueueRepositoryFactory() {
      return durableRepository;
    },
    dualWriteTranslationExecutionQueueFactory(options) {
      observed.dualWriteOptions = options;
      return activeQueue;
    },
    translationCommandServiceFactory(options) {
      observed.serviceQueue = options.translationExecutionQueue;
      return service();
    },
    translationExecutionWorkerFactory(options) {
      observed.workerQueue = options.translationExecutionQueue;
      observed.workerDurableRepository = options.durableTranslationExecutionQueueRepository;
      observed.workerLeaseDurationMs = options.leaseDurationMs;
      observed.workerLeaseIdFactory = options.leaseIdFactory;
      observed.workerClock = options.clock;
      return { processNext() {} };
    },
    translationExecutionWorkerRuntimeFactory(options) {
      observed.runtimeQueue = options.translationExecutionQueue;
      return { start() {}, stop() {}, isRunning() { return false; } };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    translationQueueLeaseIdFactory: leaseIdFactory,
    translationQueueClock: queueClock
  });

  assert.strictEqual(dependencies.translationExecutionQueue, activeQueue);
  assert.strictEqual(dependencies.durableTranslationExecutionQueueRepository, durableRepository);
  assert.strictEqual(observed.dualWriteOptions.durableRepository, durableRepository);
  assert.deepEqual(Object.keys(observed.dualWriteOptions.primaryQueue), ['enqueue', 'dequeue', 'size']);
  assert.strictEqual(observed.serviceQueue, activeQueue);
  assert.strictEqual(observed.workerQueue, activeQueue);
  assert.strictEqual(observed.workerDurableRepository, durableRepository);
  assert.equal(observed.workerLeaseDurationMs, 1000);
  assert.strictEqual(observed.workerLeaseIdFactory, leaseIdFactory);
  assert.equal(observed.workerClock(), '2026-07-20T00:00:00.000Z');
  assert.strictEqual(observed.runtimeQueue, activeQueue);
});

test('production composition creates startup recovery when durable queue is enabled', () => {
  const durableRepository = {
    enqueue() {},
    dequeue() {},
    peek() {},
    list() {},
    size() {},
    clear() {},
    updateStatus() {},
    acknowledge() {}, acknowledgeClaim() {},
    contains() {}, claim() {}, requeueExpiredProcessing() { return null; }
  };
  const recovery = { recover() {} };
  let observedRecoveryOptions;
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env',
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    fileDurableTranslationExecutionQueueRepositoryFactory() {
      return durableRepository;
    },
    startupTranslationExecutionQueueRecoveryFactory(options) {
      observedRecoveryOptions = options;
      return recovery;
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  assert.strictEqual(dependencies.startupTranslationExecutionQueueRecovery, recovery);
  assert.strictEqual(observedRecoveryOptions.durableRepository, durableRepository);
  assert.strictEqual(observedRecoveryOptions.translationRepository, dependencies.translationRepository);
  assert.strictEqual(observedRecoveryOptions.translationCommandService, dependencies.translationCommandService);
  assert.deepEqual(Object.keys(observedRecoveryOptions.activeQueue), ['enqueue', 'dequeue', 'size']);
});

test('production runtime start awaits startup recovery before starting worker runtime when enabled', async () => {
  const calls = [];
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env',
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    fileDurableTranslationExecutionQueueRepositoryFactory() {
      return {
        enqueue() {},
        dequeue() {},
        peek() {},
        list() {},
        size() {},
        clear() {},
        updateStatus() {},
        acknowledge() {},
        acknowledgeClaim() {},
        contains() {}, claim() {}, requeueExpiredProcessing() { return null; }
      };
    },
    startupTranslationExecutionQueueRecoveryFactory() {
      return {
        async recover() {
          calls.push('recover');
        }
      };
    },
    translationExecutionWorkerRuntimeFactory() {
      return {
        start() {
          calls.push('runtime.start');
        },
        stop() {
          calls.push('runtime.stop');
        },
        isRunning() {
          return false;
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    }
  });

  await dependencies.translationExecutionWorkerRuntime.start();

  assert.deepEqual(calls, ['recover', 'runtime.start']);
  dependencies.translationExecutionWorkerRuntime.stop();
  assert.deepEqual(calls, ['recover', 'runtime.start', 'runtime.stop']);
});

test('production composition allows worker and runner override without rebuilding worker dependencies', () => {
  const suppliedRunner = { execute() {} };
  const suppliedWorker = { processNext() {} };
  const suppliedRuntime = { start() {}, stop() {}, isRunning() { return false; } };
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    translationExecutionRunner: suppliedRunner,
    translationExecutionWorker: suppliedWorker,
    translationExecutionWorkerRuntime: suppliedRuntime,
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return { execute() {} };
    },
    translationExecutionRunnerFactory() {
      throw new Error('runner factory should not run when runner is supplied');
    },
    translationExecutionWorkerFactory() {
      throw new Error('worker factory should not run when worker is supplied');
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionRunner, suppliedRunner);
  assert.strictEqual(dependencies.translationExecutionWorker, suppliedWorker);
  assert.strictEqual(dependencies.translationExecutionWorkerRuntime, suppliedRuntime);
});

test('production composition queues execution for providerKey gemini without executing provider', async () => {
  const httpCalls = [];
  let persistedExecution;
  let queuedExecution;
  const queuedJobs = [];
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'gemini-composed-model'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        throw new Error(`output should not be created: ${output.id}`);
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    translationExecutionQueue: queue({
      enqueue(job) {
        queuedJobs.push(job);
      }
    }),
    geminiHttpClientFactory({ apiKey }) {
      assert.equal(apiKey, 'api-key-from-env');
      return {
        post(request) {
          httpCalls.push(request);
          return {
            ok: true,
            async json() {
              return {
                translatedText: 'Bonjour',
                detectedSourceLanguageCode: 'en'
              };
            }
          };
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.equal(Object.hasOwn(dependencies, 'translationExecutionProvider'), false);
  assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve('gemini').execute, 'function');

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'gemini'
    })
  );

  assert.equal(persistedExecution.status, 'created');
  assert.strictEqual(result, queuedExecution);
  assert.equal(result.status, 'queued');
  assert.equal(httpCalls.length, 0);
  assert.deepEqual(queuedJobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('production composition queues default Gemini execution when providerKey is omitted', async () => {
  const httpCalls = [];
  let persistedExecution;
  let queuedExecution;
  const queuedJobs = [];
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'gemini-default-model'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        throw new Error(`output should not be created: ${output.id}`);
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    translationExecutionQueue: queue({
      enqueue(job) {
        queuedJobs.push(job);
      }
    }),
    geminiHttpClientFactory({ apiKey }) {
      assert.equal(apiKey, 'api-key-from-env');
      return {
        post(request) {
          httpCalls.push(request);
          return {
            ok: true,
            async json() {
              return {
                translatedText: 'Bonjour',
                detectedSourceLanguageCode: 'en'
              };
            }
          };
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(
    dependencies.translationExecutionProviderResolver.resolve(undefined),
    dependencies.translationExecutionProviderResolver.resolve('gemini')
  );

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    })
  );

  assert.equal(persistedExecution.status, 'created');
  assert.strictEqual(result, queuedExecution);
  assert.equal(result.status, 'queued');
  assert.equal(httpCalls.length, 0);
  assert.deepEqual(queuedJobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('production composition injects supplied execution provider and queues without using it', async () => {
  const providerCalls = [];
  let persistedExecution;
  let queuedExecution;
  const queuedJobs = [];
  const suppliedProvider = {
    async execute(input) {
      providerCalls.push(input);
      return { translatedText: 'Bonjour' };
    }
  };
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        throw new Error(`output should not be created: ${output.id}`);
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    translationExecutionQueue: queue({
      enqueue(job) {
        queuedJobs.push(job);
      }
    }),
    translationExecutionProvider: suppliedProvider,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionProvider, suppliedProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('fake'), suppliedProvider);
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'fake'
    })
  );

  assert.equal(persistedExecution.status, 'created');
  assert.strictEqual(result, queuedExecution);
  assert.equal(result.status, 'queued');
  assert.deepEqual(providerCalls, []);
  assert.deepEqual(queuedJobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('production composition does not call failing provider during request submission', async () => {
  const providerError = new Error('provider failed');
  let providerCalls = 0;
  let queuedExecution;
  const queuedJobs = [];
  const suppliedProvider = {
    async execute() {
      providerCalls += 1;
      throw providerError;
    }
  };
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        return execution;
      },
      createTranslationOutput() {
        throw new Error('output should not be created on provider failure');
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    translationExecutionQueue: queue({
      enqueue(job) {
        queuedJobs.push(job);
      }
    }),
    translationExecutionProvider: suppliedProvider,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionProvider, suppliedProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve(undefined), suppliedProvider);
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      targetLanguageCode: 'fr'
    })
  );

  assert.strictEqual(result, queuedExecution);
  assert.equal(result.status, 'queued');
  assert.equal(providerCalls, 0);
  assert.deepEqual(queuedJobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('fake composition keeps supplied FakeTranslationExecutionProvider unchanged and queues execution', async () => {
  let persistedExecution;
  let queuedExecution;
  const queuedJobs = [];
  const fakeProvider = createFakeTranslationExecutionProvider();
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        throw new Error(`output should not be created: ${output.id}`);
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    translationExecutionQueue: queue({
      enqueue(job) {
        queuedJobs.push(job);
      }
    }),
    translationExecutionProvider: fakeProvider,
    geminiEnvironmentFactory() {
      throw new Error('Gemini environment should not be created for supplied fake provider');
    },
    geminiHttpClientFactory() {
      throw new Error('Gemini HTTP client should not be created for supplied fake provider');
    },
    geminiClientFactory() {
      throw new Error('Gemini client should not be created for supplied fake provider');
    },
    geminiTranslationExecutionProviderFactory() {
      throw new Error('Gemini execution provider should not be created for supplied fake provider');
    },
    googleGenAIClientFactory() {
      throw new Error('Google GenAI client should not be created for supplied fake provider');
    },
    geminiClientAdapterFactory() {
      throw new Error('Gemini saved-transcript client adapter should not be created for supplied fake provider');
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      throw new Error('Gemini saved-transcript provider should not be created for supplied fake provider');
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionProvider, fakeProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('fake'), fakeProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve(undefined), fakeProvider);
  assert.throws(
    () => dependencies.translationExecutionProviderResolver.resolve('unknown-provider'),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message, 'translation execution provider not found: unknown-provider');
      return true;
    }
  );
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      targetLanguageCode: 'fr'
    })
  );

  assert.equal(result instanceof TranslationExecution, true);
  assert.equal(persistedExecution.status, 'created');
  assert.strictEqual(result, queuedExecution);
  assert.equal(result.status, 'queued');
  assert.deepEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions, []);
  assert.deepEqual(queuedJobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('production runtime wiring preserves saved transcript resolver composition', () => {
  const savedTranscriptResolver = {
    resolve() {
      throw new Error('runtime resolver should not run');
    }
  };
  const geminiExecutionProvider = {
    async execute() {
      return { translatedText: 'Bonjour' };
    }
  };
  const savedTranscriptProvider = { translate() {} };
  const savedTranscriptService = { translateSavedTranscript() {} };
  const resolvedProvider = { translate() {} };
  let resolveSavedTranscriptTranslationProvider;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      GEMINI_MODEL: 'unused-by-mock'
    },
    sessionReadRepository: readRepository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key', model: 'model-name' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return geminiExecutionProvider;
    },
    googleGenAIClientFactory() {
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory() {
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      return { savedTranscriptTranslationProvider: savedTranscriptProvider };
    },
    translationProviderConfigurationFactory() {
      return { defaultProviderKey: 'gemini' };
    },
    translationProviderResolutionCompositionFactory() {
      return {
        resolver: savedTranscriptResolver,
        resolve(options) {
          assert.deepEqual(options, {
            providerKey: 'gemini',
            configuration: { defaultProviderKey: 'gemini' }
          });
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
      assert.ok(!Object.hasOwn(options, 'savedTranscriptTranslationProvider'));
      return savedTranscriptService;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, savedTranscriptService);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('gemini'), geminiExecutionProvider);
  assert.strictEqual(resolveSavedTranscriptTranslationProvider({ providerKey: 'gemini' }), resolvedProvider);
});

test('application composition injects supplied queue unchanged and awaits enqueue', async () => {
  const deferredEnqueue = createDeferred();
  const queueCalls = [];
  let persistedExecution;
  let resolved = false;
  const suppliedQueue = {
    enqueue(...args) {
      queueCalls.push(args);
      return deferredEnqueue.promise;
    },
    dequeue() {
      return undefined;
    },
    isEmpty() {
      return true;
    },
    size() {
      return 0;
    }
  };
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    domainEventPublisher: publisher(),
    translationExecutionQueue: suppliedQueue
  });

  assert.strictEqual(dependencies.translationExecutionQueue, suppliedQueue);
  assert.equal(Object.hasOwn(dependencies.translationExecutionQueue, 'jobs'), false);

  const resultPromise = dependencies.translationCommandService.createTranslationExecution(executionPayload()).then((result) => {
    resolved = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(resolved, false);
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0].length, 1);
  assert.deepEqual(queueCalls[0][0], {
    executionId: persistedExecution.id,
    requestId: persistedExecution.translationRequestId
  });

  deferredEnqueue.resolve();

  const result = await resultPromise;
  assert.equal(result instanceof TranslationExecution, true);
  assert.equal(result.status, 'queued');
  assert.equal(resolved, true);
});

test('application-composed enqueue failure propagates after queued persistence', async () => {
  const queueError = new Error('queue enqueue failed');
  let persistedExecution;
  let queuedExecution;
  let enqueueCalls = 0;
  let publishCalls = 0;
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        publishCalls += 1;
      }
    }),
    translationExecutionQueue: queue({
      async enqueue(job) {
        enqueueCalls += 1;
        assert.deepEqual(job, {
          executionId: persistedExecution.id,
          requestId: persistedExecution.translationRequestId
        });
        throw queueError;
      }
    })
  });

  await assert.rejects(
    dependencies.translationCommandService.createTranslationExecution(executionPayload()),
    queueError
  );

  assert.equal(persistedExecution instanceof TranslationExecution, true);
  assert.equal(queuedExecution.status, 'queued');
  assert.equal(enqueueCalls, 1);
  assert.equal(publishCalls, 2);
});

test('translation command service remains constructible when execution provider is undefined', async () => {
  let persistedExecution;
  let queuedExecution;
  const dependencies = createTranslationCommandDependencies({
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      updateTranslationExecution(execution) {
        queuedExecution = execution;
        return execution;
      }
    }),
    translationExecutionProvider: undefined
  });

  assert.equal(Object.hasOwn(dependencies, 'translationExecutionProvider'), false);

  const result = await dependencies.translationCommandService.createTranslationExecution(executionPayload());

  assert.equal(persistedExecution.status, 'created');
  assert.strictEqual(result, queuedExecution);
  assert.equal(result.status, 'queued');
  assert.deepEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions, []);
  assert.equal(dependencies.translationExecutionQueue.size(), 1);
});

test('production composition forwards create-execution providerKey from controller to service unchanged', () => {
  const serviceCalls = [];
  const input = {
    executionId: 'execution-1',
    requestId: 'request-1',
    providerKey: 'gemini'
  };
  const dependencies = createProductionTranslationCommandDependencies({
    createTranslationExecution(nextInput) {
      serviceCalls.push(nextInput);
      return { id: nextInput.executionId };
    }
  });

  const result = dependencies.translationCommandController.createTranslationExecution(input);

  assert.deepEqual(result, { id: 'execution-1' });
  assert.deepEqual(serviceCalls, [input]);
  assert.strictEqual(serviceCalls[0], input);
  assert.equal(serviceCalls[0].providerKey, 'gemini');
});

test('production composition preserves omitted create-execution providerKey as undefined', () => {
  const serviceCalls = [];
  const input = {
    executionId: 'execution-1',
    requestId: 'request-1'
  };
  const dependencies = createProductionTranslationCommandDependencies({
    createTranslationExecution(nextInput) {
      serviceCalls.push(nextInput);
      return { id: nextInput.executionId };
    }
  });

  const result = dependencies.translationCommandController.createTranslationExecution(input);

  assert.deepEqual(result, { id: 'execution-1' });
  assert.deepEqual(serviceCalls, [input]);
  assert.strictEqual(serviceCalls[0], input);
  assert.equal(serviceCalls[0].providerKey, undefined);
  assert.equal(Object.hasOwn(serviceCalls[0], 'providerKey'), false);
});

test('translation command dependencies create one usable publisher instance by default', () => {
  const translationRepository = repository();
  const translationCommandService = service();
  let injectedPublisher;
  let injectedDispatcher;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    translationCommandServiceFactory({ domainEventPublisher: nextPublisher, translationExecutionDispatcher }) {
      injectedPublisher = nextPublisher;
      injectedDispatcher = translationExecutionDispatcher;
      return translationCommandService;
    },
    translationCommandControllerFactory() {
      return controller();
    }
  });

  assert.equal(typeof dependencies.domainEventPublisher.publish, 'function');
  assert.equal(typeof dependencies.translationExecutionDispatcher.dispatch, 'function');
  assert.strictEqual(injectedPublisher, dependencies.domainEventPublisher);
  assert.strictEqual(injectedDispatcher, dependencies.translationExecutionDispatcher);
});

test('application dependencies preserve existing session read controller wiring', () => {
  const history = [{ id: 'session-1' }];
  const detail = { session: { id: 'session-1' } };
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository({ history, detail }),
    translationRepository: repository()
  });

  assert.deepEqual(dependencies.sessionReadController.listSessions(), history);
  assert.deepEqual(dependencies.sessionReadController.getSession('session-1'), detail);
});

test('composition root returns the request handler factory result', () => {
  const requestHandlerResult = function requestHandler() {};
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    requestHandlerFactory() {
      return requestHandlerResult;
    }
  });

  assert.strictEqual(dependencies.requestHandler, requestHandlerResult);
});

test('translation command dependency validation follows existing TypeError style', () => {
  assert.throws(
    () =>
      createApplicationDependencies({
        sessionReadRepository: readRepository(),
        translationRepository: undefined
      }),
    TypeError
  );
  assert.throws(
    () =>
      createApplicationDependencies({
        sessionReadRepository: readRepository(),
        translationRepository: repository(),
        translationCommandServiceFactory: {}
      }),
    /translationCommandServiceFactory must be a function/
  );
  assert.throws(
    () =>
      createApplicationDependencies({
        sessionReadRepository: readRepository(),
        translationRepository: repository(),
        translationCommandControllerFactory: null
      }),
    /translationCommandControllerFactory must be a function/
  );
});

test('composition root does not execute repository commands while assembling dependencies', () => {
  const calls = [];
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(
      Object.fromEntries(
        TRANSLATION_REPOSITORY_METHODS.map((methodName) => [
          methodName,
          function repositoryCommand() {
            calls.push(methodName);
            throw new Error(`${methodName} should not be called during composition`);
          }
        ])
      )
    )
  });

  assert.equal(typeof dependencies.translationCommandController.createTranslationRequest, 'function');
  assert.deepEqual(calls, []);
});

test('composition root does not create provider, database, event bus, or frontend dependencies', () => {
  const unexpectedDependencyNames = ['provider', 'database', 'eventBus', 'frontend'];
  const observedFactoryOptions = [];

  createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    translationCommandServiceFactory(options) {
      observedFactoryOptions.push(options);
      return service();
    },
    translationCommandControllerFactory(options) {
      observedFactoryOptions.push(options);
      return controller();
    },
    requestHandlerFactory(options) {
      observedFactoryOptions.push(options);
      return function requestHandler() {};
    }
  });

  for (const options of observedFactoryOptions) {
    for (const dependencyName of unexpectedDependencyNames) {
      assert.equal(Object.prototype.hasOwnProperty.call(options, dependencyName), false);
    }
  }
});

function repository(overrides = {}) {
  return Object.fromEntries(
    TRANSLATION_REPOSITORY_METHODS.map((methodName) => [
      methodName,
      overrides[methodName] ||
        function repositoryMethod() {
          return null;
        }
    ])
  );
}

function service(overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      function createTranslationRequest(input) {
        return input;
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      function createTranslationExecution(input) {
        return input;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      function updateTranslationExecution(input) {
        return input;
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      function createTranslationOutput(input) {
        return input;
      }
  };
}

function publisher(overrides = {}) {
  return {
    publish:
      overrides.publish ||
      function publish() {
        return undefined;
      }
  };
}

function dispatcher(overrides = {}) {
  return {
    dispatch:
      overrides.dispatch ||
      async function dispatch() {
        return undefined;
      }
  };
}

function queue(overrides = {}) {
  return {
    enqueue:
      overrides.enqueue ||
      function enqueue() {
        return undefined;
      },
    dequeue:
      overrides.dequeue ||
      function dequeue() {
        return undefined;
      },
    isEmpty:
      overrides.isEmpty ||
      function isEmpty() {
        return true;
      },
    size:
      overrides.size ||
      function size() {
        return 0;
      }
  };
}

function controller(overrides = {}) {
  return service(overrides);
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createProductionTranslationCommandDependencies(serviceOverrides = {}) {
  return createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    translationExecutionProvider: {
      async execute() {
        return { translatedText: 'translated' };
      }
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    },
    translationCommandServiceFactory() {
      return service(serviceOverrides);
    }
  });
}

function readRepository(overrides = {}) {
  return {
    listSessionHistory:
      overrides.listSessionHistory ||
      function listSessionHistory() {
        return overrides.history || [];
      },
    getSessionDetail:
      overrides.getSessionDetail ||
      function getSessionDetail() {
        return overrides.detail || null;
      }
  };
}
