import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
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
