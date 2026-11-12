import { createLocalMeetingRecorder } from './localMeetingRecorder.js';
import { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore, localTransactionFailureState } from './localMeetingStorage.js';
import { composeLocalMeetingAudioArtifact } from './localMeetingAudioExport.js';
import { createLocalMeetingRetention } from './localMeetingRetention.js';
import { recordLivePipelineTrace } from './livePipelineTrace.js';
import { createDurablePcmJournalClient } from './durablePcmJournalClient.js';
import { recordAudioFailure } from './audioFailureDiagnostic.js';
import { pcm16ChunksToWavBlob } from './audio.js';

function safeAppendFailure(error, operation, { recordingId, segmentId } = {}) {
  const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null;
  const safeCode = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value
    : typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value) ? value : null;
  return { phase: 'LOCAL_APPEND', operation,
    exceptionName: safeCode(error?.name), exceptionCode: safeCode(error?.code),
    transactionState: localTransactionFailureState(error),
    recordingId: safeId(recordingId), segmentId: safeId(segmentId),
    writerJobRegistered: null, writerAck: false };
}

export function createLocalMeetingPersistence({
  manifestStore = createIndexedDbLocalMeetingManifestStore(),
  chunkStore = createOpfsChunkStore(),
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  createOperationId = defaultOperationId,
  recordAudio = true,
  composeAudioArtifact = composeLocalMeetingAudioArtifact,
  trace = recordLivePipelineTrace,
  journalClientFactory = createDurablePcmJournalClient,
  ownerAccess = null
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') throw new Error('Web Crypto is unavailable.');
  const createRecorder = () => createLocalMeetingRecorder({ manifestStore, chunkStore, now, onTrace: trace });
  let recorder = createRecorder();
  const retention = typeof manifestStore.getRetention === 'function'
    ? createLocalMeetingRetention({ manifestStore, chunkStore, now })
    : { check: async () => {}, assertReadable: async () => {},
      withRead: async (_meetingId, work) => work(), withWrite: async (_meetingId, work) => work() };
  let activeMeetingId = null;
  let localLifecycleActive = false;
  let recordingEnabled = recordAudio === true;
  let nextAudioSequence = 1;
  let appendQueue = Promise.resolve();
  let appendQueueDepth = 0;
  let inputAudioError = null;
  let segmentOwnershipError = null;
  let translatedAudioQueue = Promise.resolve();
  let translatedQueueDepth = 0;
  let translatedAudioError = null;
  let nextTranslatedAudioSequence = null;

  const api = Object.freeze({
    async startLifecycle({ meetingId, recordingId, segmentId, operationId, pcmEnabled = false } = {}) {
      const ownerBinding = ownerAccess ? await ownerAccess.bindingForStart(meetingId, manifestStore) : null;
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      await appendQueue;
      if (activeMeetingId && activeMeetingId !== meetingId) {
        recorder = createRecorder();
        nextAudioSequence = 1;
        inputAudioError = null;
        segmentOwnershipError = null;
      }
      await recorder.restore(meetingId);
      activeMeetingId = meetingId;
      localLifecycleActive = true;
      const chunks = await manifestStore.list(meetingId);
      nextAudioSequence = chunks.reduce((next, chunk) => Math.max(next, chunk.sequence + 1), 1);
      const started = await recorder.start(meetingId, { recordingId, segmentId, operationId, pcmEnabled,
        ...ownerBinding });
      if (ownerAccess) await ownerAccess.assertOwner(meetingId, manifestStore);
      return started;
    },
  pauseLifecycle({ operationId, boundaryReceipt } = {}) {
    return recorder.pause({ operationId, boundaryReceipt });
    },
  async continueLifecycle({ operationId, nextSegmentId } = {}) {
    const meetingId = activeMeetingId;
    const existing = await manifestStore.getSegmentTransition(meetingId, operationId);
    if (existing && nextSegmentId && existing.successorId !== nextSegmentId) {
      throw localIntegrityError('INTEGRITY_UNRESOLVED');
    }
    if (existing?.phase === 'COMMITTED') {
      await recorder.restore(meetingId);
      return existing.result;
    }
    const recording = await manifestStore.getRecording(meetingId);
    if (recording?.state !== 'paused' || (recording.pcmEnabled && !recording.pauseBoundary)) {
      throw localIntegrityError('INTEGRITY_UNRESOLVED');
    }
    const boundary = recording.pauseBoundary;
    const successorId = nextSegmentId || `segment:${recording.recordingId}:${recording.segmentNumber + 1}`;
    if (!recording.pcmEnabled) {
      const prepared = existing || await recorder.preparePausedContinue({ operationId, nextSegmentId: successorId });
      const result = await manifestStore.commitSegmentTransition(prepared);
      await recorder.restore(meetingId);
      return result;
    }
    const client = journalClientFactory({ meetingId, recordingId: recording.recordingId,
      existingOnly: true, readOnly: true });
    try {
      const ownership = await this.verifySegmentPcmOwnership(meetingId);
      if (ownership.status !== 'ACTIVE_UNSEALED') {
        const error = localIntegrityError('INTEGRITY_UNRESOLVED');
        error.ownershipStatus = safeOwnershipDiagnostic(ownership.status);
        error.ownershipReason = safeOwnershipDiagnostic(ownership.reason);
        if (ownership.openErrorName !== undefined) {
          error.openErrorName = safeOwnershipDiagnostic(ownership.openErrorName);
          error.openErrorCode = safeOwnershipDiagnostic(ownership.openErrorCode);
        }
        console.info('ISSUE41_PCM_OWNERSHIP', JSON.stringify({
          status: error.ownershipStatus, reason: error.ownershipReason,
          ...(error.openErrorName && { openErrorName: error.openErrorName,
            openErrorCode: error.openErrorCode })
        }));
        throw error;
      }
      const status = await client.open();
      const receipt = await client.verifiedTransitionReceipt(boundary.transitionOperationId);
      if (status.tailState !== 'CLEAN' || status.unclaimedTailBytes > 0
        || !receipt || JSON.stringify(receipt) !== JSON.stringify(boundary)) {
        throw localIntegrityError('INTEGRITY_UNRESOLVED');
      }
      const prepared = existing || await recorder.preparePausedContinue({ operationId, nextSegmentId: successorId,
        boundaryOperationId: boundary.transitionOperationId });
      const result = await manifestStore.commitSegmentTransition({ ...prepared, boundary: receipt });
      await recorder.restore(meetingId);
      return result;
    } finally {
      try { await client.close(); } catch { /* Keep evidence for recovery. */ }
    }
    },
    async endLifecycle({ operationId } = {}) {
      await appendQueue;
      if (inputAudioError) throw inputAudioError;
      return recorder.finalize({ operationId });
    },
    async savePendingCompletion({ meetingId, operationId } = {}) {
      const recording = await manifestStore.getRecording(meetingId);
      if (recording && recording.state !== 'stopped_local') throw new Error('Local recording must be sealed before Meeting End.');
      const previous = await manifestStore.getRetention(meetingId);
      const pendingCompletion = previous?.pendingCompletion || { operationId, sealedAt: new Date(now()).toISOString() };
      await manifestStore.saveRetention({
        meetingId,
        pendingCompletion,
        expiresAt: new Date(Date.parse(pendingCompletion.sealedAt) + 30 * 60 * 1000).toISOString()
      });
      return pendingCompletion;
    },
    async getPendingCompletion(meetingId) {
      return (await manifestStore.getRetention(meetingId))?.pendingCompletion || null;
    },
    async clearPendingCompletion({ meetingId, meeting } = {}) {
      await manifestStore.saveRetention({
        meetingId,
        pendingCompletion: null,
        ...(meeting?.purgeAt || meeting?.expiresAt ? { expiresAt: meeting.purgeAt || meeting.expiresAt } : {})
      });
    },
    saveLifecycleIntent(input) {
      return manifestStore.saveLifecycleIntent(input);
    },
    getLifecycleIntent(ownerUserId, meetingId, originalOperationId) {
      return manifestStore.getLifecycleIntent(ownerUserId, meetingId, originalOperationId);
    },
    listPendingLifecycleIntents(ownerUserId, meetingId) {
      return manifestStore.listPendingLifecycleIntents(ownerUserId, meetingId);
    },
    saveContinueOperation(input) {
      return manifestStore.saveContinueOperation(input);
    },
    getPendingContinueOperation(meetingId) {
      return manifestStore.getPendingContinueOperation(meetingId);
    },
    async start({ meetingId, recordingId, segmentId, operationId } = {}) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      await appendQueue;
      if (activeMeetingId && activeMeetingId !== meetingId) {
        recorder = createRecorder();
        appendQueue = Promise.resolve();
        localLifecycleActive = false;
      inputAudioError = null;
      segmentOwnershipError = null;
      translatedAudioQueue = Promise.resolve();
      translatedAudioError = null;
      nextTranslatedAudioSequence = null;
      }
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
          operationId: operationId || createOperationId('start')
        });
      }
    if ((restored.state === 'paused' || restored.state === 'stop_incomplete')
      && !(await manifestStore.getRecording(meetingId))?.pcmEnabled) {
        return recorder.recover({ operationId: operationId || createOperationId('recover') });
      }
      return restored;
    },

    pause({ operationId } = {}) {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.pause({ operationId: operationId || createOperationId('pause') });
    },

    resume({ operationId } = {}) {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.resume({ operationId: operationId || createOperationId('resume') });
    },

    providerReconnect({ operationId } = {}) {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.providerReconnect({ operationId: operationId || createOperationId('provider-reconnect') });
    },

    providerRollover({ operationId } = {}) {
      if (!recordingEnabled) return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
      return recorder.providerRollover({ operationId: operationId || createOperationId('provider-rollover') });
    },

    prepareLocalSegmentRollover({ operationId, nextSegmentId } = {}) {
      return recorder.prepareSegmentRollover({ operationId, nextSegmentId });
    },
    abortLocalSegmentRollover({ operationId, nextSegmentId, boundaryReceipt } = {}) {
      return recorder.abortSegmentRollover({ operationId, nextSegmentId, boundaryReceipt });
    },
    getSegmentTransition(meetingId, operationId) {
      return manifestStore.getSegmentTransition(meetingId, operationId);
    },
    getLocalRecording(meetingId) {
      return manifestStore.getRecording(meetingId);
    },
    listPendingSegmentTransitions(meetingId) {
      return manifestStore.listPendingSegmentTransitions(meetingId);
    },
    resolveSegmentTransition(input, { abort = false } = {}) {
      return abort ? manifestStore.abortSegmentTransition(input) : manifestStore.commitSegmentTransition(input);
    },
    async recoverSegmentTransitions(meetingId) {
      const pending = await manifestStore.listPendingSegmentTransitions(meetingId);
      const outcomes = [];
      for (const transition of pending) {
        const recording = await manifestStore.getRecording(meetingId);
        if (!recording || recording.recordingId !== transition.recordingId) {
          throw localIntegrityError('INTEGRITY_UNRESOLVED');
        }
        if (!recording.pcmEnabled) {
          outcomes.push(await manifestStore.commitSegmentTransition(transition));
          continue;
        }
        const client = journalClientFactory({ meetingId, recordingId: transition.recordingId,
          existingOnly: true, readOnly: true });
        try {
          const status = await client.open();
          if (status.tailState !== 'CLEAN' || status.unclaimedTailBytes > 0) {
            throw localIntegrityError('INTEGRITY_UNRESOLVED');
          }
        const boundary = await client.verifiedTransitionReceipt(
          transition.boundaryOperationId || transition.operationId);
        if (!boundary && transition.boundaryOperationId) throw localIntegrityError('INTEGRITY_UNRESOLVED');
        outcomes.push(boundary
          ? await manifestStore.commitSegmentTransition({ ...transition, boundary })
          : await manifestStore.abortSegmentTransition(transition));
        } finally {
          try { await client.close(); } catch { /* Leave the evidence in place. */ }
        }
      }
      return outcomes;
    },
    async verifySegmentPcmOwnership(meetingId) {
      return retention.withRead(meetingId, async () => {
        const recording = await manifestStore.getRecording(meetingId);
        if (recording?.integrityVersion !== 2) return { status: 'LEGACY_UNVERIFIED' };
        const segments = await manifestStore.listSegments(meetingId);
        if (!recording.pcmEnabled) return { status: 'NOT_APPLICABLE', segments };
        if ((await manifestStore.listPendingSegmentTransitions(meetingId)).length) {
          return { status: 'INTEGRITY_UNRESOLVED', reason: 'transition_pending' };
        }
        const client = journalClientFactory({ meetingId, recordingId: recording.recordingId,
          existingOnly: true, readOnly: true });
      let openError = null;
        try {
        const journal = await client.open().catch((error) => {
          openError = error;
          throw error;
        });
          if (journal.tailState !== 'CLEAN' || journal.unclaimedTailBytes > 0
            || !segments.length || segments.some((segment) => segment.provenance !== 'native')) {
            return { status: 'INTEGRITY_UNRESOLVED', reason: 'journal_or_segment_unverified' };
          }
      const uncommittedPauseId = `pause:${recording.recordingId}:${recording.segmentId}`;
      const uncommittedPause = recording.state === 'capturing' && !recording.pauseBoundary
        ? await client.verifiedTransitionReceipt(uncommittedPauseId) : null;
      if (uncommittedPause?.transitionOperationId === uncommittedPauseId) {
        return { status: 'INTEGRITY_UNRESOLVED', reason: 'pause_end_without_operation' };
      }
          const stopped = recording.state === 'stopped_local';
          const active = segments.filter((segment) => segment.status === 'ACTIVE');
          if (active.length !== (stopped ? 0 : 1)
            || (!stopped && active[0]?.segmentId !== recording.segmentId)
            || segments[0].firstJournalEpoch !== 1) {
            return { status: 'INTEGRITY_UNRESOLVED', reason: 'segment_lifecycle_conflict' };
          }
          const gaps = await client.readPersistedGaps?.() || [];
          if (gaps.length) return { status: 'INTEGRITY_UNRESOLVED', reason: 'pcm_gap' };
          let nextEpoch = 1;
          for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            const successor = segments[index + 1];
            if (segment.sequence !== index + 1 || segment.firstJournalEpoch !== nextEpoch) {
              return { status: 'INTEGRITY_UNRESOLVED', reason: 'epoch_interval_conflict' };
            }
            const lastEpoch = successor ? segment.lastJournalEpoch : journal.highestEpoch;
            if (!Number.isSafeInteger(lastEpoch) || lastEpoch < nextEpoch - 1) {
              return { status: 'INTEGRITY_UNRESOLVED', reason: 'epoch_interval_conflict' };
            }
            if (successor) {
              const transition = await manifestStore.getSegmentTransition(meetingId, segment.endedByOperationId);
          const receipt = transition && await client.verifiedTransitionReceipt(
            transition.boundaryOperationId || transition.operationId);
              if (segment.status !== 'ENDED' || transition?.phase !== 'COMMITTED'
                || transition.predecessorId !== segment.segmentId
                || transition.successorId !== successor.segmentId
                || !receipt || JSON.stringify(receipt) !== JSON.stringify(transition.boundary)
                || receipt.captureEpoch !== lastEpoch || successor.firstJournalEpoch !== lastEpoch + 1) {
                return { status: 'INTEGRITY_UNRESOLVED', reason: 'boundary_conflict' };
              }
            }
        if (!successor && recording.pauseBoundary) {
          const receipt = await client.verifiedTransitionReceipt(
            recording.pauseBoundary.transitionOperationId);
          if (!receipt || JSON.stringify(receipt) !== JSON.stringify(recording.pauseBoundary)
            || receipt.captureEpoch !== lastEpoch) {
            return { status: 'INTEGRITY_UNRESOLVED', reason: 'pause_boundary_conflict' };
          }
        }
        for (let epoch = nextEpoch; epoch <= lastEpoch; epoch += 1) {
              const summary = await client.coverage(epoch, 0, 0);
              if (!summary.epochClosed || summary.endSample === null
                || (summary.endSample > 0 && !summary.epochBegun)) {
                return { status: 'INTEGRITY_UNRESOLVED', reason: 'epoch_unclosed' };
              }
              const coverage = await client.coverage(epoch, 0, summary.endSample);
              if (!coverage.complete || coverage.gaps.length || coverage.endSample !== summary.endSample) {
                return { status: 'INTEGRITY_UNRESOLVED', reason: 'pcm_coverage_incomplete' };
              }
            }
            nextEpoch = lastEpoch + 1;
          }
          if (nextEpoch !== journal.highestEpoch + 1) {
            return { status: 'INTEGRITY_UNRESOLVED', reason: 'unassigned_epoch' };
          }
          return { status: stopped ? 'PASS' : 'ACTIVE_UNSEALED', segments };
        } catch (error) {
          return { status: 'INTEGRITY_UNRESOLVED', reason: error?.code || error?.name || 'journal_unreadable',
            ...(openError && { openErrorName: error?.name, openErrorCode: error?.code }) };
        } finally {
          try { await client.close(); } catch { /* Never delete or reassign unreadable data. */ }
        }
      });
    },
    listLocalSegments(meetingId) {
      return manifestStore.listSegments(meetingId);
    },
    rolloverLocalSegment({ operationId, nextSegmentId, boundaryReceipt } = {}) {
    if (!recordingEnabled && !localLifecycleActive) {
      segmentOwnershipError = new Error('Local audio Segment rollover is disabled.');
      segmentOwnershipError.code = 'local_segment_ownership_mismatch';
      return Promise.resolve({ state: 'disabled', meetingId: activeMeetingId });
    }
      const task = appendQueue.then(async () => {
        await retention.assertReadable(activeMeetingId);
      const result = await recorder.rolloverLocalSegment({
          operationId: operationId || createOperationId('local-segment-rollover'),
          nextSegmentId, boundaryReceipt
        });
      if (result?.segmentId !== nextSegmentId) {
        const error = new Error('Local audio Segment ownership does not match the lifecycle Segment.');
        error.code = 'local_segment_ownership_mismatch';
        throw error;
      }
      return result;
      });
    appendQueue = task.catch((error) => {
      segmentOwnershipError = error;
    });
    return task;
    },

    appendAudioChunk(chunk = {}) {
      if (!recordingEnabled) return Promise.resolve(null);
      if (segmentOwnershipError) {
        recordAudioFailure({ audioPath: 'ORIGINAL_AUDIO', stage: 'AUDIO_CHUNK_ENQUEUE', operation: 'SEGMENT_OWNERSHIP',
          error: segmentOwnershipError, writerState: recorder.snapshot().state,
          queueDepth: appendQueueDepth, chunkBytes: chunk.data?.size,
          segmentId: recorder.snapshot().segmentId, elapsedMs: 0 });
        return Promise.reject(segmentOwnershipError);
      }
      const startedAt = now();
      appendQueueDepth += 1;
      const task = appendQueue.then(async () => {
        return retention.withWrite(activeMeetingId, () => appendAudioChunkLocked(chunk));
      }).then((result) => {
        if (chunk.descriptor?.chunkId && chunk.descriptor.chunkId === inputAudioError?.localChunkDescriptor?.chunkId) {
          inputAudioError = null;
        }
        return result;
      });
      void task.then(
        () => { appendQueueDepth -= 1; },
        (error) => {
          recordAudioFailure({ audioPath: 'ORIGINAL_AUDIO', stage: error?.audioFailureStage || 'AUDIO_CHUNK_ENQUEUE',
            operation: 'ORIGINAL_AUDIO', error, writerState: recorder.snapshot().state,
            queueDepth: appendQueueDepth, chunkBytes: chunk.data?.size,
            segmentId: recorder.snapshot().segmentId, elapsedMs: now() - startedAt });
          appendQueueDepth -= 1;
        }
      );
      appendQueue = task.catch((error) => {
        if (!inputAudioError) {
          const identity = error?.localChunkDescriptor || recorder.snapshot();
          console.info('ISSUE41_LOCAL_APPEND_FAILURE', safeAppendFailure(error, 'ORIGINAL_AUDIO', identity));
        }
        inputAudioError = error;
      });
      return task;
    },
    async sealSegmentWrites(meetingId = activeMeetingId) {
      await appendQueue;
      await translatedAudioQueue;
      if (meetingId !== activeMeetingId) throw new Error('Local Segment Meeting changed.');
      await retention.assertReadable(meetingId);
      if (inputAudioError) throw inputAudioError;
    if (segmentOwnershipError) throw segmentOwnershipError;
      if (translatedAudioError) throw translatedAudioError;
      return true;
    },
    appendTranslatedAudioChunk({ meetingId = activeMeetingId, sessionId, bytes } = {}) {
      const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes || []);
      if (!meetingId || !sessionId || data.byteLength === 0) throw new TypeError('Translated audio identity and PCM bytes are required.');
      const startedAt = now();
      let stage = 'AUDIO_CHUNK_ENQUEUE';
      translatedQueueDepth += 1;
      const task = translatedAudioQueue.catch(() => {}).then(() => retention.withWrite(meetingId, async () => {
        if (activeMeetingId !== meetingId) throw new Error('Translated audio Meeting changed.');
        if (nextTranslatedAudioSequence === null) {
          const existing = await manifestStore.listTranslatedAudioChunks(meetingId);
          nextTranslatedAudioSequence = existing.reduce((next, chunk) => Math.max(next, chunk.sequence + 1), 1);
        }
        const sequence = nextTranslatedAudioSequence++;
        const path = `meetings/${meetingId}/translated-audio/${sessionId}/${String(sequence).padStart(8, '0')}.pcm`;
        stage = 'AUDIO_CHUNK_WRITE';
        await chunkStore.write(path, data);
        stage = 'AUDIO_SEGMENT_COMMIT';
        return manifestStore.saveTranslatedAudioChunk({
          meetingId, sessionId, sequence, path, byteSize: data.byteLength,
          checksum: await sha256(data, cryptoImpl)
        });
      }));
      void task.then(
        () => { translatedQueueDepth -= 1; },
        (error) => {
          recordAudioFailure({ audioPath: 'TRANSLATED_AUDIO', stage, operation: 'TRANSLATED_AUDIO', error,
            writerState: recorder.snapshot().state, queueDepth: translatedQueueDepth,
            chunkBytes: data.byteLength, segmentId: recorder.snapshot().segmentId,
            elapsedMs: now() - startedAt });
          translatedQueueDepth -= 1;
        }
      );
      translatedAudioQueue = task.catch((error) => {
        if (!translatedAudioError) console.info('ISSUE41_LOCAL_APPEND_FAILURE', safeAppendFailure(
          error, 'TRANSLATED_AUDIO', { recordingId: sessionId, segmentId: recorder.snapshot().segmentId }
        ));
        translatedAudioError = error;
      });
      return task;
    },
    async finalizeTranslatedAudio(meetingId = activeMeetingId) {
      await translatedAudioQueue;
      if (translatedAudioError) throw translatedAudioError;
      const chunks = await retention.withRead(meetingId, () => manifestStore.listTranslatedAudioChunks(meetingId));
    if (chunks.length > 0 && !translatedAudioSequenceComplete(chunks)) throw localIntegrityError('INTEGRITY_UNRESOLVED');
      return Object.freeze({ status: chunks.length > 0 ? 'sealed' : 'idle', kind: 'translation', blob: null });
    },

    async finalizeAudio({ fileName = '', operationId } = {}) {
      if (!recordingEnabled) return { status: 'skipped', blob: null, fileName: '', mimeType: '', errorMessage: '' };
      await appendQueue;
      if (inputAudioError) throw inputAudioError;
      const chunks = await manifestStore.list(activeMeetingId);
      const sealed = chunks.filter((chunk) => chunk.state === 'sealed').sort((left, right) => left.sequence - right.sequence);
      if (sealed.length === 0 || sealed.length !== chunks.length) {
        throw new Error('Local audio chunks are not completely sealed.');
      }
      try { globalThis.__issue41RamStage?.({ stage: 'recorder_finalize', state: 'start', at: Date.now(), chunkCount: sealed.length, inputBytes: sealed.reduce((sum, chunk) => sum + (chunk.byteSize || 0), 0) }); } catch { /* Diagnostic only. */ }
      try {
        await recorder.finalize({
          finalSequence: sealed.at(-1)?.sequence || 0,
          operationId: operationId || createOperationId('finalize')
        });
        try { globalThis.__issue41RamStage?.({ stage: 'recorder_finalize', state: 'complete', at: Date.now(), chunkCount: sealed.length }); } catch { /* Diagnostic only. */ }
      } catch (error) {
        try { globalThis.__issue41RamStage?.({ stage: 'recorder_finalize', state: 'failed', at: Date.now(), errorName: error?.name || 'Error' }); } catch { /* Diagnostic only. */ }
        throw error;
      }
      return Object.freeze({
        status: 'sealed',
        blob: null,
        mimeType: '',
        extension: '',
        fileName: audioFileName(fileName, activeMeetingId, 'webm'),
        errorMessage: ''
      });
    },

    async listFinalizedAudioArtifactMetadata(meetingId = activeMeetingId) {
      if (!meetingId) return [];
      return retention.withRead(meetingId, async () => {
        const targetRecorder = activeMeetingId === meetingId ? recorder : createRecorder();
        const [recording, chunks, translated] = await Promise.all([
          targetRecorder.restore(meetingId), manifestStore.list(meetingId),
          manifestStore.listTranslatedAudioChunks(meetingId)
        ]);
        return [
          ...(recording.state === 'stopped_local' && chunks.some((chunk) => chunk.state === 'sealed')
            ? [{ kind: 'input', status: 'sealed', meetingId, recordingId: recording.recordingId }] : []),
        ...(translatedAudioSequenceComplete(translated)
          ? [{ kind: 'translation', status: 'sealed', meetingId }] : [])
        ];
      });
    },

    async listFinalizedAudioArtifacts(meetingId = activeMeetingId, { kind = '' } = {}) {
      if (!meetingId) return [];
      return retention.withRead(meetingId, async () => {
        const translated = kind === 'input' ? null : await readTranslatedAudioArtifact(meetingId);
        if (kind === 'translation') return translated ? [translated] : [];
      const targetRecorder = activeMeetingId === meetingId ? recorder : createRecorder();
      const recording = await targetRecorder.restore(meetingId);
        if (recording.state !== 'stopped_local') return translated ? [translated] : [];
      const chunks = (await manifestStore.list(meetingId))
        .filter((chunk) => chunk.state === 'sealed')
        .sort((left, right) => left.sequence - right.sequence);
        if (chunks.length === 0) return translated ? [translated] : [];
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
        }, ...(translated ? [translated] : [])];
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
      if (recording.state === 'stopped_local' && sealedChunks.length > 0) return 'sealed';
      if (['capturing', 'paused', 'stopping', 'stop_incomplete'].includes(recording.state) || chunks.length > 0) return 'processing';
      return 'idle';
    },


    async commitCueMutation(input = {}) {
      await retention.assertReadable(input.meetingId);
      return manifestStore.commitCueMutation(input);
    },
    async saveCheckpointFailure(input) {
      return manifestStore.saveCheckpointFailure(input);
    },
    async listCheckpointFailures(meetingId) {
      return manifestStore.listCheckpointFailures(meetingId);
    },

    async listPendingCues(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.listPendingCues(meetingId);
    },

    async inspectCueAuthority(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.inspectCueAuthority(meetingId);
    },

    async listCueConflicts(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.listCueConflicts(meetingId);
    },

    async upgradeLegacyCues(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.upgradeLegacyCues(meetingId);
    },

    async getUnassignedCue(meetingId, sessionId, cueId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.getUnassignedCue(meetingId, sessionId, cueId);
    },

    async listUnassignedCues(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.listUnassignedCues(meetingId);
    },

    async countUnassignedCues(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.countUnassignedCues(meetingId);
    },

    async listCues(meetingId, options) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.listCues(meetingId, options);
    },
    async saveTranscriptItem(input) {
      await retention.assertReadable(input.meetingId);
      return manifestStore.saveTranscriptItem(input);
    },
    async listTranscriptItems(meetingId) {
      await retention.check(meetingId);
      await retention.assertReadable(meetingId);
      return manifestStore.listTranscriptItems(meetingId);
    },
    async contentSnapshot(meetingId) {
      await retention.check(meetingId);
      return retention.withRead(meetingId, async () => {
        const [recording, cues, transcripts, checkpoints] = await Promise.all([
          manifestStore.getRecording(meetingId), manifestStore.listCues(meetingId),
          manifestStore.listTranscriptItems(meetingId), manifestStore.listCheckpoints(meetingId)
        ]);
        return Object.freeze({ meetingId, recording, cues, transcripts, checkpoints });
      });
    },

    async updateCheckpoint(payload = {}) {
      await retention.assertReadable(payload.meetingId);
      const cueAuthority = await manifestStore.inspectCueAuthority(payload.meetingId);
      if (cueAuthority === 'legacy_readonly') {
        const error = new Error('Cue content is read only for this meeting.');
        error.code = 'cue_legacy_readonly';
        throw error;
      }
      const checkpointPayload = { ...payload, finalCues: [], cueCheckpoint: null, refinedSubtitleCues: [] };
      const saved = await manifestStore.saveCheckpointCursor({
        meetingId: payload.meetingId,
        segmentId: payload.segmentId,
        checkpoint: checkpointPayload
      });
      return {
        meetingId: saved.meetingId,
        segmentId: saved.segmentId,
        checkpoint: saved.checkpoint
      };
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
      inputAudioError = null;
      translatedAudioQueue = Promise.resolve();
      translatedAudioError = null;
      nextTranslatedAudioSequence = null;
      }
      const [recording, cues, chunks, transcripts] = await Promise.all([
        recorder.restore(meetingId),
        manifestStore.listCues(meetingId),
        manifestStore.list(meetingId),
        manifestStore.listTranscriptItems(meetingId)
      ]);
      activeMeetingId = meetingId;
      nextAudioSequence = chunks.reduce((next, chunk) => Math.max(next, chunk.sequence + 1), 1);
      return Object.freeze({ recording, cues, chunks, transcripts });
    },

    snapshot: () => recorder.snapshot()
  });
  if (!ownerAccess) return api;
  const guardedMethods = new Set([
    'getLifecycleIntent', 'listPendingLifecycleIntents', 'getPendingContinueOperation',
    'savePendingCompletion', 'getPendingCompletion', 'clearPendingCompletion',
    'getSegmentTransition', 'getLocalRecording', 'listPendingSegmentTransitions',
    'recoverSegmentTransitions', 'verifySegmentPcmOwnership', 'listLocalSegments',
    'start', 'continueLifecycle', 'pauseLifecycle', 'endLifecycle', 'restore',
    'finalizeAudio', 'finalizeTranslatedAudio',
    'listFinalizedAudioArtifactMetadata', 'listFinalizedAudioArtifacts', 'getLocalAudioStatus',
    'getUnassignedCue', 'listUnassignedCues', 'countUnassignedCues', 'listCues',
    'listTranscriptItems', 'contentSnapshot', 'getCheckpoint'
  ]);
  const protectedApi = {};
  for (const [name, method] of Object.entries(api)) {
    if (!guardedMethods.has(name)) continue;
    protectedApi[name] = (...args) => {
      const input = args[0];
      const meetingId = (name === 'getLifecycleIntent' || name === 'listPendingLifecycleIntents')
        ? args[1]
        : typeof input === 'string' ? input
          : input?.meetingId || input?.upserts?.[0]?.meetingId || input?.removals?.[0]?.meetingId || activeMeetingId;
      return ownerAccess.withOwner(meetingId, manifestStore, () => method.apply(api, args));
    };
  }
  return Object.freeze({ ...api, ...protectedApi });

  async function readTranslatedAudioArtifact(meetingId) {
    const chunks = await manifestStore.listTranslatedAudioChunks(meetingId);
    if (chunks.length === 0) return null;
    if (!translatedAudioSequenceComplete(chunks)) throw localIntegrityError('INTEGRITY_UNRESOLVED');
    const parts = [];
    for (const chunk of chunks.sort((left, right) => left.sequence - right.sequence)) {
      const bytes = new Uint8Array(await (await chunkStore.read(chunk.path)).arrayBuffer());
      if (bytes.byteLength !== chunk.byteSize || await sha256(bytes, cryptoImpl) !== chunk.checksum) {
        throw new Error('Local translated audio chunk is missing or corrupt.');
      }
      parts.push(bytes);
    }
    return Object.freeze({
      status: 'ready', kind: 'translation',
      fileName: `${meetingId}-translation.wav`, mimeType: 'audio/wav',
      blob: pcm16ChunksToWavBlob(parts), captureSegmentCount: chunks.length
    });
  }

  async function appendAudioChunkLocked({ data, mimeType = 'audio/webm', receivedAt = now(), descriptor: retryDescriptor = null } = {}) {
    if (!data || typeof data.arrayBuffer !== 'function') throw new TypeError('audio chunk data must be a Blob.');
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const snapshot = recorder.snapshot();
    const descriptor = retryDescriptor
      ? await immutableRetryDescriptor(retryDescriptor, snapshot, bytes, cryptoImpl)
      : await createImmutableChunkDescriptor({ snapshot, bytes, mimeType, receivedAt });
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
      return await recorder.appendChunk(descriptor, bytes);
    } catch (error) {
      if (error && typeof error === 'object') error.localChunkDescriptor = descriptor;
      throw error;
    }
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

function translatedAudioSequenceComplete(chunks) {
  return chunks.length > 0 && chunks.map((chunk) => chunk.sequence).sort((a, b) => a - b)
    .every((sequence, index) => sequence === index + 1);
}

function localIntegrityError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeOwnershipDiagnostic(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 255) return value;
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
    ? value : 'REDACTED';
}
