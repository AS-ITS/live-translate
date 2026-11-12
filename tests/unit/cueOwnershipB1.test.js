import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleGenAI } from '@google/genai';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { applySubtitleCueEvent, createSubtitleCueState, finalizePendingSubtitleCue } from '../../src/lib/subtitleCues.js';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';

const activeSessions = [];
test.afterEach(async () => {
  await Promise.all(activeSessions.splice(0).map((session) => session.cleanup({ closeSession: true })));
});

async function withProviderConnections(run) {
  const probe = new GoogleGenAI({ apiKey: 'test-token' });
  const livePrototype = Object.getPrototypeOf(probe.live);
  const originalConnect = livePrototype.connect;
  const connections = [];
  livePrototype.connect = async ({ callbacks }) => {
    const sent = [];
    const connection = {
      callbacks,
      sent,
      closed: false,
      sendRealtimeInput(payload) { sent.push(payload); },
      close() { this.closed = true; }
    };
    connections.push(connection);
    return connection;
  };
  try {
    await run(connections);
  } finally {
    livePrototype.connect = originalConnect;
  }
}

function cuePipeline({ segmentId = 's2', useRealDrain = false } = {}) {
  let state = createSubtitleCueState();
  const events = [];
  const session = new LiveTranslateSession({
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    liveSessionId: 'live-2',
    segmentId,
    targetLanguageCode: 'en',
    sessionClock: () => 100,
    onCueEvent(event) {
      events.push(event);
      // A mutable active Segment must not supply missing event ownership.
      state = applySubtitleCueEvent(state, event, { sessionId: 'session-1', segmentId: 's3', sessionClock: () => 100 });
    }
  });
  session.getTokenResponse = async () => ({ token: 'test-token', liveConnectConfig: {} });
  session.waitForSetupComplete = async () => true;
  session.attachAudioCaptureAfterSetup = async () => true;
  if (!useRealDrain) session.drainPreRoll = () => true;
  activeSessions.push(session);
  return {
    session,
    events,
    finalize() { state = finalizePendingSubtitleCue(state, { sessionTimeMs: 100, reason: 'segment-rollover' }); },
    get state() { return state; }
  };
}

function providerCue(connection, id, text) {
  connection.callbacks.onmessage({
    eventId: id,
    serverContent: { inputTranscription: { text }, turnComplete: true }
  });
}

function coordinatorFor(segmentId) {
  const payloads = [];
  const errors = [];
  const statuses = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => { payloads.push(payload); },
    onError: (error) => errors.push(error),
    onStatusChange: (status) => statuses.push(status),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId });
  return { coordinator, payloads, errors, statuses };
}

test('provider callback owns normal s2 Cue and late s2 Cue after s3 activation', async () => {
  await withProviderConnections(async (connections) => {
    const pipeline = cuePipeline();
    await pipeline.session.connectProvider();
    providerCue(connections[0], 's2-first', 'first');
    pipeline.finalize();
    assert.equal(pipeline.state.finalCues[0].segmentId, 's2');

    const reconnect = pipeline.session.reconnectProvider({ segmentId: 's3', liveSessionId: 'live-3' });
    // reconnectProvider changes mutable context before it closes the old socket.
    providerCue(connections[0], 's2-late', 'late s2');
    pipeline.finalize();
    assert.equal(pipeline.events.at(-1).segmentId, 's2');
    assert.equal(pipeline.state.finalCues.at(-1).segmentId, 's2');

    await reconnect;
    assert.equal(connections[0].closed, true);
    providerCue(connections[0], 'stale-s2', 'stale');
    assert.equal(pipeline.events.some((event) => event.providerEventId === 'stale-s2'), false);
    providerCue(connections[1], 's3-first', 'new segment');
    pipeline.finalize();
    assert.equal(pipeline.events.at(-1).segmentId, 's3');
  });
});

test('unknown source ownership stays unassigned through Cue normalization', async () => {
  await withProviderConnections(async (connections) => {
    const pipeline = cuePipeline({ segmentId: null });
    await pipeline.session.connectProvider();
    pipeline.session.segmentId = 's3';
    providerCue(connections[0], 'unknown-1', 'unowned');
    pipeline.finalize();
    assert.equal(pipeline.events[0].segmentId, null);
    assert.equal(pipeline.state.finalCues[0].segmentId, null);
  });
});

test('partial s2 Cue keeps its identity when final s2 revision arrives during s3 rollover', async () => {
  await withProviderConnections(async (connections) => {
    const pipeline = cuePipeline();
    await pipeline.session.connectProvider();
    connections[0].callbacks.onmessage({
      eventId: 'partial-s2',
      serverContent: { inputTranscription: { text: 'partial' } }
    });
    const originalCueId = pipeline.state.currentCue.cueId;
    const reconnect = pipeline.session.reconnectProvider({ segmentId: 's3', liveSessionId: 'live-3' });
    providerCue(connections[0], 'final-s2', 'partial complete');
    pipeline.finalize();
    await reconnect;
    assert.equal(pipeline.state.finalCues[0].cueId, originalCueId);
    assert.equal(pipeline.state.finalCues[0].segmentId, 's2');
    assert.equal(pipeline.state.finalCues[0].sourceText, 'partial complete');
  });
});

test('callback source binding survives mutable Segment context drift', async () => {
  await withProviderConnections(async (connections) => {
    const pipeline = cuePipeline();
    await pipeline.session.connectProvider();
    pipeline.session.segmentId = 's3';
    pipeline.session.liveSessionId = 'live-3';
    providerCue(connections[0], 'still-s2', 'old source');
    pipeline.finalize();
    assert.equal(pipeline.events[0].segmentId, 's2');
    assert.equal(pipeline.events[0].liveSessionId, 'live-2');
    assert.equal(pipeline.state.finalCues[0].segmentId, 's2');
  });
});

test('s3 Checkpoint reports rejected Cues and accepts only valid s3 Cues', async () => {
  const { coordinator, payloads, errors, statuses } = coordinatorFor('s3');
  const s2 = { cueId: 'cue-s2', sessionId: 'session-1', segmentId: 's2', sequence: 1, status: 'final' };
  const s3 = { ...s2, cueId: 'cue-s3', segmentId: 's3', sequence: 2 };
  const unknown = { ...s2, cueId: 'cue-unknown', segmentId: null, sequence: 3 };

  const result = coordinator.enqueueCues([s2, s3]);
  assert.deepEqual(result, { acceptedCueIds: ['cue-s3'], rejectedCueIds: ['cue-s2'] });
  assert.throws(() => coordinator.enqueueCues([unknown]), { code: 'cue_segment_unassigned' });
  assert.equal(errors.length, 2);
  assert.equal(statuses.at(-1), 'error');
  await coordinator.flush();
  assert.deepEqual(payloads[0].finalCues.map((cue) => cue.cueId), ['cue-s3']);
  assert.equal(statuses.at(-1), 'error');
});

test('s2 provider output cannot enter s3 Checkpoint after rollover', async () => {
  await withProviderConnections(async (connections) => {
    const pipeline = cuePipeline();
    await pipeline.session.connectProvider();
    const reconnect = pipeline.session.reconnectProvider({ segmentId: 's3', liveSessionId: 'live-3' });
    providerCue(connections[0], 'late-s2', 'old segment');
    pipeline.finalize();
    await reconnect;
    providerCue(connections[1], 'new-s3', 'new segment');
    pipeline.finalize();

    const { coordinator, payloads } = coordinatorFor('s3');
    const result = coordinator.enqueueCues(pipeline.state.finalCues);
    assert.equal(result.rejectedCueIds.length, 1);
    await coordinator.flush();
    assert.ok(payloads[0].finalCues.every((cue) => cue.segmentId === 's3'));
    assert.ok(pipeline.state.finalCues.some((cue) => cue.segmentId === 's2'));
  });
});

test('provider transition buffers new PCM for the new connection, never the old one', async () => {
  await withProviderConnections(async (connections) => {
    const pipeline = cuePipeline({ useRealDrain: true });
    await pipeline.session.connectProvider();
    pipeline.session.captureEnabled = true;
    pipeline.session.chunker = { flush: () => [], reset() {} };
    const transition = pipeline.session.beginProviderTransition({ maxWaitMs: 50, quietPeriodMs: 0, pollIntervalMs: 1 });
    providerCue(connections[0], 's2-boundary', 'old input');
    await transition;
    const oldSendCount = connections[0].sent.length;
    pipeline.session.sendInputAudioChunk(new Uint8Array([1, 2]), pipeline.session.connectionEpoch);
    assert.equal(connections[0].sent.length, oldSendCount);
    assert.equal(pipeline.session.pendingInputAudioChunks.length, 1);

    await pipeline.session.reconnectProvider({ segmentId: 's3', liveSessionId: 'live-3' });
    assert.equal(connections[0].sent.length, oldSendCount);
    assert.equal(connections[1].sent.filter((payload) => payload.audio?.data).length, 1);
    assert.equal(pipeline.session.pendingInputAudioChunks.length, 0);
  });
});
