import { createLocalMeetingRecorder } from './localMeetingRecorder.js';
import { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } from './localMeetingStorage.js';

export function createLocalMeetingPersistence({
  manifestStore = createIndexedDbLocalMeetingManifestStore(),
  chunkStore = createOpfsChunkStore(),
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  createOperationId = defaultOperationId
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') throw new Error('Web Crypto is unavailable.');
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore, now });
  let activeMeetingId = null;
  let nextAudioSequence = 1;
  let appendQueue = Promise.resolve();

  return Object.freeze({
    async start({ meetingId, recordingId, segmentId } = {}) {
      const restored = await recorder.restore(meetingId);
      activeMeetingId = meetingId;
      const chunks = await manifestStore.list(meetingId);
      nextAudioSequence = chunks.reduce((next, chunk) => Math.max(next, chunk.sequence + 1), 1);
      if (restored.state === 'idle') {
        return recorder.start(meetingId, {
          recordingId,
          segmentId,
          operationId: createOperationId('start')
        });
      }
      if (restored.state === 'paused' || restored.state === 'stop_incomplete') {
        return recorder.recover({ operationId: createOperationId('recover') });
      }
      return restored;
    },

    pause() {
      return recorder.pause({ operationId: createOperationId('pause') });
    },

    resume() {
      return recorder.resume({ operationId: createOperationId('resume') });
    },

    providerReconnect() {
      return recorder.providerReconnect({ operationId: createOperationId('provider-reconnect') });
    },

    providerRollover() {
      return recorder.providerRollover({ operationId: createOperationId('provider-rollover') });
    },

    appendAudioChunk(chunk = {}) {
      const task = appendQueue.then(() => appendAudioChunkLocked(chunk));
      appendQueue = task.catch(() => {});
      return task;
    },

    async finalizeAudio({ fileName = '' } = {}) {
      await appendQueue;
      const chunks = await manifestStore.list(activeMeetingId);
      const sealed = chunks.filter((chunk) => chunk.state === 'sealed').sort((left, right) => left.sequence - right.sequence);
      await recorder.finalize({
        finalSequence: sealed.at(-1)?.sequence || 0,
        operationId: createOperationId('finalize')
      });
      const parts = await Promise.all(sealed.map((chunk) => chunkStore.read(chunk.path)));
      const mimeType = sealed[0]?.mimeType || 'audio/webm';
      return Object.freeze({
        status: parts.length > 0 ? 'ready' : 'idle',
        blob: parts.length > 0 ? new Blob(parts, { type: mimeType }) : null,
        mimeType,
        extension: mimeType.includes('ogg') ? 'ogg' : 'webm',
        fileName,
        errorMessage: ''
      });
    },

    async saveCue({ meetingId, segmentId, sessionId, cue, producedAt } = {}) {
      return manifestStore.saveCue({ meetingId, segmentId, sessionId, cue, producedAt });
    },

    async listCues(meetingId, options) {
      return manifestStore.listCues(meetingId, options);
    },

    async updateCheckpoint(payload = {}) {
      const saved = await manifestStore.saveCheckpoint({
        meetingId: payload.meetingId,
        segmentId: payload.segmentId,
        checkpoint: payload
      });
      return { checkpoint: saved.checkpoint };
    },

    async getCheckpoint({ meetingId, segmentId } = {}) {
      return manifestStore.getCheckpoint(meetingId, segmentId);
    },

    async restore(meetingId) {
      const [recording, cues, chunks] = await Promise.all([
        recorder.restore(meetingId),
        manifestStore.listCues(meetingId),
        manifestStore.list(meetingId)
      ]);
      activeMeetingId = meetingId;
      nextAudioSequence = chunks.reduce((next, chunk) => Math.max(next, chunk.sequence + 1), 1);
      return Object.freeze({ recording, cues, chunks });
    },

    snapshot: () => recorder.snapshot()
  });

  async function appendAudioChunkLocked({ data, mimeType = 'audio/webm', receivedAt = now() } = {}) {
    if (!data || typeof data.arrayBuffer !== 'function') throw new TypeError('audio chunk data must be a Blob.');
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const sequence = nextAudioSequence;
    const checksum = await sha256(bytes, cryptoImpl);
    const snapshot = recorder.snapshot();
    const sealed = await recorder.appendChunk({
      meetingId: snapshot.meetingId,
      recordingId: snapshot.recordingId,
      segmentId: snapshot.segmentId,
      chunkId: `audio-${String(sequence).padStart(8, '0')}`,
      sequence,
      startedAt: receivedAt,
      endedAt: receivedAt,
      byteSize: bytes.byteLength,
      checksum,
      mimeType: normalizeAudioMimeType(mimeType)
    }, bytes);
    nextAudioSequence += 1;
    return sealed;
  }
}

async function sha256(bytes, cryptoImpl) {
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeAudioMimeType(value) {
  const mimeType = String(value || 'audio/webm').trim();
  return mimeType.startsWith('audio/') ? mimeType : 'audio/webm';
}

function defaultOperationId(type) {
  return `${type}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random()}`}`;
}
