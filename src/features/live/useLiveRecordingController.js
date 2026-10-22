import { useMemo, useRef } from 'react';
import { createMicrophoneRecordingController } from '../../lib/microphoneRecording.js';
import { cloudMeetingAudioEnabled, uploadMeetingSegmentAudio } from '../../lib/meetingAudioStorage.js';
import { createLiveAudioBindings } from './liveAudioBindings.js';
import {
  applySubtitleCueEvent,
  commitSubtitleCueState,
  finalizePendingSubtitleCue,
  markNumericCorrectionRequested,
  prepareSubtitleCueStateForNewSegment
} from '../../lib/subtitleCues.js';
import { missingNumericIntegrity } from '../../lib/numericIntegrity.js';
function commitCueTransition(cue, previous, proposed) {
  if (typeof cue.commit === 'function') return cue.commit(previous, proposed);
  const result = commitSubtitleCueState(cue.stateRef.current, proposed, { baseState: previous });
  if (!result.accepted) return result.state;
  cue.stateRef.current = result.state;
  cue.setState?.(result.state);
  cue.persist?.(previous, result.state);
  return result.state;
}

import { enqueueLiveCueEvent } from '../../lib/liveCueEventQueue.js';
import { applyGlossaryCorrectionsToCueState } from '../../lib/glossaryReplacement.js';
import { configureLivePipelineElapsedContext, recordLivePipelineTrace } from '../../lib/livePipelineTrace.js';
import { effectiveTranslationForCue } from '../../lib/cueContent.js';
import { translationComparisonDiagnostics } from '../../lib/translationComparisonDiagnostics.js';
import { createSessionSnapshotSyncCoordinator } from '../../lib/sessionSnapshotSyncCoordinator.js';
import { checkpointChunksForTranscriptItems, createMeetingCheckpointSyncCoordinator } from '../../lib/meetingCheckpointSyncCoordinator.js';
import { createReconnectController } from '../../lib/reconnectController.js';
import { createSegmentSwitchOrchestrator } from '../../lib/segmentSwitchOrchestrator.js';
import { createRolloverRecoveryCoordinator } from '../../lib/rolloverRecoveryCoordinator.js';
import { createProviderRecoveryCoordinator } from '../../lib/providerRecoveryCoordinator.js';
import {
  completeDurableLegacyContinue,
  establishDurableLegacyContinue,
  isRecoverableLegacyContinueError
} from '../../lib/durableLegacyContinue.js';
import { selectedMeetingGlossaryEntries } from '../../lib/meetingGlossary.js';
import { appendNewFinalTranscriptItems, buildSessionRecordInput, createActiveSessionRecord } from '../../lib/sessionRecordLifecycle.js';
import { clearMeetingAudioPreference } from '../../lib/meetingAudioPreferences.js';
import { finalizePendingTranscriptItems, transcriptItemsForStream } from '../../lib/transcript.js';
import { createRecoverySingleFlight } from '../../lib/recoverySingleFlight.js';
import { createSegmentTransitionLock } from '../../lib/segmentTransitionLock.js';
import { stopSessionSafely } from '../../lib/stopSessionSafely.js';
import { clearMeetingLifecycleWriteFence, setMeetingLifecycleWriteFence } from '../../lib/meetingLifecycleWriteFence.js';
import { isMissingSelectedInputError, requestAudioInputStream } from '../../lib/mediaDevices.js';

const INPUT_AUDIO_RECORDING_SKIPPED_STATE = {
  status: 'skipped',
  blob: null,
  mimeType: '',
  extension: '',
  fileName: '',
  errorMessage: ''
};

const TRANSLATED_AUDIO_IDLE_STATE = {
  status: 'idle',
  blob: null,
  fileName: '',
  errorMessage: ''
};

const SESSION_SNAPSHOT_SYNC_DELAY_MS = 1000;
const SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE = 20;

export async function warmUpMicrophoneInput({
  inputDeviceId = '',
  requestStream = requestAudioInputStream,
  onInputDeviceFallback = () => {}
} = {}) {
  try {
    return await requestStream(inputDeviceId);
  } catch (error) {
    if (!inputDeviceId || !isMissingSelectedInputError(error)) throw error;
    onInputDeviceFallback();
    return requestStream('');
  }
}

function stopMicrophoneStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop?.();
}

export function activateRecoveredMeetingSegment({
  meetingId,
  recoveryResult,
  activeMeetingCheckpointRef,
  startCheckpointSync
} = {}) {
  const segmentId = recoveryResult?.segment?.id;
  if (!meetingId || !segmentId || !activeMeetingCheckpointRef || typeof startCheckpointSync !== 'function') {
    throw new TypeError('Recovered meeting segment activation requires meetingId, segment, ref, and sync callback.');
  }
  const checkpoint = { meetingId, segmentId,
    ...(Number.isSafeInteger(recoveryResult.segment.sequence) ? { segmentSequence: recoveryResult.segment.sequence } : {}) };
  activeMeetingCheckpointRef.current = checkpoint;
  startCheckpointSync(checkpoint);
  return checkpoint;
}

export function meetingRequestErrorMessage(error, fallback = '會議操作失敗。') {
  if (!error?.operation) return error?.message || fallback;
  const operation = error.operation === 'recover-segment' ? 'recover'
    : error.operation === 'update-checkpoint' || error.operation === 'get-checkpoint' ? 'checkpoint'
      : error.operation;
  const status = error.status ? ` HTTP ${error.status}` : '';
  const code = error.code ? `（${error.code}）` : '';
  const requestId = error.requestId ? `；requestId：${error.requestId}` : '';
  const action = error.status === 409
    ? '會議狀態有衝突，已停止自動重試；請從會議管理重新進入此會議，仍失敗時提供 requestId。'
    : '本機錄音資料未清除；請確認網路後再按「繼續錄製」。';
  return `${operation}${status}${code} 失敗${requestId}。${action}`;
}
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;

/**
 * View-model boundary for the live recording surface.
 *
 * The application shell owns route and service composition. Live pages should
 * consume this object instead of knowing how live state is assembled. Keeping
 * the boundary explicit also lets the lifecycle implementation move here in
 * small batches without changing the page contract.
 */
function isPersistableFinalCue(cue) {
  return Boolean(
    cue
    && typeof cue.cueId === 'string' && cue.cueId.trim() !== ''
    && typeof cue.sessionId === 'string' && cue.sessionId.trim() !== ''
    && typeof cue.segmentId === 'string' && cue.segmentId.trim() !== ''
    && Number.isInteger(cue.sequence) && cue.sequence > 0
    && Number.isFinite(cue.startTimeMs) && Number.isFinite(cue.endTimeMs)
    && (
      (typeof (cue.sourceText || cue.rawSource) === 'string' && (cue.sourceText || cue.rawSource).trim() !== '')
      || (typeof (cue.translatedText || cue.rawTranslation) === 'string' && (cue.translatedText || cue.rawTranslation).trim() !== '')
    )
  );
}

export function finalizedTranscriptItemsForRecording({
  lifecycleContractVersion = 1,
  repository,
  sessionId,
  previousTranscriptState,
  nextTranscriptState
} = {}) {
  const finalItems = newlyFinalizedTranscriptItems(previousTranscriptState, nextTranscriptState);
  if (lifecycleContractVersion === 2) return finalItems;
  return appendNewFinalTranscriptItems(repository, sessionId, previousTranscriptState, nextTranscriptState);
}

export function sessionSnapshotPayloadForRecording({ session, transcriptItems = [], lifecycleContractVersion = 1 } = {}) {
  return {
    session,
    transcriptItems: lifecycleContractVersion === 2 ? [] : transcriptItems
  };
}

export function recordingLifecycleContractVersion({ lifecycle, sessionRecord, meeting } = {}) {
  return [lifecycle, sessionRecord, meeting].some((value) => (
    Number(value?.lifecycleContractVersion ?? value?.lifecycle_contract_version) === 2
  )) ? 2 : 1;
}

export async function completeMeetingAfterRecordingFinalize({
  flushAudio,
  flushCues,
  flushCheckpoint,
  flushCuePublishes,
  completeMeeting,
  alreadyCompleted = false
} = {}) {
  if (alreadyCompleted) return true;
  await flushAudio?.();
  await flushCues?.();
  if (await flushCheckpoint?.() === false) throw new Error('Checkpoint flush failed before completion.');
  if ((await flushCuePublishes?.())?.cloudSynced === false) throw new Error('Cue publication failed before completion.');
  await completeMeeting?.();
  return true;
}

export async function stopLifecycleV2AfterFailure({
  lifecycle,
  failureReason,
  failureCategory,
  flushCheckpoint,
  executeRecordingCommand,
  stopHeartbeats,
  clearWriteFence,
  preventFurtherWrites
} = {}) {
  if (!lifecycle?.meetingId || !lifecycle?.segmentId) return false;
  if (await flushCheckpoint() === false) throw new Error('Checkpoint flush failed before stop.');
  await executeRecordingCommand('stop', {
    failureReason: failureReason || 'unknown_error',
    failureCategory: failureCategory || 'unknown'
  });
  stopHeartbeats();
  clearWriteFence(lifecycle.meetingId);
  preventFurtherWrites();
  return true;
}

function newlyFinalizedTranscriptItems(previousTranscriptState, nextTranscriptState) {
  const previousIds = new Set(finalTranscriptItems(previousTranscriptState).map((item) => item.id));
  return finalTranscriptItems(nextTranscriptState).filter((item) => !previousIds.has(item.id));
}

function finalTranscriptItems(transcriptState) {
  return ['source', 'translation']
    .flatMap((stream) => transcriptItemsForStream(transcriptState, stream))
    .filter((item) => item.status === 'final');
}

export function useLiveRecordingController({
  routeMeetingId = null,
  targetLanguageCode = 'en',
  sourceLanguageCode = 'zh-Hant',
  transcriptionOnly = true,
  sessionName = '',
  echoTargetLanguage = true,
  shouldRecordInputAudio = false,
  selectedInputDeviceId = '',
  glossaryEntries = [],
  selectedMeetingGlossaryIds = [],
  privateMeetingGlossaryEntries = [],
  meetingRecords = [],
  selectedMeetingDetail = null,
  services = {},
  audio = {},
  cue = {},
  checkpoint = {},
  transcript = {},
  recovery = {},
  segmentSwitch = {},
  state = {},
  actions = {}
} = {}) {
  const recordingControllerRef = useRef(null);
  const startOperationRef = useRef(null);
  const endOperationRef = useRef(null);
  const audioUploadControllerRef = useRef(null);
  const recoverySingleFlightRef = useRef(null);
  const segmentTransitionLockRef = useRef(null);
  const providerRecoveryCoordinatorRef = useRef(null);
  const providerRecoveryContextRef = useRef(null);
  const resumeInFlightRef = useRef(false);
  const continueInFlightRef = useRef(false);
  const meetingLifecycleRef = useRef(null);
  const meetingTimingRef = useRef({ meetingId: null, startedAt: null });
  if (meetingTimingRef.current.meetingId !== routeMeetingId) {
    meetingTimingRef.current = {
      meetingId: routeMeetingId,
      startedAt: selectedMeetingDetail?.meeting?.startedAt
        ?? meetingRecords.find((meeting) => meeting.id === routeMeetingId)?.startedAt
        ?? null
    };
  } else if (!meetingTimingRef.current.startedAt) {
    meetingTimingRef.current.startedAt = selectedMeetingDetail?.meeting?.startedAt
      ?? meetingRecords.find((meeting) => meeting.id === routeMeetingId)?.startedAt
      ?? null;
  }
  const audioUpload = useMemo(() => {
    if (!audioUploadControllerRef.current && audio.upload) {
      audioUploadControllerRef.current = createLiveAudioBindings(audio.upload);
    }
    return audioUploadControllerRef.current;
  }, [audio.upload]);

  const audioController = useMemo(() => ({
    recordingController() {
      if (!recordingControllerRef.current) {
        recordingControllerRef.current = createMicrophoneRecordingController({
          onStateChange: audio.setRecordingState,
          diagnostics: audio.recordingDiagnostics,
          collectChunks: false,
          preferredMimeTypes: ['audio/webm;codecs=opus', 'audio/webm'],
          requireSupportedMimeType: true,
          onChunk: (chunk) => audio.getLocalMeetingPersistence?.().appendAudioChunk(chunk)
        });
      }
      return recordingControllerRef.current;
    },
    async startRecordingForSession(record) {
      if (!shouldRecordInputAudio) {
        this.resetInputAudioDownload();
        audio.setRecordingState?.(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
        return;
      }
      this.prepareInputAudioDownload(record);
      const meetingCheckpoint = checkpoint.activeMeetingCheckpointRef.current;
      if (!meetingCheckpoint?.meetingId || !meetingCheckpoint?.segmentId) {
        throw new Error('Missing meeting checkpoint for local audio recording.');
      }
      await audio.getLocalMeetingPersistence?.().start({
        meetingId: meetingCheckpoint.meetingId,
        recordingId: record?.recordingId,
        segmentId: meetingCheckpoint.segmentId
      });
      const nextState = await this.recordingController().start({
        stream: audio.pendingMicrophoneStreamRef?.current,
        sessionId: record?.id,
        startedAt: record?.startedAt
      });
      if (nextState.status === 'error') audio.setRecordingState?.(nextState);
    },
    prepareInputAudioDownload(record) {
      audio.inputMetadataRef.current = { sessionId: record?.id || '', startedAt: record?.startedAt ?? Date.now() };
      audio.inputChunksRef.current = [];
      audioUpload?.resetAudioUploadSegment?.('input');
    },
    resetInputAudioDownload() {
      audio.inputChunksRef.current = [];
      audio.inputMetadataRef.current = { sessionId: '', startedAt: null };
      audioUpload?.resetAudioUploadSegment?.('input');
    },
  handleInputAudioChunk(bytes) {
    if (!shouldRecordInputAudio || !bytes || !Number.isFinite(bytes.byteLength) || bytes.byteLength === 0) return;
    if (cloudMeetingAudioEnabled()) return;
    audio.inputChunksRef.current.push(new Uint8Array(bytes));
      void audioUpload?.flushAudioSegmentIfDue?.('input');
    },
    async pauseRawAudioRecording() {
      if (!shouldRecordInputAudio) {
        audio.setRecordingState?.(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
        return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
      }
      const nextState = await this.recordingController().pause()
        .then(async (recordingState) => {
          if (recordingState.status !== 'error') await audio.getLocalMeetingPersistence?.().pause();
          return recordingState;
        })
        .catch((error) => ({
          status: 'error', blob: null, mimeType: '', extension: '', fileName: '',
          errorMessage: error?.message || '原始語音錄音無法暫停。'
        }));
      audio.setRecordingState?.(nextState);
      return nextState;
    },
    async resumeRawAudioRecording() {
      if (!shouldRecordInputAudio) {
        audio.setRecordingState?.(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
        return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
      }
      const nextState = await Promise.resolve(audio.getLocalMeetingPersistence?.().resume())
        .then(() => this.recordingController().resume({ stream: audio.pendingMicrophoneStreamRef?.current }))
        .catch((error) => ({
          status: 'error', blob: null, mimeType: '', extension: '', fileName: '',
          errorMessage: error?.message || '原始語音錄音無法繼續。'
        }));
      audio.setRecordingState?.(nextState);
      return nextState;
    },
    async finalizeRawAudioRecording() {
    if (!shouldRecordInputAudio) {
      audio.setRecordingState?.(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
      return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
    }
      const nextState = await this.recordingController().finalize().then(() => (
        audio.getLocalMeetingPersistence?.().finalizeAudio({
          fileName: `${audio.inputMetadataRef.current?.sessionId || 'meeting'}-input.webm`
        })
      )).catch((error) => ({
        status: 'error', blob: null, mimeType: '', extension: '', fileName: '',
        errorMessage: error?.message || '原始語音音檔無法建立。'
      }));
      audio.setRecordingState?.(nextState);
      return nextState;
    },
    noteProviderReconnect() {
      return audio.getLocalMeetingPersistence?.().providerReconnect();
    },
    noteProviderRollover() {
      return audio.getLocalMeetingPersistence?.().providerRollover();
    },
    rolloverLocalSegment({ operationId, nextSegmentId } = {}) {
      return audio.getLocalMeetingPersistence?.().rolloverLocalSegment({ operationId, nextSegmentId });
    },
    prepareTranslatedAudioDownload(record) {
      audio.translationMetadataRef.current = { sessionId: record?.id || '', startedAt: record?.startedAt ?? Date.now() };
      audio.translationChunksRef.current = [];
      audioUpload?.resetAudioUploadSegment?.('translation');
    },
    resetTranslatedAudioDownload() {
      audio.translationChunksRef.current = [];
      audio.translationMetadataRef.current = { sessionId: '', startedAt: null };
      audioUpload?.resetAudioUploadSegment?.('translation');
      audio.setTranslatedAudioState?.(TRANSLATED_AUDIO_IDLE_STATE);
    },
  handleTranslatedAudioChunk(bytes) {
    if (!bytes || !Number.isFinite(bytes.byteLength) || bytes.byteLength === 0) return;
    if (cloudMeetingAudioEnabled()) return;
    audio.translationChunksRef.current.push(new Uint8Array(bytes));
      void audioUpload?.flushAudioSegmentIfDue?.('translation');
      audio.setTranslatedAudioState?.((current) => current.status === 'ready' ? current : { status: 'recording', blob: null, fileName: '', errorMessage: '' });
    },
  finalizeTranslatedAudioDownload() {
    if (cloudMeetingAudioEnabled()) {
      audio.setTranslatedAudioState?.(TRANSLATED_AUDIO_IDLE_STATE);
      return TRANSLATED_AUDIO_IDLE_STATE;
    }
    const segment = audio.segmentsRef.current.translation;
      const hasAudio = audio.translationChunksRef.current.length > 0 || segment.nextIndex > 0;
      if (!hasAudio) {
        audio.setTranslatedAudioState?.((current) => current.status === 'recording' ? TRANSLATED_AUDIO_IDLE_STATE : current);
        return TRANSLATED_AUDIO_IDLE_STATE;
      }
      const nextState = { status: 'saved', blob: null, fileName: '', errorMessage: '' };
      audio.setTranslatedAudioState?.(nextState);
      return nextState;
    },
    cleanup() {
      return recordingControllerRef.current?.cleanup({ discard: true });
    },
    cancelAudioUploadRetries() {
      audioUpload?.cancelAudioUploadRetries?.();
    }
  }), [audio, audioUpload, shouldRecordInputAudio]);

  const cueController = useMemo(() => ({
    applyLiveSubtitleCueEvent(event) {
      if (event?.connectionEpoch !== undefined && event.connectionEpoch !== cue.callbackGenerationRef.current.generation) {
        recordCueTrace({ cue, event, cueAction: 'drop', dropReason: 'stale_callback_generation' });
        return;
      }
      const current = cue.stateRef.current;
      const wasProcessed = Boolean(event?.eventId && current.processedEventIds?.includes(event.eventId));
      let dropReason = null;
      let next = applySubtitleCueEvent(current, event, {
        targetLanguageCode,
        sourceLanguageCode,
        sessionId: cue.getSessionId?.(),
        segmentId: cue.getSegmentId?.() || null,
        sessionClock: () => cue.getSessionTime?.() ?? 0,
        onDrop: ({ reason }) => { dropReason = reason; }
      });
      if (event?.localFinalize) {
        next = finalizePendingSubtitleCue(next, {
          sessionTimeMs: cue.getSessionTime?.() ?? 0,
          reason: event.finalizedReason || 'localSilence',
          targetLanguageCode,
          sourceLanguageCode
        });
      }
      next = applyGlossaryCorrectionsToCueState(
        next,
        cue.getLiveGlossaryEntries?.() || [],
        { entriesForCue: cue.getGlossaryEntriesForCue }
      );
      if (import.meta.env?.DEV) {
        const previousFinalIds = new Set((current.finalCues || []).map((item) => item.cueId));
        const nextFinalIds = new Set((next.finalCues || []).map((item) => item.cueId));
        const updatedExistingFinal = (next.finalCues || []).some((item) => {
          const previous = (current.finalCues || []).find((candidate) => candidate.cueId === item.cueId);
          return previous && (previous.sourceText !== item.sourceText || previous.translatedText !== item.translatedText);
        });
        const decision = next === current
          ? 'ignore'
          : updatedExistingFinal
            ? 'replace'
            : [...nextFinalIds].some((cueId) => !previousFinalIds.has(cueId))
              ? 'append'
              : 'replace';
        console.debug('[Cue state transition]', JSON.stringify({
          stream: event?.stream || null,
          text: event?.text || '',
          translatedText: event?.stream === 'translation' ? event.text || '' : '',
          isFinal: Boolean(event?.isFinal),
          turnComplete: Boolean(event?.turnComplete),
          generationComplete: Boolean(event?.generationComplete),
          audioTurnId: event?.audioTurnId || null,
          turnKey: event?.turnKey || null,
          turnIdentitySource: event?.turnIdentitySource || null,
          eventSequence: event?.eventSequence ?? null,
          connectionEpoch: event?.connectionEpoch ?? null,
          segmentId: event?.segmentId || null,
          decision,
          decisionReason: event?.eventType || (event?.localFinalize ? event.finalizedReason || 'localFinalize' : 'state-transition'),
          cueId: next.currentCue?.cueId || next.finalCues?.at(-1)?.cueId || null,
          cueSequence: next.currentCue?.sequence || next.finalCues?.at(-1)?.sequence || null,
          finalCueIds: (next.finalCues || []).map((item) => item.cueId),
          finalCueSequences: (next.finalCues || []).map((item) => item.sequence)
        }));
      }
      const transition = dropReason
        ? { cueAction: 'drop', dropReason }
        : describeCueTransition(current, next, event, { wasProcessed });
      recordCueTrace({ cue, event, previous: current, next, ...transition });
      if (next === current) return;
      this.requestNumericCorrection(commitCueTransition(cue, current, next));
    },
    queueLiveSubtitleCueEvent(event) {
      if (event?.connectionEpoch !== undefined && event.connectionEpoch !== cue.callbackGenerationRef.current.generation) {
        recordCueTrace({ cue, event, cueAction: 'drop', dropReason: 'stale_callback_generation' });
        return;
      }
      const shouldFlushImmediately = Boolean(event?.localFinalize || event?.isFinal || event?.turnComplete || event?.generationComplete || event?.eventType === 'boundary');
      if (shouldFlushImmediately) {
        cue.eventsRef.current.push(event);
        this.flushQueuedLiveCueEvents();
        return;
      }
      const previousQueueLength = cue.eventsRef.current.length;
      const nextQueue = enqueueLiveCueEvent(cue.eventsRef.current, event);
      cue.eventsRef.current = nextQueue;
      if (import.meta.env?.DEV) {
        console.debug('[Cue queue]', JSON.stringify({
          action: nextQueue.length === previousQueueLength ? 'replace-snapshot' : 'append',
          stream: event?.stream || null,
          eventId: event?.eventId || null,
          eventSequence: event?.eventSequence ?? null,
          textMergeMode: event?.textMergeMode || 'initial',
          queueLength: nextQueue.length
        }));
      }
      if (cue.flushTimerRef.current !== null) return;
      cue.flushTimerRef.current = window.setTimeout(() => {
        cue.flushTimerRef.current = null;
        this.flushQueuedLiveCueEvents();
      }, 16);
    },
    flushQueuedLiveCueEvents() {
      if (cue.flushTimerRef.current !== null) {
        window.clearTimeout(cue.flushTimerRef.current);
        cue.flushTimerRef.current = null;
      }
      const generation = cue.callbackGenerationRef.current.generation;
      const queuedEvents = cue.eventsRef.current.splice(0);
      const events = queuedEvents.filter((event) => event?.connectionEpoch === undefined || event.connectionEpoch === generation);
      for (const event of queuedEvents) {
        if (!events.includes(event)) recordCueTrace({ cue, event, cueAction: 'drop', dropReason: 'stale_callback_generation' });
      }
      for (const event of events) this.applyLiveSubtitleCueEvent(event);
    },
    requestNumericCorrection(currentState) {
      if (transcriptionOnly) return;
      const target = [...(currentState.finalCues || [])].reverse().find((candidate) => candidate.status === 'final' && candidate.sourceText && candidate.translatedText && !candidate.numericCorrectionRequested && missingNumericIntegrity(candidate.sourceText, candidate.translatedText));
      if (!target) return;
      const next = markNumericCorrectionRequested(currentState, target.cueId);
      commitCueTransition(cue, currentState, next);
      cue.retranslate?.(target.sourceText, target.cueId);
    },
    flushSubtitleCues(reason) {
      this.flushQueuedLiveCueEvents();
      const current = cue.stateRef.current;
      const next = finalizePendingSubtitleCue(current, { sessionTimeMs: cue.getSessionTime?.() ?? 0, reason });
      if (next === current) return;
      recordCueTransitionTrace({
        cue,
        event: { eventType: reason, isFinal: true },
        previous: current,
        next,
        cueAction: 'transition'
      });
      commitCueTransition(cue, current, next);
      if (!transcriptionOnly && (reason === 'stop' || reason === 'complete')) cue.schedulePolishing?.(next.finalCues);
      return next;
    }
  }), [cue, sourceLanguageCode, targetLanguageCode, transcriptionOnly]);

  const checkpointControllerRef = useRef(null);
  const sessionSnapshotControllerRef = useRef(null);
  const checkpointController = useMemo(() => ({
    async syncSessionSnapshot(sessionId) {
      const detail = checkpoint.sessionRepositoryRef.current.getSessionRecord(sessionId);
      if (!detail) return null;
      const pendingIds = checkpoint.pendingSnapshotIdsRef.current.get(sessionId) || new Set();
      const transcriptItems = detail.transcriptItems.filter((item) => pendingIds.has(item.id));
      const lifecycleContractVersion = meetingLifecycleRef.current?.sessionId === sessionId ? 2 : 1;
      const result = await checkpoint.sessionSnapshotApiClientRef.current.sync(sessionSnapshotPayloadForRecording({
        session: detail.sessionRecord,
        transcriptItems,
        lifecycleContractVersion
      }));
      for (const item of transcriptItems) pendingIds.delete(item.id);
      if (pendingIds.size === 0) checkpoint.pendingSnapshotIdsRef.current.delete(sessionId);
      return result;
    },
    markPendingSessionSnapshotItems(sessionId, items = []) {
      if (!sessionId || items.length === 0) return;
      const pendingIds = checkpoint.pendingSnapshotIdsRef.current.get(sessionId) || new Set();
      for (const item of items) if (item?.id) pendingIds.add(item.id);
      checkpoint.pendingSnapshotIdsRef.current.set(sessionId, pendingIds);
    },
    isLifecycleV2Session(sessionId) {
    const sessionRecord = checkpoint.sessionRepositoryRef.current
      .getSessionRecord(sessionId)?.sessionRecord;
    return recordingLifecycleContractVersion({
      lifecycle: meetingLifecycleRef.current?.sessionId === sessionId
        ? { lifecycleContractVersion: 2 }
        : null,
      sessionRecord
    }) === 2;
    },
    sessionSnapshotSyncCoordinator() {
      if (!sessionSnapshotControllerRef.current) {
        sessionSnapshotControllerRef.current = createSessionSnapshotSyncCoordinator({
          syncSessionSnapshot: (sessionId) => this.syncSessionSnapshot(sessionId),
          delayMs: SESSION_SNAPSHOT_SYNC_DELAY_MS,
          onError: checkpoint.reportSnapshotError
        });
      }
      return sessionSnapshotControllerRef.current;
    },
    scheduleSessionSnapshotSync(sessionId) {
      if ((checkpoint.pendingSnapshotIdsRef.current.get(sessionId)?.size || 0) >= SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE) {
        void this.flushSessionSnapshot(sessionId);
        return;
      }
      this.sessionSnapshotSyncCoordinator().schedule(sessionId);
    },
    flushSessionSnapshot(sessionId) {
      return this.sessionSnapshotSyncCoordinator().flush(sessionId);
    },
    retrySessionSnapshot(sessionId) {
      return this.sessionSnapshotSyncCoordinator().retry(sessionId);
    },
    meetingCheckpointSyncCoordinator() {
      if (!checkpointControllerRef.current) {
        checkpointControllerRef.current = createMeetingCheckpointSyncCoordinator({
          updateCheckpoint: async (payload) => {
            const cloudOperationId = `checkpoint:${payload.meetingId}:${payload.segmentId}:${payload.idempotencyKey}`;
            checkpoint.cloudSaveCoordinator?.begin({ id: cloudOperationId, kind: 'checkpoint' });
            recordLivePipelineTrace({
              stage: 'CHECKPOINT_SAVE_STARTED',
              meetingId: payload.meetingId,
              segmentId: payload.segmentId,
              operationId: payload.idempotencyKey,
              persistenceState: 'saving'
            });
            recordLivePipelineTrace({
              stage: 'CHECKPOINT_REQUEST',
              meetingId: payload.meetingId,
              segmentId: payload.segmentId,
              operationId: payload.idempotencyKey,
              persistenceState: 'saving'
            });
            try {
              const result = await checkpoint.getLocalMeetingPersistence().updateCheckpoint(payload);
              checkpoint.cloudSaveCoordinator?.succeed(cloudOperationId);
              return result;
            } catch (error) {
              checkpoint.cloudSaveCoordinator?.fail(cloudOperationId, error);
              recordLivePipelineTrace({
                stage: 'CHECKPOINT_SAVE_FAILED',
                meetingId: payload.meetingId,
                segmentId: payload.segmentId,
                operationId: payload.idempotencyKey,
                persistenceState: 'retrying',
                httpStatus: error?.status,
                errorCode: error?.code
              });
              recordLivePipelineTrace({
                stage: 'CHECKPOINT_FAILED',
                meetingId: payload.meetingId,
                segmentId: payload.segmentId,
                operationId: payload.idempotencyKey,
                persistenceState: 'retrying',
                httpStatus: error?.status,
                errorCode: error?.code
              });
              throw error;
            }
          },
          getCheckpoint: (payload) => checkpoint.getLocalMeetingPersistence().getCheckpoint(payload),
          delayMs: MEETING_CHECKPOINT_SYNC_DELAY_MS,
          onStatusChange: (status) => {
            if (['idle', 'ready'].includes(status)
              && checkpoint.cloudSaveCoordinator?.snapshot().failedCount === 0) {
              checkpoint.setMeetingCheckpointStatus?.(status);
              return;
            }
            if (!checkpoint.cloudSaveCoordinator) {
              checkpoint.setMeetingCheckpointStatus?.(status);
              if (status === 'synced') checkpoint.clearCheckpointError?.();
            }
          },
          onError: checkpoint.reportCheckpointError
        });
      }
      return checkpointControllerRef.current;
    },
    scheduleMeetingCheckpointSync(transcriptItems) {
      const current = checkpoint.activeMeetingCheckpointRef.current;
      const chunks = checkpointChunksForTranscriptItems({ meetingId: current?.meetingId, segmentId: current?.segmentId, transcriptItems });
      this.meetingCheckpointSyncCoordinator().enqueue(chunks);
    },
    flushMeetingCheckpointSync() {
      return checkpointControllerRef.current?.flush() || Promise.resolve(true);
    },
    cancel() {
      sessionSnapshotControllerRef.current?.cancel();
      checkpointControllerRef.current?.cancel();
    }
  }), [checkpoint]);

  const reconnectControllerRef = useRef(null);
  const transcriptController = useMemo(() => ({
    async finalizePendingTranscriptItemsForStop() {
      await this.finalizePendingTranscriptItemsForStreams();
    },
    async finalizePendingTranscriptItemsForStreams(options = {}) {
      const currentTranscript = transcript.stateRef.current;
      if (!this.expectedPendingPartialsStillCurrent(currentTranscript, options.expectedPartialByStream)) return;

      const nextTranscript = finalizePendingTranscriptItems(currentTranscript, { streams: options.streams });
      if (nextTranscript === currentTranscript) return;

      const activeSessionRecordId = transcript.activeSessionRecordIdRef.current;
      const lifecycleContractVersion = meetingLifecycleRef.current ? 2 : 1;
      const appended = finalizedTranscriptItemsForRecording({
        lifecycleContractVersion,
        repository: transcript.sessionRepositoryRef.current,
        sessionId: activeSessionRecordId,
        previousTranscriptState: currentTranscript,
        nextTranscriptState: nextTranscript
      });
      transcript.stateRef.current = nextTranscript;
      transcript.setState((previous) => {
        if (previous === currentTranscript) return nextTranscript;
        if (!this.expectedPendingPartialsStillCurrent(previous, options.expectedPartialByStream)) return previous;
        return finalizePendingTranscriptItems(previous, { streams: options.streams });
      });

      if (appended.length === 0) return;
      const activeSessionRecord = transcript.sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
      if (activeSessionRecord) {
        if (lifecycleContractVersion !== 2) checkpointController.scheduleSessionSnapshotSync(activeSessionRecordId);
        checkpointController.scheduleMeetingCheckpointSync(appended);
      }
    },
    expectedPendingPartialsStillCurrent(transcriptState, expectedPartialByStream) {
      if (!expectedPartialByStream) return true;
      return Object.entries(expectedPartialByStream).every(([stream, expected]) => {
        const currentPartial = transcriptState?.[stream]?.currentPartial;
        return currentPartial?.id === expected.id && currentPartial.text === expected.text;
      });
    }
  }), [checkpointController, transcript]);

  const recoveryController = useMemo(() => {
    if (!recoverySingleFlightRef.current) {
      recoverySingleFlightRef.current = createRecoverySingleFlight();
    }
    const recoverySingleFlight = recoverySingleFlightRef.current;
    if (!segmentTransitionLockRef.current) {
      segmentTransitionLockRef.current = createSegmentTransitionLock();
    }
    const segmentTransitionLock = segmentTransitionLockRef.current;
    const recoveryKeyFor = (meetingCheckpoint) => (
      meetingCheckpoint?.meetingId && meetingCheckpoint?.segmentId
        ? `${meetingCheckpoint.meetingId}:${meetingCheckpoint.segmentId}`
        : null
    );
    const clearSettledRecoveryForCheckpoint = (meetingCheckpoint) => {
      const recoveryKey = recoveryKeyFor(meetingCheckpoint);
      if (!recoveryKey) return;

      for (const suffix of [':recover', ':finalize']) {
        const key = `${recoveryKey}${suffix}`;
        if (!recoverySingleFlight.isInFlight(key)) {
          recoverySingleFlight.clear(key);
        }
      }
    };

    const nextOperationId = (command) => globalThis.crypto?.randomUUID?.() || `${command}-${Date.now()}-${Math.random()}`;

    if (!providerRecoveryCoordinatorRef.current) {
      providerRecoveryCoordinatorRef.current = createProviderRecoveryCoordinator({
        execute: async ({ operation, attempt }) => {
          if (attempt > 1) await audioController.noteProviderReconnect();
          recordLivePipelineTrace({
            stage: 'PROVIDER_RECOVERY_ATTEMPT',
            meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
            recorderSessionId: recovery.activeSessionRecordIdRef.current,
            geminiSessionId: operation.liveSessionId,
            segmentId: operation.segmentId,
            operationId: operation.operationId,
            reconnectAttempt: attempt,
            providerEpoch: operation.session.providerEpoch
          });
          try {
            const ready = await operation.session.reconnectProvider({
              segmentId: operation.segmentId,
              liveSessionId: operation.liveSessionId,
              forceRefresh: true
            });
            if (!ready) {
              recordLivePipelineTrace({
                stage: 'PROVIDER_RECOVERY_FAILED',
                meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
                recorderSessionId: recovery.activeSessionRecordIdRef.current,
                geminiSessionId: operation.liveSessionId,
                segmentId: operation.segmentId,
                operationId: operation.operationId,
                reconnectAttempt: attempt,
                providerEpoch: operation.session.providerEpoch,
                reason: 'provider_not_ready'
              });
            }
            return ready;
          } catch (error) {
            recordLivePipelineTrace({
              stage: 'PROVIDER_RECOVERY_FAILED',
              meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
              recorderSessionId: recovery.activeSessionRecordIdRef.current,
              geminiSessionId: operation.liveSessionId,
              segmentId: operation.segmentId,
              operationId: operation.operationId,
              reconnectAttempt: attempt,
              providerEpoch: operation.session.providerEpoch,
              errorCode: error?.code,
              httpStatus: error?.status
            });
            throw error;
          }
        }
      });
    }
    const providerRecoveryCoordinator = providerRecoveryCoordinatorRef.current;

    const runCommittedProviderRecovery = async (context, { manual = false } = {}) => {
      recovery.setError('');
      recovery.setStatusLabelOverride(manual ? '正在手動恢復翻譯' : '正在恢復 Gemini 翻譯');
      recovery.setStatus('provider-recovery');
      const result = await providerRecoveryCoordinator.run({
        ...context,
        operationId: nextOperationId(manual ? 'provider-recovery-manual' : 'provider-recovery'),
        manual
      });
      if (result.status === 'cancelled') return result;
      if (result.status !== 'ready') {
        recordLivePipelineTrace({
          stage: 'PROVIDER_RECOVERY_EXHAUSTED',
          meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
          recorderSessionId: recovery.activeSessionRecordIdRef.current,
          geminiSessionId: context.liveSessionId,
          segmentId: context.segmentId,
          operationId: result.operationId,
          reconnectAttempt: result.attempt,
          providerEpoch: context.session.providerEpoch,
          errorCode: result.lastError?.code
        });
        recovery.setStatus('provider-recovery-failed');
        recovery.setStatusLabelOverride('翻譯已停止，可手動重試');
        recovery.setError('翻譯已停止，可手動重試');
        recovery.cancelSegmentSwitch?.();
      }
      return result;
    };

    const stopMeetingLifecycleHeartbeats = () => {
      const lifecycle = meetingLifecycleRef.current;
      if (!lifecycle) return;
      if (lifecycle.leaseTimer) clearInterval(lifecycle.leaseTimer);
      if (lifecycle.livenessTimer) clearInterval(lifecycle.livenessTimer);
      lifecycle.leaseTimer = null;
      lifecycle.livenessTimer = null;
    };

    const executeMeetingLifecycleCommand = async (command, payload = {}, identity = {}) => {
      const lifecycle = meetingLifecycleRef.current;
      if (!lifecycle) return null;
      const result = await recovery.meetingCheckpointApiClientRef.current.executeRecordingCommand({
        meetingId: lifecycle.meetingId,
        command,
        operationId: identity.operationId || nextOperationId(command),
        expectedLifecycleVersion: identity.expectedLifecycleVersion ?? lifecycle.lifecycleVersion,
        leaseId: lifecycle.leaseId,
        fenceToken: lifecycle.fenceToken,
        ...payload
      });
      lifecycle.lifecycleVersion = result.meeting.lifecycle_version ?? result.meeting.lifecycleVersion;
      lifecycle.leaseId = result.lease.leaseId;
      lifecycle.fenceToken = result.lease.fenceToken;
      lifecycle.sessionId = result.session.id;
      lifecycle.segmentId = result.segment?.id || null;
      if (lifecycle.segmentId) setMeetingLifecycleWriteFence(lifecycle);
      return result;
    };

    const startMeetingLifecycleHeartbeats = () => {
      const lifecycle = meetingLifecycleRef.current;
      if (!lifecycle) return;
      stopMeetingLifecycleHeartbeats();
      lifecycle.leaseTimer = setInterval(() => {
        recovery.meetingCheckpointApiClientRef.current.renewRecordingLease(lifecycle).catch(() => {});
      }, 3_000);
      lifecycle.livenessTimer = setInterval(() => {
        recovery.meetingCheckpointApiClientRef.current.heartbeatMeeting(lifecycle).catch(() => {});
      }, 30_000);
    };

  const resumeLifecycleV2 = async () => {
    if (meetingLifecycleRef.current) return executeMeetingLifecycleCommand('resume');

    const sessionRecord = recovery.sessionRepositoryRef.current
      .getSessionRecord(recovery.activeSessionRecordIdRef.current)?.sessionRecord;
    const meeting = [
      selectedMeetingDetail?.meeting,
      meetingRecords.find((item) => item.id === routeMeetingId)
    ].find((item) => item?.id === routeMeetingId);
    if (recordingLifecycleContractVersion({ sessionRecord, meeting }) !== 2) {
      const error = new Error('Unable to restore lifecycle v2 recording identity.');
      error.code = 'meeting_lifecycle_conflict';
      throw error;
    }

    const resumed = await recovery.meetingCheckpointApiClientRef.current.executeRecordingCommand({
      meetingId: meeting.id,
      command: 'resume',
      operationId: nextOperationId('resume'),
      expectedLifecycleVersion: meeting.lifecycleVersion ?? meeting.lifecycle_version ?? 0
    });
    meetingLifecycleRef.current = {
      meetingId: resumed.meeting.id,
      sessionId: resumed.session.id,
      segmentId: resumed.segment?.id || null,
      lifecycleVersion: resumed.meeting.lifecycle_version ?? resumed.meeting.lifecycleVersion,
      leaseId: resumed.lease.leaseId,
      fenceToken: resumed.lease.fenceToken,
      leaseTimer: null,
      livenessTimer: null
    };
    setMeetingLifecycleWriteFence(meetingLifecycleRef.current);
    startMeetingLifecycleHeartbeats();
    return resumed;
  };

  const controller = ({
    cancelProviderRecovery(reason = 'cancelled') {
      const context = providerRecoveryContextRef.current;
      if (context) {
        recordLivePipelineTrace({
          stage: 'PROVIDER_RECOVERY_CANCELLED',
          meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
          recorderSessionId: recovery.activeSessionRecordIdRef.current,
          geminiSessionId: context.liveSessionId,
          segmentId: context.segmentId,
          providerEpoch: context.session.providerEpoch,
          reason
        });
      }
      providerRecoveryContextRef.current = null;
      providerRecoveryCoordinator.cancel(reason);
    },

    async retryProviderRecovery() {
      const context = providerRecoveryContextRef.current;
      if (!context || recovery.sessionStopRequestedRef.current) return false;
      const result = await runCommittedProviderRecovery(context, { manual: true });
      if (result.status !== 'ready') return false;
      providerRecoveryContextRef.current = null;
      if (!recovery.activateLiveSessionCallbacks(context.session.callbackGeneration)) return false;
      recovery.sessionRef.current = context.session;
      recovery.setStatusLabelOverride('翻譯已恢復');
      recovery.setStatus('listening');
      recovery.startSegmentSwitch?.();
      return true;
    },

    async createCurrentSessionRecord(meetingCheckpoint = recovery.activeMeetingCheckpointRef.current, initialTranscript = null, existingSessionId = null) {
      recovery.polishingSessionIdRef.current = null;
      const sessionBinding = meetingCheckpoint?.meetingId && meetingCheckpoint?.segmentId
        ? { meetingId: meetingCheckpoint.meetingId, segmentId: meetingCheckpoint.segmentId }
        : {};
      const persisted = existingSessionId
      ? await recovery.sessionCommandApiClientRef.current.update(existingSessionId, {
        status: 'active',
        ...sessionBinding
      })
      : await recovery.sessionCommandApiClientRef.current.create({
        name: sessionName.trim() || `即時翻譯 ${new Date().toLocaleString('zh-TW')}`,
        ...sessionBinding,
        targetLanguageCode,
          targetLanguageLabel: recovery.targetLanguageLabelFor(targetLanguageCode),
          sourceLanguageCode,
          echoTargetLanguage,
          shouldRecordInputAudio,
          meetingGlossaryEntries: recovery.currentMeetingGlossaryEntries(),
          selectedInputDeviceId: selectedInputDeviceId || null,
          inputDeviceLabelSnapshot: recovery.selectedInputDeviceSnapshot().inputDeviceLabelSnapshot
        });
      const record = createActiveSessionRecord(
        recovery.sessionRepositoryRef.current,
        buildSessionRecordInput({
          id: persisted?.session?.id,
          startedAt: null,
          status: 'created',
          name: persisted?.session?.name,
          targetLanguageCode,
          targetLanguageLabel: recovery.targetLanguageLabelFor(targetLanguageCode),
          sourceLanguageCode,
          echoTargetLanguage,
          shouldRecordInputAudio,
          meetingId: meetingCheckpoint?.meetingId,
          recordingId: persisted?.session?.recordingId || null,
          segmentId: meetingCheckpoint?.segmentId,
          meetingGlossaryEntries: recovery.currentMeetingGlossaryEntries(),
          ...recovery.selectedInputDeviceSnapshot()
        })
      );
      recovery.activeSessionRecordIdRef.current = record.id;
      audioController.prepareInputAudioDownload(record);
      audioController.prepareTranslatedAudioDownload(record);
      const lifecycleContractVersion = meetingLifecycleRef.current?.sessionId === record.id ? 2 : 1;
      const initialItems = lifecycleContractVersion === 2
        ? []
        : controller.appendInitialTranscriptItems(record.id, initialTranscript);
      if (lifecycleContractVersion !== 2) {
        checkpointController.markPendingSessionSnapshotItems(record.id, initialItems);
        void checkpointController.flushSessionSnapshot(record.id).catch(() => {});
      }
      return record;
    },
    appendInitialTranscriptItems(sessionId, initialTranscript) {
      if (!sessionId || !initialTranscript) return [];
      return transcriptItemsForStream(initialTranscript, 'source')
        .concat(transcriptItemsForStream(initialTranscript, 'translation'))
        .filter((item) => item.status === 'final')
        .map((item) => recovery.sessionRepositoryRef.current.appendTranscriptItem(sessionId, item));
    },
  async uploadFinalizedSessionAudioArtifacts(sessionId, states = {}, options = {}) {
      try {
        await Promise.all([
          audioUpload?.flushAudioSegment?.('input', { force: true, sessionId }),
          audioUpload?.flushAudioSegment?.('translation', { force: true, sessionId })
        ]);
        await this.refreshAudioArtifactDetails(sessionId, options);
      } catch (nextError) {
        console.error('Session audio artifact persistence failed.', nextError);
        if (nextError?.status === 413) {
          recovery.setError('語音紀錄分段超過伺服器保存上限，但逐字稿保存不受影響。請調高 SESSION_AUDIO_MAX_BYTES 或縮短分段時間。');
          return;
        }
        if (audioUpload?.isRetryableAudioUploadError?.(nextError)) {
          recovery.setError('語音紀錄暫時無法同步，未上傳片段已保留並會在背景持續重試。');
          return;
        }
      recovery.setError('語音紀錄無法儲存到翻譯紀錄，但逐字稿保存不受影響。');
    }
  },
  async uploadFinalizedMeetingAudio(state, checkpoint = recovery.activeMeetingCheckpointRef.current) {
    if (!cloudMeetingAudioEnabled() || state?.status !== 'ready' || !state.blob || !checkpoint?.meetingId || !checkpoint?.segmentId) return null;
    try {
      audio.setRecordingState?.({ ...state, status: 'uploading' });
      const artifact = await uploadMeetingSegmentAudio({
        meetingId: checkpoint.meetingId,
        segmentId: checkpoint.segmentId,
        blob: state.blob,
        diagnostics: audio.recordingDiagnostics
      });
      audio.setRecordingState?.({ ...state, status: 'saved', blob: null, artifact, errorMessage: '' });
      recovery.meetingDetailCacheRef.current.delete(checkpoint.meetingId);
      return artifact;
    } catch {
      audio.setRecordingState?.({ ...state, status: 'error', errorMessage: '原始語音上傳失敗，可稍後重試。' });
      recovery.setError('原始語音上傳失敗，但逐字稿與會議狀態不受影響。');
      return null;
    }
  },
    async refreshAudioArtifactDetails(sessionId, { meetingId = null } = {}) {
      if (!sessionId || !meetingId) return;
      recovery.meetingDetailCacheRef.current.delete(meetingId);
      if (recovery.selectedMeetingIdRef.current === meetingId) {
        await recovery.refreshSelectedMeetingDetail(meetingId);
      }
    },
    async createMeetingCheckpointForSession({ liveSessionId, glossaryEntries = [], privateGlossaryEntries = [] } = {}) {
      try {
        recovery.setMeetingCheckpointStatus('syncing');
        const result = await recovery.meetingCheckpointApiClientRef.current.createMeeting({ liveSessionId, glossaryEntries, privateGlossaryEntries });
        const meetingCheckpoint = {
          meetingId: result.meeting.id,
        segmentId: result.segment.id,
        segmentSequence: result.segment.sequence
        };
        recovery.activeMeetingCheckpointRef.current = meetingCheckpoint;
        checkpointController.meetingCheckpointSyncCoordinator().start(meetingCheckpoint);
        return meetingCheckpoint;
      } catch (nextError) {
        recovery.activeMeetingCheckpointRef.current = null;
        checkpointController.cancel();
        recovery.setMeetingCheckpointStatus('error');
        throw new Error('無法建立長會議同步紀錄。請稍後再試。', { cause: nextError });
      }
    },
    async finalizeCurrentSessionRecord(options) {
      const sessionId = recovery.activeSessionRecordIdRef.current;
      const translatedAudioFinalState = audioController.finalizeTranslatedAudioDownload(sessionId);
      recovery.polishingSessionIdRef.current = sessionId || null;
      recovery.activeSessionRecordIdRef.current = null;
      const meetingId = recovery.activeMeetingCheckpointRef.current?.meetingId || null;

      try {
        const checkpointFlushed = await checkpointController.flushMeetingCheckpointSync();
        if (!checkpointFlushed) {
          recovery.setError('長會議同步尚未完成，但目前逐字稿仍會保存；未同步片段會保留以便重試。');
        }
        const finalized = recovery.finalizeActiveSessionRecord(
          recovery.sessionRepositoryRef.current,
          sessionId,
          recovery.buildFinalizePatch(options)
        );

      if (finalized) {
        await checkpointController.flushSessionSnapshot(sessionId);
        void controller.uploadFinalizedMeetingAudio(
          options?.audioStates?.input,
          recovery.activeMeetingCheckpointRef.current
        );
        if (!cloudMeetingAudioEnabled()) {
          void controller.uploadFinalizedSessionAudioArtifacts(sessionId, {
            input: options?.audioStates?.input,
            translation: translatedAudioFinalState
          }, { meetingId });
        }
        }

        return finalized;
      } catch {
        return null;
      } finally {
        recovery.sessionControlLeaseRef.current?.release(sessionId);
        recovery.setHasSessionControl(false);
        recovery.activeMeetingCheckpointRef.current = null;
      }
    },
      async interruptActiveMeeting({ failureReason, failureCategory } = {}) {
      controller.cancelProviderRecovery('interrupted');
        const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
        if (!meetingCheckpoint) return null;
        const recoveryKey = recoveryKeyFor(meetingCheckpoint);
        if (!recoveryKey) return null;

      return recoverySingleFlight.run(`${recoveryKey}:recover`, async () => {
        try {
          if (await checkpointController.flushMeetingCheckpointSync() === false) {
            throw new Error('Checkpoint flush failed before interruption.');
          }
          if (meetingLifecycleRef.current) {
            return await executeMeetingLifecycleCommand('recover', {
              failureReason: failureReason || 'unknown_error',
              failureCategory: failureCategory || 'unknown'
            });
          }
          return await recovery.meetingCheckpointApiClientRef.current.recoverSegment({
              meetingId: meetingCheckpoint.meetingId,
              segmentId: meetingCheckpoint.segmentId,
              idempotencyKey: `interrupt:${meetingCheckpoint.segmentId}:${failureReason}`,
              checkpoint: {
                idempotencyKey: `checkpoint:${meetingCheckpoint.segmentId}:interrupt:${failureReason}`,
                durableChunks: [],
                pendingPartial: null
              },
              nextLiveSessionId: null,
              failureReason: failureReason || 'unknown_error',
              failureCategory: failureCategory || 'unknown',
              outcome: 'interrupted'
            });
          } catch {
            return null;
          }
        });
      },
      async finalizeFailedSession({ status = 'failed', failureReason, failureCategory } = {}) {
        const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
        const recoveryKey = recoveryKeyFor(meetingCheckpoint);
        if (!recoveryKey) {
          await this.finalizeCurrentSessionRecord({ status, failureReason, failureCategory });
          return;
        }
        await recoverySingleFlight.run(`${recoveryKey}:finalize`, async () => {
          if (meetingLifecycleRef.current) {
            const lifecycle = meetingLifecycleRef.current;
            await stopLifecycleV2AfterFailure({
              lifecycle,
              failureReason,
              failureCategory,
              flushCheckpoint: () => checkpointController.flushMeetingCheckpointSync(),
              executeRecordingCommand: executeMeetingLifecycleCommand,
              stopHeartbeats: stopMeetingLifecycleHeartbeats,
              clearWriteFence: clearMeetingLifecycleWriteFence,
              preventFurtherWrites: () => {
                recovery.invalidateLiveSessionCallbacks();
                recovery.setLiveCueUpdatesAllowed(false);
                audioController.cancelAudioUploadRetries();
              }
            });
            meetingLifecycleRef.current = null;
          } else {
            await this.interruptActiveMeeting({ failureReason, failureCategory });
          }
          await this.finalizeCurrentSessionRecord({ status, failureReason, failureCategory });
        });
    },
    async completeResumableMeeting() {
      const currentMeetingId = recovery.getRouteMeetingId?.();
      const resumeDraft = recovery.resumeDraft;
      if (!resumeDraft || !currentMeetingId || resumeDraft.meetingId !== currentMeetingId || state.isActive || !['idle', 'paused'].includes(state.status)) return;
      if (!window.confirm('確定要結束這場會議嗎？既有逐字稿會保留，之後將無法繼續錄製。')) return;
      recovery.setError('');
      recovery.setMeetingCheckpointStatus?.('ending');
      try {
        await completeMeetingAfterRecordingFinalize({
          flushAudio: () => audioController.finalizeRawAudioRecording(),
          flushCues: () => cueController.flushSubtitleCues('complete'),
          flushCheckpoint: async () => {
            const checkpointFlushed = await checkpointController.flushMeetingCheckpointSync();
            if (!checkpointFlushed) throw new Error('Unable to flush meeting checkpoint before completion.');
          },
          flushCuePublishes: () => recovery.flushMeetingCuePublishes?.(
            resumeDraft.sessionId || recovery.activeSessionRecordIdRef.current,
            { forceCloud: true }
          ),
          completeMeeting: () => recovery.meetingCheckpointApiClientRef.current.completeMeeting({ meetingId: resumeDraft.meetingId })
        });
        recovery.setResumeDraft(null);
        stopMeetingLifecycleHeartbeats();
        clearMeetingLifecycleWriteFence(currentMeetingId);
        meetingLifecycleRef.current = null;
        recovery.activeMeetingCheckpointRef.current = null;
        const cloudState = checkpoint.cloudSaveCoordinator?.snapshot().state;
        recovery.setMeetingCheckpointStatus({
          cloud_failed: 'error',
          cloud_retrying: 'retrying',
          cloud_pending: 'syncing',
          cloud_synced: 'synced'
        }[cloudState] || 'synced');
        await recovery.refreshMeetingRecords();
        window.location.hash = '#meetings';
      } catch {
        recovery.setError('無法結束會議，請稍後再試。');
      }
    },
    endCurrentSession(options = {}) {
      if (endOperationRef.current) return endOperationRef.current;
      const operation = controller.endCurrentSessionLifecycle(options);
      endOperationRef.current = operation;
      void operation.finally(() => {
        if (endOperationRef.current === operation) endOperationRef.current = null;
      }).catch(() => {});
      return operation;
    },
    async endCurrentSessionLifecycle({ redirectHash = '#meetings', completeMeeting = false } = {}) {
      const endedMeetingId = recovery.activeMeetingCheckpointRef.current?.meetingId || recovery.resumeDraft?.meetingId || '';
      if (completeMeeting && endedMeetingId) recovery.setMeetingCheckpointStatus?.('ending');
      recovery.sessionStopRequestedRef.current = true;
      recovery.reconnectController().cancel();
      controller.cancelProviderRecovery(completeMeeting ? 'end' : 'stop');
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = true;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      const reconnectingSession = recovery.reconnectSessionRef.current;
      const activeSession = recovery.sessionRef.current;
      recovery.reconnectSessionRef.current = null;
      recovery.sessionRef.current = null;
      const inputAudioState = await audioController.finalizeRawAudioRecording();
      await stopSessionSafely(reconnectingSession);
      if (activeSession !== reconnectingSession) await stopSessionSafely(activeSession);
      cueController.flushQueuedLiveCueEvents();
      recovery.invalidateLiveSessionCallbacks();
      recovery.setLiveCueUpdatesAllowed(false);
      await recovery.finalizePendingTranscriptItemsForStop();
      cueController.flushSubtitleCues('stop');
      const checkpointFlushed = await checkpointController.flushMeetingCheckpointSync();
      const cueSyncResult = await recovery.flushMeetingCuePublishes?.(
        recovery.activeSessionRecordIdRef.current,
        { forceCloud: true }
      );
      if (completeMeeting && (!checkpointFlushed || cueSyncResult?.cloudSynced === false)) {
        recovery.setMeetingCheckpointStatus?.('error');
        recovery.setMeetingCheckpointErrorMessage?.('雲端字幕同步尚未完成，未同步資料已保留，請重試結束會議。');
        throw new Error('Unable to complete meeting before checkpoint and Cue writes are durable.');
      }
      if (meetingLifecycleRef.current) {
        await executeMeetingLifecycleCommand('stop');
        stopMeetingLifecycleHeartbeats();
      }
      recovery.pendingMicrophoneStreamRef.current = null;
      recovery.setResumeDraft(null);
      await controller.finalizeCurrentSessionRecord({
        status: 'stopped',
        failureReason: 'user_stop',
        failureCategory: 'user_intent',
        audioStates: { input: inputAudioState }
      });
      if (completeMeeting && endedMeetingId) {
        await recovery.meetingCheckpointApiClientRef.current.completeMeeting({ meetingId: endedMeetingId });
        recovery.setMeetingCheckpointStatus?.('synced');
      }
      meetingLifecycleRef.current = null;
      clearMeetingLifecycleWriteFence(endedMeetingId);
      recovery.setStatus('stopped');
      if (cueSyncResult?.cloudSynced === false) {
        recovery.setMeetingCheckpointStatus?.('error');
        recovery.setMeetingCheckpointErrorMessage?.('字幕已完整保存在本機，但雲端同步失敗。可在這台設備的會議詳情查看與匯出，並稍後重試。');
      }
      clearMeetingAudioPreference(endedMeetingId);
      if (redirectHash) window.location.hash = redirectHash;
    },
    async continuePausedSession() {
      if (state.status !== 'paused' || continueInFlightRef.current) return;
      continueInFlightRef.current = true;
      const continueStartedAt = Date.now();
      recordLivePipelineTrace({
        stage: 'CONTINUE_REQUESTED',
        meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
        sessionId: recovery.activeSessionRecordIdRef.current,
        segmentId: recovery.activeMeetingCheckpointRef.current?.segmentId,
        continueElapsedMs: 0,
        timestamp: new Date().toISOString()
      });
      recovery.invalidateLiveSessionCallbacks();
      recovery.sessionStopRequestedRef.current = false;
      recovery.reconnectController().reset();
      controller.cancelProviderRecovery('continue');
      clearSettledRecoveryForCheckpoint(recovery.activeMeetingCheckpointRef.current);
      recovery.reconnectFailureDiagnosticRef.current = null;
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = false;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.setLiveCueUpdatesAllowed(false);
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      recovery.setError('');
      recovery.pendingMicrophoneStreamRef.current = null;
      const previousCueState = cue.stateRef.current;
      const preparedCueState = prepareSubtitleCueStateForNewSegment(previousCueState, { sessionTimeMs: recovery.getSessionTime(), reason: 'continue' });
      commitCueTransition(cue, previousCueState, preparedCueState);
      let session;
      let legacyContinue = null;
      let legacyPersistence = null;
      try {
      const activeSessionRecord = recovery.sessionRepositoryRef.current
        .getSessionRecord(recovery.activeSessionRecordIdRef.current)?.sessionRecord;
      const routeMeeting = [
        selectedMeetingDetail?.meeting,
        meetingRecords.find((item) => item.id === routeMeetingId)
      ].find((item) => item?.id === routeMeetingId);
      const lifecycleContractVersion = recordingLifecycleContractVersion({
        lifecycle: meetingLifecycleRef.current
          ? { lifecycleContractVersion: 2 }
          : null,
        sessionRecord: activeSessionRecord,
        meeting: routeMeeting
      });
      if (lifecycleContractVersion === 2) {
        const resumed = await resumeLifecycleV2();
          const nextCheckpoint = { meetingId: resumed.meeting.id, segmentId: resumed.segment.id, segmentSequence: resumed.segment.sequence };
          recovery.activeMeetingCheckpointRef.current = nextCheckpoint;
          checkpointController.meetingCheckpointSyncCoordinator().start(nextCheckpoint);
          recordLivePipelineTrace({
            stage: 'RESUME_SEGMENT_CONFIRMED',
            meetingId: resumed.meeting.id,
            sessionId: resumed.session.id,
            segmentId: resumed.segment.id,
            lifecycleVersion: resumed.meeting.lifecycle_version ?? resumed.meeting.lifecycleVersion,
            continueElapsedMs: Date.now() - continueStartedAt,
            timestamp: new Date().toISOString()
          });
        } else {
          const sourceCheckpoint = recovery.activeMeetingCheckpointRef.current;
          if (!sourceCheckpoint?.meetingId || !sourceCheckpoint?.segmentId) {
            const error = new Error('Legacy Continue 缺少來源 Segment。');
            error.code = 'meeting_segment_not_found';
            throw error;
          }
          await recovery.flushMeetingCuePublishes?.(recovery.activeSessionRecordIdRef.current);
          const checkpointFlushed = await checkpointController.flushMeetingCheckpointSync();
          if (checkpointFlushed === false) {
            const error = new Error('Checkpoint durability barrier failed.');
            error.code = 'checkpoint_conflict';
            throw error;
          }
          recordLivePipelineTrace({
            stage: 'CONTINUE_BARRIER_COMPLETE',
            meetingId: sourceCheckpoint.meetingId,
            sessionId: recovery.activeSessionRecordIdRef.current,
            segmentId: sourceCheckpoint.segmentId,
            continueElapsedMs: Date.now() - continueStartedAt
          });
          legacyPersistence = checkpoint.getLocalMeetingPersistence();
          const durableCheckpoint = await legacyPersistence.getCheckpoint(sourceCheckpoint);
          legacyContinue = await establishDurableLegacyContinue({
            persistence: legacyPersistence,
            api: recovery.meetingCheckpointApiClientRef.current,
            meetingId: sourceCheckpoint.meetingId,
            sourceSegmentId: sourceCheckpoint.segmentId,
            expectedSessionId: recovery.activeSessionRecordIdRef.current,
            checkpoint: durableCheckpoint?.checkpoint || {},
            liveSessionIdFactory: recovery.generateLiveSessionId,
            shouldContinue: () => !recovery.sessionStopRequestedRef.current
          });
          const resumed = legacyContinue.result;
          if (!resumed?.segment?.id || !resumed?.effectiveGlossaryRevision) {
            const error = new Error('Legacy resume did not return an authoritative Segment binding.');
            error.code = 'meeting_lifecycle_conflict';
            throw error;
          }
          const nextCheckpoint = {
            meetingId: resumed.meeting.id,
            segmentId: resumed.segment.id,
            segmentSequence: resumed.segment.sequence
          };
          recovery.activeMeetingCheckpointRef.current = nextCheckpoint;
          checkpointController.meetingCheckpointSyncCoordinator().start(nextCheckpoint);
          recordLivePipelineTrace({
            stage: 'RESUME_SEGMENT_CONFIRMED',
            meetingId: resumed.meeting.id,
            sessionId: resumed.segment.sessionId,
            segmentId: resumed.segment.id,
            revision: resumed.effectiveGlossaryRevision,
            glossaryEntryCount: resumed.glossaryEntryCount,
            operationId: legacyContinue.operation.operationId,
            continueElapsedMs: Date.now() - continueStartedAt,
            timestamp: new Date().toISOString()
          });
        }
        const activeCheckpoint = recovery.activeMeetingCheckpointRef.current;
        session = await recovery.createSession({
          preserveTranscript: true,
          startupStartedAt: continueStartedAt,
          continueStartedAt,
          liveSessionId: legacyContinue?.operation.nextLiveSessionId || recovery.generateLiveSessionId(),
          meetingId: activeCheckpoint?.meetingId,
          segmentId: activeCheckpoint?.segmentId
        });
        recovery.sessionRef.current = session;
        const started = await session.start();
        if (started !== true) {
          const error = new Error('無法繼續即時字幕：Gemini Live 連線未完成，請重試。');
          error.code = 'continue_provider_not_ready';
          error.reasonHint = 'provider_start_incomplete';
          error.startupStage = 'provider';
          error.userMessage = '無法繼續即時字幕：Gemini Live 連線未完成，請重試。';
          throw error;
        }
        recordLivePipelineTrace({
          stage: 'CONTINUE_PROVIDER_READY',
          meetingId: activeCheckpoint?.meetingId,
          sessionId: recovery.activeSessionRecordIdRef.current,
          segmentId: activeCheckpoint?.segmentId,
          continueElapsedMs: Date.now() - continueStartedAt
        });
        if (legacyContinue
          && session.effectiveGlossaryRevision !== legacyContinue.result.effectiveGlossaryRevision) {
          const error = new Error('Legacy Continue glossary revision mismatch.');
          error.code = 'glossary_revision_mismatch';
          throw error;
        }
        recovery.setTranscriptTimeOriginValue();
        if (!recovery.activateLiveSessionCallbacks(session.callbackGeneration)) throw new Error('即時字幕 callback 啟動失敗。');
        await audioController.resumeRawAudioRecording();
        recordLivePipelineTrace({
          stage: 'CONTINUE_AUDIO_RESUMED',
          meetingId: activeCheckpoint?.meetingId,
          sessionId: recovery.activeSessionRecordIdRef.current,
          segmentId: activeCheckpoint?.segmentId,
          continueElapsedMs: Date.now() - continueStartedAt
        });
        recovery.setLiveCueUpdatesAllowed(true);
        if (legacyContinue) {
          await completeDurableLegacyContinue(legacyPersistence, legacyContinue.operation);
        }
        await recovery.updateCurrentSessionStatus('active', { lastLifecycleState: 'listening' });
        recovery.clearSessionSnapshotSyncError();
        recordLivePipelineTrace({
          stage: 'CONTINUE_READY',
          meetingId: checkpoint?.meetingId,
          sessionId: recovery.activeSessionRecordIdRef.current,
          segmentId: checkpoint?.segmentId,
          revision: session.effectiveGlossaryRevision,
          glossaryEntryCount: session.liveGlossaryEntries.length,
          continueElapsedMs: Date.now() - continueStartedAt,
          timestamp: new Date().toISOString()
        });
        recovery.setStatus('listening');
        recovery.startSegmentSwitch?.();
        continueInFlightRef.current = false;
      } catch (error) {
        await stopSessionSafely(session);
        continueInFlightRef.current = false;
        if (recovery.sessionStopRequestedRef.current) return;
        recovery.sessionRef.current = null;
        if (!meetingLifecycleRef.current && isRecoverableLegacyContinueError(error)) {
          recovery.setError(meetingRequestErrorMessage(error, '雲端暫時無法確認續錄結果，請重試。'));
          recovery.setStatus('paused');
          return;
        }
        if ([
          'glossary_revision_mismatch',
          'token_segment_mismatch',
          'recorder_session_mismatch',
          'recorder_lease_invalid',
          'meeting_lifecycle_conflict'
        ].includes(error?.code)) {
          if (meetingLifecycleRef.current) {
            await executeMeetingLifecycleCommand('pause').catch(() => {});
          }
          recordLivePipelineTrace({
            stage: 'CONTINUE_CONFIGURATION_FAILED',
            meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
            sessionId: recovery.activeSessionRecordIdRef.current,
            segmentId: recovery.activeMeetingCheckpointRef.current?.segmentId,
            revision: session?.effectiveGlossaryRevision,
            glossaryEntryCount: session?.liveGlossaryEntries?.length ?? 0,
            reason: error.code,
            errorCode: error.code,
            timestamp: new Date().toISOString()
          });
          recovery.setError(error.userMessage || '字典設定同步失敗，請重試。');
          recovery.setStatus('paused');
          return;
        }
        recovery.applyStartFailure(error, '無法繼續即時字幕。');
      }
    },
    async pauseSession() {
      recovery.reconnectController().cancel();
      controller.cancelProviderRecovery('pause');
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = true;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      recovery.setStatus('stopping');
      const reconnectingSession = recovery.reconnectSessionRef.current;
      recovery.reconnectSessionRef.current = null;
      await audioController.pauseRawAudioRecording();
      await stopSessionSafely(reconnectingSession);
      await stopSessionSafely(recovery.sessionRef.current);
      recovery.sessionRef.current = null;
      recovery.invalidateLiveSessionCallbacks();
      recovery.setLiveCueUpdatesAllowed(false);
      await recovery.finalizePendingTranscriptItemsForStop();
      cueController.flushSubtitleCues('pause');
      await recovery.flushMeetingCuePublishes?.(
        recovery.activeSessionRecordIdRef.current,
        { forceCloud: true }
      );
      const checkpointFlushed = await checkpointController.flushMeetingCheckpointSync();
      if (!checkpointFlushed) {
        recovery.setMeetingCheckpointStatus?.('error');
        recovery.setMeetingCheckpointErrorMessage?.('長會議同步尚未完成，未同步字幕已保留，請重試暫停。');
        return;
      }
      if (recovery.sessionStopRequestedRef.current) return;
      if (meetingLifecycleRef.current) {
        await executeMeetingLifecycleCommand('pause');
      }
      if (recovery.sessionStopRequestedRef.current) return;
      await recovery.updateCurrentSessionStatus('paused');
      const pausedMeetingId = recovery.activeMeetingCheckpointRef.current?.meetingId || routeMeetingId;
      if (pausedMeetingId) {
        recovery.setResumeDraft?.({
          meetingId: pausedMeetingId,
          sessionId: recovery.activeSessionRecordIdRef.current,
          hasTranscript: true,
          hasBoundLiveSession: true,
          transcriptState: recovery.getTranscriptState?.(),
          segmentId: recovery.activeMeetingCheckpointRef.current?.segmentId || null
        });
      }
      recovery.pendingMicrophoneStreamRef.current = null;
      recovery.setStatus('paused');
    },
    async startSession() {
      if (startOperationRef.current) return startOperationRef.current;
      const operation = this.startSessionLifecycle();
      startOperationRef.current = operation;
      return operation.finally(() => {
        if (startOperationRef.current === operation) startOperationRef.current = null;
      });
    },
    async startSessionLifecycle() {
      let microphoneWarmupPromise = null;
      let microphoneStreamClaimed = false;
      const status = state.status ?? 'idle';
      const isActive = Boolean(state.isActive);
      if (status === 'active' || status === 'paused' || isActive || recovery.sessionRef.current || recovery.activeSessionRecordIdRef.current) {
        recovery.setError('目前已有工作階段正在進行或暫停中，請先暫停或結束目前工作階段。');
        return;
      }
      if (recovery.sessionControlLeaseRef.current?.isHeldByAnotherTab()) {
        recovery.setError('目前已有工作階段由其他頁籤控制。請先在原頁籤結束後再開始。');
        return;
      }
      const selectedResumableMeeting = [
        selectedMeetingDetail?.meeting,
        meetingRecords.find((meeting) => meeting.id === routeMeetingId)
      ].find((meeting) => meeting?.id === routeMeetingId && ['created', 'active', 'interrupted'].includes(meeting.status));
      if (!selectedResumableMeeting) {
        recovery.setError('請先選擇一個可錄音的會議。');
        return;
      }
      recovery.invalidateLiveSessionCallbacks();
      recovery.sessionStopRequestedRef.current = false;
      recovery.meetingResumeDraftRequestIdRef.current += 1;
      recovery.reconnectController().reset();
      clearSettledRecoveryForCheckpoint(recovery.activeMeetingCheckpointRef.current);
      recovery.reconnectFailureDiagnosticRef.current = null;
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = false;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.setLiveCueUpdatesAllowed(true);
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      let session;
      let record = null;
      const startupStartedAt = Date.now();
      recovery.setStatus('requesting-permission');
      try {
        await audioController.cleanup();
        audioController.resetInputAudioDownload();
        audioController.resetTranslatedAudioDownload();
        recovery.pendingMicrophoneStreamRef.current = null;
        microphoneWarmupPromise = warmUpMicrophoneInput({
          inputDeviceId: selectedInputDeviceId,
          onInputDeviceFallback: () => {
            recovery.setSelectedInputDeviceId?.('');
            recovery.setDeviceMessage?.('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
          }
        }).then(
          (stream) => ({ stream, error: null }),
          (error) => ({ stream: null, error })
        );
        const liveSessionId = recovery.generateLiveSessionId();
      let meetingCheckpoint;
      let lifecycleSessionId = null;
      if (routeMeetingId && selectedResumableMeeting.lifecycleContractVersion === 2) {
        const lifecycle = await recovery.meetingCheckpointApiClientRef.current.executeRecordingCommand({
          meetingId: routeMeetingId,
          command: 'start',
          operationId: nextOperationId('start'),
          expectedLifecycleVersion: selectedResumableMeeting.lifecycleVersion ?? 0
        });
        meetingTimingRef.current = {
          meetingId: routeMeetingId,
          startedAt: lifecycle.meeting.started_at ?? lifecycle.meeting.startedAt ?? meetingTimingRef.current.startedAt
        };
        configureLivePipelineElapsedContext({ meetingStartedAt: meetingTimingRef.current.startedAt });
        meetingLifecycleRef.current = {
          meetingId: routeMeetingId,
          sessionId: lifecycle.session.id,
          segmentId: lifecycle.segment.id,
          lifecycleVersion: lifecycle.meeting.lifecycle_version ?? lifecycle.meeting.lifecycleVersion,
          leaseId: lifecycle.lease.leaseId,
          fenceToken: lifecycle.lease.fenceToken,
          leaseTimer: null,
          livenessTimer: null
        };
        setMeetingLifecycleWriteFence(meetingLifecycleRef.current);
        lifecycleSessionId = lifecycle.session.id;
        meetingCheckpoint = { meetingId: routeMeetingId, segmentId: lifecycle.segment.id, segmentSequence: lifecycle.segment.sequence };
        recovery.activeMeetingCheckpointRef.current = meetingCheckpoint;
        checkpointController.meetingCheckpointSyncCoordinator().start(meetingCheckpoint);
        startMeetingLifecycleHeartbeats();
      } else if (routeMeetingId) {
        const segmentsResult = await recovery.meetingCheckpointApiClientRef.current.listSegments({ meetingId: routeMeetingId });
          const segment = [...segmentsResult.segments].reverse().find((item) => ['created', 'active'].includes(item.status) && !item.liveSessionId);
          if (!segment) throw new Error('此會議目前沒有可開始的錄音段落。');
          const started = await recovery.meetingCheckpointApiClientRef.current.startMeeting({ meetingId: routeMeetingId, segmentId: segment.id, liveSessionId });
        meetingTimingRef.current = {
          meetingId: routeMeetingId,
          startedAt: started.meeting.startedAt ?? started.meeting.started_at ?? meetingTimingRef.current.startedAt
        };
        configureLivePipelineElapsedContext({ meetingStartedAt: meetingTimingRef.current.startedAt });
        meetingCheckpoint = { meetingId: started.meeting.id, segmentId: started.segment.id, segmentSequence: started.segment.sequence };
          recovery.activeMeetingCheckpointRef.current = meetingCheckpoint;
          checkpointController.meetingCheckpointSyncCoordinator().start(meetingCheckpoint);
        } else {
          meetingCheckpoint = await controller.createMeetingCheckpointForSession({
            liveSessionId,
            glossaryEntries: selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode),
            privateGlossaryEntries: privateMeetingGlossaryEntries
          });
        }
      record = await controller.createCurrentSessionRecord(meetingCheckpoint, null, lifecycleSessionId);
        if (!recovery.sessionControlLeaseRef.current?.tryAcquire(record.id)) throw new Error('目前已有工作階段由其他頁籤控制。');
        recovery.setHasSessionControl(true);
        session = await recovery.createSession({
          preserveTranscript: false,
          liveSessionId,
          startupStartedAt,
          meetingId: meetingCheckpoint?.meetingId,
          segmentId: meetingCheckpoint?.segmentId
        });
        recovery.sessionRef.current = session;
        const microphoneResult = await microphoneWarmupPromise;
        if (microphoneResult.error) throw microphoneResult.error;
        recovery.pendingMicrophoneStreamRef.current = microphoneResult.stream;
        microphoneStreamClaimed = true;
        const started = await session.start({ inputStream: microphoneResult.stream });
        if (!started) throw new Error('首個音訊資料未成功送出。');
        recovery.activateLiveSessionCallbacks(session.callbackGeneration);
        const activeRecord = recovery.sessionRepositoryRef.current.updateSessionRecord(record.id, { status: 'active', startedAt: record.startedAt || Date.now(), lastLifecycleState: 'listening' });
        await checkpointController.flushSessionSnapshot(record.id);
        await audioController.startRecordingForSession(activeRecord);
        recovery.setStatus('listening');
        recovery.updateLiveMeetingUrl(meetingCheckpoint.meetingId);
        recovery.startSegmentSwitch?.();
      } catch (error) {
        if (!microphoneStreamClaimed && microphoneWarmupPromise) {
          void microphoneWarmupPromise.then(({ stream }) => stopMicrophoneStream(stream));
        }
        await stopSessionSafely(session);
        if (recovery.sessionStopRequestedRef.current) return;
        if (error?.code === 'meeting_segment_invalid_state' && routeMeetingId) {
          try {
            const latestSegments = await recovery.meetingCheckpointApiClientRef.current.listSegments({ meetingId: routeMeetingId });
            const resumableSegment = [...latestSegments.segments].reverse().find((segment) => segment.status === 'active' && segment.liveSessionId);
            if (resumableSegment) {
        recovery.activeMeetingCheckpointRef.current = { meetingId: routeMeetingId, segmentId: resumableSegment.id, segmentSequence: resumableSegment.sequence };
              recovery.setResumeDraft?.({
                sessionId: await recovery.findActiveMeetingSessionId?.(routeMeetingId),
                meetingId: routeMeetingId,
                segmentId: resumableSegment.id,
                transcriptState: recovery.getTranscriptState?.(),
                hasTranscript: false,
                hasBoundLiveSession: true
              });
              recovery.setStatus('idle');
              recovery.setError('此會議已有正在錄製的段落，已切換為「繼續錄製」流程。');
              return;
            }
            recovery.setStatus('idle');
            recovery.setError('此會議目前沒有可恢復的錄音段落，請返回會議管理。');
            return;
          } catch {
            // Fall through to the normal start failure cleanup and message.
          }
        }
        if (meetingLifecycleRef.current) {
          await executeMeetingLifecycleCommand('stop').catch(() => {});
          stopMeetingLifecycleHeartbeats();
          meetingLifecycleRef.current = null;
          clearMeetingLifecycleWriteFence(routeMeetingId);
        } else {
          await controller.interruptActiveMeeting({
            failureReason: 'live_connect_failed',
            failureCategory: 'provider'
          }).catch(() => {});
        }
        await Promise.resolve(audioController.cleanup()).catch(() => {});
        if (record?.id) {
          recovery.sessionControlLeaseRef.current?.release(record.id);
          recovery.setHasSessionControl(false);
          recovery.sessionRepositoryRef.current.updateSessionRecord(record.id, { status: 'failed', failureReason: 'live_connect_failed', failureCategory: 'provider' });
          await checkpointController.flushSessionSnapshot(record.id).catch(() => {});
          recovery.activeSessionRecordIdRef.current = null;
        }
        recovery.activeMeetingCheckpointRef.current = null;
        checkpointController.cancel();
        segmentSwitchController.cancel();
        recovery.applyStartFailure(error, '無法開始即時字幕。');
      }
    },
    async startReconnectSession({ generationId, classification }) {
      if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) return;

      const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
      const transitionKey = recoveryKeyFor(meetingCheckpoint);
      if (!transitionKey) return;
      const releaseTransition = segmentTransitionLock.tryAcquire(transitionKey);
      if (!releaseTransition) return;

      recovery.setError('');
      recovery.invalidateLiveSessionCallbacks();
      recovery.setStatusLabelOverride('');
      recovery.setStatus('reconnecting');
      recovery.cancelSegmentSwitch?.();

      const nextLiveSessionId = recovery.generateLiveSessionId();
      let recoveredSegment;
      let reconnectStage = 'flush_audio';
      let session = null;
      try {
        try {
          if (!meetingCheckpoint) throw new Error('Missing active meeting checkpoint.');
        reconnectStage = 'flush_audio';
        await audioController.pauseRawAudioRecording();
        await recovery.finalizePendingTranscriptItemsForStop();
        cueController.flushSubtitleCues('reconnect');
        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await stopSessionSafely(session);
          return;
        }

        reconnectStage = 'flush_checkpoint';
        const flushed = await checkpointController.flushMeetingCheckpointSync();
        if (!flushed) throw new Error('Unable to flush meeting checkpoint before reconnect.');
        if (!meetingLifecycleRef.current) recovery.archiveActiveTranscriptSegment();

        reconnectStage = 'recover_segment';
        const recoveryKey = recoveryKeyFor(meetingCheckpoint);
        if (!recoveryKey) throw new Error('Missing active meeting checkpoint key.');
          recoveredSegment = meetingLifecycleRef.current
            ? { segment: { id: meetingCheckpoint.segmentId } }
            : await recoverySingleFlight.run(`${recoveryKey}:recover`, () => (
              recovery.meetingCheckpointApiClientRef.current.recoverSegment({
                meetingId: meetingCheckpoint.meetingId,
                segmentId: meetingCheckpoint.segmentId,
                idempotencyKey: `recover:${meetingCheckpoint.segmentId}:${nextLiveSessionId}`,
                checkpoint: {
                  idempotencyKey: `checkpoint:${meetingCheckpoint.segmentId}:recover:${nextLiveSessionId}`,
                  durableChunks: [],
                  pendingPartial: null
                },
                nextLiveSessionId,
                failureReason: classification.reason,
                failureCategory: classification.category,
                outcome: 'interrupted'
              })
            ));
          if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) return;
          if (!meetingLifecycleRef.current) {
            activateRecoveredMeetingSegment({
              meetingId: meetingCheckpoint.meetingId,
              recoveryResult: recoveredSegment,
              activeMeetingCheckpointRef: recovery.activeMeetingCheckpointRef,
              startCheckpointSync: (checkpoint) => checkpointController.meetingCheckpointSyncCoordinator().start(checkpoint)
            });
          }
          reconnectStage = 'create_session';
          session = await recovery.createSession({
            preserveTranscript: true,
            liveSessionId: nextLiveSessionId,
            meetingId: meetingCheckpoint.meetingId,
            segmentId: recoveredSegment.segment.id
          });
          recovery.reconnectSessionRef.current = session;

        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await stopSessionSafely(session);
          return;
        }
        reconnectStage = 'connect_live_session';
        await session.start();
        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await stopSessionSafely(session);
          return;
        }
        recovery.activateLiveSessionCallbacks(session.callbackGeneration);
        reconnectStage = 'resume_audio';
        await audioController.noteProviderReconnect();
        await audioController.resumeRawAudioRecording();
      } catch (error) {
        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await stopSessionSafely(session);
          return;
        }
        await stopSessionSafely(session);
        recovery.reconnectSessionRef.current = null;
        recovery.sessionRef.current = null;
        recovery.setStatusLabelOverride('');
        const diagnostic = recovery.safeReconnectDiagnostic({ source: 'reconnect_session', stage: reconnectStage, rawError: error, reasonHint: classification.reason }, classification);
        recovery.reconnectFailureDiagnosticRef.current = diagnostic;
        void recovery.appendSessionFailureDiagnostic(diagnostic, classification);
        recovery.setError(error?.operation
          ? meetingRequestErrorMessage(error, '無法重新連線。')
          : recovery.reconnectErrorMessage({ decision: { stopReason: 'reconnect_session_failed' } }, diagnostic));
        recovery.setStatus('error');
        void controller.finalizeFailedSession({ status: 'failed', failureReason: classification.reason, failureCategory: classification.category });
        return;
      }

      if (!recovery.isCurrentGeneration?.(generationId) || recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) {
        await stopSessionSafely(session);
        return;
      }
      recovery.reconnectSessionRef.current = null;
      recovery.sessionRef.current = session;
      recovery.startSegmentSwitch?.();
      recovery.setStatusLabelOverride('');
      recovery.setStatus('listening');
      } finally {
        releaseTransition();
      }
    },
    async resumeMeetingSession() {
      if (!recovery.resumeDraft || recovery.isActive || resumeInFlightRef.current) return;
      resumeInFlightRef.current = true;
      const draft = recovery.resumeDraft;
      recovery.resetReconnect?.();
      recovery.reconnectFailureDiagnosticRef.current = null;
      recovery.invalidateLiveSessionCallbacks();
      recovery.sessionStopRequestedRef.current = false;
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = false;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.setLiveCueUpdatesAllowed(false);
      recovery.setStatusLabelOverride('');
      recovery.setError('');
      recovery.setResumeDraft(null);
      audioController.resetTranslatedAudioDownload();

      let session;
      let recoveredMeetingCheckpoint = null;
      let resumedSessionRecordId = null;
      let resumedLiveSessionId = null;
      let selectedResumeSegmentId = draft.segmentId;
      let legacyContinue = null;
      let legacyPersistence = null;
      let legacyResumeFlow = false;
      try {
        const nextLiveSessionId = recovery.generateLiveSessionId();
        resumedLiveSessionId = nextLiveSessionId;
        recovery.setStatus('reconnecting');
        const previousCueState = cue.stateRef.current;
        const preparedCueState = prepareSubtitleCueStateForNewSegment(previousCueState, {
          sessionTimeMs: recovery.getSessionTime(),
          reason: 'resume'
        });
        commitCueTransition(cue, previousCueState, preparedCueState);
        const lifecycleMeeting = selectedMeetingDetail?.meeting?.id === draft.meetingId
          ? selectedMeetingDetail.meeting
          : null;
        let resumed;
        if (lifecycleMeeting?.lifecycleContractVersion === 2) {
          const lifecycle = await recovery.meetingCheckpointApiClientRef.current.executeRecordingCommand({
            meetingId: draft.meetingId,
            command: 'takeover',
            operationId: nextOperationId('takeover'),
            expectedLifecycleVersion: lifecycleMeeting.lifecycleVersion ?? 0
          });
          meetingTimingRef.current = {
            meetingId: draft.meetingId,
            startedAt: lifecycle.meeting.started_at ?? lifecycle.meeting.startedAt ?? lifecycleMeeting.startedAt ?? meetingTimingRef.current.startedAt
          };
          configureLivePipelineElapsedContext({ meetingStartedAt: meetingTimingRef.current.startedAt });
          meetingLifecycleRef.current = {
            meetingId: draft.meetingId,
            sessionId: lifecycle.session.id,
            segmentId: lifecycle.segment.id,
            lifecycleVersion: lifecycle.meeting.lifecycle_version ?? lifecycle.meeting.lifecycleVersion,
            leaseId: lifecycle.lease.leaseId,
            fenceToken: lifecycle.lease.fenceToken,
            leaseTimer: null,
            livenessTimer: null
          };
          setMeetingLifecycleWriteFence(meetingLifecycleRef.current);
          startMeetingLifecycleHeartbeats();
          resumed = { segment: { id: lifecycle.segment.id } };
        } else {
          legacyResumeFlow = true;
          legacyPersistence = checkpoint.getLocalMeetingPersistence();
          const durableCheckpoint = await legacyPersistence.getCheckpoint({
            meetingId: draft.meetingId,
            segmentId: draft.segmentId
          });
          legacyContinue = await establishDurableLegacyContinue({
            persistence: legacyPersistence,
            api: recovery.meetingCheckpointApiClientRef.current,
            meetingId: draft.meetingId,
            sourceSegmentId: draft.segmentId,
            expectedSessionId: draft.sessionId,
            checkpoint: durableCheckpoint?.checkpoint || {},
            liveSessionIdFactory: recovery.generateLiveSessionId,
            shouldContinue: () => !recovery.sessionStopRequestedRef.current
          });
          resumed = legacyContinue.result;
          resumedLiveSessionId = legacyContinue.operation.nextLiveSessionId;
        }
        selectedResumeSegmentId = resumed.segment.id;
        const nextMeetingCheckpoint = { meetingId: draft.meetingId, segmentId: resumed.segment.id, segmentSequence: resumed.segment.sequence };
        recoveredMeetingCheckpoint = nextMeetingCheckpoint;
        recovery.activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
        checkpointController.meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
        const resumedRecord = await controller.createCurrentSessionRecord(nextMeetingCheckpoint, draft.transcriptState, draft.sessionId);
        resumedSessionRecordId = resumedRecord.id;
        recovery.resetActiveTranscriptForNextSegment(draft.transcriptState.nextSequence);
        session = await recovery.createSession({
          preserveTranscript: true,
          liveSessionId: legacyContinue?.operation.nextLiveSessionId || nextLiveSessionId,
          meetingId: nextMeetingCheckpoint.meetingId,
          segmentId: nextMeetingCheckpoint.segmentId
        });
        recovery.sessionRef.current = session;
        await session.start();
        if (legacyContinue
          && session.effectiveGlossaryRevision !== legacyContinue.result.effectiveGlossaryRevision) {
          const error = new Error('Legacy Continue glossary revision mismatch.');
          error.code = 'glossary_revision_mismatch';
          throw error;
        }
        recovery.setTranscriptTimeOriginValue();
        if (!recovery.activateLiveSessionCallbacks(session.callbackGeneration)) throw new Error('即時字幕 callback 啟動失敗。');
        recovery.setLiveCueUpdatesAllowed(true);
        if (legacyContinue) {
          await completeDurableLegacyContinue(legacyPersistence, legacyContinue.operation);
        }
        recovery.sessionRepositoryRef.current.updateSessionRecord(recovery.activeSessionRecordIdRef.current, { status: 'active', startedAt: Date.now(), lastLifecycleState: 'listening' });
        const snapshotSynced = await checkpointController.flushSessionSnapshot(recovery.activeSessionRecordIdRef.current);
        if (snapshotSynced) recovery.clearSessionSnapshotSyncError();
        recovery.setStatus('listening');
        recovery.startSegmentSwitch?.();
      } catch (error) {
        await stopSessionSafely(session);
        if (meetingLifecycleRef.current) {
          await executeMeetingLifecycleCommand('pause').catch(() => {});
          stopMeetingLifecycleHeartbeats();
        } else if (recoveredMeetingCheckpoint && !legacyContinue) {
          const cleanupResult = await recoverySingleFlight.run(`${recoveredMeetingCheckpoint.meetingId}:${recoveredMeetingCheckpoint.segmentId}:recover`, () => (
            recovery.meetingCheckpointApiClientRef.current.recoverSegment({
              meetingId: recoveredMeetingCheckpoint.meetingId,
              segmentId: recoveredMeetingCheckpoint.segmentId,
              idempotencyKey: `resume-failed:${recoveredMeetingCheckpoint.segmentId}:${resumedLiveSessionId || 'unknown'}`,
              checkpoint: { idempotencyKey: `checkpoint:${recoveredMeetingCheckpoint.segmentId}:resume-failed`, durableChunks: [], pendingPartial: null },
              nextLiveSessionId: null,
              failureReason: 'resume_start_failed',
              failureCategory: 'startup',
              outcome: 'interrupted'
            })
          )).catch(() => null);
          if (cleanupResult?.segment?.id) selectedResumeSegmentId = cleanupResult.segment.id;
        }
        const failedSessionRecordId = resumedSessionRecordId || recovery.activeSessionRecordIdRef.current;
        if (failedSessionRecordId) {
          const classification = recovery.classifyFailureSignal({ source: 'startup', rawError: error, reasonHint: 'live_connect_failed' });
          const diagnostic = recovery.safeReconnectDiagnostic({ source: 'startup', stage: 'resume_session', rawError: error, reasonHint: classification.reason }, classification);
          const current = recovery.sessionRepositoryRef.current.getSessionRecord(failedSessionRecordId)?.sessionRecord;
          recovery.sessionControlLeaseRef.current?.release(failedSessionRecordId);
          recovery.setHasSessionControl(false);
          recovery.sessionRepositoryRef.current.updateSessionRecord(failedSessionRecordId, { status: 'failed', failureReason: 'live_connect_failed', failureCategory: 'provider', failureDiagnostics: [...(current?.failureDiagnostics || []), diagnostic].slice(-10) });
          await checkpointController.flushSessionSnapshot(failedSessionRecordId).catch(() => {});
          recovery.activeSessionRecordIdRef.current = null;
        }
        if (recovery.sessionStopRequestedRef.current) return;
        recovery.sessionRef.current = null;
        recovery.activeMeetingCheckpointRef.current = null;
        checkpointController.cancel();
        recovery.cancelSegmentSwitch?.();
        recovery.setResumeDraft({ ...draft, segmentId: selectedResumeSegmentId });
        recovery.setError(meetingRequestErrorMessage(error, '無法續錄長會議。'));
        recovery.setStatus(legacyResumeFlow && isRecoverableLegacyContinueError(error) ? 'idle' : 'error');
      } finally {
        resumeInFlightRef.current = false;
      }
    },
    async switchMeetingSegment({ generation: rolloverGeneration } = {}) {
      const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
      const previousSession = recovery.sessionRef.current;
      if (!meetingCheckpoint || !previousSession || recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;

      const transitionKey = recoveryKeyFor(meetingCheckpoint);
      if (!transitionKey) return;
      const releaseTransition = segmentTransitionLock.tryAcquire(transitionKey);
      if (!releaseTransition) return;

      let rolloverStage = 'prepare';
      let rolloverCommandCommitted = false;
      try {
        recordLivePipelineTrace({
          stage: 'SESSION_ROLLOVER_START',
          meetingId: meetingCheckpoint.meetingId,
          recorderSessionId: recovery.activeSessionRecordIdRef.current,
          geminiSessionId: previousSession.liveSessionId,
          oldSessionId: recovery.activeSessionRecordIdRef.current,
          oldSegmentId: meetingCheckpoint.segmentId,
          rolloverGeneration,
          recordingState: 'switching-segment',
          captureEpoch: previousSession.captureEpoch,
          providerEpoch: previousSession.providerEpoch
        });
        recovery.reconnectController().cancel();
        recovery.setError('');
        recovery.setStatusLabelOverride('切換下一段中');
        recovery.setStatus('switching-segment');
        const nextLiveSessionId = recovery.generateLiveSessionId();

        rolloverStage = 'provider-drain';
        const drain = await previousSession.beginProviderTransition?.({ maxWaitMs: 3_000 });
        recordLivePipelineTrace({
          stage: 'PROVIDER_TRANSITION_DRAINED',
          meetingId: meetingCheckpoint.meetingId,
          oldSegmentId: meetingCheckpoint.segmentId,
          providerEpoch: drain?.providerEpoch ?? previousSession.providerEpoch,
          audioTurnId: drain?.audioTurnId,
          eventSequence: drain?.eventSequence,
          queueDepth: previousSession.pendingInputAudioChunks?.length,
          reason: drain?.timedOut ? 'bounded_timeout' : 'provider_boundary'
        });
        await recovery.finalizePendingTranscriptItemsForStop();
        cueController.flushSubtitleCues('segment-rollover');
        await recovery.flushMeetingCuePublishes?.(recovery.activeSessionRecordIdRef.current);
        if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;

        rolloverStage = 'checkpoint';
        const flushed = await checkpointController.flushMeetingCheckpointSync();
        if (!flushed) {
          recovery.setMeetingCheckpointStatus?.('error');
          recovery.setMeetingCheckpointErrorMessage?.('長會議同步暫時失敗，錄音與本機字幕仍會繼續，未同步資料會保留重試。');
          throw new Error('Unable to flush meeting checkpoint before rollover.');
        }
    if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;

        rolloverStage = 'rollover-command';
        const lifecycle = meetingLifecycleRef.current;
        const operationId = lifecycle
          ? nextOperationId('rollover')
          : `rollover:${meetingCheckpoint.segmentId}:${previousSession.liveSessionId}`;
        const lifecycleIdentity = lifecycle
          ? { operationId, expectedLifecycleVersion: lifecycle.lifecycleVersion }
          : null;
        const legacyPayload = {
          meetingId: meetingCheckpoint.meetingId,
          segmentId: meetingCheckpoint.segmentId,
          idempotencyKey: operationId,
          checkpoint: {
            idempotencyKey: `checkpoint:${meetingCheckpoint.segmentId}:rollover`,
            durableChunks: [],
            pendingPartial: null
          },
          nextLiveSessionId
        };
        const operation = {
          operationId,
          payload: lifecycle
            ? {
                meetingId: lifecycle.meetingId,
                command: 'rollover',
                expectedLifecycleVersion: lifecycleIdentity.expectedLifecycleVersion,
                leaseId: lifecycle.leaseId,
                fenceToken: lifecycle.fenceToken,
                nextLiveSessionId
              }
            : legacyPayload
        };
        const rolloverCoordinator = createRolloverRecoveryCoordinator({
          execute: () => lifecycle
            ? executeMeetingLifecycleCommand('rollover', { nextLiveSessionId }, lifecycleIdentity)
            : recovery.meetingCheckpointApiClientRef.current.rolloverSegment(legacyPayload),
          reconcile: async () => {
            const authoritative = await recovery.meetingCheckpointApiClientRef.current.listSegments({ meetingId: meetingCheckpoint.meetingId });
            const committedSegment = authoritative.segments.find((segment) => (
              segment.id !== meetingCheckpoint.segmentId
              && segment.status === 'active'
              && (!Number.isSafeInteger(meetingCheckpoint.segmentSequence)
                || segment.sequence === meetingCheckpoint.segmentSequence + 1)
            ));
            if (committedSegment) {
              if (!lifecycle) {
                return { status: 'committed', result: { segment: committedSegment }, authoritativeSegment: committedSegment };
              }
              // The lifecycle RPC is idempotent by operationId and returns the stored
              // response. Replaying it here retrieves the authoritative lease/session
              // after a lost ACK; it does not create another Segment.
              const result = await executeMeetingLifecycleCommand('rollover', { nextLiveSessionId }, lifecycleIdentity);
              return { status: 'committed', result, authoritativeSegment: result.segment };
            }
            const sourceSegment = authoritative.segments.find((segment) => segment.id === meetingCheckpoint.segmentId);
            return sourceSegment?.status === 'active'
              ? { status: 'source-active', authoritativeSegment: sourceSegment }
              : { status: 'conflict', authoritativeSegment: sourceSegment || null };
          },
          onStateChange: (rolloverState) => recordLivePipelineTrace({
            stage: 'SESSION_ROLLOVER_RECOVERY',
            meetingId: meetingCheckpoint.meetingId,
            oldSegmentId: meetingCheckpoint.segmentId,
            operationId,
            rolloverGeneration: rolloverState.attempt,
            retryAttempt: rolloverState.attempt,
            authoritativeSegmentId: rolloverState.authoritativeSegment?.id,
            reason: rolloverState.status,
            httpStatus: rolloverState.lastError?.status,
            serverErrorCode: rolloverState.lastError?.code
          })
        });
        const rollover = await rolloverCoordinator.run(operation);
        rolloverCommandCommitted = true;
        recordLivePipelineTrace({
          stage: 'ROLLOVER_COMMITTED',
          meetingId: meetingCheckpoint.meetingId,
          recorderSessionId: recovery.activeSessionRecordIdRef.current,
          geminiSessionId: nextLiveSessionId,
          oldSegmentId: meetingCheckpoint.segmentId,
          newSegmentId: rollover.segment.id,
          rolloverGeneration,
          recordingState: 'switching-segment',
          reason: 'authoritative_segment_committed'
        });

      if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;
      recovery.archiveActiveTranscriptSegment();
      const nextMeetingCheckpoint = { meetingId: meetingCheckpoint.meetingId, segmentId: rollover.segment.id, segmentSequence: rollover.segment.sequence };
      recordLivePipelineTrace({
        stage: 'SESSION_CREATED',
        meetingId: meetingCheckpoint.meetingId,
        oldSessionId: recovery.activeSessionRecordIdRef.current,
        newSessionId: rollover.session?.id || recovery.activeSessionRecordIdRef.current,
        oldSegmentId: meetingCheckpoint.segmentId,
        newSegmentId: rollover.segment.id
      });
      recovery.activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
      checkpointController.meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
      recordLivePipelineTrace({
        stage: 'SESSION_SCOPE_SWITCHED',
        meetingId: meetingCheckpoint.meetingId,
        oldSessionId: recovery.activeSessionRecordIdRef.current,
        newSessionId: rollover.session?.id || recovery.activeSessionRecordIdRef.current,
        oldSegmentId: meetingCheckpoint.segmentId,
        newSegmentId: rollover.segment.id
      });
      const sessionId = recovery.activeSessionRecordIdRef.current;
      if (sessionId && !meetingLifecycleRef.current) {
        rolloverStage = 'session-metadata';
        await recovery.sessionCommandApiClientRef.current.update(sessionId, {
          status: 'active',
          segmentId: rollover.segment.id
        });
      }
      cueController.flushSubtitleCues('segment-rollover');
      rolloverStage = 'local-audio-scope';
      await audioController.rolloverLocalSegment({
        operationId,
        nextSegmentId: rollover.segment.id
      });
      rolloverStage = 'provider-recovery';
      const providerRecoveryContext = Object.freeze({
        session: previousSession,
        segmentId: rollover.segment.id,
        liveSessionId: nextLiveSessionId
      });
      providerRecoveryContextRef.current = providerRecoveryContext;
      const providerRecovery = await runCommittedProviderRecovery(providerRecoveryContext);
      if (providerRecovery.status === 'cancelled') return;
      if (providerRecovery.status !== 'ready') {
        const error = new Error('翻譯已停止，可手動重試', { cause: providerRecovery.lastError });
        error.code = 'provider_recovery_exhausted';
        throw error;
      }
      providerRecoveryContextRef.current = null;
      rolloverStage = 'audio-resume';

      if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) {
        return;
      }

      recovery.activateLiveSessionCallbacks(previousSession.callbackGeneration);
      recovery.sessionRef.current = previousSession;
      recovery.setStatusLabelOverride('下一段已開始');
      recovery.setStatus('listening');
      recordLivePipelineTrace({
        stage: 'RECORDING_PIPELINE_STATE',
        meetingId: nextMeetingCheckpoint.meetingId,
        sessionId: recovery.activeSessionRecordIdRef.current,
        segmentId: nextMeetingCheckpoint.segmentId,
        captureEpoch: previousSession.captureEpoch,
        providerEpoch: previousSession.providerEpoch,
        reason: 'rollover_continued'
      });
      } catch (cause) {
        recordLivePipelineTrace({
          stage: 'ROLLOVER_FAILED',
          meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
          recorderSessionId: recovery.activeSessionRecordIdRef.current,
          geminiSessionId: previousSession.liveSessionId,
          segmentId: recovery.activeMeetingCheckpointRef.current?.segmentId,
          rolloverGeneration,
          recordingState: rolloverCommandCommitted ? 'reconnecting' : 'listening',
          httpStatus: cause?.status,
          errorCode: cause?.code,
          reason: rolloverStage
        });
        if (!rolloverCommandCommitted) previousSession.cancelProviderTransition?.();
        recovery.activateLiveSessionCallbacks(previousSession.callbackGeneration);
        recovery.sessionRef.current = previousSession;
      recovery.setStatus(cause?.code === 'provider_recovery_exhausted'
        ? 'provider-recovery-failed'
        : rolloverCommandCommitted ? 'reconnecting' : 'listening');
        recordLivePipelineTrace({
          stage: 'RECORDING_PIPELINE_STATE',
          meetingId: recovery.activeMeetingCheckpointRef.current?.meetingId,
          sessionId: recovery.activeSessionRecordIdRef.current,
          segmentId: recovery.activeMeetingCheckpointRef.current?.segmentId,
          captureEpoch: previousSession.captureEpoch,
          providerEpoch: previousSession.providerEpoch,
          httpStatus: cause?.status,
          serverErrorCode: cause?.code,
          reason: 'rollover_failed_recording_continues'
        });
        const failure = new Error('Meeting segment rollover failed.', { cause });
        failure.rolloverStage = rolloverStage;
        failure.status = cause?.status;
        failure.code = cause?.code;
        failure.requestId = cause?.requestId;
        failure.endpoint = cause?.endpoint;
        throw failure;
      } finally {
        releaseTransition();
      }
    },
    reconnectController() {
      if (!reconnectControllerRef.current) {
        reconnectControllerRef.current = createReconnectController({
          executeReconnect: controller.startReconnectSession
        });
      }
      return reconnectControllerRef.current;
    },
    cancel() {
      reconnectControllerRef.current?.cancel();
    }
    });
    controller.startSession = controller.startSession.bind(controller);
    return controller;
  }, [recovery]);

  const segmentSwitchControllerRef = useRef(null);
  const segmentSwitchController = useMemo(() => {
    if (!segmentSwitchControllerRef.current) {
      segmentSwitchControllerRef.current = createSegmentSwitchOrchestrator({
        switchSegment: recoveryController.switchMeetingSegment,
        intervalMs: segmentSwitch.intervalMs,
        onStatusChange: segmentSwitch.onStatusChange,
        onError: segmentSwitch.onError
      });
    }
    return segmentSwitchControllerRef.current;
  }, [recoveryController.switchMeetingSegment, segmentSwitch.intervalMs, segmentSwitch.onError, segmentSwitch.onStatusChange]);

  return useMemo(() => ({
    status: state.status ?? 'idle',
    statusLabelOverride: state.statusLabelOverride ?? '',
    error: state.error ?? '',
    deviceMessage: state.deviceMessage ?? '',
    transcript: state.transcript,
    archivedTranscript: state.archivedTranscript,
    subtitleCueState: state.subtitleCueState,
    polishingState: state.polishingState,
    polishedArticle: state.polishedArticle,
    recordingState: state.recordingState,
    translatedAudioState: state.translatedAudioState,
    meetingCheckpointStatus: state.meetingCheckpointStatus ?? 'idle',
    segmentRolloverStatus: state.segmentRolloverStatus ?? 'idle',
    meetingViewStats: state.meetingViewStats ?? { archivedSegmentCount: 0, loadedSegmentCount: 0 },
    resumeDraft: state.resumeDraft ?? null,
    controlLeaseSnapshot: state.controlLeaseSnapshot ?? null,
    hasSessionControl: Boolean(state.hasSessionControl),
    isActive: Boolean(state.isActive),
    controlsLocked: Boolean(state.controlsLocked),
    meetingStartedAt: meetingTimingRef.current.startedAt,
    routeMeetingId,
    targetLanguageCode,
    sourceLanguageCode,
    sessionName,
    echoTargetLanguage,
    shouldRecordInputAudio,
    selectedInputDeviceId,
    glossaryEntries,
    selectedMeetingGlossaryIds,
    privateMeetingGlossaryEntries,
    meetingRecords,
    selectedMeetingDetail,
    services,
    audio: audioController,
    audioUpload,
    cue: cueController,
    transcriptWorkflow: transcriptController,
    checkpoint: checkpointController,
    recovery: recoveryController,
    segmentSwitch: segmentSwitchController,
    actions: {
      startSession: actions.startSession || recoveryController.startSession,
      pauseSession: actions.pauseSession || recoveryController.pauseSession,
      continuePausedSession: actions.continuePausedSession || recoveryController.continuePausedSession,
      endCurrentSession: actions.endCurrentSession || recoveryController.endCurrentSession,
      resumeMeetingSession: actions.resumeMeetingSession || recoveryController.resumeMeetingSession,
      completeResumableMeeting: actions.completeResumableMeeting || recoveryController.completeResumableMeeting,
      retryPolishingExecution: actions.retryPolishingExecution,
      copyLiveSource: actions.copyLiveSource,
      copyLiveTranslation: actions.copyLiveTranslation
    }
  }), [
    actions,
    audioController,
    checkpointController,
    recoveryController,
    segmentSwitchController,
    echoTargetLanguage,
    glossaryEntries,
    meetingRecords,
    privateMeetingGlossaryEntries,
    routeMeetingId,
    selectedInputDeviceId,
    selectedMeetingDetail,
    selectedMeetingGlossaryIds,
    services,
    sessionName,
    shouldRecordInputAudio,
    sourceLanguageCode,
    state,
    targetLanguageCode
  ]);
}

function cueMapInState(state = {}) {
  return new Map([
    state.currentCue,
    ...(state.pendingCues || []),
    ...(state.finalCues || [])
  ].filter((item) => item?.cueId).map((item) => [item.cueId, item]));
}

const OBSERVABLE_CUE_FIELDS = [
  'sourceText', 'translatedText', 'sourceStatus', 'translationStatus', 'status',
  'version', 'sourceVersion', 'translationVersion', 'finalizedReason', 'finalizedAt',
  'revision', 'refinedSubtitleRevision'
];

function cueChanged(previous, next) {
  return OBSERVABLE_CUE_FIELDS.some((field) => previous?.[field] !== next?.[field]);
}

function describeCueTransition(current, next, event, { wasProcessed = false } = {}) {
  if (next === current) return {
    cueAction: 'drop',
    dropReason: wasProcessed ? 'duplicate_event' : 'no_state_change'
  };
  return { cueAction: 'transition' };
}

export function recordCueTransitionTrace({ cue, event = {}, previous, next, cueAction = null, dropReason = null }) {
  const previousCues = cueMapInState(previous);
  const nextCues = cueMapInState(next);
  const previousFinalIds = new Set((previous?.finalCues || []).map((item) => item?.cueId).filter(Boolean));
  const nextFinalIds = new Set((next?.finalCues || []).map((item) => item?.cueId).filter(Boolean));
  const transitionCueId = event.cueId || null;
  const matchedIds = transitionCueId && nextCues.has(transitionCueId)
    ? [transitionCueId]
    : event.audioTurnId
      ? [...nextCues.entries()].filter(([, item]) => item.audioTurnId === event.audioTurnId).map(([cueId]) => cueId)
      : [];
  const matchedCue = matchedIds.length === 1 ? nextCues.get(matchedIds[0]) : null;
  const previousMatchedCue = matchedCue?.cueId ? previousCues.get(matchedCue.cueId) : null;
  if (event.translationComparisonEventId) {
    const canonicalTranslation = matchedCue ? effectiveTranslationForCue(matchedCue) : null;
    const previousCanonicalTranslation = previousMatchedCue
      ? effectiveTranslationForCue(previousMatchedCue)
      : null;
    translationComparisonDiagnostics.record({
      stage: 'cue_canonical',
      eventIdentity: event.translationComparisonEventId,
      meetingId: event.meetingId,
      segmentId: matchedCue?.segmentId || event.segmentId || cue.getSegmentId?.() || null,
      cueId: matchedCue?.cueId || null,
      cueSequence: matchedCue?.sequence,
      audioTurnId: event.audioTurnId || matchedCue?.audioTurnId || null,
      providerEpoch: event.providerEpoch,
      providerEventSequence: event.eventSequence,
      providerEventId: event.providerEventId,
      normalizedEventId: event.eventId,
      turnKey: event.turnKey || matchedCue?.turnKey || null,
      associationStatus: matchedIds.length === 1
        ? 'matched'
        : matchedIds.length > 1
          ? 'ambiguous'
          : 'unmatched',
      sourceVersion: matchedCue?.sourceVersion,
      translationVersion: matchedCue?.translationVersion,
      previousCanonicalTranslation,
      canonicalTranslation,
      authoritativeSnapshotApplied: Boolean(
        previousMatchedCue
        && event.stream === 'translation'
        && event.isFinal
        && event.textMergeMode === 'snapshot'
        && previousCanonicalTranslation !== canonicalTranslation
      )
    });
  }
  const traceFields = {
    recordingId: matchedCue?.sessionId || cue.getSessionId?.() || null,
    segmentId: matchedCue?.segmentId || event.segmentId || cue.getSegmentId?.() || null,
    connectionEpoch: event.connectionEpoch ?? null,
    audioTurnId: event.audioTurnId || matchedCue?.audioTurnId || null,
    eventId: event.eventId || null,
    eventSequence: event.eventSequence ?? null,
    providerEventId: event.providerEventId || null,
    normalizedEventId: event.eventId || null,
    originEventId: event.originEventId || null,
    eventType: event.eventType || null,
    terminalStatus: event.terminalStatus || null,
    terminalReason: event.terminalReason || null,
    localFinalize: Boolean(event.localFinalize),
    isTerminalReplay: Boolean(event.isTerminalReplay),
    isFinal: Boolean(event.isFinal),
    isLateTranscript: Boolean(event.isLateTranscript),
    turnComplete: Boolean(event.turnComplete),
    generationComplete: Boolean(event.generationComplete),
    providerTurnIndex: event.turnIndex ?? null,
    turnKey: event.turnKey || matchedCue?.turnKey || null,
    turnIdentitySource: event.turnIdentitySource || null,
    sourceText: matchedCue?.sourceText || (event.stream === 'source' ? event.text || '' : ''),
    translationText: matchedCue?.translatedText || (event.stream === 'translation' ? event.text || '' : ''),
    beforeSourceText: previousMatchedCue?.sourceText || '',
    afterSourceText: matchedCue?.sourceText || '',
    beforeTranslationText: previousMatchedCue?.translatedText || '',
    afterTranslationText: matchedCue?.translatedText || '',
    cueId: matchedCue?.cueId || null,
    cueAction,
    dropReason,
    sourceStatus: matchedCue?.sourceText ? 'present' : null,
    translationStatus: matchedCue?.translatedText ? 'present' : null,
    turnState: event.turnComplete || event.generationComplete ? 'complete' : 'active',
    speechObservedSinceBoundary: event.speechObservedSinceBoundary ?? null
  };
  if (cueAction === 'drop') {
    recordLivePipelineTrace({
      ...traceFields,
      stage: dropReason === 'duplicate_event' || dropReason === 'no_state_change' ? 'EVENT_DEDUPED' : 'EVENT_DROPPED',
      reason: dropReason || 'unspecified_drop',
      dropReason: dropReason || 'unspecified_drop',
      decision: 'drop'
    });
    return;
  }
  for (const [cueId, nextCue] of nextCues) {
    const previousCue = previousCues.get(cueId);
    const fields = {
      ...traceFields,
      cueId,
      audioTurnId: event.audioTurnId || nextCue.audioTurnId || null,
      turnKey: event.turnKey || nextCue.turnKey || null,
      sourceText: nextCue.sourceText || '',
      translationText: nextCue.translatedText || '',
      sourceStatus: nextCue.sourceStatus || null,
      translationStatus: nextCue.translationStatus || null
    };
    if (!previousCue) {
      recordLivePipelineTrace({ ...fields, stage: 'CUE_CREATED', cueAction: 'create' });
    } else if (cueChanged(previousCue, nextCue)) {
      recordLivePipelineTrace({ ...fields, stage: 'CUE_UPDATED', cueAction: 'update' });
    }
    if (!previousFinalIds.has(cueId) && nextFinalIds.has(cueId)) {
      recordLivePipelineTrace({ ...fields, stage: 'CUE_FINALIZED', cueAction: 'finalize' });
    }
  }
}

function recordCueTrace({ cue, event = {}, next, previous, cueAction, dropReason = null }) {
  recordCueTransitionTrace({ cue, event, previous, next, cueAction, dropReason });
}
