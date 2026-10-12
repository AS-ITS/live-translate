import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderRecoveryCoordinator } from '../../src/lib/providerRecoveryCoordinator.js';

test('provider recovery makes exactly three fenced attempts before exhaustion', async () => {
  const attempts = [];
  const states = [];
  const coordinator = createProviderRecoveryCoordinator({
    retryDelaysMs: [0, 0, 0],
    wait: async () => {},
    execute: async ({ operation, attempt, generation }) => {
      attempts.push({ operationId: operation.operationId, attempt, generation });
      throw Object.assign(new Error('provider unavailable'), { code: 'provider_unavailable' });
    },
    onStateChange: (state) => states.push(state.status)
  });

  const result = await coordinator.run({ operationId: 'recovery-1', segmentId: 'segment-2' });
  assert.equal(result.status, 'exhausted');
  assert.deepEqual(attempts.map((item) => item.attempt), [1, 2, 3]);
  assert.equal(new Set(attempts.map((item) => item.generation)).size, 1);
  assert.deepEqual(states, ['recovering', 'recovering', 'recovering', 'exhausted']);
});

test('provider recovery stops after ready and shares duplicate operation calls', async () => {
  let release;
  let attempts = 0;
  const coordinator = createProviderRecoveryCoordinator({
    retryDelaysMs: [0, 0, 0],
    wait: async () => {},
    execute: async () => {
      attempts += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  });
  const operation = { operationId: 'recovery-1', segmentId: 'segment-2' };
  const first = coordinator.run(operation);
  const duplicate = coordinator.run({ ...operation });
  assert.strictEqual(first, duplicate);
  await Promise.resolve();
  release(true);
  const result = await first;
  assert.equal(result.status, 'ready');
  assert.equal(attempts, 1);
});

test('manual retry uses a new operation after exhausted recovery', async () => {
  let available = false;
  const operations = [];
  const coordinator = createProviderRecoveryCoordinator({
    retryDelaysMs: [0, 0, 0],
    wait: async () => {},
    execute: async ({ operation }) => {
      operations.push(operation.operationId);
      return available;
    }
  });
  assert.equal((await coordinator.run({ operationId: 'automatic-1' })).status, 'exhausted');
  available = true;
  assert.equal((await coordinator.run({ operationId: 'manual-2', manual: true })).status, 'ready');
  assert.deepEqual(operations, ['automatic-1', 'automatic-1', 'automatic-1', 'manual-2']);
});

test('cancel fences late provider readiness and allows a later operation', async () => {
  let release;
  const coordinator = createProviderRecoveryCoordinator({
    retryDelaysMs: [0, 0, 0],
    wait: async () => {},
    execute: async () => new Promise((resolve) => { release = resolve; })
  });
  const pending = coordinator.run({ operationId: 'recovery-1' });
  await Promise.resolve();
  coordinator.cancel('pause');
  release(true);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(coordinator.getState().reason, 'pause');
});
