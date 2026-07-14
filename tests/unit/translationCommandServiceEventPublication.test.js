import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import {
  TRANSLATION_EVENT_TYPES,
  TranslationExecution,
  createTranslationExecutionCreatedEvent,
  createTranslationExecutionUpdatedEvent,
  createTranslationOutputCreatedEvent,
  createTranslationRequestCreatedEvent
} from '../../src/domain/translation/index.js';

const CREATE_CASES = Object.freeze([
  {
    name: 'request create',
    command: 'createTranslationRequest',
    repositoryMethod: 'createTranslationRequest',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED,
    aggregateField: 'request',
    payload: requestPayload,
    occurredAt: 1000,
    factory: createTranslationRequestCreatedEvent
  },
  {
    name: 'execution create',
    command: 'createTranslationExecution',
    repositoryMethod: 'createTranslationExecution',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED,
    aggregateField: 'execution',
    payload: executionPayload,
    occurredAt: 1100,
    factory: createTranslationExecutionCreatedEvent
  },
  {
    name: 'output create',
    command: 'createTranslationOutput',
    repositoryMethod: 'createTranslationOutput',
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED,
    aggregateField: 'output',
    payload: outputPayload,
    occurredAt: 1200,
    factory: createTranslationOutputCreatedEvent
  }
]);

for (const createCase of CREATE_CASES) {
  test(`${createCase.name} publishes factory event after repository success`, () => {
    const calls = [];
    const repositoryResult = { id: `${createCase.name}-repository-result` };
    const input = createCase.payload();
    const inputBefore = structuredClone(input);
    let savedAggregate;
    let publishedEvent;
    const service = createService({
      translationRepository: translationRepository({
        [createCase.repositoryMethod](aggregate) {
          savedAggregate = aggregate;
          calls.push(createCase.repositoryMethod);
          return repositoryResult;
        }
      }),
      domainEventPublisher: publisher({
        publish(event) {
          publishedEvent = event;
          calls.push('publish');
        }
      })
    });

    const result = service[createCase.command](input);

    assert.strictEqual(result, repositoryResult);
    assert.deepEqual(calls, [createCase.repositoryMethod, 'publish']);
    assert.deepEqual(input, inputBefore);
    assertPublishedFactoryEvent({
      event: publishedEvent,
      expectedType: createCase.eventType,
      expectedOccurredAt: createCase.occurredAt,
      aggregateField: createCase.aggregateField,
      aggregate: savedAggregate,
      factory: createCase.factory
    });
  });
}

test('execution update publishes factory event after repository update', () => {
  const calls = [];
  const repositoryResult = { id: 'updated-execution-result' };
  const originalExecution = new TranslationExecution(executionPayload());
  let updatedExecution;
  let publishedEvent;
  const service = createService({
    translationRepository: translationRepository({
      getTranslationExecution(executionId) {
        calls.push(['getTranslationExecution', executionId]);
        return originalExecution;
      },
      updateTranslationExecution(execution) {
        updatedExecution = execution;
        calls.push('updateTranslationExecution');
        return repositoryResult;
      }
    }),
    domainEventPublisher: publisher({
      publish(event) {
        publishedEvent = event;
        calls.push('publish');
      }
    })
  });

  const result = service.updateTranslationExecution({
    executionId: 'execution-1',
    transition: 'start',
    startedAt: 1300
  });

  assert.strictEqual(result, repositoryResult);
  assert.deepEqual(calls, [['getTranslationExecution', 'execution-1'], 'updateTranslationExecution', 'publish']);
  assertPublishedFactoryEvent({
    event: publishedEvent,
    expectedType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED,
    expectedOccurredAt: 1300,
    aggregateField: 'execution',
    aggregate: updatedExecution,
    factory: createTranslationExecutionUpdatedEvent
  });
});

test('execution update uses transition-specific occurredAt values', () => {
  const transitions = [
    {
      name: 'start',
      original: new TranslationExecution(executionPayload()),
      payload: { transition: 'start', startedAt: 1300 },
      expectedStatus: 'running',
      expectedOccurredAt: 1300
    },
    {
      name: 'complete',
      original: new TranslationExecution(executionPayload()).start(1100),
      payload: { transition: 'complete', completedAt: 1400 },
      expectedStatus: 'completed',
      expectedOccurredAt: 1400
    },
    {
      name: 'fail',
      original: new TranslationExecution(executionPayload()).start(1100),
      payload: { transition: 'fail', failureInfo: { reason: 'provider_error' }, completedAt: 1500 },
      expectedStatus: 'failed',
      expectedOccurredAt: 1500
    },
    {
      name: 'cancel',
      original: new TranslationExecution(executionPayload()).start(1100),
      payload: { transition: 'cancel', completedAt: 1600 },
      expectedStatus: 'cancelled',
      expectedOccurredAt: 1600
    }
  ];

  for (const transitionCase of transitions) {
    let updatedExecution;
    let publishedEvent;
    const service = createService({
      translationRepository: translationRepository({
        getTranslationExecution() {
          return transitionCase.original;
        },
        updateTranslationExecution(execution) {
          updatedExecution = execution;
          return execution;
        }
      }),
      domainEventPublisher: publisher({
        publish(event) {
          publishedEvent = event;
        }
      })
    });

    service.updateTranslationExecution({
      executionId: 'execution-1',
      ...transitionCase.payload
    });

    assert.equal(updatedExecution.status, transitionCase.expectedStatus, transitionCase.name);
    assert.equal(publishedEvent.occurredAt, transitionCase.expectedOccurredAt, transitionCase.name);
    assert.strictEqual(publishedEvent.payload.execution, updatedExecution, transitionCase.name);
  }
});

test('repository sync failure prevents event publication and propagates original error', () => {
  const repositoryError = new Error('repository failed');
  let publishCalls = 0;
  const service = createService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        throw repositoryError;
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        publishCalls += 1;
      }
    })
  });

  assert.throws(() => service.createTranslationRequest(requestPayload()), repositoryError);
  assert.equal(publishCalls, 0);
});

test('repository async failure prevents event publication and propagates original error', async () => {
  const repositoryError = new Error('async repository failed');
  let publishCalls = 0;
  const service = createService({
    translationRepository: translationRepository({
      createTranslationOutput() {
        return Promise.reject(repositoryError);
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        publishCalls += 1;
      }
    })
  });

  await assert.rejects(service.createTranslationOutput(outputPayload()), repositoryError);
  assert.equal(publishCalls, 0);
});

test('execution update repository failure prevents event publication and propagates original errors', async () => {
  const syncUpdateError = new Error('sync update failed');
  const asyncUpdateError = new Error('async update failed');
  let syncPublishCalls = 0;
  let asyncPublishCalls = 0;

  assert.throws(
    () =>
      createService({
        translationRepository: translationRepository({
          getTranslationExecution() {
            return new TranslationExecution(executionPayload());
          },
          updateTranslationExecution() {
            throw syncUpdateError;
          }
        }),
        domainEventPublisher: publisher({
          publish() {
            syncPublishCalls += 1;
          }
        })
      }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1300 }),
    syncUpdateError
  );

  await assert.rejects(
    createService({
      translationRepository: translationRepository({
        getTranslationExecution() {
          return Promise.resolve(new TranslationExecution(executionPayload()));
        },
        updateTranslationExecution() {
          return Promise.reject(asyncUpdateError);
        }
      }),
      domainEventPublisher: publisher({
        publish() {
          asyncPublishCalls += 1;
        }
      })
    }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1300 }),
    asyncUpdateError
  );

  assert.equal(syncPublishCalls, 0);
  assert.equal(asyncPublishCalls, 0);
});

test('publisher sync failure propagates original error and does not return repository result', () => {
  const repositoryResult = { id: 'stored-request' };
  const publisherError = new Error('publisher failed');
  let repositoryCalls = 0;
  const service = createService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        repositoryCalls += 1;
        return repositoryResult;
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        throw publisherError;
      }
    })
  });

  assert.throws(() => service.createTranslationRequest(requestPayload()), publisherError);
  assert.equal(repositoryCalls, 1);
});

test('publisher async failure propagates original error and does not resolve repository result', async () => {
  const repositoryResult = { id: 'stored-output' };
  const publisherError = new Error('async publisher failed');
  let repositoryCalls = 0;
  const service = createService({
    translationRepository: translationRepository({
      createTranslationOutput() {
        repositoryCalls += 1;
        return repositoryResult;
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        return Promise.reject(publisherError);
      }
    })
  });

  await assert.rejects(service.createTranslationOutput(outputPayload()), publisherError);
  assert.equal(repositoryCalls, 1);
});

test('service waits for publisher promise before resolving repository result', async () => {
  const repositoryResult = { id: 'stored-request' };
  const publication = deferred();
  let resolved = false;
  let publishStarted = false;
  const service = createService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        return repositoryResult;
      }
    }),
    domainEventPublisher: publisher({
      async publish() {
        publishStarted = true;
        await publication.promise;
      }
    })
  });

  const resultPromise = service.createTranslationRequest(requestPayload());
  resultPromise.then(() => {
    resolved = true;
  });

  await Promise.resolve();

  assert.equal(publishStarted, true);
  assert.equal(resolved, false);

  publication.resolve();

  assert.strictEqual(await resultPromise, repositoryResult);
  assert.equal(resolved, true);
});

test('async repository result is returned only after successful publication', async () => {
  const repositoryResult = { id: 'async-execution-result' };
  const calls = [];
  const service = createService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        calls.push('createTranslationExecution');
        return Promise.resolve(repositoryResult);
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        calls.push('publish');
      }
    })
  });

  const result = await service.createTranslationExecution(executionPayload());

  assert.strictEqual(result, repositoryResult);
  assert.deepEqual(calls, ['createTranslationExecution', 'publish']);
});

function assertPublishedFactoryEvent({ event, expectedType, expectedOccurredAt, aggregateField, aggregate, factory }) {
  const expectedEvent = factory({
    [aggregateField]: aggregate,
    occurredAt: expectedOccurredAt
  });

  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(event.type, expectedType);
  assert.equal(event.occurredAt, expectedOccurredAt);
  assert.deepEqual(event, expectedEvent);
  assert.strictEqual(event.payload[aggregateField], aggregate);
  assert.strictEqual(expectedEvent.payload[aggregateField], aggregate);
}

function createService({ translationRepository: repository, domainEventPublisher } = {}) {
  return createTranslationCommandService({
    translationRepository: repository || translationRepository(),
    domainEventPublisher: domainEventPublisher || publisher()
  });
}

function translationRepository(overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      function createTranslationRequest(request) {
        return request;
      },
    getTranslationRequest:
      overrides.getTranslationRequest ||
      function getTranslationRequest() {
        return null;
      },
    updateTranslationRequest:
      overrides.updateTranslationRequest ||
      function updateTranslationRequest(request) {
        return request;
      },
    listTranslationRequestsBySession:
      overrides.listTranslationRequestsBySession ||
      function listTranslationRequestsBySession() {
        return [];
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      function createTranslationExecution(execution) {
        return execution;
      },
    getTranslationExecution:
      overrides.getTranslationExecution ||
      function getTranslationExecution() {
        return null;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      function updateTranslationExecution(execution) {
        return execution;
      },
    listTranslationExecutionsByRequest:
      overrides.listTranslationExecutionsByRequest ||
      function listTranslationExecutionsByRequest() {
        return [];
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      function createTranslationOutput(output) {
        return output;
      },
    listTranslationOutputsByExecution:
      overrides.listTranslationOutputsByExecution ||
      function listTranslationOutputsByExecution() {
        return [];
      },
    listTranslationOutputsBySession:
      overrides.listTranslationOutputsBySession ||
      function listTranslationOutputsBySession() {
        return [];
      },
    listTranslationOutputsByRequest:
      overrides.listTranslationOutputsByRequest ||
      function listTranslationOutputsByRequest() {
        return [];
      },
    getTranslationOutput:
      overrides.getTranslationOutput ||
      function getTranslationOutput() {
        return null;
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

function requestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'zh-Hant',
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ text: 'hello', sequence: 0 }]
    },
    createdAt: 1000,
    ...overrides
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1100,
    ...overrides
  };
}

function outputPayload(overrides = {}) {
  return {
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'translated text',
    targetLanguageCode: 'ja',
    createdAt: 1200,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
