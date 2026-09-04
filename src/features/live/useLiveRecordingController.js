import { useMemo, useRef } from 'react';
import { createMicrophoneRecordingController } from '../../lib/microphoneRecording.js';
import { createLiveAudioBindings } from './liveAudioBindings.js';
import {
  applySubtitleCueEvent,
  finalizePendingSubtitleCue,
  markNumericCorrectionRequested,
  prepareSubtitleCueStateForNewSegment
} from '../../lib/subtitleCues.js';
import { missingNumericIntegrity } from '../../lib/numericIntegrity.js';
import { createSessionSnapshotSyncCoordinator } from '../../lib/sessionSnapshotSyncCoordinator.js';
import { checkpointChunksForTranscriptItems, createMeetingCheckpointSyncCoordinator } from '../../lib/meetingCheckpointSyncCoordinator.js';
import { createReconnectController } from '../../lib/reconnectController.js';
import { createSegmentSwitchOrchestrator } from '../../lib/segmentSwitchOrchestrator.js';
import { selectedMeetingGlossaryEntries } from '../../lib/meetingGlossary.js';
import { appendNewFinalTranscriptItems, buildSessionRecordInput, createActiveSessionRecord } from '../../lib/sessionRecordLifecycle.js';
import { finalizePendingTranscriptItems, transcriptItemsForStream } from '../../lib/transcript.js';

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
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;

/**
 * View-model boundary for the live recording surface.
 *
 * The application shell owns route and service composition. Live pages should
 * consume this object instead of knowing how live state is assembled. Keeping
 * the boundary explicit also lets the lifecycle implementation move here in
 * small batches without changing the page contract.
 */
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
  const audioUploadControllerRef = useRef(null);
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
          collectChunks: false
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
      audio.inputChunksRef.current.push(new Uint8Array(bytes));
      void audioUpload?.flushAudioSegmentIfDue?.('input');
    },
    async pauseRawAudioRecording() {
      if (!shouldRecordInputAudio) {
        audio.setRecordingState?.(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
        return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
      }
      const nextState = await this.recordingController().pause().catch((error) => ({
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
      const nextState = await this.recordingController().resume({ stream: audio.pendingMicrophoneStreamRef?.current }).catch((error) => ({
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
      const segment = audio.segmentsRef.current.input;
      const hasAudio = audio.inputChunksRef.current.length > 0 || segment.nextIndex > 0;
      const nextState = await this.recordingController().cleanup({ discard: true }).catch((error) => ({
        status: 'error', blob: null, mimeType: '', extension: '', fileName: '',
        errorMessage: error?.message || '原始語音音檔無法建立。'
      }));
      const savedState = { ...nextState, status: hasAudio ? 'saved' : 'idle', blob: null, mimeType: 'audio/wav', extension: 'wav', fileName: '', errorMessage: '' };
      audio.setRecordingState?.(savedState);
      return savedState;
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
      audio.translationChunksRef.current.push(new Uint8Array(bytes));
      void audioUpload?.flushAudioSegmentIfDue?.('translation');
      audio.setTranslatedAudioState?.((current) => current.status === 'ready' ? current : { status: 'recording', blob: null, fileName: '', errorMessage: '' });
    },
    finalizeTranslatedAudioDownload() {
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
      if (event?.connectionEpoch !== undefined && event.connectionEpoch !== cue.callbackGenerationRef.current.generation) return;
      const current = cue.stateRef.current;
      let next = applySubtitleCueEvent(current, event, {
        targetLanguageCode,
        sourceLanguageCode,
        sessionId: cue.getSessionId?.(),
        segmentId: cue.getSegmentId?.() || null,
        sessionClock: () => cue.getSessionTime?.() ?? 0
      });
      if (event?.localFinalize) {
        next = finalizePendingSubtitleCue(next, {
          sessionTimeMs: cue.getSessionTime?.() ?? 0,
          reason: event.finalizedReason || 'localSilence',
          targetLanguageCode,
          sourceLanguageCode
        });
      }
      if (next === current) return;
      cue.stateRef.current = next;
      cue.setState?.(next);
      cue.persist?.(current, next);
      this.requestNumericCorrection(next);
    },
    queueLiveSubtitleCueEvent(event) {
      if (event?.connectionEpoch !== undefined && event.connectionEpoch !== cue.callbackGenerationRef.current.generation) return;
      const shouldFlushImmediately = Boolean(event?.localFinalize || event?.isFinal || event?.turnComplete || event?.generationComplete || event?.eventType === 'boundary');
      if (shouldFlushImmediately) {
        cue.eventsRef.current.push(event);
        this.flushQueuedLiveCueEvents();
        return;
      }
      const key = `${event?.stream || 'unknown'}:${event?.eventType || 'partial'}:${event?.turnIndex ?? 'current'}`;
      const existingIndex = cue.eventsRef.current.findIndex((candidate) => `${candidate?.stream || 'unknown'}:${candidate?.eventType || 'partial'}:${candidate?.turnIndex ?? 'current'}` === key);
      if (existingIndex >= 0) cue.eventsRef.current[existingIndex] = event;
      else cue.eventsRef.current.push(event);
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
      const events = cue.eventsRef.current.splice(0).filter((event) => event?.connectionEpoch === undefined || event.connectionEpoch === generation);
      for (const event of events) this.applyLiveSubtitleCueEvent(event);
    },
    requestNumericCorrection(currentState) {
      if (transcriptionOnly) return;
      const target = [...(currentState.finalCues || [])].reverse().find((candidate) => candidate.status === 'final' && candidate.sourceText && candidate.translatedText && !candidate.numericCorrectionRequested && missingNumericIntegrity(candidate.sourceText, candidate.translatedText));
      if (!target) return;
      const next = markNumericCorrectionRequested(currentState, target.cueId);
      cue.stateRef.current = next;
      cue.setState?.(next);
      cue.persist?.(currentState, next);
      cue.retranslate?.(target.sourceText, target.cueId);
    },
    flushSubtitleCues(reason) {
      this.flushQueuedLiveCueEvents();
      const current = cue.stateRef.current;
      const next = finalizePendingSubtitleCue(current, { sessionTimeMs: cue.getSessionTime?.() ?? 0, reason });
      if (next === current) return;
      cue.stateRef.current = next;
      cue.setState?.(next);
      cue.persist?.(current, next);
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
      const result = await checkpoint.sessionSnapshotApiClientRef.current.sync({ session: detail.sessionRecord, transcriptItems });
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
    meetingCheckpointSyncCoordinator() {
      if (!checkpointControllerRef.current) {
        checkpointControllerRef.current = createMeetingCheckpointSyncCoordinator({
          updateCheckpoint: (payload) => checkpoint.meetingCheckpointApiClientRef.current.updateCheckpoint(payload),
          getCheckpoint: (payload) => checkpoint.meetingCheckpointApiClientRef.current.getCheckpoint(payload),
          delayMs: MEETING_CHECKPOINT_SYNC_DELAY_MS,
          onStatusChange: (status) => {
            checkpoint.setMeetingCheckpointStatus?.(status);
            if (status === 'synced') checkpoint.clearCheckpointError?.();
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
      const appended = appendNewFinalTranscriptItems(
        transcript.sessionRepositoryRef.current,
        activeSessionRecordId,
        currentTranscript,
        nextTranscript
      );
      transcript.stateRef.current = nextTranscript;
      transcript.setState((previous) => {
        if (previous === currentTranscript) return nextTranscript;
        if (!this.expectedPendingPartialsStillCurrent(previous, options.expectedPartialByStream)) return previous;
        return finalizePendingTranscriptItems(previous, { streams: options.streams });
      });

      if (appended.length === 0) return;
      const activeSessionRecord = transcript.sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
      if (activeSessionRecord) {
        checkpointController.scheduleSessionSnapshotSync(activeSessionRecordId);
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
    const controller = ({
    async createCurrentSessionRecord(meetingCheckpoint = recovery.activeMeetingCheckpointRef.current, initialTranscript = null, existingSessionId = null) {
      const persisted = existingSessionId
        ? await recovery.sessionCommandApiClientRef.current.update(existingSessionId, { status: 'active' })
        : await recovery.sessionCommandApiClientRef.current.create({
          name: sessionName.trim() || `即時翻譯 ${new Date().toLocaleString('zh-TW')}`,
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
          segmentId: meetingCheckpoint?.segmentId,
          meetingGlossaryEntries: recovery.currentMeetingGlossaryEntries(),
          ...recovery.selectedInputDeviceSnapshot()
        })
      );
      recovery.activeSessionRecordIdRef.current = record.id;
      audioController.prepareInputAudioDownload(record);
      audioController.prepareTranslatedAudioDownload(record);
      const initialItems = controller.appendInitialTranscriptItems(record.id, initialTranscript);
      checkpointController.markPendingSessionSnapshotItems(record.id, initialItems);
      await checkpointController.flushSessionSnapshot(record.id);
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
          segmentId: result.segment.id
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
          void controller.uploadFinalizedSessionAudioArtifacts(sessionId, {
            input: options?.audioStates?.input,
            translation: translatedAudioFinalState
          }, { meetingId });
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
      const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
      if (!meetingCheckpoint) return null;

      try {
        await checkpointController.flushMeetingCheckpointSync();
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
    },
    async finalizeFailedSession({ status = 'failed', failureReason, failureCategory } = {}) {
      await this.interruptActiveMeeting({ failureReason, failureCategory });
      await this.finalizeCurrentSessionRecord({ status, failureReason, failureCategory });
    },
    async completeResumableMeeting() {
      const currentMeetingId = recovery.getRouteMeetingId?.();
      if (!recovery.resumeDraft || !currentMeetingId || recovery.resumeDraft.meetingId !== currentMeetingId || state.isActive || state.status !== 'idle') return;
      if (!window.confirm('確定要結束這場會議嗎？既有逐字稿會保留，之後將無法繼續錄製。')) return;
      recovery.setError('');
      try {
        cueController.flushSubtitleCues('complete');
        const checkpointFlushed = await checkpointController.flushMeetingCheckpointSync();
        if (!checkpointFlushed) throw new Error('Unable to flush meeting checkpoint before completion.');
        await recovery.meetingCheckpointApiClientRef.current.completeMeeting({ meetingId: recovery.resumeDraft.meetingId });
        recovery.setResumeDraft(null);
        recovery.activeMeetingCheckpointRef.current = null;
        recovery.setMeetingCheckpointStatus('synced');
        await recovery.refreshMeetingRecords();
        window.location.hash = '#meetings';
      } catch {
        recovery.setError('無法結束會議，請稍後再試。');
      }
    },
    async endCurrentSession({ redirectHash = '#meetings' } = {}) {
      recovery.sessionStopRequestedRef.current = true;
      recovery.reconnectController().cancel();
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
      await reconnectingSession?.stop().catch(() => {});
      if (activeSession !== reconnectingSession) await activeSession?.stop().catch(() => {});
      cueController.flushQueuedLiveCueEvents();
      recovery.invalidateLiveSessionCallbacks();
      recovery.setLiveCueUpdatesAllowed(false);
      await recovery.finalizePendingTranscriptItemsForStop();
      cueController.flushSubtitleCues('stop');
      await checkpointController.flushMeetingCheckpointSync();
      recovery.pendingMicrophoneStreamRef.current = null;
      recovery.setResumeDraft(null);
      await controller.finalizeCurrentSessionRecord({
        status: 'stopped',
        failureReason: 'user_stop',
        failureCategory: 'user_intent',
        audioStates: { input: inputAudioState }
      });
      recovery.setStatus('stopped');
      if (redirectHash) window.location.hash = redirectHash;
    },
    async continuePausedSession() {
      if (state.status !== 'paused') return;
      recovery.invalidateLiveSessionCallbacks();
      recovery.sessionStopRequestedRef.current = false;
      recovery.reconnectController().reset();
      recovery.reconnectFailureDiagnosticRef.current = null;
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = false;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.setLiveCueUpdatesAllowed(false);
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      recovery.setError('');
      recovery.pendingMicrophoneStreamRef.current = null;
      const preparedCueState = prepareSubtitleCueStateForNewSegment(cue.stateRef.current, { sessionTimeMs: recovery.getSessionTime(), reason: 'continue' });
      cue.stateRef.current = preparedCueState;
      cue.setState?.(preparedCueState);
      let session;
      try {
        session = await recovery.createSession({ preserveTranscript: true, liveSessionId: recovery.generateLiveSessionId() });
        recovery.sessionRef.current = session;
        await session.start();
        recovery.setTranscriptTimeOriginValue();
        if (!recovery.activateLiveSessionCallbacks(session.callbackGeneration)) throw new Error('即時字幕 callback 啟動失敗。');
        await audioController.resumeRawAudioRecording();
        recovery.setLiveCueUpdatesAllowed(true);
        await recovery.updateCurrentSessionStatus('active', { lastLifecycleState: 'listening' });
        recovery.clearSessionSnapshotSyncError();
        recovery.setStatus('listening');
        recovery.startSegmentSwitch?.();
      } catch (error) {
        await session?.stop().catch(() => {});
        if (recovery.sessionStopRequestedRef.current) return;
        recovery.sessionRef.current = null;
        recovery.applyStartFailure(error, '無法繼續即時字幕。');
      }
    },
    async pauseSession() {
      recovery.reconnectController().cancel();
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = true;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      const reconnectingSession = recovery.reconnectSessionRef.current;
      recovery.reconnectSessionRef.current = null;
      await audioController.pauseRawAudioRecording();
      await reconnectingSession?.stop().catch(() => {});
      await recovery.sessionRef.current?.stop();
      recovery.sessionRef.current = null;
      recovery.invalidateLiveSessionCallbacks();
      recovery.setLiveCueUpdatesAllowed(false);
      await recovery.finalizePendingTranscriptItemsForStop();
      cueController.flushSubtitleCues('pause');
      await checkpointController.flushMeetingCheckpointSync();
      await recovery.updateCurrentSessionStatus('paused');
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
      const status = state.status ?? 'idle';
      const isActive = Boolean(state.isActive);
      if (status === 'active' || status === 'paused' || isActive || recovery.sessionRef.current || recovery.activeSessionRecordIdRef.current) {
        recovery.setError('目前已有工作階段正在進行或暫停中，請先暫停或結束目前工作階段。');
        return;
      }
      if (recovery.sessionControlLeaseRef.current?.current()) {
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
      recovery.reconnectFailureDiagnosticRef.current = null;
      recovery.cancelSegmentSwitch?.();
      recovery.segmentSwitchCancelledRef.current = false;
      recovery.suppressReconnectErrorRef.current = false;
      recovery.setLiveCueUpdatesAllowed(true);
      recovery.cancelLiveCueIdleTimers?.();
      recovery.setStatusLabelOverride('');
      let session;
      let record = null;
      recovery.setStatus('requesting-permission');
      try {
        await audioController.cleanup();
        audioController.resetInputAudioDownload();
        audioController.resetTranslatedAudioDownload();
        recovery.pendingMicrophoneStreamRef.current = null;
        const liveSessionId = recovery.generateLiveSessionId();
        let meetingCheckpoint;
        if (routeMeetingId) {
          const segmentsResult = await recovery.meetingCheckpointApiClientRef.current.listSegments({ meetingId: routeMeetingId });
          const segment = [...segmentsResult.segments].reverse().find((item) => ['created', 'active'].includes(item.status) && !item.liveSessionId);
          if (!segment) throw new Error('此會議目前沒有可開始的錄音段落。');
          const started = await recovery.meetingCheckpointApiClientRef.current.startMeeting({ meetingId: routeMeetingId, segmentId: segment.id, liveSessionId });
          meetingCheckpoint = { meetingId: started.meeting.id, segmentId: started.segment.id };
          recovery.activeMeetingCheckpointRef.current = meetingCheckpoint;
          checkpointController.meetingCheckpointSyncCoordinator().start(meetingCheckpoint);
        } else {
          meetingCheckpoint = await controller.createMeetingCheckpointForSession({
            liveSessionId,
            glossaryEntries: selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode),
            privateGlossaryEntries: privateMeetingGlossaryEntries
          });
        }
        record = await controller.createCurrentSessionRecord(meetingCheckpoint);
        if (!recovery.sessionControlLeaseRef.current?.tryAcquire(record.id)) throw new Error('目前已有工作階段由其他頁籤控制。');
        recovery.setHasSessionControl(true);
        session = await recovery.createSession({ preserveTranscript: false, liveSessionId });
        recovery.sessionRef.current = session;
        const started = await session.start();
        if (!started) throw new Error('首個音訊資料未成功送出。');
        recovery.activateLiveSessionCallbacks(session.callbackGeneration);
        const activeRecord = recovery.sessionRepositoryRef.current.updateSessionRecord(record.id, { status: 'active', startedAt: record.startedAt || Date.now(), lastLifecycleState: 'listening' });
        await checkpointController.flushSessionSnapshot(record.id);
        await audioController.startRecordingForSession(activeRecord);
        recovery.setStatus('listening');
        recovery.updateLiveMeetingUrl(meetingCheckpoint.meetingId);
        recovery.startSegmentSwitch?.();
      } catch (error) {
        await session?.stop().catch(() => {});
        if (recovery.sessionStopRequestedRef.current) return;
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

      recovery.setError('');
      recovery.invalidateLiveSessionCallbacks();
      recovery.setStatusLabelOverride('');
      recovery.setStatus('reconnecting');
      recovery.cancelSegmentSwitch?.();

      const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
      const nextLiveSessionId = recovery.generateLiveSessionId();
      let recoveredSegment;
      let reconnectStage = 'create_session';
      const session = await recovery.createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
      recovery.reconnectSessionRef.current = session;

      try {
        if (!meetingCheckpoint) throw new Error('Missing active meeting checkpoint.');
        reconnectStage = 'flush_audio';
        await audioController.pauseRawAudioRecording();
        await recovery.finalizePendingTranscriptItemsForStop();
        cueController.flushSubtitleCues('reconnect');
        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await session.stop().catch(() => {});
          return;
        }

        reconnectStage = 'flush_checkpoint';
        const flushed = await checkpointController.flushMeetingCheckpointSync();
        if (!flushed) throw new Error('Unable to flush meeting checkpoint before reconnect.');
        recovery.archiveActiveTranscriptSegment();

        reconnectStage = 'recover_segment';
        recoveredSegment = await recovery.meetingCheckpointApiClientRef.current.recoverSegment({
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
        });

        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await session.stop().catch(() => {});
          return;
        }
        reconnectStage = 'connect_live_session';
        await session.start();
        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await session.stop().catch(() => {});
          return;
        }
        recovery.activateLiveSessionCallbacks(session.callbackGeneration);
        reconnectStage = 'resume_audio';
        await audioController.resumeRawAudioRecording();
      } catch (error) {
        if (!recovery.isCurrentGeneration?.(generationId) || recovery.sessionStopRequestedRef.current) {
          await session.stop().catch(() => {});
          return;
        }
        await session.stop().catch(() => {});
        recovery.reconnectSessionRef.current = null;
        recovery.sessionRef.current = null;
        recovery.setStatusLabelOverride('');
        const diagnostic = recovery.safeReconnectDiagnostic({ source: 'reconnect_session', stage: reconnectStage, rawError: error, reasonHint: classification.reason }, classification);
        recovery.reconnectFailureDiagnosticRef.current = diagnostic;
        void recovery.appendSessionFailureDiagnostic(diagnostic, classification);
        recovery.setError(recovery.reconnectErrorMessage({ decision: { stopReason: 'reconnect_session_failed' } }, diagnostic));
        recovery.setStatus('error');
        void controller.finalizeFailedSession({ status: 'failed', failureReason: classification.reason, failureCategory: classification.category });
        return;
      }

      if (!recovery.isCurrentGeneration?.(generationId) || recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) {
        await session.stop().catch(() => {});
        return;
      }
      recovery.reconnectSessionRef.current = null;
      recovery.sessionRef.current = session;
      const nextMeetingCheckpoint = { meetingId: meetingCheckpoint.meetingId, segmentId: recoveredSegment.segment.id };
      recovery.activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
      checkpointController.meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
      recovery.startSegmentSwitch?.();
      recovery.setStatusLabelOverride('');
      recovery.setStatus('listening');
    },
    async resumeMeetingSession() {
      if (!recovery.resumeDraft || recovery.isActive) return;
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
      try {
        const nextLiveSessionId = recovery.generateLiveSessionId();
        resumedLiveSessionId = nextLiveSessionId;
        recovery.setStatus('reconnecting');
        const preparedCueState = prepareSubtitleCueStateForNewSegment(cue.stateRef.current, {
          sessionTimeMs: recovery.getSessionTime(),
          reason: 'resume'
        });
        cue.stateRef.current = preparedCueState;
        cue.setState?.(preparedCueState);
        const segmentsResult = await recovery.meetingCheckpointApiClientRef.current.listSegments({ meetingId: draft.meetingId });
        const currentSegment = segmentsResult.segments.find((segment) => segment.id === draft.segmentId);
        const resumed = currentSegment?.status === 'created'
          ? await recovery.meetingCheckpointApiClientRef.current.startMeeting({ meetingId: draft.meetingId, segmentId: draft.segmentId, liveSessionId: nextLiveSessionId })
          : await recovery.meetingCheckpointApiClientRef.current.recoverSegment({
            meetingId: draft.meetingId,
            segmentId: draft.segmentId,
            idempotencyKey: `recover:${draft.segmentId}:${nextLiveSessionId}`,
            checkpoint: {
              idempotencyKey: `checkpoint:${draft.segmentId}:resume:${nextLiveSessionId}`,
              durableChunks: [],
              pendingPartial: null,
              finalCues: preparedCueState.finalCues.filter((item) => item.segmentId === draft.segmentId),
              cueCheckpoint: recovery.cueCheckpointForState(preparedCueState)
            },
            nextLiveSessionId,
            failureReason: 'manual_resume',
            failureCategory: 'user_intent',
            outcome: 'interrupted'
          });
        const nextMeetingCheckpoint = { meetingId: draft.meetingId, segmentId: resumed.segment.id };
        recoveredMeetingCheckpoint = nextMeetingCheckpoint;
        recovery.activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
        checkpointController.meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
        const resumedRecord = await controller.createCurrentSessionRecord(nextMeetingCheckpoint, draft.transcriptState, draft.sessionId);
        resumedSessionRecordId = resumedRecord.id;
        recovery.resetActiveTranscriptForNextSegment(draft.transcriptState.nextSequence);
        session = await recovery.createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
        recovery.sessionRef.current = session;
        await session.start();
        recovery.setTranscriptTimeOriginValue();
        if (!recovery.activateLiveSessionCallbacks(session.callbackGeneration)) throw new Error('即時字幕 callback 啟動失敗。');
        recovery.setLiveCueUpdatesAllowed(true);
        recovery.sessionRepositoryRef.current.updateSessionRecord(recovery.activeSessionRecordIdRef.current, { status: 'active', startedAt: Date.now(), lastLifecycleState: 'listening' });
        const snapshotSynced = await checkpointController.flushSessionSnapshot(recovery.activeSessionRecordIdRef.current);
        if (snapshotSynced) recovery.clearSessionSnapshotSyncError();
        recovery.setStatus('listening');
        recovery.startSegmentSwitch?.();
      } catch (error) {
        await session?.stop().catch(() => {});
        if (recoveredMeetingCheckpoint) {
          await recovery.meetingCheckpointApiClientRef.current.recoverSegment({
            meetingId: recoveredMeetingCheckpoint.meetingId,
            segmentId: recoveredMeetingCheckpoint.segmentId,
            idempotencyKey: `resume-failed:${recoveredMeetingCheckpoint.segmentId}:${resumedLiveSessionId || 'unknown'}`,
            checkpoint: { idempotencyKey: `checkpoint:${recoveredMeetingCheckpoint.segmentId}:resume-failed`, durableChunks: [], pendingPartial: null },
            nextLiveSessionId: null,
            failureReason: 'resume_start_failed',
            failureCategory: 'startup',
            outcome: 'interrupted'
          }).catch(() => {});
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
        recovery.setError(error.message || '無法續錄長會議。');
        recovery.setStatus('error');
      }
    },
    async switchMeetingSegment() {
      const meetingCheckpoint = recovery.activeMeetingCheckpointRef.current;
      const previousSession = recovery.sessionRef.current;
      if (!meetingCheckpoint || !previousSession || recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;

      recovery.invalidateLiveSessionCallbacks();
      recovery.setError('');
      recovery.setStatusLabelOverride('切換下一段中');
      recovery.setStatus('switching-segment');

      await recovery.finalizePendingTranscriptItemsForStop();
      cueController.flushSubtitleCues('segment-rollover');
      if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;

      const flushed = await checkpointController.flushMeetingCheckpointSync();
      if (!flushed) throw new Error('無法同步目前段落 checkpoint。');
      if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;
      recovery.archiveActiveTranscriptSegment();

      const rollover = await recovery.meetingCheckpointApiClientRef.current.rolloverSegment({
        meetingId: meetingCheckpoint.meetingId,
        segmentId: meetingCheckpoint.segmentId,
        idempotencyKey: `rollover:${meetingCheckpoint.segmentId}:${previousSession.liveSessionId}`,
        checkpoint: {
          idempotencyKey: `checkpoint:${meetingCheckpoint.segmentId}:rollover`,
          durableChunks: [],
          pendingPartial: null
        },
        nextLiveSessionId: previousSession.liveSessionId
      });

      if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) return;
      cueController.flushSubtitleCues('segment-rollover');
      const providerResumed = await previousSession.reconnectProvider({ segmentId: rollover.segment.id, forceRefresh: true });
      if (!providerResumed) throw new Error('無法恢復 Gemini 即時連線。');

      if (recovery.segmentSwitchCancelledRef.current || recovery.sessionStopRequestedRef.current) {
        return;
      }

      recovery.activateLiveSessionCallbacks(previousSession.callbackGeneration);
      recovery.sessionRef.current = previousSession;
      const nextMeetingCheckpoint = { meetingId: meetingCheckpoint.meetingId, segmentId: rollover.segment.id };
      recovery.activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
      checkpointController.meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
      recovery.setStatusLabelOverride('下一段已開始');
      recovery.setStatus('listening');
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
    meetingViewStats: state.meetingViewStats ?? { archivedSegmentCount: 0, loadedSegmentCount: 0 },
    resumeDraft: state.resumeDraft ?? null,
    controlLeaseSnapshot: state.controlLeaseSnapshot ?? null,
    hasSessionControl: Boolean(state.hasSessionControl),
    isActive: Boolean(state.isActive),
    controlsLocked: Boolean(state.controlsLocked),
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
