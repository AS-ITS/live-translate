import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { TRANSLATION_EVENT_TYPES, TranslationExecution } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';

test('composition without handlers builds dependencies and publishes without handler failure', async () => {
  const repository = repositorySpy();
  const dependencies = createApplicationDependencies({ translationRepository: repository });

  const result = await dependencies.translationCommandService.createTranslationRequest(requestPayload());

  assert.strictEqual(result, repository.requests.get('request-1'));
  assert.equal(typeof dependencies.domainEventPublisher.publish, 'function');
  assert.equal(typeof dependencies.unsubscribeTranslationDomainEvents, 'function');
});

test('request created event routes to requestCreated with original event and aggregate references', async () => {
  const repository = repositorySpy();
  let receivedEvent;
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: {
      requestCreated(event) {
        receivedEvent = event;
      }
    }
  });

  const result = await dependencies.translationCommandService.createTranslationRequest(requestPayload());

  assert.equal(receivedEvent.type, TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED);
  assert.strictEqual(receivedEvent.payload.request, repository.requests.get('request-1'));
  assert.strictEqual(receivedEvent.payload.request, result);
});

test('execution creation routes created then queued update events', async () => {
  const calls = handlerCalls();
  const repository = repositorySpy();
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: calls.handlers
  });

  await dependencies.translationCommandService.createTranslationExecution(executionPayload());

  assert.deepEqual(calls.names(), ['executionCreated', 'executionUpdated']);
  assert.equal(calls.firstEvent().type, TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED);
  assert.equal(calls.firstEvent().payload.execution.status, 'created');
  assert.equal(repository.executions.get('execution-1').status, 'queued');
});

test('execution updated event routes updated execution and preserves transition timestamp semantics', async () => {
  const repository = repositorySpy({
    executions: [new TranslationExecution(executionPayload()).start('2026-07-14T01:01:30.000Z')]
  });
  let receivedEvent;
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: {
      executionUpdated(event) {
        receivedEvent = event;
      }
    }
  });

  const result = await dependencies.translationCommandService.updateTranslationExecution({
    executionId: 'execution-1',
    transition: 'complete',
    completedAt: '2026-07-14T01:02:00.000Z'
  });

  assert.equal(receivedEvent.type, TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED);
  assert.equal(receivedEvent.occurredAt, '2026-07-14T01:02:00.000Z');
  assert.equal(receivedEvent.payload.execution.status, 'completed');
  assert.strictEqual(receivedEvent.payload.execution, result);
});

test('output created event routes to outputCreated', async () => {
  const repository = repositorySpy();
  let receivedEvent;
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: {
      outputCreated(event) {
        receivedEvent = event;
      }
    }
  });

  const result = await dependencies.translationCommandService.createTranslationOutput(outputPayload());

  assert.equal(receivedEvent.type, TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED);
  assert.strictEqual(receivedEvent.payload.output, repository.outputs.get('output-1'));
  assert.strictEqual(receivedEvent.payload.output, result);
});

test('exact handler mapping does not cross-dispatch between translation event types', async () => {
  const calls = handlerCalls();
  const repository = repositorySpy({
    executions: [new TranslationExecution(executionPayload({ id: 'execution-update' }))]
  });
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: calls.handlers
  });

  await dependencies.translationCommandService.createTranslationRequest(requestPayload());
  assert.deepEqual(calls.takeNames(), ['requestCreated']);

  await dependencies.translationCommandService.createTranslationExecution(executionPayload());
  assert.deepEqual(calls.takeNames(), ['executionCreated', 'executionUpdated']);

  await dependencies.translationCommandService.updateTranslationExecution({
    executionId: 'execution-update',
    transition: 'start',
    startedAt: '2026-07-14T01:02:00.000Z'
  });
  assert.deepEqual(calls.takeNames(), ['executionUpdated']);

  await dependencies.translationCommandService.createTranslationOutput(outputPayload());
  assert.deepEqual(calls.takeNames(), ['outputCreated']);
});

test('production composed publisher and subscriber share the bus used by command publication', async () => {
  let receivedEvent;
  const dependencies = createApplicationDependencies({
    translationRepository: repositorySpy(),
    translationDomainEventHandlers: {
      requestCreated(event) {
        receivedEvent = event;
      }
    }
  });

  await dependencies.translationCommandService.createTranslationRequest(requestPayload());

  assert.equal(receivedEvent.type, TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED);
});

test('dependency graph registers one subscriber set for repeated use of the same graph', async () => {
  const calls = handlerCalls();
  const dependencies = createApplicationDependencies({
    translationRepository: repositorySpy(),
    translationDomainEventHandlers: calls.handlers,
    requestHandlerFactory({ translationCommandController }) {
      return { translationCommandController };
    }
  });

  assert.strictEqual(dependencies.requestHandler.translationCommandController, dependencies.translationCommandController);
  await dependencies.translationCommandController.createTranslationRequest(requestPayload());

  assert.deepEqual(calls.names(), ['requestCreated']);
});

test('dependency graphs have isolated event buses and subscriptions', async () => {
  const callsA = handlerCalls();
  const callsB = handlerCalls();
  const appA = createApplicationDependencies({
    translationRepository: repositorySpy(),
    translationDomainEventHandlers: callsA.handlers
  });
  const appB = createApplicationDependencies({
    translationRepository: repositorySpy(),
    translationDomainEventHandlers: callsB.handlers
  });

  await appA.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-a' }));
  assert.deepEqual(callsA.names(), ['requestCreated']);
  assert.deepEqual(callsB.names(), []);

  callsA.takeNames();
  await appB.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-b' }));
  assert.deepEqual(callsA.names(), []);
  assert.deepEqual(callsB.names(), ['requestCreated']);
});

test('async handlers are awaited before command promise resolves', async () => {
  let releaseHandler;
  let handlerCompleted = false;
  let commandResolved = false;
  const dependencies = createApplicationDependencies({
    translationRepository: repositorySpy(),
    translationDomainEventHandlers: {
      async requestCreated() {
        await new Promise((resolve) => {
          releaseHandler = resolve;
        });
        handlerCompleted = true;
      }
    }
  });

  const commandPromise = dependencies.translationCommandService
    .createTranslationRequest(requestPayload())
    .then(() => {
      commandResolved = true;
    });
  await Promise.resolve();

  assert.equal(commandResolved, false);
  releaseHandler();
  await commandPromise;
  assert.equal(handlerCompleted, true);
  assert.equal(commandResolved, true);
});

test('handler async rejection propagates the exact error after repository success', async () => {
  const expectedError = new Error('handler failed');
  const repository = repositorySpy();
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: {
      async requestCreated() {
        throw expectedError;
      }
    }
  });

  await assert.rejects(
    dependencies.translationCommandService.createTranslationRequest(requestPayload()),
    (actualError) => actualError === expectedError
  );
  assert.equal(repository.requests.has('request-1'), true);
});

test('exposed unsubscribe stops future handler delivery and is idempotent', async () => {
  const calls = handlerCalls();
  const dependencies = createApplicationDependencies({
    translationRepository: repositorySpy(),
    translationDomainEventHandlers: calls.handlers
  });

  dependencies.unsubscribeTranslationDomainEvents();
  dependencies.unsubscribeTranslationDomainEvents();
  await dependencies.translationCommandService.createTranslationRequest(requestPayload());

  assert.deepEqual(calls.names(), []);
});

function repositorySpy({ executions = [] } = {}) {
  const state = {
    requests: new Map(),
    executions: new Map(executions.map((execution) => [execution.id, execution])),
    outputs: new Map()
  };

  return Object.freeze({
    ...Object.fromEntries(TRANSLATION_REPOSITORY_METHODS.map((methodName) => [methodName, () => null])),
    requests: state.requests,
    executions: state.executions,
    outputs: state.outputs,
    createTranslationRequest(request) {
      state.requests.set(request.id, request);
      return request;
    },
    getTranslationRequest(requestId) {
      return state.requests.get(requestId) || null;
    },
    updateTranslationRequest(request) {
      state.requests.set(request.id, request);
      return request;
    },
    createTranslationExecution(execution) {
      state.executions.set(execution.id, execution);
      return execution;
    },
    getTranslationExecution(executionId) {
      return state.executions.get(executionId) || null;
    },
    updateTranslationExecution(execution) {
      state.executions.set(execution.id, execution);
      return execution;
    },
    createTranslationOutput(output) {
      state.outputs.set(output.id, output);
      return output;
    },
    listTranslationOutputsByExecution(executionId) {
      return Array.from(state.outputs.values()).filter((output) => output.executionId === executionId);
    },
    getTranslationOutput(outputId) {
      return state.outputs.get(outputId) || null;
    }
  });
}

function handlerCalls() {
  const calls = [];

  return {
    handlers: {
      requestCreated(event) {
        calls.push(['requestCreated', event]);
      },
      executionCreated(event) {
        calls.push(['executionCreated', event]);
      },
      executionUpdated(event) {
        calls.push(['executionUpdated', event]);
      },
      outputCreated(event) {
        calls.push(['outputCreated', event]);
      }
    },
    names() {
      return calls.map(([name]) => name);
    },
    takeNames() {
      const names = this.names();
      calls.length = 0;
      return names;
    },
    firstEvent() {
      return calls[0][1];
    }
  };
}

function requestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    sourceTranscriptSnapshot: null,
    targetLanguageCode: 'fr',
    createdAt: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    status: 'created',
    startedAt: '2026-07-14T01:01:00.000Z',
    completedAt: null,
    failureInfo: null,
    ...overrides
  };
}

function outputPayload(overrides = {}) {
  return {
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'Bonjour',
    targetLanguageCode: 'fr',
    providerMetadata: null,
    createdAt: '2026-07-14T01:06:00.000Z',
    ...overrides
  };
}
