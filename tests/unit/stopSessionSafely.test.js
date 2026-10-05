import assert from 'node:assert/strict';
import test from 'node:test';
import { stopSessionSafely } from '../../src/lib/stopSessionSafely.js';

test('stopSessionSafely accepts an absent session', async () => {
  assert.equal(await stopSessionSafely(undefined), false);
});

test('stopSessionSafely absorbs synchronous and asynchronous stop failures', async () => {
  assert.equal(await stopSessionSafely({ stop() { throw new Error('sync failure'); } }), false);
  assert.equal(await stopSessionSafely({ stop: async () => { throw new Error('async failure'); } }), false);
});

test('stopSessionSafely reports a successful stop', async () => {
  let stopped = 0;
  assert.equal(await stopSessionSafely({ stop: async () => { stopped += 1; } }), true);
  assert.equal(stopped, 1);
});
