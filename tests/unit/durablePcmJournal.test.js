import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurablePcmJournal } from '../../src/lib/durablePcmJournal.js';
import { createDurablePcmJournalClient } from '../../src/lib/durablePcmJournalClient.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

function memoryStore() {
  const files = new Map();
  let failNextFlush = '';
  let quotaBytes = Infinity;
  function file(name) {
    if (!files.has(name)) files.set(name, { committed: new Uint8Array(), working: new Uint8Array() });
    const state = files.get(name);
    return {
      async getSize() { return state.working.length; },
      async read(offset, length) { return state.working.slice(offset, offset + length); },
      async write(offset, bytes) {
        if (offset + bytes.length > quotaBytes) {
          const error = new Error('quota exceeded'); error.name = 'QuotaExceededError'; throw error;
        }
        const next = new Uint8Array(Math.max(state.working.length, offset + bytes.length));
        next.set(state.working); next.set(bytes, offset); state.working = next;
      },
      async truncate(size) { state.working = state.working.slice(0, size); },
      async flush() {
        if (failNextFlush === name) { failNextFlush = ''; throw new Error('injected flush interruption'); }
        state.committed = state.working.slice();
      },
      close() {}
    };
  }
  return {
    ledger: (id) => file(`${id}/claims.bin`),
    segment: (id, number) => file(`${id}/pcm-${number}.bin`),
    failFlush(name) { failNextFlush = name; },
    setQuota(bytes) { quotaBytes = bytes; },
    crash() { for (const state of files.values()) state.working = state.committed.slice(); },
    corrupt(name, offset) { files.get(name).working[offset] ^= 0xff; files.get(name).committed[offset] ^= 0xff; },
    fileCount() { return files.size; }
  };
}

const bytes = (value, samples = 1600) => new Uint8Array(samples * 2).fill(value);
const frame = (operationId, startSample, value = 1, captureEpoch = 1) => ({
  operationId, captureEpoch, startSample, bytes: bytes(value)
});

test('hashed END receipt survives lost ACK and keeps later epochs distinct', async () => {
  const store = memoryStore();
  const first = createDurablePcmJournal({ store, recordingId: 'recording-boundary' });
  await first.open();
  await first.beginEpoch(1);
  await first.append(frame('first-epoch', 0));
  await first.endEpoch(1, 1600);
  await first.beginEpoch(2);
  await first.append(frame('second-epoch', 0, 2, 2));
  const end = await first.endEpoch(2, 1600, { transitionOperationId: 'rollover-1' });
  assert.equal(end.receipt.captureEpoch, 2);
  store.crash();
  const recovered = createDurablePcmJournal({ store, recordingId: 'recording-boundary' });
  assert.equal((await recovered.open()).tailState, 'CLEAN');
  assert.deepEqual(recovered.transitionReceipt('rollover-1'), end.receipt);
  assert.deepEqual(recovered.coverage(1, 0, 1600).gaps, []);
  assert.deepEqual(recovered.coverage(2, 0, 1600).gaps, []);
  await assert.rejects(recovered.append(frame('late', 1600, 3, 2)), { code: 'CAPTURE_EPOCH_CLOSED' });
  assert.equal((await recovered.endEpoch(2, 1600, { transitionOperationId: 'rollover-1' })).duplicate, true);
  await assert.rejects(recovered.endEpoch(2, 1600, { transitionOperationId: 'rollover-other' }),
    { code: 'EPOCH_END_CONFLICT' });
});

test('append/read uses exact half-open sample ranges; duplicate operation is idempotent', async () => {
  const store = memoryStore();
  const journal = createDurablePcmJournal({ store, recordingId: 'recording-1' });
  await journal.open();
  assert.equal((await journal.append(frame('first', 0))).state, 'COMMITTED');
  await journal.append(frame('second', 1600, 2));
  assert.deepEqual([...await journal.readRange(1, 1598, 1602)], [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal((await journal.append(frame('first', 0))).duplicate, true);
  await assert.rejects(journal.append(frame('first', 0, 9)), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(journal.append(frame('overlap', 1500)), { code: 'SAMPLE_RANGE_OVERLAP' });
  assert.equal(store.fileCount(), 2);
});

test('crash before ledger flush leaves no false commit and orphan PCM is safely reused', async () => {
  const store = memoryStore();
  const first = createDurablePcmJournal({ store, recordingId: 'recording-2' });
  await first.open();
  store.failFlush('recording-2/claims.bin');
  await assert.rejects(first.append(frame('first', 0)), /injected flush interruption/);
  store.crash();
  const reopened = createDurablePcmJournal({ store, recordingId: 'recording-2' });
  const status = await reopened.open();
  assert.equal(status.committedBytes, 0);
  await assert.rejects(reopened.readRange(1, 0, 1600), { code: 'SAMPLE_RANGE_NOT_COMMITTED' });
  assert.equal((await reopened.append(frame('first', 0))).state, 'COMMITTED');
  store.crash();
  const third = createDurablePcmJournal({ store, recordingId: 'recording-2' });
  assert.equal((await third.open()).committedBytes, 3200);
  assert.equal((await third.append(frame('first', 0))).duplicate, true);
});

test('partial ledger tail and damaged PCM are never classified complete', async () => {
  const store = memoryStore();
  const first = createDurablePcmJournal({ store, recordingId: 'recording-3' });
  await first.open();
  await first.append(frame('first', 0));
  store.failFlush('recording-3/claims.bin');
  await assert.rejects(first.append(frame('second', 1600)), /injected flush interruption/);
  // A process crash may leave either the old ledger or a partial new tail.
  const ledger = await store.ledger('recording-3');
  const size = await ledger.getSize();
  await ledger.truncate(size - 8);
  await ledger.flush();
  const reopened = createDurablePcmJournal({ store, recordingId: 'recording-3' });
  assert.equal((await reopened.open()).tailState, 'CORRUPT_OR_INCOMPLETE_LEDGER');
  assert.equal((await reopened.readRange(1, 0, 1600)).length, 3200);
  assert.equal(reopened.coverage(1, 0, 3200).complete, false);
  const cleanStore = memoryStore();
  const clean = createDurablePcmJournal({ store: cleanStore, recordingId: 'recording-4' });
  await clean.open(); await clean.append(frame('first', 0));
  cleanStore.corrupt('recording-4/pcm-1.bin', 0);
  const damaged = createDurablePcmJournal({ store: cleanStore, recordingId: 'recording-4' });
  assert.equal((await damaged.open()).tailState, 'CORRUPT_PCM');
});

test('epoch boundary, storage quota and index cap remain explicit', async () => {
  const store = memoryStore();
  const journal = createDurablePcmJournal({ store, recordingId: 'recording-5', maxBytes: 6400, maxClaims: 2 });
  await journal.open();
  await journal.append(frame('first', 0));
  await journal.endEpoch(1, 3200);
  assert.deepEqual(journal.coverage(1, 0, 3200).gaps, [[1600, 3200]]);
  await assert.rejects(journal.append(frame('late', 1600)), { code: 'CAPTURE_EPOCH_CLOSED' });
  await journal.append(frame('next', 0, 2, 2));
  await assert.rejects(journal.append(frame('third', 1600, 3, 2)), { code: 'JOURNAL_INDEX_LIMIT' });
  const limited = createDurablePcmJournal({ store: memoryStore(), recordingId: 'recording-6', maxBytes: 1000 });
  await limited.open();
  await assert.rejects(limited.append(frame('first', 0)), { code: 'JOURNAL_STORAGE_LIMIT' });
  const quota = memoryStore(); quota.setQuota(10);
  const quotaJournal = createDurablePcmJournal({ store: quota, recordingId: 'recording-7' });
  await quotaJournal.open();
  await assert.rejects(quotaJournal.append(frame('first', 0)), { name: 'QuotaExceededError' });
});

test('read of an older segment does not change the append cursor or file count policy', async () => {
  const store = memoryStore();
  const journal = createDurablePcmJournal({ store, recordingId: 'recording-9', segmentBytes: 6400 });
  await journal.open();
  await journal.append(frame('one', 0));
  await journal.append(frame('two', 1600));
  await journal.append(frame('three', 3200));
  assert.equal((await journal.readRange(1, 0, 1600))[0], 1);
  await journal.append(frame('four', 4800));
  assert.equal(store.fileCount(), 3); // one ledger and two PCM segments
  assert.equal((await journal.readRange(1, 4800, 6400)).length, 3200);
  await assert.rejects(journal.readRange(1, 0, 480_001), { code: 'INVALID_READ_RANGE' });
});

test('bounded client refuses Journal backlog without delaying the Live send path', async () => {
  const events = [];
  const worker = {
    onmessage: null, onerror: null,
    postMessage(message) {
      events.push(message);
      const result = message.command === 'OPEN'
        ? { highestEpoch: 0, tailState: 'CLEAN' }
        : { state: 'COMMITTED' };
      setTimeout(() => this.onmessage({ data: { id: message.id, ok: true, result } }),
        message.command === 'APPEND' ? 30 : 0);
    },
    terminate() {}
  };
  const statuses = [];
  const client = createDurablePcmJournalClient({ meetingId: 'meeting-8', recordingId: 'recording-8', workerFactory: () => worker,
    maxPendingBytes: 6400, onStatus: (status) => statuses.push(status) });
  await client.open();
  let liveSends = 0;
  const session = new LiveTranslateSession({ targetLanguageCode: 'en',
    onInputAudioChunk: (pcm, metadata) => client.offer(pcm, metadata) });
  session.session = { sendRealtimeInput: () => { liveSends += 1; } };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  for (let index = 0; index < 10; index += 1) {
    session.sendInputAudioChunk(bytes(index), session.connectionEpoch, { force: true });
  }
  assert.equal(liveSends, 10);
  assert.ok(statuses.some(({ state }) => state === 'BACKPRESSURE_GAP'));
  await client.flush({ endEpoch: true });
  assert.equal(client.status().pendingBytes, 0);
  client.offer(bytes(11), { connectionEpoch: 2 });
  await client.flush({ endEpoch: true });
  assert.deepEqual(events.filter(({ command }) => command === 'APPEND')
    .map(({ args }) => args.captureEpoch), [1, 2]);
  assert.deepEqual(events.filter(({ command }) => command === 'BEGIN')
    .map(({ args }) => args.captureEpoch), [1, 2]);
});

test('provider epoch changes preserve capture identity; pause opens a new sample clock', async () => {
  const messages = [];
  const worker = {
    onmessage: null, onerror: null,
    postMessage(message) {
      messages.push(message);
      queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true,
        result: message.command === 'OPEN' ? { highestEpoch: 0, tailState: 'CLEAN' }
          : { state: 'COMMITTED' } } }));
    },
    terminate() {}
  };
  const client = createDurablePcmJournalClient({ meetingId: 'meeting-10', recordingId: 'recording-10', workerFactory: () => worker });
  await client.open();
  for (let index = 0; index < 10; index += 1) {
    client.offer(bytes(index), { connectionEpoch: 7, providerEpoch: index < 5 ? 1 : 2 });
  }
  await client.flush({ endEpoch: true });
  client.offer(bytes(11), { connectionEpoch: 7, providerEpoch: 3 });
  await client.flush({ endEpoch: true });
  assert.deepEqual(messages.filter(({ command }) => command === 'APPEND')
    .map(({ args }) => [args.captureEpoch, args.startSample, args.bytes.length]),
  [[1, 0, 32_000], [2, 0, 3200]]);
});
