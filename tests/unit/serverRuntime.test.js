import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
  createProductionApplicationDependencies
} from '../../server/compositionRoot.js';
import {
  enqueuePersistedQueuedTranslationExecutions,
  selectDefaultApplicationDependenciesFactory,
  startTranslationExecutionWorkerRuntime
} from '../../server/index.js';

test('default server uses production dependencies when Gemini API key is configured', () => {
  assert.strictEqual(
    selectDefaultApplicationDependenciesFactory({ env: { GEMINI_API_KEY: 'test-key' } }),
    createProductionApplicationDependencies
  );
  assert.strictEqual(
    selectDefaultApplicationDependenciesFactory({ env: { NODE_ENV: 'production' } }),
    createProductionApplicationDependencies
  );
  assert.strictEqual(
    selectDefaultApplicationDependenciesFactory({ env: {} }),
    createApplicationDependencies
  );
});

test('translation execution worker runtime starts once and stops idempotently', async () => {
  const calls = [];
  const stop = startTranslationExecutionWorkerRuntime({
    sessionRepository: emptySessionRepository(),
    translationExecutionQueue: noopQueue(),
    translationExecutionWorkerRuntime: {
      start() {
        calls.push('start');
      },
      stop() {
        calls.push('stop');
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  stop();

  assert.deepEqual(calls, ['start', 'stop']);
});

test('translation execution worker runtime restores persisted queued executions before start', async () => {
  const calls = [];
  startTranslationExecutionWorkerRuntime({
    sessionRepository: sessionRepositoryWithTranslationState({
      requests: [{ id: 'request-1' }, { id: 'request-completed' }, { id: 'request-failed' }],
      executions: [
        { id: 'execution-1', translationRequestId: 'request-1', status: 'queued' },
        { id: 'execution-completed', translationRequestId: 'request-completed', status: 'completed' },
        { id: 'execution-failed', translationRequestId: 'request-failed', status: 'failed' }
      ],
      outputs: []
    }),
    translationExecutionQueue: {
      enqueue(job) {
        calls.push(['enqueue', job]);
      }
    },
    translationExecutionWorkerRuntime: {
      start() {
        calls.push(['start']);
      },
      stop() {}
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    ['enqueue', { executionId: 'execution-1', requestId: 'request-1' }],
    ['start']
  ]);
});

test('persisted queue recovery skips completed outputs and executions without source requests', async () => {
  const jobs = [];
  const recoveredCount = await enqueuePersistedQueuedTranslationExecutions({
    sessionRepository: sessionRepositoryWithTranslationState({
      requests: [{ id: 'request-1' }],
      executions: [
        { id: 'execution-1', translationRequestId: 'request-1', status: 'queued' },
        { id: 'execution-with-output', translationRequestId: 'request-1', status: 'queued' },
        { id: 'execution-missing-request', translationRequestId: 'missing-request', status: 'queued' }
      ],
      outputs: [{ id: 'output-1', executionId: 'execution-with-output' }]
    }),
    translationExecutionQueue: {
      enqueue(job) {
        jobs.push(job);
      }
    }
  });

  assert.equal(recoveredCount, 1);
  assert.deepEqual(jobs, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('translation execution worker runtime start failures are logged safely', async () => {
  const logs = [];
  startTranslationExecutionWorkerRuntime({
    sessionRepository: emptySessionRepository(),
    translationExecutionQueue: noopQueue(),
    translationExecutionWorkerRuntime: {
      async start() {
        throw new Error('secret provider failure');
      },
      stop() {}
    },
    logger(event) {
      logs.push(event);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(logs, [{
    level: 'error',
    event: 'translation_execution_worker_runtime_start_failed',
    errorName: 'Error',
    safeSummary: 'Translation execution worker runtime failed'
  }]);
});

function sessionRepositoryWithTranslationState(translationCommandState) {
  return {
    async listSessionRecords() {
      return [{
        id: 'session-1',
        translationCommandState
      }];
    }
  };
}

function emptySessionRepository() {
  return sessionRepositoryWithTranslationState({
    requests: [],
    executions: [],
    outputs: []
  });
}

function noopQueue() {
  return {
    enqueue() {}
  };
}
