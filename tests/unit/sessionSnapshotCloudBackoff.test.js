import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSnapshotSyncCoordinator } from '../../src/lib/sessionSnapshotSyncCoordinator.js';

test('session snapshot coordinator stops scheduled retries after cloud 503', async () => {
  const calls = [];
  const timers = [];
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => {
      calls.push(sessionId);
      const error = new Error('cloud unavailable');
      error.status = 503;
      throw error;
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {}
  });

  coordinator.schedule('session-1');
  timers.shift()();
  await coordinator.flush();

  coordinator.schedule('session-1');
  assert.equal(timers.length, 0);
  assert.deepEqual(calls, ['session-1']);
});

test('explicit snapshot flush can retry a cloud-blocked session', async () => {
  const calls = [];
  let fail = true;
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => {
      calls.push(sessionId);
      if (fail) {
        fail = false;
        const error = new Error('cloud unavailable');
        error.status = 503;
        throw error;
      }
    },
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  coordinator.schedule('session-1');
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.retry('session-1'), true);
  assert.deepEqual(calls, ['session-1', 'session-1']);
});

test('ordinary snapshot flush does not retry a cloud-blocked session', async () => {
  const calls = [];
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => {
      calls.push(sessionId);
      const error = new Error('cloud unavailable');
      error.status = 503;
      throw error;
    },
    setTimeoutFn: (callback) => callback,
    clearTimeoutFn: () => {}
  });

  coordinator.schedule('session-1');
  await coordinator.flush();
  assert.equal(await coordinator.flush('session-1'), false);
  assert.deepEqual(calls, ['session-1']);
});
