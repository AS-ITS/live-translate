import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
  createProductionApplicationDependencies,
  createTranslationCommandDependencies
} from '../../server/compositionRoot.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';

test('application dependencies assemble translation command graph with injected repository', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationExecutionDispatcher = dispatcher();
  const translationCommandService = service();
  const translationCommandController = controller();
  const requestHandlerResult = function requestHandler() {};
  const calls = [];

  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
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
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
  assert.strictEqual(dependencies.requestHandler, requestHandlerResult);
  assert.strictEqual(calls[0][1].translationRepository, translationRepository);
  assert.strictEqual(calls[0][1].domainEventPublisher, domainEventPublisher);
  assert.strictEqual(calls[0][1].translationExecutionDispatcher, translationExecutionDispatcher);
  assert.deepEqual(Object.keys(calls[0][1]), [
    'translationRepository',
    'domainEventPublisher',
    'translationExecutionDispatcher'
  ]);
  assert.strictEqual(calls[1][1].translationCommandService, translationCommandService);
  assert.deepEqual(Object.keys(calls[1][1]), ['translationCommandService']);
  assert.strictEqual(calls[2][1].translationCommandController, translationCommandController);
  assert.strictEqual(calls[2][1].sessionReadController, dependencies.sessionReadController);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), ['sessionReadController', 'translationCommandController']);
});

test('translation command dependencies use the service factory result to build the controller', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationExecutionDispatcher = dispatcher();
  const translationCommandService = service();
  const translationCommandController = controller();
  let injectedRepository;
  let injectedPublisher;
  let injectedDispatcher;
  let injectedService;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationCommandServiceFactory({
      translationRepository: nextRepository,
      domainEventPublisher: nextPublisher,
      translationExecutionDispatcher: nextDispatcher
    }) {
      injectedRepository = nextRepository;
      injectedPublisher = nextPublisher;
      injectedDispatcher = nextDispatcher;
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
  assert.strictEqual(injectedService, translationCommandService);
  assert.strictEqual(dependencies.domainEventPublisher, domainEventPublisher);
  assert.strictEqual(dependencies.translationExecutionDispatcher, translationExecutionDispatcher);
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
});

test('production composition creates a default fake dispatcher and dispatches created executions', async () => {
  let persistedExecution;
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.equal(typeof dependencies.translationExecutionDispatcher.dispatch, 'function');
  assert.deepEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions, []);

  const result = await dependencies.translationCommandService.createTranslationExecution(executionPayload());

  assert.equal(result instanceof TranslationExecution, true);
  assert.strictEqual(result, persistedExecution);
  assert.deepEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions, [result]);
  assert.strictEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions[0], result);
});

test('production composition injects supplied dispatcher unchanged and awaits dispatch', async () => {
  const deferredDispatch = createDeferred();
  const dispatchCalls = [];
  let persistedExecution;
  let resolved = false;
  const suppliedDispatcher = {
    dispatch(...args) {
      dispatchCalls.push(args);
      return deferredDispatch.promise;
    }
  };
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    translationExecutionDispatcher: suppliedDispatcher,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionDispatcher, suppliedDispatcher);
  assert.equal(Object.hasOwn(dependencies.translationExecutionDispatcher, 'dispatchedExecutions'), false);

  const resultPromise = dependencies.translationCommandService.createTranslationExecution(executionPayload()).then((result) => {
    resolved = true;
    return result;
  });

  await Promise.resolve();

  assert.equal(resolved, false);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].length, 1);
  assert.strictEqual(dispatchCalls[0][0], persistedExecution);

  deferredDispatch.resolve();

  assert.strictEqual(await resultPromise, persistedExecution);
  assert.equal(resolved, true);
});

test('production-composed dispatcher failure propagates after persistence without retry', async () => {
  const dispatcherError = new Error('dispatch failed');
  let persistedExecution;
  let dispatchCalls = 0;
  let publishCalls = 0;
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        publishCalls += 1;
      }
    }),
    translationExecutionDispatcher: {
      async dispatch(execution) {
        dispatchCalls += 1;
        assert.strictEqual(execution, persistedExecution);
        throw dispatcherError;
      }
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  await assert.rejects(
    dependencies.translationCommandService.createTranslationExecution(executionPayload()),
    dispatcherError
  );

  assert.equal(persistedExecution instanceof TranslationExecution, true);
  assert.equal(dispatchCalls, 1);
  assert.equal(publishCalls, 0);
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

test('composition root does not create provider, database, queue, event bus, or frontend dependencies', () => {
  const unexpectedDependencyNames = ['provider', 'database', 'queue', 'eventBus', 'frontend'];
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
