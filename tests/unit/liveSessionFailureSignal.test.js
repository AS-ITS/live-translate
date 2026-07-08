import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyConnectionFailure } from '../../src/lib/connectionFailures.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { createReconnectController } from '../../src/lib/reconnectController.js';

test('unexpected close triggers connection failure after cleanup', async () => {
  const events = [];
  const failures = [];
  const session = createTestSession({
    events,
    onConnectionFailure: (failure) => {
      events.push('failure');
      failures.push(failure);
    },
    onError: () => events.push('error')
  });

  await session.handleSessionClose({ reason: 'provider closed', code: 1011 });

  assert.deepEqual(events, ['cleanup', 'failure', 'error']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 'unexpected_close');
  assert.equal(failures[0].reasonHint, 'unexpected_close');
  assert.equal(failures[0].afterCleanup, true);
  assert.deepEqual(failures[0].rawEvent, { reason: 'provider closed', code: 1011 });
});

test('expected user stop does not trigger connection failure', async () => {
  const events = [];
  let failureCount = 0;
  const session = createTestSession({
    events,
    onConnectionFailure: () => {
      failureCount += 1;
    },
    onClose: () => events.push('close')
  });

  await session.stop();

  assert.deepEqual(events, ['cleanup', 'close']);
  assert.equal(failureCount, 0);
});

test('live error triggers connection failure after cleanup', async () => {
  const events = [];
  const failures = [];
  const error = new Error('provider failed');
  const session = createTestSession({
    events,
    onConnectionFailure: (failure) => {
      events.push('failure');
      failures.push(failure);
    },
    onError: () => events.push('error')
  });

  await session.handleSessionError(error);

  assert.deepEqual(events, ['cleanup', 'failure', 'error']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 'live_error');
  assert.equal(failures[0].reasonHint, 'provider_error');
  assert.equal(failures[0].rawError, error);
  assert.equal(failures[0].rawEvent, error);
  assert.equal(failures[0].afterCleanup, true);
});

test('connection failure payload includes afterCleanup true', async () => {
  let failurePayload;
  const session = createTestSession({
    onConnectionFailure: (failure) => {
      failurePayload = failure;
    }
  });

  await session.handleSessionClose({ reason: 'closed' });

  assert.equal(failurePayload.afterCleanup, true);
});

test('user stop cancels reconnect controller schedule', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  controller.cancel();

  assert.equal(controller.currentState(), 'cancelled');
  assert.equal(timer.pendingCount(), 0);
});

test('duplicate failure signals do not create duplicate pending schedules', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });
  const handleFailure = (failure) => {
    const classification = classifyConnectionFailure({
      reason: failure.reasonHint,
      error: failure.rawError,
      context: failure.source
    });
    return controller.scheduleReconnect(classification);
  };

  const first = await handleFailure({ reasonHint: 'unexpected_close', source: 'unexpected_close' });
  const second = await handleFailure({ reasonHint: 'provider_error', source: 'live_error' });

  assert.equal(first.scheduled, true);
  assert.equal(second.ignored, true);
  assert.equal(timer.pendingCount(), 1);
});

function createTestSession({ events = [], onConnectionFailure, onError, onClose } = {}) {
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onConnectionFailure,
    onError,
    onClose
  });

  session.cleanup = async () => {
    events.push('cleanup');
  };

  return session;
}

function createFakeTimer() {
  let nextId = 1;
  const pending = new Map();

  return {
    set(callback, delayMs) {
      const handle = { id: nextId++ };
      pending.set(handle.id, { callback, delayMs });
      return handle;
    },
    clear(handle) {
      if (handle) {
        pending.delete(handle.id);
      }
    },
    pendingCount() {
      return pending.size;
    }
  };
}
