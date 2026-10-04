import { createLocalMeetingRecorder } from './localMeetingRecorder.js';
import { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } from './localMeetingStorage.js';
import { composeLocalMeetingAudioArtifact } from './localMeetingAudioExport.js';

export function createLocalMeetingPersistence({
  manifestStore = createIndexedDbLocalMeetingManifestStore(),
  chunkStore = createOpfsChunkStore(),
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  createOperationId = defaultOperationId,
  recordAudio = true,
  composeAudioArtifact = composeLocalMeetingAudioArtifact
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') throw new Error('Web Crypto is unavailable.');
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore, now });
  let activeMeetingId = null;
  let recordingEnabled = recordAudio === true;
  let nextAudioSequence = 1;
  let appendQueue = Promise.resolve();

  return Object.freeze({
    async start({ meetingId, recordingId, segmentId } = {}) {
      if (!recordingEnabled) {
        activeMeetingId = meetingId || null;
        return Object.freeze({ state: 'disabled', meetingId: activeMeetingId, recordingId: recordingId || null, segmentId: segmentId || null });
      }
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
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.pause({ operationId: createOperationId('pause') });
    },

    resume() {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.resume({ operationId: createOperationId('resume') });
    },

    providerReconnect() {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.providerReconnect({ operationId: createOperationId('provider-reconnect') });
    },

    providerRollover() {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.providerRollover({ operationId: createOperationId('provider-rollover') });
    },

    appendAudioChunk(chunk = {}) {
      if (!recordingEnabled) return Promise.resolve(null);
      const task = appendQueue.then(() => appendAudioChunkLocked(chunk));
      appendQueue = task.catch(() => {});
      return task;
    },

    async finalizeAudio({ fileName = '' } = {}) {
      if (!recordingEnabled) return { status: 'skipped', blob: null, fileName: '', mimeType: '', errorMessage: '' };
      await appendQueue;
      const chunks = await manifestStore.list(activeMeetingId);
      const sealed = chunks.filter((chunk) => chunk.state === 'sealed').sort((left, right) => left.sequence - right.sequence);
      await recorder.finalize({
        finalSequence: sealed.at(-1)?.sequence || 0,
        operationId: createOperationId('finalize')
      });
      const artifact = sealed.length > 0
        ? await composeAudioArtifact({ chunks: sealed, readChunk: (path) => chunkStore.read(path) })
        : null;
      return Object.freeze({
        status: artifact?.blob?.size > 0 ? 'ready' : 'idle',
        blob: artifact?.blob?.size > 0 ? artifact.blob : null,
        mimeType: artifact?.mimeType || '',
        extension: artifact?.extension || '',
        fileName: artifact ? audioFileName(fileName, activeMeetingId, artifact.extension) : '',
        errorMessage: ''
      });
    },

    async listFinalizedAudioArtifacts(meetingId = activeMeetingId) {
      if (!meetingId) return [];
      const recording = await recorder.restore(meetingId);
      if (recording.state !== 'stopped_local') return [];
      const chunks = (await manifestStore.list(meetingId))
        .filter((chunk) => chunk.state === 'sealed')
        .sort((left, right) => left.sequence - right.sequence);
      if (chunks.length === 0) return [];
      const artifact = await composeAudioArtifact({ chunks, readChunk: (path) => chunkStore.read(path) });
      return [{
        kind: 'input',
        recordingId: recording.recordingId,
        captureEpoch: recording.captureEpoch,
        providerEpoch: recording.providerEpoch,
        fileName: audioFileName('', recording.recordingId || meetingId, artifact.extension),
        mimeType: artifact.mimeType,
        blob: artifact.blob,
        captureSegmentCount: artifact.captureSegmentCount,
        segments: chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          sequence: chunk.sequence,
          segmentId: chunk.segmentId,
          captureEpoch: recording.captureEpoch,
          providerEpoch: recording.providerEpoch,
          byteSize: chunk.byteSize,
          checksum: chunk.checksum
        }))
      }];
    },

    setRecordingEnabled(value) {
      recordingEnabled = value === true;
      return recordingEnabled;
    },

    async getLocalAudioStatus(meetingId = activeMeetingId) {
      if (!meetingId) return 'idle';
      const [recording, chunks] = await Promise.all([recorder.restore(meetingId), manifestStore.list(meetingId)]);
      const sealedChunks = chunks.filter((chunk) => chunk.state === 'sealed');
      if (recording.state === 'stopped_local' && sealedChunks.length > 0) return 'ready';
      if (['capturing', 'paused', 'stopping', 'stop_incomplete'].includes(recording.state) || chunks.length > 0) return 'processing';
      return 'idle';
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

function audioFileName(requestedName, identity, extension) {
  const safeExtension = extension || 'webm';
  if (requestedName) return requestedName.replace(/\.(?:webm|ogg|m4a|mp4|wav)$/iu, `.${safeExtension}`);
  return `${identity || 'meeting'}-input.${safeExtension}`;
}

function normalizeAudioMimeType(value) {
  const mimeType = String(value || 'audio/webm').trim();
  return mimeType.startsWith('audio/') ? mimeType : 'audio/webm';
}

function defaultOperationId(type) {
  return `${type}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random()}`}`;
}
