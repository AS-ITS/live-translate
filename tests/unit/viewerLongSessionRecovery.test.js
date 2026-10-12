import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingViewerRealtimeController } from '../../src/lib/meetingViewerRealtime.js';
import { mergeMeetingCues, mergeMeetingViewerSnapshot } from '../../src/lib/meetingViewerState.js';
import { createWebRtcSubtitleTransport } from '../../src/webrtc/subtitleTransport.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Scenario A: Realtime channel failure cancels token refresh and reconnects for replay', async () => {
  const subscriptions = [];
  const timers = [];
  const errors = [];
  let subscribedCount = 0;
  const client = {
    realtime: { async setAuth() {} },
    channel() {
      return {
        on() { return this; },
        subscribe(callback) { subscriptions.push(callback); return this; },
      };
    },
    async removeChannel() {},
  };
  const controller = createMeetingViewerRealtimeController({
    basePath: '/api/shared-meetings/share-token',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { accessToken: 'viewer-jwt', channel: 'meeting:meeting-1', expiresAt: Date.now() + 60_000 };
      },
    }),
    client,
    random: () => 0.5,
    onSubscribed: async () => { subscribedCount += 1; },
    onError: (error) => errors.push(error),
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
  });

  controller.start();
  await tick();
  await subscriptions[0]('SUBSCRIBED');
  assert.equal(subscribedCount, 1);
  const tokenRefresh = timers.find((timer) => timer.ms > 20_000 && !timer.cleared);
  assert.ok(tokenRefresh);

  subscriptions[0]('CHANNEL_ERROR');
  assert.equal(tokenRefresh.cleared, true);
  assert.equal(errors.at(-1)?.code, 'realtime_channel_interrupted');
  const reconnect = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  assert.ok(reconnect, 'failure retry must not be blocked by the token refresh timer');

  await reconnect.fn();
  await tick();
  await subscriptions[1]('SUBSCRIBED');
  assert.equal(subscribedCount, 2, 'new generation resubscribes and runs snapshot/replay recovery');
  await controller.stop();
});

test('Scenario B/D: meeting-level merge accepts Segment B sequence 1 after Segment A sequence 100', () => {
  const segmentA = {
    cueId: 'cue-a-100', meetingId: 'meeting-1', sessionId: 'session-1',
    segmentId: 'segment-a', segmentSequence: 1, sequence: 100,
    sourceText: 'A100', sourceVersion: 1,
  };
  const segmentB = {
    cueId: 'cue-b-1', meetingId: 'meeting-1', sessionId: 'session-1',
    segmentId: 'segment-b', segmentSequence: 2, sequence: 1,
    sourceText: 'B1', sourceVersion: 1,
  };

  const cues = mergeMeetingCues([segmentA], [segmentB]);
  assert.deepEqual(cues.map((cue) => cue.cueId), ['cue-a-100', 'cue-b-1']);
  const state = mergeMeetingViewerSnapshot({
    meetingId: 'meeting-1', cues: [segmentA], cursor: { eventId: 100, cueSequence: 100 },
  }, {
    meetingId: 'meeting-1', cues: [segmentB], cursor: { eventId: 101, cueSequence: 1 },
  });
  assert.deepEqual(state.cues.map((cue) => cue.cueId), ['cue-a-100', 'cue-b-1']);
  assert.equal(state.cursor.eventId, 101);
});

test('Scenario E: expired signaling participant is rejoined with the same meeting scope', async () => {
  const timers = [];
  let joins = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-long-session',
    RTCPeerConnectionImpl: class {},
    random: () => 0.5,
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) {
        joins += 1;
        if (joins === 2) {
          return { ok: false, status: 403, async json() { return { error: { code: 'participant_unauthorized' } }; } };
        }
        return { ok: true, status: 200, async json() { return { ttlMs: 60_000, iceServers: [] }; } };
      }
      if (url.endsWith('/leave')) return { ok: true, status: 200, async json() { return { left: true }; } };
      return { ok: true, status: 200, async json() { return { messages: [], after: 0 }; } };
    },
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
  });

  transport.start();
  await tick();
  const heartbeat = timers.find((timer) => timer.ms === 30_000 && !timer.cleared);
  assert.ok(heartbeat);
  await heartbeat.fn();
  await tick();
  const reconnect = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  assert.ok(reconnect);
  await reconnect.fn();
  await tick();
  assert.equal(joins, 3);
  await transport.stop();
});
