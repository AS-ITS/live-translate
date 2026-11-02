import { createDurablePcmJournal } from './durablePcmJournal.js';

function wrap(handle) {
  return {
    getSize: async () => handle.getSize(),
    read: async (offset, length) => {
      const bytes = new Uint8Array(length);
      return bytes.subarray(0, handle.read(bytes, { at: offset }));
    },
    write: async (offset, bytes) => {
      let written = 0;
      while (written < bytes.length) {
        const count = handle.write(bytes.subarray(written), { at: offset + written });
        if (count < 1) throw new Error('OPFS_SHORT_WRITE');
        written += count;
      }
    },
    flush: async () => handle.flush(),
    truncate: async (size) => handle.truncate(size),
    close: () => handle.close()
  };
}

function validIdentity(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
    throw new TypeError(`valid ${field} required`);
  }
  return value;
}

async function opfsStore(meetingId) {
  const owner = validIdentity(meetingId, 'meetingId');
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('pcm-journals', { create: true });
  const version = await base.getDirectoryHandle('v1', { create: true });
  const meeting = await version.getDirectoryHandle(owner, { create: true });
  async function directory(recordingId) {
    return meeting.getDirectoryHandle(validIdentity(recordingId, 'recordingId'), { create: true });
  }
  async function open(recordingId, name) {
    const parent = await directory(recordingId);
    const file = await parent.getFileHandle(name, { create: true });
    return wrap(await file.createSyncAccessHandle());
  }
  return {
    ledger: (recordingId) => open(recordingId, 'claims.bin'),
    segment: (recordingId, number) => open(recordingId, `pcm-${String(number).padStart(6, '0')}.bin`)
  };
}

let journal;
let activeRecordingId = null;
let releaseMeetingLock;
let queue = Promise.resolve();

async function holdMeetingLock(meetingId) {
  if (!navigator.locks?.request) throw new Error('MEETING_LOCK_UNAVAILABLE');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const request = navigator.locks.request(`live-translate:meeting:${meetingId}`,
    { mode: 'shared' }, async (lock) => {
      if (!lock) throw new Error('MEETING_LOCK_UNAVAILABLE');
      readyResolve();
      await held;
    }).catch((error) => { readyReject(error); throw error; });
  await ready;
  return async () => { release(); await request; };
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { id, command, args = {}, diagnosticClientId = null } = data;
    try {
      let result;
      if (command === 'OPEN') {
        const meetingId = validIdentity(args.meetingId, 'meetingId');
        const recordingId = validIdentity(args.recordingId, 'recordingId');
        journal?.close();
        journal = null;
        await releaseMeetingLock?.();
        releaseMeetingLock = await holdMeetingLock(meetingId);
        try {
          journal = createDurablePcmJournal({ store: await opfsStore(meetingId), recordingId });
          result = await journal.open();
        activeRecordingId = recordingId;
        } catch (error) {
          await releaseMeetingLock();
          releaseMeetingLock = null;
          throw error;
        }
      } else {
        if (!journal) throw new Error('JOURNAL_NOT_OPEN');
        if (command === 'BEGIN') result = await journal.beginEpoch(args.captureEpoch);
        else if (command === 'APPEND') result = await journal.append(args);
      else if (command === 'END') {
        console.info('ISSUE41_PCM_END', JSON.stringify({ stage: 'WORKER_END_RECEIVED', recordingId: activeRecordingId, clientId: diagnosticClientId, requestId: id, captureEpoch: args.captureEpoch, endSample: args.endSample }));
        result = await journal.endEpoch(args.captureEpoch, args.endSample, { clientId: diagnosticClientId, requestId: id });
        console.info('ISSUE41_PCM_END', JSON.stringify({ stage: 'WORKER_END_AWAITED', recordingId: activeRecordingId, clientId: diagnosticClientId, requestId: id, captureEpoch: args.captureEpoch, state: result?.state ?? null }));
      }
        else if (command === 'COVERAGE') result = journal.coverage(args.captureEpoch, args.startSample, args.endSample);
        else if (command === 'READ') result = await journal.readRange(args.captureEpoch, args.startSample, args.endSample);
        else if (command === 'STATUS') result = journal.status();
        else if (command === 'CLOSE') {
          journal.close(); journal = null;
          await releaseMeetingLock?.(); releaseMeetingLock = null;
        console.info('ISSUE41_PCM_END', JSON.stringify({ stage: 'WORKER_CLOSE', recordingId: activeRecordingId, clientId: diagnosticClientId, requestId: id }));
        activeRecordingId = null;
          result = { state: 'CLOSED' };
        }
        else throw new Error('UNKNOWN_JOURNAL_COMMAND');
      }
      if (result instanceof Uint8Array) self.postMessage({ id, ok: true, result }, [result.buffer]);
      else self.postMessage({ id, ok: true, result });
    } catch (error) {
      if (command === 'END') console.info('ISSUE41_PCM_END', JSON.stringify({ stage: 'WORKER_END_ERROR', recordingId: activeRecordingId, clientId: diagnosticClientId, requestId: id, captureEpoch: args.captureEpoch, code: error?.code ?? error?.name ?? 'unknown' }));
      self.postMessage({ id, ok: false, error: { code: error?.code || error?.name || 'JOURNAL_ERROR',
        message: error?.message || String(error) } });
    }
  }).catch((error) => {
    self.postMessage({ id: data.id, ok: false, error: { code: 'JOURNAL_WORKER_ERROR', message: error?.message || String(error) } });
  });
};
