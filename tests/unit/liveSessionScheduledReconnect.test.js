import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

const settleTimer = () => new Promise((resolve) => setTimeout(resolve, 30));

test('rejected scheduled reconnect reports one terminal failure and clears pending PCM', async () => {
  const errors = [];
  const failures = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onError: (error) => errors.push(error),
    onConnectionFailure: (failure) => failures.push(failure)
  });
  session.queuePendingInputAudioChunk(new Uint8Array([1, 2]));
  let attempts = 0;
  session.reconnectProvider = async () => {
    attempts += 1;
    throw new Error('scheduled reconnect rejected');
  };

  session.scheduleProviderReconnect('0ms');
  await settleTimer();

  assert.equal(failures.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /scheduled reconnect rejected/);
  assert.ok(attempts >= 1 && attempts <= 3);
  assert.equal(session.closed, true);
  assert.equal(session.pendingInputAudioChunks.length, 0);
  assert.equal(session.providerReconnectTimer, null);
});

test('scheduled reconnect is cancelled by stop or cleanup and by a stale provider epoch', async () => {
  for (const cancel of [
    async (session) => session.stop(),
    async (session) => session.cleanup(),
    async (session) => { session.providerEpoch += 1; }
  ]) {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    let attempts = 0;
    session.reconnectProvider = async () => { attempts += 1; return true; };
    session.scheduleProviderReconnect('10ms');
    await cancel(session);
    await settleTimer();
    assert.equal(attempts, 0);
    assert.equal(session.providerReconnectTimer, null);
  }
});

test('scheduled reconnect does not overlap an active reconnect', async () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  let attempts = 0;
  session.providerReconnectInProgress = new Promise(() => {});
  session.reconnectProvider = async () => { attempts += 1; return true; };
  session.scheduleProviderReconnect('0ms');
  await settleTimer();
  assert.equal(attempts, 0);
  assert.equal(session.providerReconnectTimer, null);
});

test('real reconnect rejections consume a bounded attempt and report failure', async () => {
  const failures = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  let attempts = 0;
  session.connectProvider = async () => {
    attempts += 1;
    throw new Error('provider unavailable');
  };
  session.scheduleProviderReconnect('0ms');
  await settleTimer();
  assert.equal(attempts, 2);
  assert.equal(session.providerReconnectAttempts, 2);
  assert.equal(failures.length, 1);
  assert.ok(session.failureDiagnostics.some((item) => item.source === 'scheduled_reconnect'));
});

test('stop during a pending scheduled reconnect suppresses late failure reporting', async () => {
  const failures = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  let rejectReconnect;
  session.reconnectProvider = () => new Promise((_, reject) => { rejectReconnect = reject; });
  session.scheduleProviderReconnect('0ms');
  await settleTimer();
  assert.equal(typeof rejectReconnect, 'function');
  await session.stop();
  rejectReconnect(new Error('late failure'));
  await settleTimer();
  assert.equal(failures.length, 0);
});
