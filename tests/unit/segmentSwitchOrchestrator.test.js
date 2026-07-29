import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSegmentSwitchOrchestrator,
  normalizeSegmentIntervalMs
} from '../../src/lib/segmentSwitchOrchestrator.js';

test('segment switch orchestrator triggers scheduled segment switches', async () => {
  const timers = [];
  const statuses = [];
  let switches = 0;
  const orchestrator = createSegmentSwitchOrchestrator({
    intervalMs: 10,
    switchSegment: async () => {
      switches += 1;
    },
    setTimeoutFn: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return callback;
    },
    clearTimeoutFn: () => {},
    onStatusChange: (status) => statuses.push(status)
  });

  orchestrator.start();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 10);
  await orchestrator.triggerNow();

  assert.equal(switches, 1);
  assert.deepEqual(statuses, ['switching', 'switched']);
  assert.equal(timers.length, 2);
});

test('segment switch orchestrator cancels pending switches and reports failures', async () => {
  const timers = [];
  const errors = [];
  const cancelled = createSegmentSwitchOrchestrator({
    intervalMs: 10,
    switchSegment: async () => {
      throw new Error('should not run');
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {}
  });

  cancelled.start();
  cancelled.cancel();
  timers[0]();

  const failing = createSegmentSwitchOrchestrator({
    intervalMs: 10,
    switchSegment: async () => {
      throw new Error('switch failed');
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {},
    onError: (error) => errors.push(error.message)
  });

  failing.start();
  await failing.triggerNow();

  assert.deepEqual(errors, ['switch failed']);
});

test('normalizeSegmentIntervalMs caps the production interval at 15 minutes', () => {
  assert.equal(normalizeSegmentIntervalMs(20 * 60 * 1000), 15 * 60 * 1000);
  assert.equal(normalizeSegmentIntervalMs(1000), 1000);
});
