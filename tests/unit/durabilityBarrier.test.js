import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForDurabilityPromises } from '../../src/lib/durabilityBarrier.js';

test('durability barrier returns without waiting forever and leaves work running', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const result = await waitForDurabilityPromises([Promise.resolve('saved'), pending], { timeoutMs: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.settlements[0].status, 'fulfilled');
  release('eventually-saved');
  assert.equal(await pending, 'eventually-saved');
});

test('durability barrier reports all fulfilled and rejected operations', async () => {
  const result = await waitForDurabilityPromises([
    Promise.resolve('saved'),
    Promise.reject(Object.assign(new Error('503'), { status: 503 }))
  ], { timeoutMs: 50 });
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.settlements.map(({ status }) => status), ['fulfilled', 'rejected']);
});
