import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPcmGapLedger } from '../../src/lib/localPcmGapLedger.js';

function memoryIndexedDb() {
  const stores = new Map();
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      stores.set(name, new Map());
      return {};
    },
    transaction(names) {
      const transaction = { oncomplete: null, onerror: null, onabort: null };
      let pending = 0;
      let completed = false;
      let timer;
      const scheduleCompletion = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending === 0 && !completed) {
            completed = true;
            transaction.oncomplete?.();
          }
        }, 0);
      };
      transaction.abort = () => {
        if (!completed) { completed = true; transaction.onabort?.(); }
      };
      transaction.objectStore = (name) => {
        assert.ok(names.includes(name));
        const rows = stores.get(name);
        const request = (work) => {
          pending += 1;
          const result = { onsuccess: null, onerror: null };
          queueMicrotask(() => {
            try { result.result = work(); result.onsuccess?.(); }
            catch (error) { result.error = error; result.onerror?.(); }
            pending -= 1;
            scheduleCompletion();
          });
          return result;
        };
        return {
          get: (key) => request(() => structuredClone(rows.get(key))),
          getAll: () => request(() => structuredClone([...rows.values()])),
          put: (value) => request(() => { rows.set(value.id ?? value.meetingId, structuredClone(value)); }),
          delete: (key) => request(() => { rows.delete(key); })
        };
      };
      scheduleCompletion();
      return transaction;
    },
    close() {}
  };
  return {
    open() {
      const result = { result: database, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => { result.onupgradeneeded?.(); result.onsuccess?.(); });
      return result;
    },
    rows: (name) => stores.get(name)
  };
}

test('Gap Ledger reload, pending reconciliation, duplicate events and deletion tombstone', async () => {
  const indexedDBImpl = memoryIndexedDb();
  const first = createLocalPcmGapLedger({ indexedDBImpl });
  const gap = { id: 'gap-1', meetingId: 'meeting-1', recordingId: 'recording-1',
    captureEpoch: 1, localEpoch: 1, startSample: 0, endSample: 1600, code: 'BACKPRESSURE_GAP' };
  await first.append(gap);
  await first.append(gap);
  assert.equal((await first.list('recording-1')).length, 1);
  indexedDBImpl.rows('gaps').set(gap.id, { ...gap, persistenceState: 'pending' });
  const reloaded = createLocalPcmGapLedger({ indexedDBImpl });
  assert.equal((await reloaded.list('recording-1'))[0].persistenceState, 'pending');
  assert.equal((await reloaded.reconcile('recording-1'))[0].persistenceState, 'durable');
  await assert.rejects(reloaded.append({ ...gap, endSample: 3200 }),
    { code: 'local_gap_identity_conflict' });
  await reloaded.clearMeeting('meeting-1');
  assert.deepEqual(await reloaded.list('recording-1'), []);
  await assert.rejects(first.append(gap), { code: 'meeting_deleted' });
});
