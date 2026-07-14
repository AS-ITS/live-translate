import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { TRANSLATION_EVENT_TYPES, TranslationExecution } from '../../src/domain/translation/index.js';

const HANDLER_NAMES = Object.freeze([
  'requestCreated',
  'executionCreated',
  'executionUpdated',
  'outputCreated'
]);

test('request creation persists, publishes request.created, routes only to requestCreated, and awaits handler', async () => {
  await verifyRoutedCommandFlow({
    commandName: 'createTranslationRequest',
    repositoryMethod: 'createTranslationRequest',
    handlerName: 'requestCreated',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED,
    aggregateField: 'request',
    aggregateId: 'request-1',
    occurredAt: '2026-07-14T01:00:00.000Z',
    payload: requestPayload(),
    storedAggregate(repository) {
      return repository.requests.get('request-1');
    },
    run(commandService, payload) {
      return commandService.createTranslationRequest(payload);
    }
  });
});

test('execution creation publishes execution.created, routes only to executionCreated, and awaits handler', async () => {
  await verifyRoutedCommandFlow({
    commandName: 'createTranslationExecution',
    repositoryMethod: 'createTranslationExecution',
    handlerName: 'executionCreated',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED,
    aggregateField: 'execution',
    aggregateId: 'execution-1',
    occurredAt: '2026-07-14T01:01:00.000Z',
    payload: executionPayload(),
    storedAggregate(repository) {
      return repository.executions.get('execution-1');
    },
    run(commandService, payload) {
      return commandService.createTranslationExecution(payload);
    }
  });
});

test('execution update publishes execution.updated with transition timestamp and awaits handler', async () => {
  const originalExecution = new TranslationExecution(executionPayload({ id: 'execution-update-1' })).start(
    '2026-07-14T01:01:30.000Z'
  );

  await verifyRoutedCommandFlow({
    commandName: 'updateTranslationExecution',
    repositoryMethod: 'updateTranslationExecution',
    handlerName: 'executionUpdated',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED,
    aggregateField: 'execution',
    aggregateId: 'execution-update-1',
    occurredAt: '2026-07-14T01:02:00.000Z',
    repositoryOptions: { executions: [originalExecution] },
    payload: {
      executionId: 'execution-update-1',
      transition: 'complete',
      completedAt: '2026-07-14T01:02:00.000Z'
    },
    storedAggregate(repository) {
      return repository.executions.get('execution-update-1');
    },
    run(commandService, payload) {
      return commandService.updateTranslationExecution(payload);
    },
    afterAssertions({ result }) {
      assert.equal(originalExecution.status, 'running');
      assert.equal(originalExecution.completedAt, null);
      assert.equal(result.status, 'completed');
      assert.equal(result.completedAt, '2026-07-14T01:02:00.000Z');
    }
  });
});

test('output creation publishes output.created, routes only to outputCreated, and awaits handler', async () => {
  await verifyRoutedCommandFlow({
    commandName: 'createTranslationOutput',
    repositoryMethod: 'createTranslationOutput',
    handlerName: 'outputCreated',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED,
    aggregateField: 'output',
    aggregateId: 'output-1',
    occurredAt: '2026-07-14T01:06:00.000Z',
    payload: outputPayload(),
    storedAggregate(repository) {
      return repository.outputs.get('output-1');
    },
    run(commandService, payload) {
      return commandService.createTranslationOutput(payload);
    }
  });
});

test('handler rejection propagates unchanged after repository success without rollback, retry, or logging', async () => {
  const expectedError = new Error('handler rejected');
  const repository = createTranslationRepositoryFixture();
  const calls = [];
  const consoleCapture = captureConsole();
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: {
      async requestCreated(event) {
        calls.push(event);
        throw expectedError;
      }
    }
  });

  try {
    await assert.rejects(
      dependencies.translationCommandService.createTranslationRequest(requestPayload()),
      (actualError) => actualError === expectedError
    );
  } finally {
    consoleCapture.restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(repository.callsFor('createTranslationRequest').length, 1);
  assert.equal(repository.requests.has('request-1'), true);
  assert.strictEqual(calls[0].payload.request, repository.requests.get('request-1'));
  assert.deepEqual(consoleCapture.calls, []);
});

test('unsubscribe is idempotent, stops future delivery, and commands still succeed without subscribers', async () => {
  const repository = createTranslationRepositoryFixture({
    executions: [new TranslationExecution(executionPayload({ id: 'execution-unsub-1' }))]
  });
  const calls = recordHandlers();
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: calls.handlers
  });

  dependencies.unsubscribeTranslationDomainEvents();
  dependencies.unsubscribeTranslationDomainEvents();

  const request = await dependencies.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-unsub-1' }));
  const execution = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({ id: 'execution-unsub-created-1' })
  );
  const updatedExecution = await dependencies.translationCommandService.updateTranslationExecution({
    executionId: 'execution-unsub-1',
    transition: 'start',
    startedAt: '2026-07-14T01:03:00.000Z'
  });
  const output = await dependencies.translationCommandService.createTranslationOutput(outputPayload({ id: 'output-unsub-1' }));

  assert.equal(request.id, 'request-unsub-1');
  assert.equal(execution.id, 'execution-unsub-created-1');
  assert.equal(updatedExecution.id, 'execution-unsub-1');
  assert.equal(output.id, 'output-unsub-1');
  assert.deepEqual(calls.names(), []);
});

test('missing, empty, and partial handler collections remain safe for all command flows', async () => {
  await assertAllCommandFlowsSucceed({ translationDomainEventHandlers: undefined });
  await assertAllCommandFlowsSucceed({ translationDomainEventHandlers: {} });

  const partialCalls = [];
  await assertAllCommandFlowsSucceed({
    translationDomainEventHandlers: {
      requestCreated(event) {
        partialCalls.push(['requestCreated', event]);
      }
    }
  });
  assert.deepEqual(
    partialCalls.map(([handlerName]) => handlerName),
    ['requestCreated']
  );
});

test('independent dependency graphs isolate event buses, handlers, and unsubscribe lifecycle', async () => {
  const callsA = recordHandlers();
  const callsB = recordHandlers();
  const graphA = createApplicationDependencies({
    translationRepository: createTranslationRepositoryFixture(),
    translationDomainEventHandlers: callsA.handlers
  });
  const graphB = createApplicationDependencies({
    translationRepository: createTranslationRepositoryFixture(),
    translationDomainEventHandlers: callsB.handlers
  });

  await graphA.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-a-1' }));
  assert.deepEqual(callsA.names(), ['requestCreated']);
  assert.deepEqual(callsB.names(), []);

  await graphB.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-b-1' }));
  assert.deepEqual(callsA.names(), ['requestCreated']);
  assert.deepEqual(callsB.names(), ['requestCreated']);

  graphA.unsubscribeTranslationDomainEvents();
  await graphA.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-a-2' }));
  await graphB.translationCommandService.createTranslationExecution(executionPayload({ id: 'execution-b-1' }));

  assert.deepEqual(callsA.names(), ['requestCreated']);
  assert.deepEqual(callsB.names(), ['requestCreated', 'executionCreated']);
});

test('one dependency graph publishes one event to one handler without duplicate delivery', async () => {
  const calls = recordHandlers();
  const dependencies = createApplicationDependencies({
    translationRepository: createTranslationRepositoryFixture(),
    translationDomainEventHandlers: calls.handlers
  });

  await dependencies.translationCommandService.createTranslationRequest(requestPayload());

  assert.deepEqual(calls.names(), ['requestCreated']);
  assert.equal(calls.events().length, 1);
  assert.equal(calls.events()[0].type, TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED);
});

async function verifyRoutedCommandFlow({
  commandName,
  repositoryMethod,
  handlerName,
  eventType,
  aggregateField,
  aggregateId,
  occurredAt,
  payload,
  repositoryOptions = {},
  storedAggregate,
  run,
  afterAssertions = () => {}
}) {
  const repository = createTranslationRepositoryFixture(repositoryOptions);
  const inputBefore = structuredClone(payload);
  const handlers = controlledHandlers(handlerName);
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    translationDomainEventHandlers: handlers.handlers
  });
  let commandResolved = false;

  const commandPromise = Promise.resolve(run(dependencies.translationCommandService, payload)).then((result) => {
    commandResolved = true;
    return result;
  });

  await Promise.resolve();

  assert.equal(commandResolved, false, `${commandName} resolved before ${handlerName} completed`);
  assert.equal(handlers.completed, false);
  assert.deepEqual(handlers.names(), [handlerName]);

  const event = handlers.events()[0];
  const payloadReference = event.payload;
  const aggregateReference = event.payload[aggregateField];
  const aggregateFieldsBefore = structuredClone(Object.fromEntries(Object.entries(aggregateReference)));
  const persistedAggregate = storedAggregate(repository);

  assert.equal(repository.callsFor(repositoryMethod).length, 1);
  assert.equal(event.type, eventType);
  assert.equal(event.occurredAt, occurredAt);
  assert.deepEqual(Object.keys(event), ['type', 'occurredAt', 'payload']);
  assert.deepEqual(Object.keys(event.payload), [aggregateField]);
  assert.equal(aggregateReference.id, aggregateId);
  assert.strictEqual(aggregateReference, persistedAggregate);
  assert.deepEqual(payload, inputBefore);

  handlers.release();
  const result = await commandPromise;

  assert.equal(commandResolved, true);
  assert.equal(handlers.completed, true);
  assert.strictEqual(result, persistedAggregate);
  assert.strictEqual(event, handlers.events()[0]);
  assert.strictEqual(event.payload, payloadReference);
  assert.strictEqual(event.payload[aggregateField], aggregateReference);
  assert.equal(event.type, eventType);
  assert.equal(event.occurredAt, occurredAt);
  assert.deepEqual(Object.keys(event), ['type', 'occurredAt', 'payload']);
  assert.deepEqual(Object.keys(event.payload), [aggregateField]);
  assert.deepEqual(Object.fromEntries(Object.entries(aggregateReference)), aggregateFieldsBefore);
  assert.deepEqual(payload, inputBefore);
  assert.deepEqual(handlers.names(), [handlerName]);
  afterAssertions({ result, event, repository });
}

async function assertAllCommandFlowsSucceed({ translationDomainEventHandlers }) {
  const repository = createTranslationRepositoryFixture({
    executions: [new TranslationExecution(executionPayload({ id: 'execution-existing-1' }))]
  });
  const dependencies = createApplicationDependencies({
    translationRepository: repository,
    ...(translationDomainEventHandlers === undefined ? {} : { translationDomainEventHandlers })
  });

  const request = await dependencies.translationCommandService.createTranslationRequest(requestPayload({ id: 'request-safe-1' }));
  const execution = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({ id: 'execution-safe-1' })
  );
  const updatedExecution = await dependencies.translationCommandService.updateTranslationExecution({
    executionId: 'execution-existing-1',
    transition: 'start',
    startedAt: '2026-07-14T01:03:00.000Z'
  });
  const output = await dependencies.translationCommandService.createTranslationOutput(outputPayload({ id: 'output-safe-1' }));

  assert.equal(request.id, 'request-safe-1');
  assert.equal(execution.id, 'execution-safe-1');
  assert.equal(updatedExecution.id, 'execution-existing-1');
  assert.equal(output.id, 'output-safe-1');
}

function controlledHandlers(awaitedHandlerName) {
  const calls = recordHandlers({
    [awaitedHandlerName]: async (event) => {
      calls.record(awaitedHandlerName, event);
      await gate.promise;
      completed = true;
    }
  });
  const gate = deferred();
  let completed = false;

  return {
    handlers: calls.handlers,
    names: calls.names,
    events: calls.events,
    release: gate.resolve,
    get completed() {
      return completed;
    }
  };
}

function recordHandlers(overrides = {}) {
  const calls = [];
  const handlers = Object.fromEntries(
    HANDLER_NAMES.map((handlerName) => [
      handlerName,
      overrides[handlerName] ??
        function handler(event) {
          record(handlerName, event);
        }
    ])
  );

  function record(handlerName, event) {
    calls.push({ handlerName, event });
  }

  return {
    handlers,
    record,
    names() {
      return calls.map((call) => call.handlerName);
    },
    events() {
      return calls.map((call) => call.event);
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function captureConsole() {
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const calls = [];

  console.error = (...args) => calls.push(['error', ...args]);
  console.warn = (...args) => calls.push(['warn', ...args]);
  console.log = (...args) => calls.push(['log', ...args]);

  return {
    calls,
    restore() {
      console.error = originalError;
      console.warn = originalWarn;
      console.log = originalLog;
    }
  };
}

function createTranslationRepositoryFixture({ executions = [] } = {}) {
  const requests = new Map();
  const executionMap = new Map(executions.map((execution) => [execution.id, execution]));
  const outputs = new Map();
  const calls = [];

  function record(methodName, args) {
    calls.push([methodName, ...args]);
  }

  return {
    calls,
    requests,
    executions: executionMap,
    outputs,

    callsFor(methodName) {
      return calls.filter(([nextMethodName]) => nextMethodName === methodName).map(([, ...args]) => args);
    },

    createTranslationRequest(request) {
      record('createTranslationRequest', [request]);
      requests.set(request.id, request);
      return request;
    },

    getTranslationRequest(requestId) {
      record('getTranslationRequest', [requestId]);
      return requests.get(requestId) ?? null;
    },

    updateTranslationRequest(request) {
      record('updateTranslationRequest', [request]);
      requests.set(request.id, request);
      return request;
    },

    listTranslationRequestsBySession(sessionId) {
      record('listTranslationRequestsBySession', [sessionId]);
      return Array.from(requests.values()).filter((request) => request.sessionId === sessionId);
    },

    createTranslationExecution(execution) {
      record('createTranslationExecution', [execution]);
      executionMap.set(execution.id, execution);
      return execution;
    },

    getTranslationExecution(executionId) {
      record('getTranslationExecution', [executionId]);
      return executionMap.get(executionId) ?? null;
    },

    updateTranslationExecution(execution) {
      record('updateTranslationExecution', [execution]);
      executionMap.set(execution.id, execution);
      return execution;
    },

    listTranslationExecutionsByRequest(requestId) {
      record('listTranslationExecutionsByRequest', [requestId]);
      return Array.from(executionMap.values()).filter((execution) => execution.translationRequestId === requestId);
    },

    createTranslationOutput(output) {
      record('createTranslationOutput', [output]);
      outputs.set(output.id, output);
      return output;
    },

    listTranslationOutputsByExecution(executionId) {
      record('listTranslationOutputsByExecution', [executionId]);
      return Array.from(outputs.values()).filter((output) => output.executionId === executionId);
    },

    listTranslationOutputsBySession(sessionId) {
      record('listTranslationOutputsBySession', [sessionId]);
      const requestIds = new Set(
        Array.from(requests.values())
          .filter((request) => request.sessionId === sessionId)
          .map((request) => request.id)
      );
      const executionIds = new Set(
        Array.from(executionMap.values())
          .filter((execution) => requestIds.has(execution.translationRequestId))
          .map((execution) => execution.id)
      );

      return Array.from(outputs.values()).filter((output) => executionIds.has(output.executionId));
    },

    listTranslationOutputsByRequest(requestId) {
      record('listTranslationOutputsByRequest', [requestId]);
      const executionIds = new Set(
        Array.from(executionMap.values())
          .filter((execution) => execution.translationRequestId === requestId)
          .map((execution) => execution.id)
      );

      return Array.from(outputs.values()).filter((output) => executionIds.has(output.executionId));
    },

    getTranslationOutput(outputId) {
      record('getTranslationOutput', [outputId]);
      return outputs.get(outputId) ?? null;
    }
  };
}

function requestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'ja',
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ id: 'source-item-1', text: 'Hello', sequence: 0 }]
    },
    createdAt: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: '2026-07-14T01:01:00.000Z',
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
    providerMetadata: {
      provider: 'fixture-provider'
    },
    createdAt: '2026-07-14T01:06:00.000Z',
    ...overrides
  };
}
