import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
  createTranslationCommandDependencies
} from '../../server/compositionRoot.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';

test('application dependencies assemble translation command graph with injected repository', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationCommandService = service();
  const translationCommandController = controller();
  const requestHandlerResult = function requestHandler() {};
  const calls = [];

  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    domainEventPublisher,
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
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
  assert.strictEqual(dependencies.requestHandler, requestHandlerResult);
  assert.strictEqual(calls[0][1].translationRepository, translationRepository);
  assert.strictEqual(calls[0][1].domainEventPublisher, domainEventPublisher);
  assert.deepEqual(Object.keys(calls[0][1]), ['translationRepository', 'domainEventPublisher']);
  assert.strictEqual(calls[1][1].translationCommandService, translationCommandService);
  assert.deepEqual(Object.keys(calls[1][1]), ['translationCommandService']);
  assert.strictEqual(calls[2][1].translationCommandController, translationCommandController);
  assert.strictEqual(calls[2][1].sessionReadController, dependencies.sessionReadController);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), ['sessionReadController', 'translationCommandController']);
});

test('translation command dependencies use the service factory result to build the controller', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationCommandService = service();
  const translationCommandController = controller();
  let injectedRepository;
  let injectedPublisher;
  let injectedService;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    domainEventPublisher,
    translationCommandServiceFactory({ translationRepository: nextRepository, domainEventPublisher: nextPublisher }) {
      injectedRepository = nextRepository;
      injectedPublisher = nextPublisher;
      return translationCommandService;
    },
    translationCommandControllerFactory({ translationCommandService: nextService }) {
      injectedService = nextService;
      return translationCommandController;
    }
  });

  assert.strictEqual(injectedRepository, translationRepository);
  assert.strictEqual(injectedPublisher, domainEventPublisher);
  assert.strictEqual(injectedService, translationCommandService);
  assert.strictEqual(dependencies.domainEventPublisher, domainEventPublisher);
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
});

test('translation command dependencies create one usable publisher instance by default', () => {
  const translationRepository = repository();
  const translationCommandService = service();
  let injectedPublisher;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    translationCommandServiceFactory({ domainEventPublisher: nextPublisher }) {
      injectedPublisher = nextPublisher;
      return translationCommandService;
    },
    translationCommandControllerFactory() {
      return controller();
    }
  });

  assert.equal(typeof dependencies.domainEventPublisher.publish, 'function');
  assert.strictEqual(injectedPublisher, dependencies.domainEventPublisher);
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

function controller(overrides = {}) {
  return service(overrides);
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
