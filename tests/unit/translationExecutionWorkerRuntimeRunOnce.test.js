import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionWorkerRuntime } from '../../src/infrastructure/translationExecutionWorkerRuntime.js';

test('runOnce replays and processes a bounded durable batch', async () => {
  const jobs = [];
  const processed = [];
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionQueue: {
      enqueue(job) {
        jobs.push(job);
      },
      dequeue() {
        return jobs.shift() || null;
      },
      size() {
        return jobs.length;
      }
    },
    translationExecutionWorker: {
      async processNext() {
        processed.push(jobs.shift());
      }
    },
    durableRepository: {
      async listAvailable() {
        return [
          { executionId: 'execution-1', requestId: 'request-1', ownerUserId: 'owner-1' },
          { executionId: 'execution-2', requestId: 'request-2', ownerUserId: 'owner-1' }
        ];
      },
      async nextAvailableAt() {
        return null;
      }
    }
  });

  const result = await runtime.runOnce({ limit: 1 });

  assert.deepEqual(result, { processed: 1, busy: false });
  assert.deepEqual(processed, [{ executionId: 'execution-1', requestId: 'request-1', ownerUserId: 'owner-1' }]);
});

test('runOnce rejects an unbounded or invalid batch size', async () => {
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionQueue: { enqueue() {}, dequeue() { return null; }, size() { return 0; } },
    translationExecutionWorker: { async processNext() {} }
  });

  await assert.rejects(() => runtime.runOnce({ limit: 0 }), TypeError);
  await assert.rejects(() => runtime.runOnce({ limit: 1.5 }), TypeError);
});
