import assert from 'node:assert/strict';
import test from 'node:test';
import { createRolloverRecoveryCoordinator } from '../../src/lib/rolloverRecoveryCoordinator.js';

const operation = Object.freeze({
  operationId: 'rollover-1',
  payload: { meetingId: 'meeting-1', expectedLifecycleVersion: 3, nextLiveSessionId: 'live-2' }
});

test('503 reconciles before retry and reuses the exact logical operation', async () => {
  const calls = [];
  const coordinator = createRolloverRecoveryCoordinator({
    retryDelaysMs: [0],
    wait: async () => {},
    execute: async ({ operation: received, attempt }) => {
      calls.push(['execute', received.operationId, received.payload, attempt]);
      if (attempt === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
      return { segment: { id: 'segment-2' } };
    },
    reconcile: async ({ operation: received }) => {
      calls.push(['reconcile', received.operationId, received.payload]);
      return { status: 'source-active', authoritativeSegment: { id: 'segment-1' } };
    }
  });

  const result = await coordinator.run(operation);
  assert.equal(result.segment.id, 'segment-2');
  assert.deepEqual(calls.map(([name]) => name), ['execute', 'reconcile', 'execute']);
  assert.strictEqual(calls[0][2], calls[1][2]);
  assert.strictEqual(calls[0][2], calls[2][2]);
});

test('timeout after server commit reconciles without duplicate mutation', async () => {
  let executions = 0;
  const coordinator = createRolloverRecoveryCoordinator({
    retryDelaysMs: [0],
    wait: async () => {},
    execute: async () => {
      executions += 1;
      throw Object.assign(new Error('timeout'), { code: 'request_timeout', outcomeUnknown: true, status: 504 });
    },
    reconcile: async () => ({
      status: 'committed',
      authoritativeSegment: { id: 'segment-2' },
      result: { segment: { id: 'segment-2' } }
    })
  });

  const result = await coordinator.run(operation);
  assert.equal(result.segment.id, 'segment-2');
  assert.equal(executions, 1);
});

test('403 is not retried and leaves recoverable failure state', async () => {
  let reconciliations = 0;
  const coordinator = createRolloverRecoveryCoordinator({
    execute: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
    reconcile: async () => { reconciliations += 1; }
  });

  await assert.rejects(coordinator.run(operation), (error) => error.status === 403);
  assert.equal(reconciliations, 0);
  assert.equal(coordinator.getState().status, 'recoverable-failure');
});

test('concurrent calls share one request and reject payload changes for an operationId', async () => {
  let release;
  let executions = 0;
  const coordinator = createRolloverRecoveryCoordinator({
    execute: async () => {
      executions += 1;
      return new Promise((resolve) => { release = resolve; });
    },
    reconcile: async () => ({ status: 'source-active' })
  });

  const first = coordinator.run(operation);
  const duplicate = coordinator.run({ operationId: operation.operationId, payload: { ...operation.payload } });
  assert.strictEqual(first, duplicate);
  assert.throws(
    () => coordinator.run({ operationId: operation.operationId, payload: { ...operation.payload, nextLiveSessionId: 'different' } }),
    (error) => error.code === 'rollover_operation_payload_conflict'
  );
  await Promise.resolve();
  await Promise.resolve();
  release({ segment: { id: 'segment-2' } });
  await first;
  assert.equal(executions, 1);
});

test('409 reconciles committed operation but never retries blindly', async () => {
  let executions = 0;
  const coordinator = createRolloverRecoveryCoordinator({
    retryDelaysMs: [0],
    execute: async () => {
      executions += 1;
      throw Object.assign(new Error('conflict'), { status: 409, code: 'meeting_lifecycle_conflict' });
    },
    reconcile: async () => ({
      status: 'committed',
      result: { segment: { id: 'segment-2' } },
      authoritativeSegment: { id: 'segment-2' }
    })
  });

  const result = await coordinator.run(operation);
  assert.equal(result.segment.id, 'segment-2');
  assert.equal(executions, 1);
});
