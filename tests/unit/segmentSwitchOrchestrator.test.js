import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSegmentSwitchOrchestrator,
  normalizeSegmentIntervalMs
} from '../../src/lib/segmentSwitchOrchestrator.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { createDurablePcmJournalClient } from '../../src/lib/durablePcmJournalClient.js';
import {
  LONG_MEETING_SEGMENT_INTERVAL_MS,
  LONG_MEETING_SOAK_DURATION_MS,
  LONG_MEETING_SOAK_ROLLOVER_COUNT,
  LONG_MEETING_SOAK_SEGMENT_COUNT
} from '../helpers/longMeetingScenario.js';

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
  assert.deepEqual(statuses, ['scheduled', 'switching', 'switched', 'scheduled']);
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
  assert.equal(timers.length, 3);
});

test('segment switch orchestrator remains scheduled after a failed rollover', async () => {
  const timers = createFakeTimers();
  let attempts = 0;
  const orchestrator = createSegmentSwitchOrchestrator({
    intervalMs: 10,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    switchSegment: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
    }
  });

  orchestrator.start();
  await timers.advanceBy(10);
  await timers.advanceBy(10);
  assert.equal(attempts, 2);
});

test('normalizeSegmentIntervalMs caps the production interval at 15 minutes', () => {
  assert.equal(normalizeSegmentIntervalMs(20 * 60 * 1000), 15 * 60 * 1000);
  assert.equal(normalizeSegmentIntervalMs(1000), 1000);
});

test('Supabase rollover failure preserves capture and local PCM callback', async () => {
  const journalCalls = [];
  const worker = {
    onmessage: null,
    postMessage({ id, command, args }) {
      journalCalls.push({ command, args });
      queueMicrotask(() => this.onmessage({ data: { id, ok: true,
        result: command === 'OPEN' ? { highestEpoch: 0, tailState: 'CLEAN' } : { state: 'COMMITTED' } } }));
    },
    terminate() {}
  };
  const journal = createDurablePcmJournalClient({ meetingId: 'meeting-1', recordingId: 'recording-1',
    workerFactory: () => worker });
  await journal.open();
  const failures = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en',
    onInputAudioChunk: (pcm, metadata) => journal.offer(pcm, metadata) });
  session.session = { sendRealtimeInput() {} };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  const orchestrator = createSegmentSwitchOrchestrator({
    switchSegment: async () => {
      try {
        await session.beginProviderTransition({ maxWaitMs: 5, quietPeriodMs: 0, pollIntervalMs: 1 });
        throw new Error('Supabase unavailable');
      } catch (error) {
        session.cancelProviderTransition();
        throw error;
      }
    },
    onError: (error) => failures.push(error.message),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  orchestrator.start();
  assert.equal(await orchestrator.triggerNow(), false);
  session.sendInputAudioChunk(new Uint8Array([1, 2]), session.connectionEpoch, { force: true });
  await journal.flush();
  assert.deepEqual(failures, ['Supabase unavailable']);
  assert.deepEqual(journalCalls.filter(({ command }) => command === 'APPEND')
    .map(({ args }) => [args.captureEpoch, args.startSample, args.bytes.length]), [[1, 0, 2]]);
  assert.equal(session.inputSendingEnabled, true);
  assert.equal(session.closed, false);
  orchestrator.cancel();
  await journal.close();
});

test('segment switch orchestrator simulates a 130 minute meeting with eight fifteen-minute segments', async () => {
  const timers = createFakeTimers();
  const segmentLiveSessionIds = ['live-session-1'];
  const rolloverEvents = [];
  let currentSequence = 0;

  const orchestrator = createSegmentSwitchOrchestrator({
    intervalMs: LONG_MEETING_SEGMENT_INTERVAL_MS,
    switchSegment: async () => {
      const previousSequence = currentSequence;
      currentSequence += 1;
      const nextLiveSessionId = `live-session-${currentSequence + 1}`;
      segmentLiveSessionIds.push(nextLiveSessionId);
      rolloverEvents.push({
        previousSequence,
        nextSequence: currentSequence,
        nextLiveSessionId,
        elapsedMs: timers.now()
      });
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  orchestrator.start();

  for (let index = 0; index < LONG_MEETING_SOAK_ROLLOVER_COUNT; index += 1) {
    await timers.advanceBy(LONG_MEETING_SEGMENT_INTERVAL_MS);
  }
  orchestrator.cancel();
  await timers.advanceBy(LONG_MEETING_SOAK_DURATION_MS - (LONG_MEETING_SOAK_ROLLOVER_COUNT * LONG_MEETING_SEGMENT_INTERVAL_MS));

  assert.equal(timers.now(), LONG_MEETING_SOAK_DURATION_MS);
  assert.equal(rolloverEvents.length, LONG_MEETING_SOAK_ROLLOVER_COUNT);
  assert.equal(segmentLiveSessionIds.length, LONG_MEETING_SOAK_SEGMENT_COUNT);
  assert.deepEqual(
    rolloverEvents.map((event) => event.elapsedMs),
    Array.from({ length: LONG_MEETING_SOAK_ROLLOVER_COUNT }, (_, index) => (index + 1) * LONG_MEETING_SEGMENT_INTERVAL_MS)
  );
  assert.deepEqual(
    rolloverEvents.map((event) => event.nextSequence),
    Array.from({ length: LONG_MEETING_SOAK_ROLLOVER_COUNT }, (_, index) => index + 1)
  );
  assert.equal(new Set(segmentLiveSessionIds).size, LONG_MEETING_SOAK_SEGMENT_COUNT);
});

function createFakeTimers() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    now() {
      return nowMs;
    },
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, {
        callback,
        dueAt: nowMs + delayMs
      });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advanceBy(delayMs) {
      const target = nowMs + delayMs;
      while (true) {
        const next = nextDueTimer(timers, target);
        if (!next) break;
        nowMs = next.dueAt;
        timers.delete(next.id);
        next.callback();
        await Promise.resolve();
      }
      nowMs = target;
      await Promise.resolve();
    }
  };
}

function nextDueTimer(timers, target) {
  return Array.from(timers.entries())
    .map(([id, timer]) => ({ id, ...timer }))
    .filter((timer) => timer.dueAt <= target)
    .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0] || null;
}
