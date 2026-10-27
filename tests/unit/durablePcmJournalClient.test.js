import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurablePcmJournalClient } from '../../src/lib/durablePcmJournalClient.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

function fixture() {
  const calls = [];
  let terminated = false;
  const worker = {
    onmessage: null,
    postMessage({ id, command, args }) {
      calls.push({ command, args });
      queueMicrotask(() => worker.onmessage({ data: { id, ok: true, result: command === 'OPEN'
        ? { highestEpoch: 0, tailState: 'CLEAN' } : {} } }));
    },
    terminate() { terminated = true; }
  };
  const client = createDurablePcmJournalClient({ meetingId: 'meeting-a', recordingId: 'recording-a',
    workerFactory: () => worker, commitIntervalMs: 60_000 });
  return { client, calls, get terminated() { return terminated; } };
}

test('meeting identity is required and is sent to the worker', async () => {
  assert.throws(() => createDurablePcmJournalClient({ recordingId: 'recording-a' }), /meetingId/);
  const f = fixture();
  await f.client.open();
  assert.deepEqual(f.calls[0], { command: 'OPEN', args: { meetingId: 'meeting-a', recordingId: 'recording-a' } });
  await f.client.close();
  assert.equal(f.terminated, true);
});

test('provider metadata keeps one capture range; pause starts a new epoch', async () => {
  const f = fixture();
  await f.client.open();
  f.client.offer(new Uint8Array(3200), { connectionEpoch: 7, providerEpoch: 1 });
  f.client.offer(new Uint8Array(3200), { connectionEpoch: 7, providerEpoch: 2 });
  await f.client.flush({ endEpoch: true });
  f.client.offer(new Uint8Array(3200), { connectionEpoch: 7, providerEpoch: 3 });
  await f.client.close();
  const appends = f.calls.filter(({ command }) => command === 'APPEND');
  assert.deepEqual(appends.map(({ args }) => [args.captureEpoch, args.startSample, args.bytes.length]),
    [[1, 0, 6400], [2, 0, 3200]]);
  assert.deepEqual(appends.map(({ args }) => args.operationId), ['r1_0_3200', 'r2_0_1600']);
  assert.equal(f.terminated, true);
});

test('Journal backpressure does not delay or duplicate Live provider sends', async () => {
  const calls = [];
  const statuses = [];
  const worker = {
    onmessage: null,
    postMessage(message) {
      calls.push(message);
      const result = message.command === 'OPEN'
        ? { highestEpoch: 0, tailState: 'CLEAN' } : { state: 'COMMITTED' };
      setTimeout(() => this.onmessage({ data: { id: message.id, ok: true, result } }),
        message.command === 'APPEND' ? 30 : 0);
    },
    terminate() {}
  };
  const client = createDurablePcmJournalClient({ meetingId: 'meeting-a', recordingId: 'recording-a',
    workerFactory: () => worker, maxPendingBytes: 6400,
    onStatus: (status) => statuses.push(status) });
  await client.open();
  const providerPayloads = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en',
    onInputAudioChunk: (pcm, metadata) => client.offer(pcm, metadata) });
  session.session = { sendRealtimeInput: ({ audio }) => providerPayloads.push(audio.data) };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  for (let index = 1; index <= 10; index += 1) {
    session.sendInputAudioChunk(new Uint8Array(3200).fill(index), session.connectionEpoch, { force: true });
  }
  assert.equal(providerPayloads.length, 10); // before the delayed APPEND completes
  assert.equal(new Set(providerPayloads).size, 10);
  assert.ok(statuses.some(({ state }) => state === 'BACKPRESSURE_GAP'));
  await client.flush({ endEpoch: true });
  assert.equal(client.status().pendingBytes, 0);
  session.sendInputAudioChunk(new Uint8Array(3200).fill(11), session.connectionEpoch, { force: true });
  await client.flush({ endEpoch: true });
  assert.equal(providerPayloads.length, 11);
  assert.equal(new Set(providerPayloads).size, 11);
  assert.deepEqual(calls.filter(({ command }) => command === 'APPEND')
    .map(({ args }) => args.captureEpoch), [1, 2]);
  assert.deepEqual(calls.filter(({ command }) => command === 'BEGIN')
    .map(({ args }) => args.captureEpoch), [1, 2]);
  await client.close();
});

test('Journal worker failure stays observable without resending captured PCM', async () => {
  const statuses = [];
  const worker = {
    onmessage: null,
    postMessage({ id, command }) {
      queueMicrotask(() => this.onmessage({ data: command === 'APPEND'
        ? { id, ok: false, error: { code: 'DISK_FAIL', message: 'disk failure' } }
        : { id, ok: true, result: command === 'OPEN'
          ? { highestEpoch: 0, tailState: 'CLEAN' } : { state: 'COMMITTED' } } }));
    },
    terminate() {}
  };
  const client = createDurablePcmJournalClient({ meetingId: 'meeting-a', recordingId: 'recording-a',
    workerFactory: () => worker, onStatus: (status) => statuses.push(status) });
  await client.open();
  const providerPayloads = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en',
    onInputAudioChunk: (pcm, metadata) => client.offer(pcm, metadata) });
  session.session = { sendRealtimeInput: ({ audio }) => providerPayloads.push(audio.data) };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.sendInputAudioChunk(new Uint8Array(3200).fill(1), session.connectionEpoch, { force: true });
  await assert.rejects(client.flush({ endEpoch: true }), { code: 'DISK_FAIL' });
  assert.ok(statuses.some(({ state, code }) => state === 'DEGRADED' && code === 'DISK_FAIL'));
  session.sendInputAudioChunk(new Uint8Array(3200).fill(2), session.connectionEpoch, { force: true });
  assert.equal(providerPayloads.length, 2);
  assert.equal(new Set(providerPayloads).size, 2);
  await assert.rejects(client.close(), { code: 'DISK_FAIL' });
});
