import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerHandler } from '../../api/internal/worker.js';

const originalCronSecret = process.env.CRON_SECRET;

test.afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(name, value); },
    end(body = '') { this.body = body; }
  };
}

test('worker rejects requests without the cron secret', async () => {
  process.env.CRON_SECRET = 'expected-secret';
  const handler = createWorkerHandler({
    getDependencies() {
      throw new Error('must not initialize dependencies');
    }
  });
  const res = response();

  await handler({ method: 'POST', headers: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized.' });
});

test('worker returns the processed result', async () => {
  process.env.CRON_SECRET = 'expected-secret';
  const calls = [];
  const handler = createWorkerHandler({
    getDependencies() {
      return {
        translationExecutionWorkerRuntime: {
          async runOnce(options) {
            calls.push(options);
            return { processed: 0, busy: false };
          }
        }
      };
    },
    runAsUser(_user, operation) {
      return operation();
    }
  });
  const res = response();

  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer expected-secret' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, processed: 0, busy: false });
  assert.deepEqual(calls, [{ limit: 3 }]);
});

test('worker expires stale Meetings in the same bounded CRON invocation', async () => {
  process.env.CRON_SECRET = 'expected-secret';
  const calls = [];
  const handler = createWorkerHandler({
    getDependencies() {
      return {
        meetingLifecycleService: {
          async expireStaleMeetings(input) {
            calls.push(['expire', input]);
            return { expired: 2 };
          }
        },
        translationExecutionWorkerRuntime: {
          async runOnce(input) {
            calls.push(['translation', input]);
            return { processed: 0, busy: false };
          }
        }
      };
    },
    runAsUser(_user, operation) {
      return operation();
    }
  });
  const res = response();

  await handler({ method: 'POST', headers: { authorization: 'Bearer expected-secret' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, processed: 0, busy: false, meetingExpiration: { expired: 2 } });
  assert.deepEqual(calls, [['expire', { limit: 3 }], ['translation', { limit: 3 }]]);
});

test('worker logs a safe diagnostic and returns 503 on execution failure', async () => {
  process.env.CRON_SECRET = 'expected-secret';
  const events = [];
  const handler = createWorkerHandler({
    getDependencies() {
      const error = new Error('Supabase request failed with GEMINI_API_KEY=AIza123456789012345678901234');
      error.code = 'supabase_request_failed';
      error.status = 503;
      throw error;
    },
    logger: { log(event) { events.push(event); } }
  });
  const res = response();

  await handler({
    method: 'POST',
    headers: {
      authorization: 'Bearer expected-secret',
      'x-vercel-id': 'iad1::invocation-123'
    }
  }, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'Worker execution failed.' });
  assert.deepEqual(events, [{
    level: 'error',
    event: 'translation_worker_failed',
    requestId: 'iad1::invocation-123',
    errorCode: 'supabase_request_failed',
    errorStatus: 503,
    errorName: 'Error',
    errorMessage: 'Supabase request failed with [REDACTED_SECRET_NAME]=[REDACTED_API_KEY]'
  }]);
});
