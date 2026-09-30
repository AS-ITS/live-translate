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

test('viewer realtime isolates its short-lived token from the signed-in Supabase client', async () => {
  let subscriptionCallback;
  let tokenProvider;
  const authCalls = [];
  const channel = {
    on() { return this; },
    subscribe(callback) { subscriptionCallback = callback; return this; }
  };
  const dedicatedClient = {
    realtime: {
      async setAuth(...args) { authCalls.push(args); }
    },
    channel() { return channel; },
    async removeChannel() {}
  };
  const controller = createMeetingViewerRealtimeController({
    basePath: '/api/shared-meetings/share-token',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { accessToken: 'viewer-jwt', channel: 'meeting:meeting-1', expiresAt: Date.now() + 60_000 };
      }
    }),
    clientFactory(provider) {
      tokenProvider = provider;
      return dedicatedClient;
    },
    setTimer: () => 1,
    clearTimer: () => {}
  });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await tokenProvider(), 'viewer-jwt');
  assert.deepEqual(authCalls, [[]]);
  await subscriptionCallback('SUBSCRIBED');
  await controller.stop();
});

test('viewer realtime requests JSON when replaying missed events', async () => {
  let subscriptionCallback;
  const fetchCalls = [];
  const channel = {
    on() { return this; },
    subscribe(callback) { subscriptionCallback = callback; return this; }
  };
  const client = {
    realtime: { async setAuth() {} },
    channel() { return channel; },
    async removeChannel() {}
  };
  let replayed;
  const controller = createMeetingViewerRealtimeController({
    basePath: '/api/shared-meetings/share-token',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        async json() {
          if (url.endsWith('/realtime-token')) {
            return { accessToken: 'viewer-jwt', channel: 'meeting:meeting-1', expiresAt: Date.now() + 60_000 };
          }
          return { events: [{ eventId: 8 }], cursor: { eventId: 8 } };
        }
      };
    },
    client,
    onSubscribed: async ({ replay }) => { replayed = await replay(7); },
    setTimer: () => 1,
    clearTimer: () => {}
  });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  await subscriptionCallback('SUBSCRIBED');

  assert.deepEqual(fetchCalls[1], {
    url: '/api/shared-meetings/share-token/events?after=7',
    options: { headers: { Accept: 'application/json' } }
  });
  assert.deepEqual(replayed, { events: [{ eventId: 8 }], cursor: { eventId: 8 } });
  await controller.stop();
});
