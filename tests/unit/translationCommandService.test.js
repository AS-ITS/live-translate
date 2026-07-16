import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandService as createRawTranslationCommandService } from '../../src/application/translationCommandService.js';
import {
  TranslationExecution,
  TranslationOutput,
  TranslationRequest
} from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';

const SERVICE_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

function createTranslationCommandService(options = {}) {
  return createRawTranslationCommandService({
    domainEventPublisher: domainEventPublisher(),
    ...options
  });
}

test('factory throws TypeError when translationRepository is missing', () => {
  assert.throws(() => createTranslationCommandService(), TypeError);
});

test('factory throws TypeError when any required repository method is missing', () => {
  for (const missingMethod of TRANSLATION_REPOSITORY_METHODS) {
    const repository = translationRepository();
    delete repository[missingMethod];

    assert.throws(
      () => createTranslationCommandService({ translationRepository: repository }),
      new RegExp(`translationRepository\\.${missingMethod}`)
    );
  }
});

test('factory throws TypeError when domainEventPublisher publish contract is missing', () => {
  const repository = translationRepository();

  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository }),
    /domainEventPublisher is required/
  );
  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository, domainEventPublisher: null }),
    /domainEventPublisher is required/
  );
  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository, domainEventPublisher: {} }),
    /domainEventPublisher\.publish must be a function/
  );
  assert.throws(
    () => createRawTranslationCommandService({ translationRepository: repository, domainEventPublisher: { publish: true } }),
    /domainEventPublisher\.publish must be a function/
  );
});

test('service object is frozen and only exposes command methods', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository()
  });

  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(Object.keys(service), SERVICE_METHODS);

  for (const method of SERVICE_METHODS) {
    assert.equal(typeof service[method], 'function');
  }

  assert.throws(() => {
    service.getTranslationRequest = () => null;
  }, TypeError);
});

test('createTranslationRequest creates domain object and returns repository result unchanged', () => {
  const calls = [];
  const repositoryResult = { id: 'stored-request-1' };
  const payload = requestPayload({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ text: 'hello', sequence: 0 }]
    }
  });
  const payloadBefore = structuredClone(payload);
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationRequest(request) {
        calls.push(request);
        return repositoryResult;
      }
    })
  });

  const result = service.createTranslationRequest(payload);

  assert.strictEqual(result, repositoryResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0] instanceof TranslationRequest, true);
  assert.equal(calls[0].targetLanguageCode, 'ZH-hant-custom');
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.deepEqual(payload, payloadBefore);
});

test('createTranslationRequest does not swallow domain validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        throw new Error('repository should not be called');
      }
    })
  });

  assert.throws(
    () =>
      service.createTranslationRequest({
        ...requestPayload(),
        targetLanguageCode: ''
      }),
    /targetLanguageCode/
  );
});

test('createTranslationExecution creates domain object and returns repository result unchanged', async () => {
  const calls = [];
  const repositoryResult = { id: 'stored-execution-1' };
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        calls.push(['createTranslationExecution', execution]);
        return repositoryResult;
      },
      getTranslationExecution() {
        calls.push(['getTranslationExecution']);
        return null;
      },
      updateTranslationExecution() {
        calls.push(['updateTranslationExecution']);
        return null;
      }
    })
  });

  const result = await service.createTranslationExecution(executionPayload());

  assert.strictEqual(result, repositoryResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'createTranslationExecution');
  assert.equal(calls[0][1] instanceof TranslationExecution, true);
  assert.equal(Object.isFrozen(calls[0][1]), true);
});

test('createTranslationExecution forwards providerKey to TranslationExecution', async () => {
  let createdExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        createdExecution = execution;
        return execution;
      }
    })
  });

  const result = await service.createTranslationExecution(executionPayload({ providerKey: 'gemini' }));

  assert.strictEqual(result, createdExecution);
  assert.equal(createdExecution instanceof TranslationExecution, true);
  assert.equal(createdExecution.providerKey, 'gemini');
});

test('createTranslationExecution preserves undefined providerKey', async () => {
  let createdExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution(execution) {
        createdExecution = execution;
        return execution;
      }
    })
  });

  await service.createTranslationExecution(executionPayload());

  assert.equal(createdExecution.providerKey, undefined);
});

test('createTranslationExecution propagates providerKey validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationExecution() {
        throw new Error('repository should not be called');
      }
    })
  });

  assert.throws(() => service.createTranslationExecution(executionPayload({ providerKey: '' })), {
    name: 'RangeError',
    message: 'providerKey must not be empty'
  });
});

test('createTranslationExecution does not swallow domain validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository()
  });

  assert.throws(
    () =>
      service.createTranslationExecution({
        ...executionPayload(),
        startedAt: undefined
      }),
    /startedAt/
  );
});

test('updateTranslationExecution reads, transitions, updates, and returns repository result unchanged', () => {
  const originalExecution = new TranslationExecution(executionPayload());
  const repositoryResult = { id: 'updated-execution-1' };
  const calls = [];
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution(executionId) {
        calls.push(['getTranslationExecution', executionId]);
        return originalExecution;
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return repositoryResult;
      }
    })
  });

  const result = service.updateTranslationExecution({
    executionId: 'execution-1',
    transition: 'start',
    startedAt: 1100
  });

  assert.strictEqual(result, repositoryResult);
  assert.deepEqual(calls[0], ['getTranslationExecution', 'execution-1']);
  assert.equal(calls[1][0], 'updateTranslationExecution');
  assert.equal(calls[1][1] instanceof TranslationExecution, true);
  assert.notStrictEqual(calls[1][1], originalExecution);
  assert.equal(calls[1][1].status, 'running');
  assert.equal(calls[1][1].startedAt, 1100);
  assert.equal(Object.isFrozen(calls[1][1]), true);
  assert.equal(originalExecution.status, 'pending');
  assert.equal(originalExecution.startedAt, 1000);
});

test('updateTranslationExecution supports complete, fail, and cancel transition payloads', () => {
  const runningExecution = new TranslationExecution(executionPayload()).start(1100);

  assert.equal(runTransition(runningExecution, { transition: 'complete', completedAt: 1200 }).status, 'completed');
  assert.equal(
    runTransition(runningExecution, {
      transition: 'fail',
      failureInfo: { reason: 'provider_error' },
      completedAt: 1200
    }).status,
    'failed'
  );
  assert.equal(runTransition(runningExecution, { transition: 'cancel', completedAt: 1200 }).status, 'cancelled');
  assert.equal(runningExecution.status, 'running');
});

test('updateTranslationExecution throws deterministic error when execution is not found', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return null;
      }
    })
  });

  assert.throws(
    () =>
      service.updateTranslationExecution({
        executionId: 'execution-missing',
        transition: 'start',
        startedAt: 1100
      }),
    /TranslationExecution execution-missing was not found/
  );
});

test('updateTranslationExecution fails for unsupported transition name', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return new TranslationExecution(executionPayload());
      }
    })
  });

  assert.throws(
    () =>
      service.updateTranslationExecution({
        executionId: 'execution-1',
        transition: 'transitionTo',
        status: 'running'
      }),
    /Unsupported TranslationExecution transition/
  );
});

test('updateTranslationExecution does not swallow illegal domain transitions', () => {
  const completedExecution = new TranslationExecution({
    ...executionPayload(),
    status: 'completed',
    completedAt: 1200
  });
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return completedExecution;
      }
    })
  });

  assert.throws(
    () =>
      service.updateTranslationExecution({
        executionId: 'execution-1',
        transition: 'fail',
        failureInfo: { reason: 'later' },
        completedAt: 1300
      }),
    /transition/
  );
  assert.equal(completedExecution.status, 'completed');
});

test('updateTranslationExecution propagates repository read and update errors unchanged', async () => {
  const readError = new Error('read failed');
  const updateError = new Error('update failed');
  const asyncReadError = new Error('async read failed');
  const asyncUpdateError = new Error('async update failed');

  assert.throws(
    () =>
      createTranslationCommandService({
        translationRepository: translationRepository({
          getTranslationExecution() {
            throw readError;
          }
        })
      }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    readError
  );

  assert.throws(
    () =>
      createTranslationCommandService({
        translationRepository: translationRepository({
          getTranslationExecution() {
            return new TranslationExecution(executionPayload());
          },
          updateTranslationExecution() {
            throw updateError;
          }
        })
      }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    updateError
  );

  await assert.rejects(
    createTranslationCommandService({
      translationRepository: translationRepository({
        getTranslationExecution() {
          return Promise.reject(asyncReadError);
        }
      })
    }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    asyncReadError
  );

  await assert.rejects(
    createTranslationCommandService({
      translationRepository: translationRepository({
        getTranslationExecution() {
          return Promise.resolve(new TranslationExecution(executionPayload()));
        },
        updateTranslationExecution() {
          return Promise.reject(asyncUpdateError);
        }
      })
    }).updateTranslationExecution({ executionId: 'execution-1', transition: 'start', startedAt: 1100 }),
    asyncUpdateError
  );
});

test('updateTranslationExecution supports async repository read and update path', async () => {
  const repositoryResult = { id: 'async-updated-execution-1' };
  const calls = [];
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution(executionId) {
        calls.push(['getTranslationExecution', executionId]);
        return Promise.resolve(new TranslationExecution(executionPayload()));
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return Promise.resolve(repositoryResult);
      }
    })
  });

  const resultPromise = service.updateTranslationExecution({
    executionId: 'execution-1',
    transition: 'start',
    startedAt: 1100
  });

  assert.equal(typeof resultPromise.then, 'function');
  assert.strictEqual(await resultPromise, repositoryResult);
  assert.deepEqual(calls[0], ['getTranslationExecution', 'execution-1']);
  assert.equal(calls[1][1].status, 'running');
});

test('createTranslationOutput creates domain object and returns repository result unchanged', () => {
  const calls = [];
  const repositoryResult = { id: 'stored-output-1' };
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationOutput(output) {
        calls.push(['createTranslationOutput', output]);
        return repositoryResult;
      },
      updateTranslationExecution(execution) {
        calls.push(['updateTranslationExecution', execution]);
        return null;
      }
    })
  });

  const result = service.createTranslationOutput(outputPayload());

  assert.strictEqual(result, repositoryResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'createTranslationOutput');
  assert.equal(calls[0][1] instanceof TranslationOutput, true);
  assert.equal(Object.isFrozen(calls[0][1]), true);
});

test('createTranslationOutput does not swallow domain validation errors', () => {
  const service = createTranslationCommandService({
    translationRepository: translationRepository()
  });

  assert.throws(
    () =>
      service.createTranslationOutput({
        ...outputPayload(),
        translatedText: ''
      }),
    /translatedText/
  );
});

test('create methods preserve sync and async repository behavior', async () => {
  const requestResult = { id: 'sync-request-result' };
  const executionResult = { id: 'async-execution-result' };
  const outputResult = { id: 'async-output-result' };
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      createTranslationRequest() {
        return requestResult;
      },
      createTranslationExecution() {
        return Promise.resolve(executionResult);
      },
      createTranslationOutput() {
        return Promise.resolve(outputResult);
      }
    })
  });

  assert.strictEqual(service.createTranslationRequest(requestPayload()), requestResult);
  assert.strictEqual(await service.createTranslationExecution(executionPayload()), executionResult);
  assert.strictEqual(await service.createTranslationOutput(outputPayload()), outputResult);
});

function runTransition(execution, transitionPayload) {
  let updatedExecution;
  const service = createTranslationCommandService({
    translationRepository: translationRepository({
      getTranslationExecution() {
        return execution;
      },
      updateTranslationExecution(nextExecution) {
        updatedExecution = nextExecution;
        return nextExecution;
      }
    })
  });

  service.updateTranslationExecution({
    executionId: execution.id,
    ...transitionPayload
  });

  return updatedExecution;
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

function domainEventPublisher(overrides = {}) {
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
    targetLanguageCode: 'ZH-hant-custom',
    createdAt: 1000,
    ...overrides
  };
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
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
    createdAt: 1000,
    ...overrides
  };
}
