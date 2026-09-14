import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingViewerRealtimeController } from '../../src/lib/meetingViewerRealtime.js';

test('viewer realtime subscribes privately before delivering persisted cue broadcasts', async () => {
  let subscriptionCallback;
  let broadcastCallback;
  const timers = [];
  const calls = [];
  const channel = {
    on(type, filter, callback) {
      calls.push(['on', type, filter]);
      broadcastCallback = callback;
      return this;
    },
    subscribe(callback) {
      subscriptionCallback = callback;
      return this;
    }
  };
  const client = {
    realtime: { async setAuth(token) { calls.push(['auth', token]); } },
    channel(topic, options) { calls.push(['channel', topic, options]); return channel; },
    async removeChannel() {}
  };
  const events = [];
  let snapshotLoaded = false;
  const controller = createMeetingViewerRealtimeController({
    basePath: '/api/shared-meetings/share-token',
    fetchImpl: async () => ({
      ok: true,
      async json() { return { accessToken: 'viewer-jwt', channel: 'meeting:meeting-1', expiresAt: Date.now() + 60_000 }; }
    }),
    client,
    onEvent: (payload) => events.push(payload),
    onSubscribed: async () => { snapshotLoaded = true; },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimer: () => {}
  });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], ['auth', 'viewer-jwt']);
  assert.deepEqual(calls[1], ['channel', 'meeting:meeting-1', { config: { private: true } }]);

  await subscriptionCallback('SUBSCRIBED');
  assert.equal(snapshotLoaded, true);
  broadcastCallback({ payload: { type: 'cue.append', cue: { cueId: 'cue-1' } } });
  assert.deepEqual(events, [{ type: 'cue.append', cue: { cueId: 'cue-1' } }]);
  assert.equal(timers.length, 1);
  await controller.stop();
});
