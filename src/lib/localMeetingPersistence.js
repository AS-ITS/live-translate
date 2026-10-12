import { createLocalMeetingRecorder } from './localMeetingRecorder.js';
import { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } from './localMeetingStorage.js';
import { composeLocalMeetingAudioArtifact } from './localMeetingAudioExport.js';
import { createLocalMeetingRetention } from './localMeetingRetention.js';
import { recordLivePipelineTrace } from './livePipelineTrace.js';

export function createLocalMeetingPersistence({
  manifestStore = createIndexedDbLocalMeetingManifestStore(),
  chunkStore = createOpfsChunkStore(),
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  createOperationId = defaultOperationId,
  recordAudio = true,
  composeAudioArtifact = composeLocalMeetingAudioArtifact,
  trace = recordLivePipelineTrace,
  diagnostics = null
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') throw new Error('Web Crypto is unavailable.');
  const reportDiagnostic = (method, ...args) => {
    try { diagnostics?.[method]?.(...args); } catch { /* Diagnostics must never interrupt local recording. */ }
  };
  const createRecorder = () => createLocalMeetingRecorder({ manifestStore, chunkStore, now, onTrace: trace });
  let recorder = createRecorder();
  const retention = typeof manifestStore.getRetention === 'function'
    ? createLocalMeetingRetention({ manifestStore, chunkStore, now })
    : { check: async () => {}, assertReadable: async () => {}, withRead: async (_meetingId, work) => work() };
  let activeMeetingId = null;
  let recordingEnabled = recordAudio === true;
  let nextAudioSequence = 1;
  let appendQueue = Promise.resolve();

  return Object.freeze({
    saveContinueOperation(input) {
      return manifestStore.saveContinueOperation(input);
    },
    getPendingContinueOperation(meetingId) {
      return manifestStore.getPendingContinueOperation(meetingId);
    },
    async start({ meetingId, recordingId, segmentId } = {}) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      await appendQueue;
      if (activeMeetingId && activeMeetingId !== meetingId) {
        recorder = createRecorder();
        appendQueue = Promise.resolve();
      }
      if (!recordingEnabled) {
        activeMeetingId = meetingId || null;
        return Object.freeze({ state: 'disabled', meetingId: activeMeetingId, recordingId: recordingId || null, segmentId: segmentId || null });
      }
      const restored = await recorder.restore(meetingId);
      activeMeetingId = meetingId;
      const chunks = await manifestStore.list(meetingId);
      updateManifestDiagnostics(chunks);
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

    rolloverLocalSegment({ operationId, nextSegmentId } = {}) {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      const task = appendQueue.then(async () => {
        await retention.assertReadable(activeMeetingId);
        return recorder.rolloverLocalSegment({
          operationId: operationId || createOperationId('local-segment-rollover'),
          nextSegmentId
        });
      });
      appendQueue = task.catch(() => {});
      return task;
    },

    appendAudioChunk(chunk = {}) {
      if (!recordingEnabled) return Promise.resolve(null);
      const task = appendQueue.then(async () => {
        await retention.assertReadable(activeMeetingId);
        return appendAudioChunkLocked(chunk);
      });
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
        ? await retention.withRead(activeMeetingId,
          () => composeAudioArtifact({ chunks: sealed, readChunk: (path) => chunkStore.read(path) }))
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
      return retention.withRead(meetingId, async () => {
      const targetRecorder = activeMeetingId === meetingId ? recorder : createRecorder();
      const recording = await targetRecorder.restore(meetingId);
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
      });
    },

    setRecordingEnabled(value) {
      recordingEnabled = value === true;
      return recordingEnabled;
    },

    async getLocalAudioStatus(meetingId = activeMeetingId) {
      if (!meetingId) return 'idle';
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      const targetRecorder = activeMeetingId === meetingId ? recorder : createRecorder();
      const [recording, chunks] = await Promise.all([targetRecorder.restore(meetingId), manifestStore.list(meetingId)]);
      const sealedChunks = chunks.filter((chunk) => chunk.state === 'sealed');
      if (recording.state === 'stopped_local' && sealedChunks.length > 0) return 'ready';
      if (['capturing', 'paused', 'stopping', 'stop_incomplete'].includes(recording.state) || chunks.length > 0) return 'processing';
      return 'idle';
    },

    async saveCue({ meetingId, segmentId, sessionId, cue, producedAt } = {}) {
      await retention.assertReadable(meetingId);
      return manifestStore.saveCue({ meetingId, segmentId, sessionId, cue, producedAt });
    },

    async listCues(meetingId, options) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.listCues(meetingId, options);
    },

    async updateCheckpoint(payload = {}) {
      await retention.assertReadable(payload.meetingId);
      const saved = await manifestStore.saveCheckpoint({
        meetingId: payload.meetingId,
        segmentId: payload.segmentId,
        checkpoint: payload
      });
      return { checkpoint: saved.checkpoint };
    },

    async getCheckpoint({ meetingId, segmentId } = {}) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.getCheckpoint(meetingId, segmentId);
    },

    async restore(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      await appendQueue;
      if (activeMeetingId && activeMeetingId !== meetingId) {
        recorder = createRecorder();
        appendQueue = Promise.resolve();
      }
      const [recording, cues, chunks] = await Promise.all([
        recorder.restore(meetingId),
        manifestStore.listCues(meetingId),
        manifestStore.list(meetingId)
      ]);
      activeMeetingId = meetingId;
      updateManifestDiagnostics(chunks);
      nextAudioSequence = chunks.reduce((next, chunk) => Math.max(next, chunk.sequence + 1), 1);
      return Object.freeze({ recording, cues, chunks });
    },

    snapshot: () => recorder.snapshot()
  });

  async function appendAudioChunkLocked({ data, mimeType = 'audio/webm', receivedAt = now(), descriptor: retryDescriptor = null } = {}) {
    if (!data || typeof data.arrayBuffer !== 'function') throw new TypeError('audio chunk data must be a Blob.');
    const appendStartedAt = now();
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const snapshot = recorder.snapshot();
    const descriptor = retryDescriptor
      ? await immutableRetryDescriptor(retryDescriptor, snapshot, bytes, cryptoImpl)
      : await createImmutableChunkDescriptor({ snapshot, bytes, mimeType, receivedAt });
    const previous = retryDescriptor && typeof manifestStore.get === 'function'
      ? await manifestStore.get(descriptor.chunkId)
      : null;
    const newlyReserved = !previous;
    reportDiagnostic('recordOpfsAppendStarted', { bytes: bytes.byteLength });
    reportDiagnostic('recordOpfsChunkReserved', { bytes: descriptor.byteSize, isRetry: !newlyReserved });
    try {
      trace?.({
        stage: 'LOCAL_CHUNK_RECEIVED',
        meetingId: descriptor.meetingId,
        recordingId: descriptor.recordingId,
        segmentId: descriptor.segmentId,
        chunkId: descriptor.chunkId,
        sequence: descriptor.sequence,
        captureEpoch: snapshot.captureEpoch,
        providerEpoch: snapshot.providerEpoch,
        pcmBytes: descriptor.byteSize,
        receivedAt
      });
    } catch { /* Diagnostics must never interrupt local recording. */ }
    nextAudioSequence = Math.max(nextAudioSequence, descriptor.sequence + 1);
    try {
      const result = await recorder.appendChunk(descriptor, bytes);
      const newlySealed = previous?.state !== 'sealed';
      reportDiagnostic('recordOpfsChunkSealed', { bytes: descriptor.byteSize, wasUnsealed: newlySealed });
      reportDiagnostic('recordOpfsAppendFinished', {
        bytes: descriptor.byteSize,
        durationMs: Math.max(0, now() - appendStartedAt),
        status: 'sealed',
        newlySealed
      });
      return result;
    } catch (error) {
      if (newlyReserved && typeof manifestStore.get === 'function') {
        try {
          const retained = await manifestStore.get(descriptor.chunkId);
          if (!retained) reportDiagnostic('recordOpfsChunkDiscarded', { bytes: descriptor.byteSize });
        } catch { /* Diagnostics must never replace the recording error. */ }
      }
      reportDiagnostic('recordOpfsAppendFinished', {
        bytes: descriptor.byteSize,
        durationMs: Math.max(0, now() - appendStartedAt),
        status: 'failed',
        newlySealed: false
      });
      if (error && typeof error === 'object') error.localChunkDescriptor = descriptor;
      throw error;
    }
  }

  function updateManifestDiagnostics(chunks = []) {
    const sealed = chunks.filter((chunk) => chunk.state === 'sealed');
    const unsealed = chunks.filter((chunk) => chunk.state !== 'sealed');
    reportDiagnostic('setOpfsManifest', {
      sealedBytes: sealed.reduce((sum, chunk) => sum + (Number(chunk.byteSize) || 0), 0),
      unsealedCount: unsealed.length,
      unsealedBytes: unsealed.reduce((sum, chunk) => sum + (Number(chunk.byteSize) || 0), 0)
    });
  }

  async function createImmutableChunkDescriptor({ snapshot, bytes, mimeType, receivedAt }) {
    const sequence = nextAudioSequence;
    return Object.freeze({
      meetingId: snapshot.meetingId,
      recordingId: snapshot.recordingId,
      segmentId: snapshot.segmentId,
      chunkId: `${snapshot.recordingId}:audio-${String(sequence).padStart(8, '0')}`,
      sequence,
      startedAt: receivedAt,
      endedAt: receivedAt,
      byteSize: bytes.byteLength,
      checksum: await sha256(bytes, cryptoImpl),
      mimeType: normalizeAudioMimeType(mimeType)
    });
  }
}

async function immutableRetryDescriptor(value, snapshot, bytes, cryptoImpl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('audio chunk descriptor must be an object.');
  }
  const descriptor = Object.freeze({ ...value });
  if (descriptor.meetingId !== snapshot.meetingId
    || descriptor.recordingId !== snapshot.recordingId
    || !Number.isSafeInteger(descriptor.sequence)
    || descriptor.sequence < 1
    || descriptor.byteSize !== bytes.byteLength
    || descriptor.checksum !== await sha256(bytes, cryptoImpl)) {
    const error = new Error('local_chunk_retry_identity_conflict');
    error.code = 'local_chunk_retry_identity_conflict';
    error.status = 409;
    throw error;
  }
  return descriptor;
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
