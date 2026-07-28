import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSnapshotSyncCoordinator } from '../../src/lib/sessionSnapshotSyncCoordinator.js';

test('session snapshot sync coordinator coalesces scheduled syncs', async () => {
  const calls = [];
  const timers = [];
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => calls.push(sessionId),
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {}
  });

  coordinator.schedule('session-1');
  coordinator.schedule('session-1');

  assert.equal(timers.length, 1);
  assert.deepEqual(calls, []);

  timers[0]();
  await coordinator.flush();

  assert.deepEqual(calls, ['session-1']);
});

test('session snapshot sync coordinator flushes a session immediately', async () => {
  const calls = [];
  const clearedTimers = [];
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => calls.push(sessionId),
    delayMs: 5000,
    setTimeoutFn: (callback) => callback,
    clearTimeoutFn: (timer) => clearedTimers.push(timer)
  });

  coordinator.schedule('session-1');
  await coordinator.flush('session-1');

  assert.equal(clearedTimers.length, 1);
  assert.deepEqual(calls, ['session-1']);
});

test('session snapshot sync coordinator does not drop pending sessions when flushing one session', async () => {
  const calls = [];
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => calls.push(sessionId),
    setTimeoutFn: (callback) => callback,
    clearTimeoutFn: () => {}
  });

  coordinator.schedule('session-1');
  coordinator.schedule('session-2');
  await coordinator.flush('session-1');

  assert.deepEqual(calls, ['session-1', 'session-2']);
});

test('session snapshot sync coordinator reports errors and continues later syncs', async () => {
  const calls = [];
  const errors = [];
  const coordinator = createSessionSnapshotSyncCoordinator({
    syncSessionSnapshot: async (sessionId) => {
      calls.push(sessionId);
      if (sessionId === 'session-fail') {
        throw new Error('failed');
      }
    },
    onError: (error, sessionId) => errors.push({ message: error.message, sessionId }),
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  assert.equal(await coordinator.flush('session-fail'), false);
  assert.equal(await coordinator.flush('session-ok'), true);

  assert.deepEqual(calls, ['session-fail', 'session-ok']);
  assert.deepEqual(errors, [{ message: 'failed', sessionId: 'session-fail' }]);
});
