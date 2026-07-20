import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionWorker } from '../../src/application/translationExecutionWorker.js';
import { TranslationExecution, TranslationRequest } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

test('empty queue returns idle', async () => {
  const worker = createTranslationExecutionWorker(workerDependencies({ translationExecutionQueue: queue() }));

  assert.deepEqual(await worker.processNext(), { status: 'idle' });
});

test('empty queue does not call repository or runner', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({ calls, translationExecutionQueue: queue() }));

  await worker.processNext();

  assert.deepEqual(calls, []);
});

test('dequeue once processes only one job', async () => {
  const calls = [];
  const queue = createInMemoryTranslationExecutionQueue();
  queue.enqueue({ executionId: 'execution-1', requestId: 'request-1' });
  queue.enqueue({ executionId: 'execution-2', requestId: 'request-2' });
  const worker = createTranslationExecutionWorker(workerDependencies({ calls, translationExecutionQueue: queue }));

  const result = await worker.processNext();

  assert.deepEqual(result, { status: 'processed', executionId: 'execution-1' });
  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById', 'runner.run']);
  assert.equal(queue.size(), 1);
  assert.deepEqual(queue.dequeue(), { executionId: 'execution-2', requestId: 'request-2' });
});

test('repository is queried with execution and request identifiers', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({ calls }));

  await worker.processNext();

  assert.deepEqual(calls[0], ['findExecutionById', 'execution-1']);
  assert.deepEqual(calls[1], ['findRequestById', 'request-1']);
});

test('runner.run is called once with loaded execution and request', async () => {
  const calls = [];
  const execution = translationExecution({ id: 'execution-loaded' });
  const request = translationRequest({ id: 'request-loaded' });
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionQueue: queue([{ executionId: 'execution-loaded', requestId: 'request-loaded' }]),
      translationRepository: repository({ execution, request })
    })
  );

  const result = await worker.processNext();

  const runnerCalls = calls.filter((call) => call[0] === 'runner.run');
  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(result, { status: 'processed', executionId: 'execution-loaded' });
  assert.strictEqual(runnerCalls[0][1].execution, execution);
  assert.strictEqual(runnerCalls[0][1].request, request);
});

for (const status of ['created', 'running', 'completed', 'failed']) {
  test(`${status} execution is skipped before durable claim or runner execution`, async () => {
    const calls = [];
    const worker = createTranslationExecutionWorker(
      workerDependencies({
        calls,
        translationRepository: repository({ calls, execution: executionWithStatus(status) }),
        durableTranslationExecutionQueueRepository: durableRepository({ calls })
      })
    );

    assert.deepEqual(await worker.processNext(), {
      processed: false,
      reason: 'execution_not_processable',
      executionId: 'execution-1',
      status
    });
    assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById']);
  });
}

test('durable queue claim is persisted before runner starts', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      durableTranslationExecutionQueueRepository: durableRepository({ calls })
    })
  );

  await worker.processNext();

  assert.deepEqual(calls.map((call) => call[0]), [
    'findExecutionById',
    'findRequestById',
    'durable.claim',
    'durable.updateStatus',
    'runner.run',
    'durable.acknowledge'
  ]);
  assert.deepEqual(calls[3], ['durable.updateStatus', 'execution-1', 'processing']);
});

test('acknowledges after a successful runner reaches completed state', async () => {
  const calls = [];
  let executionState = 'processing';
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        run() {
          calls.push(['runner.run']);
          executionState = 'completed';
        }
      },
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        acknowledge() {
          calls.push(['durable.acknowledge', executionState]);
        }
      })
    })
  );

  await worker.processNext();

  assert.deepEqual(calls.map((call) => call[0]), [
    'findExecutionById',
    'findRequestById',
    'durable.claim',
    'durable.updateStatus',
    'runner.run',
    'durable.acknowledge'
  ]);
  assert.deepEqual(calls.at(-1), ['durable.acknowledge', 'completed']);
});

test('durable queue claim failure propagates without running execution', async () => {
  const calls = [];
  const claimError = new Error('claim failed');
  const durableItem = {
    executionId: 'execution-1',
    requestId: 'request-1',
    enqueuedAt: '2026-07-17T08:00:00.000Z',
    status: 'queued'
  };
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        updateStatus() {
          assert.equal(durableItem.status, 'queued');
          calls.push(['durable.updateStatus', 'execution-1', 'processing']);
          throw claimError;
        }
      })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === claimError);

  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById', 'durable.claim', 'durable.updateStatus']);
  assert.equal(durableItem.status, 'queued');
});

test('missing execution throws stable error without querying request or runner', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationRepository: repository({ calls, execution: null })
    })
  );

  await assert.rejects(worker.processNext(), /TranslationExecution execution-1 was not found/);

  assert.deepEqual(calls, [['findExecutionById', 'execution-1']]);
});

test('missing request throws stable error without calling runner', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationRepository: repository({ calls, request: null })
    })
  );

  await assert.rejects(worker.processNext(), /TranslationRequest request-1 was not found/);

  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById']);
  assert.equal(calls.some((call) => call[0] === 'runner.run'), false);
});

test('runner receives persisted lookup objects instead of queue payload references', async () => {
  const calls = [];
  const persistedExecution = translationExecution({ id: 'execution-persisted' });
  const persistedRequest = translationRequest({ id: 'request-persisted' });
  const queueExecution = { id: 'execution-from-queue' };
  const queueRequest = { id: 'request-from-queue' };
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionQueue: queue([
        {
          executionId: 'execution-persisted',
          requestId: 'request-persisted',
          execution: queueExecution,
          request: queueRequest,
          sourceText: 'queue payload should not be used'
        }
      ]),
      translationRepository: repository({
        calls,
        execution: persistedExecution,
        request: persistedRequest
      })
    })
  );

  await worker.processNext();

  const runnerInput = calls.find((call) => call[0] === 'runner.run')[1];
  assert.strictEqual(runnerInput.execution, persistedExecution);
  assert.strictEqual(runnerInput.request, persistedRequest);
  assert.notStrictEqual(runnerInput.execution, queueExecution);
  assert.notStrictEqual(runnerInput.request, queueRequest);
  assert.equal(Object.hasOwn(runnerInput, 'sourceText'), false);
});

test('runner error propagates unchanged', async () => {
  const runnerError = new Error('runner failed');
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      translationExecutionRunner: {
        run() {
          throw runnerError;
        }
      }
    })
  );

  await assert.rejects(worker.processNext(), (actualError) => actualError === runnerError);
});

test('runner failure is acknowledged after failed state persistence and rethrows the original error', async () => {
  const calls = [];
  const runnerError = new Error('runner failed');
  let executionState = 'processing';
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        run() {
          calls.push(['runner.run']);
          executionState = 'failed';
          throw runnerError;
        }
      },
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        acknowledge() {
          calls.push(['durable.acknowledge', executionState]);
        }
      })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === runnerError);

  assert.deepEqual(calls.at(-1), ['durable.acknowledge', 'failed']);
  assert.equal(calls.filter((call) => call[0] === 'runner.run').length, 1);
});

test('acknowledgement failure propagates unchanged without rerunning the runner', async () => {
  const calls = [];
  const acknowledgementError = new Error('acknowledgement failed');
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        acknowledge() {
          calls.push(['durable.acknowledge']);
          throw acknowledgementError;
        }
      })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === acknowledgementError);
  assert.equal(calls.filter((call) => call[0] === 'runner.run').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'durable.acknowledge').length, 1);
});

test('dequeue removes processed job from queue', async () => {
  const queue = createInMemoryTranslationExecutionQueue();
  queue.enqueue({ executionId: 'execution-1', requestId: 'request-1' });
  const worker = createTranslationExecutionWorker(workerDependencies({ translationExecutionQueue: queue }));

  await worker.processNext();

  assert.equal(queue.size(), 0);
  assert.equal(queue.dequeue(), null);
});

test('worker can delegate to existing execute runner method', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        execute(input) {
          calls.push(['runner.execute', input]);
        }
      }
    })
  );

  await worker.processNext();

  assert.equal(calls.filter((call) => call[0] === 'runner.execute').length, 1);
});

function workerDependencies(options = {}) {
  const calls = options.calls ?? [];
  return {
    translationExecutionQueue:
      options.translationExecutionQueue ?? queue([{ executionId: 'execution-1', requestId: 'request-1' }]),
    translationRepository: options.translationRepository ?? repository({ calls }),
    translationExecutionRunner:
      options.translationExecutionRunner ??
      {
        run(input) {
          calls.push(['runner.run', input]);
        }
      },
    ...(options.durableTranslationExecutionQueueRepository !== undefined
      ? { durableTranslationExecutionQueueRepository: options.durableTranslationExecutionQueueRepository }
      : {})
  };
}

function queue(jobs = []) {
  const entries = [...jobs];

  return {
    dequeue() {
      return entries.shift();
    },
    enqueue(job) {
      entries.push(job);
    },
    isEmpty() {
      return entries.length === 0;
    },
    size() {
      return entries.length;
    }
  };
}

function durableRepository({ calls = [], updateStatus, acknowledge } = {}) {
  return {
    enqueue() {
      throw new Error('worker should not enqueue durable repository');
    },
    dequeue() {
      throw new Error('worker should not dequeue durable repository');
    },
    peek() {
      throw new Error('worker should not peek durable repository');
    },
    list() {
      throw new Error('worker should not list durable repository');
    },
    size() {
      throw new Error('worker should not read durable repository size');
    },
    clear() {
      throw new Error('worker should not clear durable repository');
    },
    updateStatus:
      updateStatus ||
      function updateStatusDefault(executionId, status) {
        calls.push(['durable.updateStatus', executionId, status]);
      },
    acknowledge:
      acknowledge ||
      function acknowledgeDefault(executionId) {
        calls.push(['durable.acknowledge', executionId]);
      },
    contains() {
      throw new Error('worker should not query durable item existence');
    },
    claim(executionId, leasedUntil) {
      calls.push(['durable.claim', executionId, leasedUntil]);
    },
    releaseExpired() { throw new Error('worker should not release leases'); },
    isLeaseExpired() { throw new Error('worker should not inspect leases'); },
    renewLease() { throw new Error('worker heartbeat should not run in synchronous tests'); }
  };
}

function repository({ calls = [], execution = translationExecution(), request = translationRequest() } = {}) {
  return Object.fromEntries(
    TRANSLATION_REPOSITORY_METHODS.map((methodName) => [
      methodName,
      function repositoryMethod(identifier) {
        if (methodName === 'findExecutionById') {
          calls.push([methodName, identifier]);
          return execution;
        }

        if (methodName === 'findRequestById') {
          calls.push([methodName, identifier]);
          return request;
        }

        throw new Error(`${methodName} should not be called by TranslationExecutionWorker.`);
      }
    ])
  );
}

function translationExecution(overrides = {}) {
  return new TranslationExecution({
    id: 'execution-1',
    translationRequestId: 'request-1',
    status: 'queued',
    startedAt: 1000,
    ...overrides
  });
}

function executionWithStatus(status) {
  return translationExecution({
    status,
    ...(status === 'completed' ? { completedAt: 1100 } : {}),
    ...(status === 'failed' ? { completedAt: 1100, failureInfo: { code: 'failed' } } : {})
  });
}

function translationRequest(overrides = {}) {
  return new TranslationRequest({
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'revision-1',
    targetLanguageCode: 'fr',
    sourceTranscriptSnapshot: {
      text: 'hello'
    },
    createdAt: 900,
    ...overrides
  });
}
