const DB_NAME = 'live-translate-pcm-gaps-v1';
const GAP_STORE = 'gaps';
const DELETED_STORE = 'deletedMeetings';

export function createLocalPcmGapLedger({ indexedDBImpl = globalThis.indexedDB } = {}) {
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Gap ledger request failed.'));
    });
  }

  function open() {
    if (!indexedDBImpl?.open) return Promise.reject(new Error('IndexedDB is unavailable.'));
    return new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(GAP_STORE)) {
          request.result.createObjectStore(GAP_STORE, { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains(DELETED_STORE)) {
          request.result.createObjectStore(DELETED_STORE, { keyPath: 'meetingId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Gap ledger open failed.'));
    });
  }

  async function transact(stores, mode, work) {
    const db = await open();
    try {
      const transaction = db.transaction(stores, mode);
      const committed = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Gap ledger transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('Gap ledger transaction aborted.'));
      });
      committed.catch(() => {});
      try {
        const result = await work(transaction);
        await committed;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* already closed */ }
        throw error;
      }
    } finally { db.close(); }
  }

  async function putGap(gap, persistenceState) {
    return transact([GAP_STORE, DELETED_STORE], 'readwrite', async (transaction) => {
      if (await requestResult(transaction.objectStore(DELETED_STORE).get(gap.meetingId))) {
        const error = new Error('Meeting content was deleted.');
        error.code = 'meeting_deleted';
        throw error;
      }
      const store = transaction.objectStore(GAP_STORE);
      const existing = await requestResult(store.get(gap.id));
      if (existing && !sameGap(existing, gap)) {
        const error = new Error('Gap identity conflict.');
        error.code = 'local_gap_identity_conflict';
        throw error;
      }
      if (existing?.persistenceState === 'durable') return existing;
      const saved = { ...gap, persistenceState };
      await requestResult(store.put(saved));
      return saved;
    });
  }

  return Object.freeze({
    async append(gap) {
      await putGap(gap, 'pending');
      return putGap(gap, 'durable');
    },
    list(recordingId) {
      return transact(GAP_STORE, 'readonly', async (transaction) =>
        (await requestResult(transaction.objectStore(GAP_STORE).getAll()))
          .filter((gap) => gap.recordingId === recordingId));
    },
    async reconcile(recordingId) {
      for (const gap of await this.list(recordingId)) {
        if (gap.persistenceState === 'pending') await putGap(gap, 'durable');
      }
      return this.list(recordingId);
    },
    clearMeeting(meetingId) {
      return transact([GAP_STORE, DELETED_STORE], 'readwrite', async (transaction) => {
        const store = transaction.objectStore(GAP_STORE);
        for (const gap of await requestResult(store.getAll())) {
          if (gap.meetingId === meetingId) await requestResult(store.delete(gap.id));
        }
        await requestResult(transaction.objectStore(DELETED_STORE).put({ meetingId }));
      });
    }
  });
}

function sameGap(left, right) {
  return left.meetingId === right.meetingId && left.recordingId === right.recordingId
    && left.captureEpoch === right.captureEpoch && left.localEpoch === right.localEpoch
    && left.startSample === right.startSample && left.endSample === right.endSample
    && left.code === right.code;
}
