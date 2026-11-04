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
import { createCloudFoundationHandler } from '../../server/cloudFoundation.js';

test('cloud foundation handler is health-only and reports readiness from Supabase configuration', async () => {
  const handler = createCloudFoundationHandler({ env: {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'secret',
    SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
  } });
  const health = await request(handler, { method: 'GET', url: '/healthz' });
  const ready = await request(handler, { method: 'GET', url: '/api/readyz' });
  const unavailable = await request(handler, { method: 'POST', url: '/api/sessions' });

  assert.equal(health.statusCode, 200);
  assert.equal(ready.statusCode, 200);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json.error.code, 'cloud_capability_unavailable');
});

test('cloud foundation readiness stays unavailable without Supabase configuration', async () => {
  const handler = createCloudFoundationHandler({ env: {} });
  const ready = await request(handler, { method: 'GET', url: '/readyz' });

  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json.ok, false);
});

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
  assert.strictEqual(
    selectDefaultApplicationDependenciesFactory({ env: {
      LOCAL_SUPABASE_MODE: 'true', SUPABASE_URL: 'http://127.0.0.1:55421', SUPABASE_SECRET_KEY: 'local-key'
    } }),
    createProductionApplicationDependencies
  );
  assert.strictEqual(
    selectDefaultApplicationDependenciesFactory({ env: {
      LOCAL_SUPABASE_MODE: 'true', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'remote-key'
    } }),
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

test('request-scoped session repositories skip startup queue recovery', async () => {
  const calls = [];
  startTranslationExecutionWorkerRuntime({
    sessionRepository: {
      requiresRequestIdentity: true,
      async listSessionRecords() {
        throw new Error('startup must not read owner-scoped records');
      }
    },
    translationExecutionQueue: noopQueue(),
    translationExecutionWorkerRuntime: {
      async start() {
        calls.push('start');
      },
      stop() {}
    },
    logger(event) {
      calls.push(event.event);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['start']);
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

function request(handler, { method, url }) {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    }
  };
  return Promise.resolve(handler({ method, url, headers: {} }, response)).then(() => ({
    ...response,
    json: JSON.parse(response.body || '{}')
  }));
}
