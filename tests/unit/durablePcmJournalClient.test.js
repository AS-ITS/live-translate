import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurablePcmJournalClient } from '../../src/lib/durablePcmJournalClient.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

function fixture() {
  const calls = [];
  const gapRecords = [];
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
    workerFactory: () => worker, gapStore: { append: async (gap) => gapRecords.push(gap) },
    commitIntervalMs: 60_000 });
  return { client, calls, gapRecords, get terminated() { return terminated; } };
}

test('meeting identity is required and is sent to the worker', async () => {
  assert.throws(() => createDurablePcmJournalClient({ recordingId: 'recording-a' }), /meetingId/);
  const f = fixture();
  await f.client.open();
  assert.deepEqual(f.calls[0], { command: 'OPEN', args: { meetingId: 'meeting-a', recordingId: 'recording-a' } });
  await f.client.close();
  assert.equal(f.terminated, true);
});

test('Pause END and CLOSE release ownership before verifier and next writer OPEN', async () => {
  const calls = [];
  let locked = false;
  let highestEpoch = 0;
  const workerFactory = () => {
    const worker = {
      onmessage: null,
      postMessage({ id, command, args }) {
        calls.push({ command, captureEpoch: args.captureEpoch ?? null });
        queueMicrotask(() => {
          if (command === 'OPEN' && locked) {
            worker.onmessage({ data: { id, ok: false,
              error: { code: 7, message: 'OPFS file locked' } } });
            return;
          }
          if (command === 'OPEN') locked = true;
          if (command === 'END') highestEpoch = args.captureEpoch;
          if (command === 'CLOSE') locked = false;
          worker.onmessage({ data: { id, ok: true, result: command === 'OPEN'
            ? { highestEpoch, tailState: 'CLEAN' } : { state: 'COMMITTED' } } });
        });
      },
      terminate() {}
    };
    return worker;
  };
  const options = { meetingId: 'meeting-a', recordingId: 'recording-a', workerFactory,
    gapStore: { append: async () => {} }, commitIntervalMs: 60_000 };
  const first = createDurablePcmJournalClient(options);
  await first.open();
  first.offer(new Uint8Array(3200), { connectionEpoch: 1 });
  await first.flush({ endEpoch: true, transitionOperationId: 'pause-1' });
  await first.close();
  const verifier = createDurablePcmJournalClient({ ...options, existingOnly: true, readOnly: true });
  await verifier.open();
  await verifier.close();
  const next = createDurablePcmJournalClient(options);
  await next.open();
  next.offer(new Uint8Array(3200), { connectionEpoch: 2 });
  await next.flush();
  await next.close();
  assert.deepEqual(calls.filter(({ command }) => command === 'END').map(({ captureEpoch }) => captureEpoch), [1, 2]);
  assert.deepEqual(calls.filter(({ command }) => command === 'BEGIN').map(({ captureEpoch }) => captureEpoch), [1, 2]);
  assert.deepEqual(calls.filter(({ command }) => ['OPEN', 'CLOSE'].includes(command)).map(({ command }) => command),
    ['OPEN', 'CLOSE', 'OPEN', 'CLOSE', 'OPEN', 'CLOSE']);
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

test('duplicate or late capture callback cannot acquire a new sample range after END', async () => {
  const f = fixture();
  await f.client.open();
  const first = f.client.offer(new Uint8Array(3200), {
    captureSourceId: 'source-1', sequence: 1, connectionEpoch: 1
  });
  assert.equal(first.state, 'QUEUED');
  await f.client.flush({ endEpoch: true });
  assert.deepEqual(f.client.offer(new Uint8Array(3200), {
    captureSourceId: 'source-1', sequence: 1, connectionEpoch: 1
  }), { state: 'REJECTED', code: 'DUPLICATE_OR_LATE_PCM' });
  f.client.offer(new Uint8Array(3200), { captureSourceId: 'source-1', sequence: 2, connectionEpoch: 1 });
  await f.client.close();
  assert.deepEqual(f.calls.filter(({ command }) => command === 'APPEND')
    .map(({ args }) => [args.captureEpoch, args.startSample]), [[1, 0], [2, 0]]);
});

test('Journal backpressure does not delay or duplicate Live provider sends', async () => {
  const calls = [];
  const statuses = [];
  const gapRecords = [];
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
    gapStore: { append: async (gap) => { gapRecords.push(gap); },
      list: async () => gapRecords },
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
  assert.ok(client.gapLedger().length > 0);
  assert.equal(client.gapLedger()[0].code, 'BACKPRESSURE_GAP');
  assert.ok((await client.whenGapsPersisted()).every((gap) => gap.persistenceState === 'durable'));
  assert.equal((await client.readPersistedGaps()).length, client.gapLedger().length);
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
    workerFactory: () => worker, gapStore: { append: async () => {} },
    onStatus: (status) => statuses.push(status) });
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
  assert.deepEqual(client.gapLedger().map(({ startSample, endSample, code }) =>
    [startSample, endSample, code]), [[0, 1600, 'DISK_FAIL']]);
  assert.equal((await client.whenGapsPersisted())[0].persistenceState, 'durable');
  session.sendInputAudioChunk(new Uint8Array(3200).fill(2), session.connectionEpoch, { force: true });
  assert.equal(providerPayloads.length, 2);
  assert.equal(new Set(providerPayloads).size, 2);
  await assert.rejects(client.close(), { code: 'DISK_FAIL' });
});

test('provider send failure preserves capture and Journal commits while reconnecting', async () => {
  const f = fixture();
  await f.client.open();
  const failures = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en',
    onInputAudioChunk: (pcm, metadata) => f.client.offer(pcm, metadata),
    onConnectionFailure: (failure) => failures.push(failure) });
  let cleanupCalls = 0;
  let reconnectCalls = 0;
  session.cleanup = async () => { cleanupCalls += 1; };
  session.reconnectProvider = async () => { reconnectCalls += 1; return false; };
  session.session = { sendRealtimeInput: () => { throw new Error('provider offline'); } };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.sendInputAudioChunk(new Uint8Array(3200), session.connectionEpoch, { force: true });
  session.sendInputAudioChunk(new Uint8Array(3200), session.connectionEpoch, { force: true });
  await f.client.flush();
  assert.equal(cleanupCalls, 0);
  assert.equal(reconnectCalls, 1);
  assert.equal(failures.length, 0);
  assert.equal(session.providerReady, false);
  assert.deepEqual(f.calls.filter(({ command }) => command === 'APPEND')
    .map(({ args }) => [args.startSample, args.bytes.length]), [[0, 6400]]);
  await f.client.close();
});

test('gap ledger failure remains visible and never becomes a durable gap claim', async () => {
  const statuses = [];
  const worker = {
    onmessage: null,
    postMessage({ id, command }) {
      queueMicrotask(() => this.onmessage({ data: { id, ok: true,
        result: command === 'OPEN' ? { highestEpoch: 0, tailState: 'CLEAN' } : {} } }));
    },
    terminate() {}
  };
  const client = createDurablePcmJournalClient({ meetingId: 'meeting-a', recordingId: 'recording-a',
    workerFactory: () => worker, maxPendingBytes: 2,
    gapStore: { append: async () => { throw new Error('IndexedDB unavailable'); } },
    onStatus: (status) => statuses.push(status) });
  await client.open();
  assert.equal(client.offer(new Uint8Array(4)).state, 'REJECTED');
  const [gap] = await client.whenGapsPersisted();
  assert.equal(gap.persistenceState, 'failed');
  assert.ok(statuses.some(({ state }) => state === 'GAP_LEDGER_ERROR'));
  assert.equal(client.status().gaps[0].persistenceState, 'failed');
  await client.close();
});
