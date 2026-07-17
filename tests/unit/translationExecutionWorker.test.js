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
      }
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
