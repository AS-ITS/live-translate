import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyConnectionFailure } from '../../src/lib/connectionFailures.js';
import { createReconnectController } from '../../src/lib/reconnectController.js';

test('initial state is idle with generation zero', () => {
  const controller = createReconnectController({ timer: createFakeTimer() });

  assert.equal(controller.currentState(), 'idle');
  assert.equal(controller.currentGeneration(), 0);
});

test('schedule reconnect runs cleanup then creates pending schedule', async () => {
  const events = [];
  const timer = createFakeTimer(events);
  const controller = createReconnectController({
    timer,
    cleanup: () => events.push('cleanup')
  });

  const result = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));

  assert.deepEqual(events, ['cleanup', 'set:750']);
  assert.equal(result.scheduled, true);
  assert.equal(result.decision.shouldRetry, true);
  assert.equal(result.decision.delayMs, 750);
  assert.equal(controller.currentState(), 'scheduled');
  assert.equal(timer.pendingCount(), 1);
});

test('retry decision is respected for non-retryable failures', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  const result = await controller.scheduleReconnect(classifyConnectionFailure('auth_failed'));

  assert.equal(result.scheduled, false);
  assert.equal(result.decision.shouldRetry, false);
  assert.equal(result.decision.stopReason, 'auth_failed');
  assert.equal(controller.currentState(), 'completed');
  assert.equal(timer.pendingCount(), 0);
});

test('generation increments for new reconnect lifecycles', async () => {
  const controller = createReconnectController({ timer: createFakeTimer() });

  const first = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  controller.stop();
  const second = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));

  assert.equal(first.generationId, 1);
  assert.equal(second.generationId, 3);
  assert.equal(controller.currentGeneration(), 3);
});

test('stale timer callback is ignored', async () => {
  const timer = createFakeTimer();
  let executionCount = 0;
  const controller = createReconnectController({ timer });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const staleCallback = timer.pendingCallbacks()[0];

  controller.cancel();
  await staleCallback();

  assert.equal(controller.currentState(), 'cancelled');
  assert.equal(controller.currentGeneration(), 2);
  assert.equal(executionCount, 0);
});

test('cancel clears pending schedule', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const snapshot = controller.cancel();

  assert.equal(snapshot.state, 'cancelled');
  assert.equal(controller.currentState(), 'cancelled');
  assert.equal(timer.pendingCount(), 0);
});

test('cancel prevents future reconnect scheduling', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  controller.cancel();
  const result = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));

  assert.equal(result.ignored, true);
  assert.equal(controller.currentState(), 'cancelled');
  assert.equal(timer.pendingCount(), 0);
});

test('stop transitions pending reconnect to completed', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const snapshot = controller.stop();

  assert.equal(snapshot.state, 'completed');
  assert.equal(controller.currentState(), 'completed');
  assert.equal(timer.pendingCount(), 0);
});

test('reset clears state and pending schedule', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const scheduledGeneration = controller.currentGeneration();
  const snapshot = controller.reset();

  assert.equal(snapshot.state, 'idle');
  assert.equal(controller.currentState(), 'idle');
  assert.equal(controller.currentGeneration(), scheduledGeneration + 1);
  assert.equal(timer.pendingCount(), 0);
});

test('only one pending reconnect is allowed', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  const first = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const second = await controller.scheduleReconnect(classifyConnectionFailure('network_timeout'));

  assert.equal(first.scheduled, true);
  assert.equal(second.ignored, true);
  assert.equal(timer.pendingCount(), 1);
  assert.equal(controller.currentState(), 'scheduled');
});

test('duplicate schedule is ignored while cleanup is running', async () => {
  const timer = createFakeTimer();
  let resolveCleanup;
  const cleanupDone = new Promise((resolve) => {
    resolveCleanup = resolve;
  });
  const controller = createReconnectController({
    timer,
    cleanup: () => cleanupDone
  });

  const first = controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const second = await controller.scheduleReconnect(classifyConnectionFailure('network_timeout'));
  resolveCleanup();
  const firstResult = await first;

  assert.equal(second.ignored, true);
  assert.equal(firstResult.scheduled, true);
  assert.equal(timer.pendingCount(), 1);
});

test('retry exhaustion completes without scheduling another timer', async () => {
  const timer = createFakeTimer();
  let executionCount = 0;
  const controller = createReconnectController({
    timer,
    retryOptions: { maxAttempts: 1 },
    executeReconnect: () => {
      executionCount += 1;
    }
  });

  const first = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  await timer.run(first.generationId);
  const second = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));

  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, false);
  assert.equal(second.decision.shouldRetry, false);
  assert.equal(second.decision.stopReason, 'max_attempts_exceeded');
  assert.equal(controller.currentState(), 'completed');
  assert.equal(timer.pendingCount(), 0);
  assert.equal(executionCount, 1);
});

test('execution hook runs after scheduled retry delay', async () => {
  const events = [];
  const timer = createFakeTimer(events);
  const controller = createReconnectController({
    timer,
    executeReconnect: () => events.push('execute')
  });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));

  assert.deepEqual(events, ['set:750']);
  await timer.run();

  assert.deepEqual(events, ['set:750', 'execute']);
  assert.equal(controller.currentState(), 'completed');
});

test('execution hook receives classification decision and generationId', async () => {
  const timer = createFakeTimer();
  const classification = classifyConnectionFailure('unexpected_close');
  let payload;
  const controller = createReconnectController({
    timer,
    executeReconnect: (nextPayload) => {
      payload = nextPayload;
    }
  });

  const result = await controller.scheduleReconnect(classification);
  await timer.run();

  assert.equal(payload.classification, classification);
  assert.equal(payload.decision, result.decision);
  assert.equal(payload.generationId, result.generationId);
});

test('cancel before timer prevents execution hook', async () => {
  const timer = createFakeTimer();
  let executionCount = 0;
  const controller = createReconnectController({
    timer,
    executeReconnect: () => {
      executionCount += 1;
    }
  });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const callback = timer.pendingCallbacks()[0];
  controller.cancel();
  await callback();

  assert.equal(executionCount, 0);
  assert.equal(controller.currentState(), 'cancelled');
});

test('stale timer callback does not execute hook', async () => {
  const timer = createFakeTimer();
  let executionCount = 0;
  const controller = createReconnectController({
    timer,
    executeReconnect: () => {
      executionCount += 1;
    }
  });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const callback = timer.pendingCallbacks()[0];
  controller.reset();
  await callback();

  assert.equal(executionCount, 0);
  assert.equal(controller.currentState(), 'idle');
});

test('duplicate schedule creates only one pending execution', async () => {
  const timer = createFakeTimer();
  let executionCount = 0;
  const controller = createReconnectController({
    timer,
    executeReconnect: () => {
      executionCount += 1;
    }
  });

  const first = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const second = await controller.scheduleReconnect(classifyConnectionFailure('provider_error'));
  await timer.run();

  assert.equal(first.scheduled, true);
  assert.equal(second.ignored, true);
  assert.equal(executionCount, 1);
});

test('retry exhausted does not execute hook', async () => {
  const timer = createFakeTimer();
  let executionCount = 0;
  const controller = createReconnectController({
    timer,
    retryOptions: { maxAttempts: 1 },
    executeReconnect: () => {
      executionCount += 1;
    }
  });

  const first = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  await timer.run(first.generationId);
  const exhausted = await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));

  assert.equal(exhausted.scheduled, false);
  assert.equal(exhausted.decision.stopReason, 'max_attempts_exceeded');
  assert.equal(timer.pendingCount(), 0);
  assert.equal(executionCount, 1);
});

test('executeReconnect throw is handled safely', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({
    timer,
    executeReconnect: async () => {
      throw new Error('test execution failure');
    }
  });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  await assert.doesNotReject(() => timer.run());

  assert.equal(controller.currentState(), 'completed');
});

test('controller state transitions through scheduled running and completed', async () => {
  const timer = createFakeTimer();
  const states = [];
  const controller = createReconnectController({
    timer,
    executeReconnect: () => {
      states.push(controller.currentState());
    }
  });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  states.push(controller.currentState());
  await timer.run();
  states.push(controller.currentState());

  assert.deepEqual(states, ['scheduled', 'running', 'completed']);
});

test('cancel during running prevents later state overwrite', async () => {
  const timer = createFakeTimer();
  let resolveExecution;
  const executionDone = new Promise((resolve) => {
    resolveExecution = resolve;
  });
  const controller = createReconnectController({
    timer,
    executeReconnect: () => {
      controller.cancel();
      return executionDone;
    }
  });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  const runPromise = timer.run();
  resolveExecution();
  await runPromise;

  assert.equal(controller.currentState(), 'cancelled');
});

function createFakeTimer(events = []) {
  let nextId = 1;
  const pending = new Map();

  return {
    set(callback, delayMs) {
      const handle = { id: nextId++ };
      pending.set(handle.id, { callback, delayMs });
      events.push(`set:${delayMs}`);
      return handle;
    },
    clear(handle) {
      if (handle) {
        pending.delete(handle.id);
      }
    },
    pendingCount() {
      return pending.size;
    },
    pendingCallbacks() {
      return [...pending.values()].map((entry) => entry.callback);
    },
    async run(id) {
      const entry = pending.get(id) || pending.values().next().value;
      if (!entry) {
        return;
      }
      for (const [pendingId, pendingEntry] of pending.entries()) {
        if (pendingEntry === entry) {
          pending.delete(pendingId);
          break;
        }
      }
      return entry.callback();
    }
  };
}
