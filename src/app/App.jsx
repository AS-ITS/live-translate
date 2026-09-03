import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Mic, MicOff, Pause, Play, Plus, Square } from 'lucide-react';
import { targetLanguageLabelFor } from '../lib/languages.js';
import { classifyConnectionFailure } from '../lib/connectionFailures.js';
import { failureUiStateForClassification } from '../lib/failureUiState.js';
import { audioInputDevices } from '../lib/mediaDevices.js';
import { createMemorySessionRepository } from '../lib/sessionRepository.js';
import { createSessionReadApiClient } from '../lib/sessionReadApiClient.js';
import { createSessionControlLease } from '../lib/sessionControlLease.js';
import { createMeetingReadApiClient } from '../lib/meetingReadApiClient.js';
import { createSessionSnapshotApiClient } from '../lib/sessionSnapshotApiClient.js';
import { createSessionCommandApiClient } from '../lib/sessionCommandApiClient.js';
import { createMeetingCheckpointApiClient } from '../lib/meetingCheckpointApiClient.js';
import { createMeetingCueApiClient } from '../lib/meetingCueApiClient.js';
import { createTranslationCommandApiClient } from '../lib/translationCommandApiClient.js';
import { createGlossaryApiClient } from '../lib/glossaryApiClient.js';
import { liveGlossaryEntriesForTarget, selectedMeetingGlossaryEntries } from '../lib/meetingGlossary.js';
import { authenticatedFetch } from '../lib/accessToken.js';
import { applyGlossaryReplacements } from '../lib/glossaryReplacement.js';
import { createTranslationCommandLifecycle } from '../lib/translationCommandLifecycle.js';
import { formatTranslationCommandPersistenceError } from '../lib/translationCommandError.js';
import { createTranscriptPolishingLifecycle } from '../lib/transcriptPolishingLifecycle.js';
import { createCueRefinementCoordinator, mergePolishedItemsFromOutputs } from '../lib/transcriptPolishing.js';
import { applyCueRefinementExecutionStates, markCuesCompletedByRefinedSubtitleCues, mergeCuesByIdPreferRefinement, refinedSubtitleCuesForDisplay } from '../lib/cueRefinement.js';
import { effectiveTranslationForCue, rawSourceForCue, rawTranslationForCue } from '../lib/cueContent.js';
import { mergeRetranslationHistoryIntoDetail } from '../lib/sessionTranslationHistory.js';
import {
  appendNewFinalTranscriptItems,
  buildFinalizePatch,
  finalizeActiveSessionRecord
} from '../lib/sessionRecordLifecycle.js';
import {
  applyTranscriptEvent,
  createTranscriptState,
  describeTranscriptSegmentDecision,
  resetTranscriptState
} from '../lib/transcript.js';
import {
  createSubtitleCueState,
  dismissSubtitleCue,
  resetSubtitleCueState,
  resolveIdleSubtitleCue,
  DEFAULT_TURN_COMPLETE_DEBOUNCE_MS
} from '../lib/subtitleCues.js';
import { sourceTextForCopy, translationTextForCopy } from '../lib/cueUi.js';
import { canonicalHashForLocation, FEATURE_PAGES, pageFromLocation, pageInfoFromLocation } from './routes.js';
import { AppRouter } from './AppRouter.jsx';
import { MeetingSettingsLayout } from '../layouts/AppLayout.jsx';
import { MeetingSettingsPage } from '../pages/meetings/MeetingSettingsPage.jsx';
import { MeetingViewerPage } from '../pages/viewer/MeetingViewerPage.jsx';
import { GlobalGlossaryPage } from '../pages/glossary/GlobalGlossaryPage.jsx';
import { LiveMeetingPicker, LiveRecordingPage, liveMeetingStatusLabel } from '../pages/live/LiveRecordingPage.jsx';
import { LiveCuePanel as LiveCuePanelView } from '../features/live/LiveCuePanel.jsx';
import { applyCompletedRefinementOutputs } from '../features/live/liveRecordingController.js';
import { WorkspacePage } from '../features/workspace/WorkspacePage.jsx';
import { MeetingDetailPage, MeetingManagementPage } from '../features/meetings/index.js';
import { GlobalGlossaryPanel } from '../features/glossary/index.js';
import { activeSegmentTranscriptCount, archivedTranscriptFromSegments, completedPolishingOutputs, emptyTranscriptStateWithNextSequence, latestPolishingExecution, latestPolishingOutput, logTranscriptSegmentDecision, mergeTranscriptItems, rawCuesFromDetail, reconnectErrorMessage, safeReconnectDiagnostic, transcriptHasFinalItems, transcriptSegmentsFromCheckpoints, transcriptStateFromCheckpointChunks, traditionalChineseTranscriptItem, unrepresentedTranscriptItems } from '../features/live/liveTranscriptRecovery.js';
import { createAudioUploadSegmentState } from '../features/live/liveAudioBindings.js';
import { useLiveRecordingController } from '../features/live/useLiveRecordingController.js';
import { classifyFailureSignal, composeCheckpointStatusMessage, hasAudioStatusError } from '../features/live/liveStatus.js';
import { LiveTranscriptionSession } from '../lib/liveTranscriptionSession.js';

const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const LIVE_CUE_IDLE_FINALIZE_MS = DEFAULT_TURN_COMPLETE_DEBOUNCE_MS;
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const TRANSCRIPT_POLISHING_ENABLED = import.meta.env?.VITE_TRANSCRIPT_POLISHING_ENABLED !== 'false';
const TRANSCRIPT_POLISHING_MAX_RPM = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MAX_RPM || '15', 10);
const SEGMENT_SWITCH_INTERVAL_MS = 15 * 60 * 1000;
const TRANSLATED_AUDIO_IDLE_STATE = {
  status: 'idle',
  blob: null,
  fileName: '',
  errorMessage: ''
};
const INPUT_AUDIO_RECORDING_SKIPPED_STATE = {
  status: 'skipped',
  blob: null,
  mimeType: '',
  extension: '',
  fileName: '',
  errorMessage: ''
};

function meetingDetailReturnPage(info = pageInfoFromLocation()) {
  return info.meetingDetailFrom === 'meetings' ? 'meetings' : 'history';
}

const INVALID_MEETING_ROUTE_MESSAGE = '會議連結不存在或已失效，請重新選擇已建立的會議。';

export function App() {
  const [page, setPage] = useState(pageFromLocation);
  const [locationVersion, setLocationVersion] = useState(0);
  const [status, setStatus] = useState('idle');
  const [hasSessionControl, setHasSessionControl] = useState(false);
  const [controlLeaseSnapshot, setControlLeaseSnapshot] = useState(null);
  const [statusLabelOverride, setStatusLabelOverride] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [sessionName, setSessionName] = useState('');
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  // Legacy transcript state remains in the data flow for persistence, export,
  // and backward-compatible Session detail fallback. Live rendering is
  // owned by the Cue stream until the later transcript migration removes it.
  const [transcript, setTranscript] = useState(createTranscriptState);
  const [subtitleCueState, setSubtitleCueState] = useState(createSubtitleCueState);
  const [archivedTranscript, setArchivedTranscript] = useState(createTranscriptState);
  const [transcriptTimeOrigin, setTranscriptTimeOrigin] = useState(null);
  const [copiedArticleStream, setCopiedArticleStream] = useState('');
  const [inputDevices, setInputDevices] = useState([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState('');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [error, setError] = useState('');
  const [navigationNotice, setNavigationNotice] = useState('');
  const [meetingRecords, setMeetingRecords] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [selectedMeetingDetail, setSelectedMeetingDetail] = useState(null);
  const [meetingDetailError, setMeetingDetailError] = useState('');
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [glossaryCategories, setGlossaryCategories] = useState([]);
  const [selectedMeetingGlossaryIds, setSelectedMeetingGlossaryIds] = useState([]);
  const [privateMeetingGlossaryEntries, setPrivateMeetingGlossaryEntries] = useState([]);
  const [meetingCheckpointStatus, setMeetingCheckpointStatus] = useState('idle');
  const [shouldRecordInputAudio, setShouldRecordInputAudio] = useState(false);
  const [recordingState, setRecordingState] = useState({
    status: 'idle',
    blob: null,
    mimeType: '',
    extension: '',
    fileName: '',
    errorMessage: ''
  });
  const [translatedAudioState, setTranslatedAudioState] = useState(TRANSLATED_AUDIO_IDLE_STATE);
  const [meetingViewStats, setMeetingViewStats] = useState({
    archivedSegmentCount: 0,
    loadedSegmentCount: 0
  });
  const [polishingState, setPolishingState] = useState({ status: 'idle', text: '', version: null, updatedAt: null, error: '' });
  const [polishedArticle, setPolishedArticle] = useState({ text: '', items: [], version: null, updatedAt: null });
  const [resumeDraft, setResumeDraft] = useState(null);
  const sessionRef = useRef(null);
  const pendingMicrophoneStreamRef = useRef(null);
  const liveSessionCallbackGenerationRef = useRef({ generation: 0, active: false });
  const inputAudioUploadChunksRef = useRef([]);
  const inputAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const translatedAudioUploadChunksRef = useRef([]);
  const translatedAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const audioUploadSegmentsRef = useRef(createAudioUploadSegmentState());
  const audioUploadRetryTimersRef = useRef({ input: null, translation: null });
  const audioUploadRetryAttemptsRef = useRef({ input: 0, translation: 0 });
  const transcriptRef = useRef(transcript);
  const subtitleCueStateRef = useRef(subtitleCueState);
  const transcriptTimeOriginRef = useRef(null);
  const archivedTranscriptRef = useRef(archivedTranscript);
  const archivedTranscriptSegmentsRef = useRef([]);
  const inputDevicesRef = useRef(inputDevices);
  const selectedInputDeviceIdRef = useRef(selectedInputDeviceId);
  const reconnectSessionRef = useRef(null);
  const sessionRepositoryRef = useRef(createMemorySessionRepository());
  const sessionSnapshotApiClientRef = useRef(createSessionSnapshotApiClient());
  const sessionCommandApiClientRef = useRef(createSessionCommandApiClient());
  const pendingSessionSnapshotItemIdsRef = useRef(new Map());
  const meetingCheckpointApiClientRef = useRef(createMeetingCheckpointApiClient());
  const meetingCueApiClientRef = useRef(createMeetingCueApiClient({ fetchImpl: authenticatedFetch(fetch) }));
  const activeMeetingCheckpointRef = useRef(null);
  const runtimeMeetingIdsRef = useRef(new Set());
  const liveSessionIdSequenceRef = useRef(0);
  const segmentSwitchCancelledRef = useRef(false);
  const sessionStopRequestedRef = useRef(false);
  const sessionReadApiClientRef = useRef(createSessionReadApiClient());
  const meetingReadApiClientRef = useRef(createMeetingReadApiClient());
  const meetingDetailCacheRef = useRef(new Map());
  const translationCommandLifecycleRef = useRef(null);
  const transcriptPolishingLifecycleRef = useRef(null);
  const transcriptPolishingCoordinatorRef = useRef(null);
  const activeSessionRecordIdRef = useRef(null);
  const sessionControlLeaseRef = useRef(null);
  const polishingSessionIdRef = useRef(null);
  const suppressReconnectErrorRef = useRef(false);
  const reconnectFailureDiagnosticRef = useRef(null);
  const detailRequestIdRef = useRef(0);
  const meetingDetailRequestIdRef = useRef(0);
  const selectedMeetingIdRef = useRef(null);
  const meetingResumeDraftRequestIdRef = useRef(0);
  const pendingLiveCueEventsRef = useRef([]);
  const liveCueFlushTimerRef = useRef(null);
  const liveCueUpdatesAllowedRef = useRef(false);
  const liveCueIdleTimersRef = useRef(new Map());
  const refinementDispatchingRef = useRef(new Set());
  const refinementSubmissionTimesRef = useRef([]);
  const subtitleRefinementTimerRef = useRef(null);
  const refinementRateLimitTimerRef = useRef(null);

  const routeMeetingId = pageInfoFromLocation().meetingId;
  const workspaceInfo = pageInfoFromLocation();
  const isLiveSurface = page === 'live-recording';

  const isActive =
    status === 'requesting-permission' ||
    status === 'connecting' ||
    status === 'listening' ||
    status === 'reconnecting' ||
    status === 'switching-segment';
  const controlsLocked = isActive || status === 'paused' || Boolean(controlLeaseSnapshot && !hasSessionControl);
  const isNavigationLocked = isActive || status === 'paused';
  const liveController = useLiveRecordingController({
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
    audio: {
      pendingMicrophoneStreamRef,
      inputChunksRef: inputAudioUploadChunksRef,
      inputMetadataRef: inputAudioMetadataRef,
      translationChunksRef: translatedAudioUploadChunksRef,
      translationMetadataRef: translatedAudioMetadataRef,
      segmentsRef: audioUploadSegmentsRef,
      setRecordingState,
      setTranslatedAudioState,
      upload: {
        chunks: { input: inputAudioUploadChunksRef, translation: translatedAudioUploadChunksRef },
        metadata: { input: inputAudioMetadataRef, translation: translatedAudioMetadataRef },
        segments: audioUploadSegmentsRef,
        retryTimers: audioUploadRetryTimersRef,
        retryAttempts: audioUploadRetryAttemptsRef,
        getActiveSessionId: () => activeSessionRecordIdRef.current,
        setError
      }
    },
    cue: {
      stateRef: subtitleCueStateRef,
      eventsRef: pendingLiveCueEventsRef,
      flushTimerRef: liveCueFlushTimerRef,
      callbackGenerationRef: liveSessionCallbackGenerationRef,
      setState: setSubtitleCueState,
      getSessionId: () => activeSessionRecordIdRef.current,
      getSegmentId: () => activeMeetingCheckpointRef.current?.segmentId,
      getSessionTime: () => sessionTimeForSubtitleCues(),
      persist: enqueueCuePersistence,
      retranslate: (sourceText, cueId) => sessionRef.current?.retranslateSourceText(sourceText, cueId),
      schedulePolishing: null
    },
    checkpoint: {
      sessionRepositoryRef,
      sessionSnapshotApiClientRef,
      pendingSnapshotIdsRef: pendingSessionSnapshotItemIdsRef,
      activeMeetingCheckpointRef,
      meetingCheckpointApiClientRef,
      setMeetingCheckpointStatus,
      clearCheckpointError: clearSessionSnapshotSyncError,
      reportSnapshotError: reportSessionSnapshotSyncError,
      reportCheckpointError: reportMeetingCheckpointSyncError
    },
    transcript: {
      stateRef: transcriptRef,
      setState: setTranscript,
      sessionRepositoryRef,
      activeSessionRecordIdRef,
      translationCommandLifecycle
    },
    recovery: {
      resumeDraft,
      isActive,
      resetReconnect: () => liveController.recovery.reconnectController().reset(),
      activeMeetingCheckpointRef,
      sessionRef,
      segmentSwitchCancelledRef,
      sessionStopRequestedRef,
      suppressReconnectErrorRef,
      meetingCheckpointApiClientRef,
      setError,
      setStatusLabelOverride,
      setStatus,
      invalidateLiveSessionCallbacks,
      finalizePendingTranscriptItemsForStop: () => liveController.transcriptWorkflow.finalizePendingTranscriptItemsForStop(),
      archiveActiveTranscriptSegment,
      generateLiveSessionId,
      createSession,
      activateLiveSessionCallbacks,
      setLiveCueUpdatesAllowed: (allowed) => { liveCueUpdatesAllowedRef.current = allowed; },
      getSessionTime: () => sessionTimeForSubtitleCues(),
      cueCheckpointForState,
      sessionCommandApiClientRef,
      targetLanguageLabelFor,
      currentMeetingGlossaryEntries,
      selectedInputDeviceSnapshot,
      resetActiveTranscriptForNextSegment,
      setTranscriptTimeOriginValue,
      sessionRepositoryRef,
      activeSessionRecordIdRef,
      polishingSessionIdRef,
      clearSessionSnapshotSyncError,
      sessionControlLeaseRef,
      setHasSessionControl,
      classifyFailureSignal,
      isCurrentGeneration: (generationId) => generationId === liveController.recovery.reconnectController().currentGeneration(),
      reconnectSessionRef,
      reconnectFailureDiagnosticRef,
      cancelSegmentSwitch: () => liveController.segmentSwitch.cancel(),
      startSegmentSwitch: () => liveController.segmentSwitch.start(),
      safeReconnectDiagnostic,
      reconnectErrorMessage,
      appendSessionFailureDiagnostic,
      finalizeActiveSessionRecord,
      buildFinalizePatch,
      translationCommandLifecycle,
      meetingDetailCacheRef,
      selectedMeetingIdRef,
      refreshSelectedMeetingDetail,
      inputDevicesRef,
      selectedInputDeviceIdRef,
      pendingMicrophoneStreamRef,
      meetingResumeDraftRequestIdRef,
      setSelectedInputDeviceId,
      setDeviceMessage,
      cancelLiveCueIdleTimers,
      updateLiveMeetingUrl,
      applyStartFailure,
      updateCurrentSessionStatus,
      setResumeDraft,
      getRouteMeetingId: () => pageInfoFromLocation().meetingId,
      setMeetingCheckpointStatus,
      refreshMeetingRecords
    },
    segmentSwitch: {
      intervalMs: configuredSegmentSwitchIntervalMs(),
      onStatusChange: (nextStatus) => {
        if (nextStatus === 'switching') setMeetingCheckpointStatus('switching');
        if (nextStatus === 'switched') setMeetingCheckpointStatus('switched');
      },
      onError: reportSegmentSwitchError
    },
    state: {
      status,
      statusLabelOverride,
      error,
      deviceMessage,
      transcript,
      archivedTranscript,
      subtitleCueState,
      polishingState,
      polishedArticle,
      recordingState,
      translatedAudioState,
      meetingCheckpointStatus,
      meetingViewStats,
      resumeDraft,
      controlLeaseSnapshot,
      hasSessionControl,
      isActive,
      controlsLocked
    },
    actions: {
      retryPolishingExecution,
      copyLiveSource,
      copyLiveTranslation
    }
  });

  useEffect(() => {
    const lease = createSessionControlLease();
    sessionControlLeaseRef.current = lease;
    const unsubscribe = lease.subscribe((current) => {
      setControlLeaseSnapshot(current);
      setHasSessionControl(Boolean(activeSessionRecordIdRef.current && lease.owns(activeSessionRecordIdRef.current)));
    });
    return () => {
      unsubscribe();
      lease.destroy();
      sessionControlLeaseRef.current = null;
    };
  }, []);

  inputDevicesRef.current = inputDevices;
  selectedInputDeviceIdRef.current = selectedInputDeviceId;

  useEffect(() => {
    void refreshInputDevices();

    if (!navigator.mediaDevices?.addEventListener) {
      return undefined;
    }

    const handleDeviceChange = () => {
      void refreshInputDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      liveController.recovery.reconnectController().setConnectivity(false);
      setStatusLabelOverride('網路離線');
      setError('網路已中斷，等待恢復後重新連線。');
      if (sessionRef.current) {
        void sessionRef.current.handleNetworkOffline();
      }
    };
    const handleOnline = () => {
      liveController.recovery.reconnectController().setConnectivity(true);
      setStatusLabelOverride('重新連線中');
      setError('');
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const canonicalHash = canonicalHashForLocation();
      if (canonicalHash !== window.location.hash) {
        window.history.replaceState(null, '', canonicalHash);
      }
      const next = pageInfoFromLocation();
      if (next.page === 'live-recording' && selectedMeetingIdRef.current !== next.meetingId) {
        selectedMeetingIdRef.current = null;
        setSelectedMeetingId(null);
        setSelectedMeetingDetail(null);
        setMeetingDetailError('');
      }
      setPage(next.page);
      setLocationVersion((current) => current + 1);
      if (next.page !== 'meetings') {
        setNavigationNotice('');
      }
      if (next.page !== 'live-recording') {
        setError('');
      }
    };
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (page === 'meetings') {
      void refreshMeetingRecords();
    }
  }, [page]);

  useEffect(() => {
    if (!['meeting-detail', 'live-recording'].includes(page)) return;

    const info = pageInfoFromLocation();
    if (!info.meetingId) {
      selectedMeetingIdRef.current = null;
      setSelectedMeetingId(null);
      setSelectedMeetingDetail(null);
      setMeetingDetailError('');
      return;
    }

    if (selectedMeetingIdRef.current !== info.meetingId) {
      void loadMeetingDetail(info.meetingId);
    }
  }, [page, routeMeetingId, locationVersion]);

  useEffect(() => {
    if (!isLiveSurface) return;
    let cancelled = false;
    void refreshMeetingRecords().then((meetings) => {
      if (cancelled || !meetings) return;
      const resumableMeetings = meetings.filter((meeting) => ['created', 'active', 'interrupted'].includes(meeting.status));
      const currentMeetingId = pageInfoFromLocation().meetingId;
      if (currentMeetingId && !resumableMeetings.some((meeting) => meeting.id === currentMeetingId)) {
        redirectToMeetingWithError();
      }
    });
    return () => { cancelled = true; };
  }, [page, isLiveSurface]);

  useEffect(() => {
    if (!isLiveSurface) return undefined;
    let cancelled = false;
    void createGlossaryApiClient().listEntries()
      .then((entries) => {
        if (!cancelled) setGlossaryEntries(entries);
      })
      .catch(() => {
        // The drawer reports glossary loading failures when the user opens it.
      });
    return () => { cancelled = true; };
  }, [page, isLiveSurface]);

  useEffect(() => {
    // Live transcription is source-only; legacy polishing results are
    // intentionally not polled or applied during a recording.
    return undefined;
    /* istanbul ignore next -- retained below only for historical compatibility */
    if (!(activeSessionRecordIdRef.current || polishingSessionIdRef.current) || status === 'idle') return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const sessionId = activeSessionRecordIdRef.current || polishingSessionIdRef.current;
        const detail = await getSessionDetailWithTranslationHistory(sessionId);
        const outputs = completedPolishingOutputs(detail);
        applyRefinementExecutionStates(detail);
        applyRefinedOutputs(detail);
        applyPersistedRefinedSubtitleCues(detail);
        applyPersistedFinalCues(rawCuesFromDetail(detail?.cues));
        const output = latestPolishingOutput(detail);
        const latestExecution = latestPolishingExecution(detail);
        const pendingExecution = latestExecution && ['queued', 'processing', 'running'].includes(latestExecution.status)
          ? latestExecution
          : null;
        if (!cancelled && pendingExecution) {
          setPolishingState({
            status: pendingExecution.status,
            version: null,
            updatedAt: pendingExecution.startedAt || pendingExecution.createdAt || null,
            error: '',
            executionId: pendingExecution.id
          });
        } else if (!cancelled && outputs.length > 0) {
          const hasRefinedItems = outputs.some((item) => Array.isArray(item.refinedItems) && item.refinedItems.length > 0);
          if (!hasRefinedItems) {
            const polishedItems = mergePolishedItemsFromOutputs(outputs);
            applyPolishedOutput({
              ...output,
              polishedItems,
              translatedText: polishedItems.map((item) => item.polishedText).join('\n')
            });
          }
          setPolishingState({ status: 'completed', text: hasRefinedItems ? '已完成逐句修正' : output.translatedText || '', version: output.version ?? null, updatedAt: output.completedAt || output.createdAt || null, error: '', executionId: output.executionId || null });
        } else {
          if (!cancelled && latestExecution) setPolishingState({
            status: latestExecution.status,
            version: null,
            updatedAt: latestExecution.completedAt || latestExecution.startedAt || null,
            error: latestExecution.status === 'failed' ? translationFailureReasonLabel(latestExecution.failureInfo) : '',
            executionId: latestExecution.id
          });
        }
      } catch {
        // Polishing read failures are isolated from the Live session.
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [status]);

  function applyPolishedOutput(output) {
    const polishedItems = Array.isArray(output?.polishedItems) ? output.polishedItems : [];
    const text = typeof output?.translatedText === 'string' ? output.translatedText.trim() : '';
    if (!text && polishedItems.length === 0) return;
    setPolishedArticle({
      text,
      items: polishedItems.map((item) => ({ cueId: item.cueId, sequence: item.sequence, polishedText: item.polishedText })),
      version: output.version ?? null,
      updatedAt: output.completedAt || output.createdAt || null
    });
    setPolishingState((current) => ({ ...current, text, version: output.version ?? current.version, updatedAt: output.completedAt || output.createdAt || current.updatedAt }));
  }

  function applyRefinedOutputs(detail) {
    const outputs = completedPolishingOutputs(detail);
    if (outputs.length === 0) return;
    const previous = subtitleCueStateRef.current;
    const refinement = applyCompletedRefinementOutputs(previous.finalCues, outputs, {
      sessionId: activeSessionRecordIdRef.current,
      logger: (event) => { if (import.meta.env?.DEV) console.debug('[Cue refinement]', event); }
    });
    if (!refinement.changed) return;
    const nextCues = refinement.cues;
    const next = { ...previous, finalCues: nextCues };
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(previous, next);
    setPolishedArticle({ text: refinement.articleText, items: nextCues.map((cue) => ({ cueId: cue.cueId, sequence: cue.sequence, polishedText: effectiveTranslationForCue(cue) })), version: null, updatedAt: new Date().toISOString() });
  }

  function applyRefinementExecutionStates(detail) {
    const current = subtitleCueStateRef.current;
    const nextCues = applyCueRefinementExecutionStates(current.finalCues, detail?.translationHistory?.executions);
    if (nextCues.every((cue, index) => cue === current.finalCues[index])) return;
    const next = { ...current, finalCues: nextCues };
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
  }

  function applyPersistedRefinedSubtitleCues(detail) {
    const current = subtitleCueStateRef.current;
    const refinedCues = refinedSubtitleCuesForDisplay(detail?.cues, {
      inputHash: current.refinedSubtitleInputHash
    });
    if (refinedCues.length === 0) return false;
    if (JSON.stringify(refinedCues) === JSON.stringify(current.refinedSubtitleCues || [])) {
      return true;
    }
    const next = {
      ...current,
      refinedSubtitleCues: refinedCues,
      refinedSubtitleStatus: 'completed',
      refinedSubtitleRevision: Math.max(
        current.refinedSubtitleRevision || 0,
        Number(detail?.refinedSubtitleRevision) || 0
      ) || (current.refinedSubtitleRevision || 0) + 1
    };
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
    return true;
  }

  function applyPersistedFinalCues(persistedCues = []) {
    if (!Array.isArray(persistedCues) || persistedCues.length === 0) return;
    const current = subtitleCueStateRef.current;
    const mergedCues = mergeCuesByIdPreferRefinement(current.finalCues, persistedCues);
    if (mergedCues.every((cue, index) => cue === current.finalCues[index])) return;
    const next = { ...current, finalCues: mergedCues };
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
  }

  useEffect(() => {
    const { page: currentPage, meetingId } = pageInfoFromLocation();
    if (currentPage !== 'live-recording') {
      return;
    }
    if (!meetingId) {
      if (!isActive && !sessionRef.current) {
        meetingResumeDraftRequestIdRef.current += 1;
        activeMeetingCheckpointRef.current = null;
        setResumeDraft(null);
        setMeetingCheckpointStatus('idle');
        setMeetingViewStats({ archivedSegmentCount: 0, loadedSegmentCount: 0 });
      }
      return;
    }
    if (status !== 'idle') return;

    void meetingReadApiClientRef.current.getMeetingDetail(meetingId)
      .then((detail) => {
        const meeting = detail?.meeting;
        if (meeting?.status === 'completed') {
          window.location.hash = `#meeting-detail?meetingId=${encodeURIComponent(meeting.id)}&from=history`;
          return;
        }
        if (!meeting || !['created', 'active', 'interrupted'].includes(meeting.status)) {
          redirectToMeetingWithError();
          return;
        }
        const nextTargetLanguageCode = meeting.targetLanguageCode || 'en';
        setSessionName(meeting.name || '');
        setSourceLanguageCode(meeting.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE);
        setTargetLanguageCode(nextTargetLanguageCode);
        setEchoTargetLanguage(meeting.echoTargetLanguage !== false);
        setShouldRecordInputAudio(meeting.shouldRecordInputAudio === true);
        setSelectedMeetingGlossaryIds((current) => {
          if (current.length > 0) return current;
          return glossaryEntries.filter((entry) => (meeting.glossaryEntries || []).some((item) => item.source === entry.source && entry.translations?.[nextTargetLanguageCode] === item.target)).map((entry) => entry.id);
        });
        setPrivateMeetingGlossaryEntries(Array.isArray(meeting.privateGlossaryEntries) ? meeting.privateGlossaryEntries : []);
      })
      .catch(() => {})
      .finally(() => {
        if (pageFromLocation() === 'live-recording' && pageInfoFromLocation().meetingId === meetingId) {
          loadMeetingResumeDraft(meetingId);
        }
      });
  }, [page, status, locationVersion]);

  useEffect(() => () => {
    invalidateLiveSessionCallbacks();
    liveController.recovery.cancel();
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);
    sessionRef.current = null;
    reconnectSessionRef.current = null;
    liveController.checkpoint.cancel();
    if (refinementRateLimitTimerRef.current) window.clearTimeout(refinementRateLimitTimerRef.current);
    refinementRateLimitTimerRef.current = null;
    liveController.audio.cancelAudioUploadRetries();
    liveController.segmentSwitch.cancel();
    for (const session of sessions) {
      void session?.stop().catch(() => {});
    }
    void Promise.resolve(liveController.audio.cleanup()).catch(() => {});
  }, []);

  useEffect(() => {
    updateActiveSessionGlossaryEntries(glossaryEntries);
  }, [glossaryEntries, targetLanguageCode]);

  useEffect(() => {
    cancelLiveCueIdleTimers();
    if (!liveCueUpdatesAllowedRef.current || status !== 'listening') return undefined;
    const candidates = [
      subtitleCueState.currentCue,
      ...(subtitleCueState.pendingCues || [])
    ].filter((cue) => cue?.cueId && Number.isFinite(cue.updatedTimeMs));
    const now = sessionTimeForSubtitleCues();
    for (const cue of candidates) {
      const timerOrigin = Number.isFinite(cue.boundaryAtMs) ? cue.boundaryAtMs : cue.updatedTimeMs;
      const remaining = Math.max(0, LIVE_CUE_IDLE_FINALIZE_MS - Math.max(0, now - timerOrigin));
      const timer = setTimeout(() => {
        liveCueIdleTimersRef.current.delete(cue.cueId);
        const result = resolveIdleSubtitleCue(subtitleCueStateRef.current, {
          cueId: cue.cueId,
          updatedTimeMs: cue.updatedTimeMs,
          sessionTimeMs: sessionTimeForSubtitleCues(),
          debounceMs: LIVE_CUE_IDLE_FINALIZE_MS,
          targetLanguageCode,
          sourceLanguageCode
        });
        let nextState = result.state;
        if (result.action === 'translation-failed') {
          nextState = dismissSubtitleCue(nextState, result.cue?.cueId);
        }
        if (nextState !== subtitleCueStateRef.current) {
          const previous = subtitleCueStateRef.current;
          subtitleCueStateRef.current = nextState;
          setSubtitleCueState(nextState);
          enqueueCuePersistence(previous, nextState);
        }
        if (result.action === 'needs-retranslation') {
          sessionRef.current?.retranslateSourceText(result.cue?.sourceText, result.cue?.cueId);
        }
        liveController.cue.requestNumericCorrection(nextState);
      }, remaining);
      liveCueIdleTimersRef.current.set(cue.cueId, timer);
    }
    return cancelLiveCueIdleTimers;
  }, [subtitleCueState, status, targetLanguageCode, sourceLanguageCode]);

  async function refreshInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      const devices = audioInputDevices(await navigator.mediaDevices.enumerateDevices());
      setInputDevices(devices);
      setSelectedInputDeviceId((current) => {
        if (!current || devices.some((device) => device.deviceId === current)) {
          return current;
        }

        setDeviceMessage('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
        selectedInputDeviceIdRef.current = '';
        return '';
      });
    } catch {
      setDeviceMessage('無法取得麥克風清單，已改用瀏覽器預設麥克風。');
    }
  }

  function cancelLiveCueIdleTimers() {
    for (const timer of liveCueIdleTimersRef.current.values()) clearTimeout(timer);
    liveCueIdleTimersRef.current.clear();
  }

  function applyStartFailure(nextError, fallbackMessage) {
    const classification = classifyFailureSignal({
      source: 'microphone_capture',
      rawError: nextError,
      reasonHint: 'audio_capture_failed'
    });
    const noDefaultInputDevice =
      classification.reason === 'selected_device_missing' && !selectedInputDeviceId;
    const message = noDefaultInputDevice
      ? '找不到可用的麥克風。請連接或允許麥克風後再試一次。'
      : classification.safeMessage || nextError?.message || fallbackMessage;

    const diagnostic = safeReconnectDiagnostic({
      source: 'startup',
      stage: 'start_session',
      rawError: nextError,
      reasonHint: classification.reason
    }, classification);
    reconnectFailureDiagnosticRef.current = diagnostic;
    void appendSessionFailureDiagnostic(diagnostic, classification);

    setStatusLabelOverride('');
    setError(message);
    setStatus('error');
  }

  async function createSession({ preserveTranscript, liveSessionId = generateLiveSessionId() }) {
    if (!preserveTranscript) {
      setError('');
      setDeviceMessage('');
      const sessionStartedAt = Date.now();
      setTranscriptTimeOriginValue(sessionStartedAt);
      const resetTranscript = resetTranscriptState();
      transcriptRef.current = resetTranscript;
      setTranscript(() => resetTranscript);
      const resetCues = resetSubtitleCueState();
      transcriptPolishingLifecycleRef.current?.reset(activeSessionRecordIdRef.current);
      transcriptPolishingCoordinatorRef.current?.reset();
      setPolishingState({ status: 'idle', text: '', version: null, updatedAt: null, error: '' });
      setPolishedArticle({ text: '', items: [], version: null, updatedAt: null });
      cancelLiveCueIdleTimers();
      subtitleCueStateRef.current = resetCues;
      setSubtitleCueState(resetCues);
      const resetArchivedTranscript = resetTranscriptState();
      archivedTranscriptSegmentsRef.current = [];
      archivedTranscriptRef.current = resetArchivedTranscript;
      setArchivedTranscript(() => resetArchivedTranscript);
      setMeetingViewStats({ archivedSegmentCount: 0, loadedSegmentCount: 0 });
      setCopiedArticleStream('');
      setStatus('requesting-permission');
    }

    const inputDeviceIdForSession = inputDevicesRef.current.some((device) => device.deviceId === selectedInputDeviceIdRef.current)
      ? selectedInputDeviceIdRef.current
      : '';

    const callbackGeneration = {
      generation: liveSessionCallbackGenerationRef.current.generation + 1,
      active: false
    };
    liveSessionCallbackGenerationRef.current = callbackGeneration;

    const session = new LiveTranscriptionSession({
      liveSessionId,
      connectionEpoch: callbackGeneration.generation,
      sessionId: activeSessionRecordIdRef.current,
      meetingId: activeMeetingCheckpointRef.current?.meetingId || null,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || liveSessionId,
      sessionClock: () => sessionTimeForSubtitleCues(),
      sourceLanguageCode,
      inputDeviceId: inputDeviceIdForSession,
      onInputDeviceFallback: () => {
        setSelectedInputDeviceId('');
        setDeviceMessage('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
      },
      onMicrophoneReady: ({ mediaStream } = {}) => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        pendingMicrophoneStreamRef.current = mediaStream || null;
        void refreshInputDevices();
      },
      onConnecting: () => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        setStatus((current) => (
          current === 'reconnecting' || current === 'switching-segment' ? current : 'connecting'
        ));
        setStatusLabelOverride('正在連線，已暫存音訊');
      },
      onCaptureStateChange: ({ state } = {}) => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        if (state === 'capturing') {
          setStatusLabelOverride('正在連線，已暫存音訊');
        }
      },
      onProviderReady: () => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        setStatusLabelOverride('');
      },
      onInputAudioChunk: (chunk) => {
        if (isCurrentLiveSessionInstance(callbackGeneration)) liveController.audio.handleInputAudioChunk(chunk);
      },
      onInputTranscript: (update) => {
        if (isCurrentLiveSessionCallback(callbackGeneration) && isOwnedLiveSessionEvent(update, callbackGeneration)) {
          applyTranscriptUpdate({ ...update, eventId: update.eventId, connectionEpoch: callbackGeneration.generation, stream: 'source' });
        }
      },
      onCueEvent: (event) => {
        if (!isCurrentLiveSessionCallback(callbackGeneration)
          || !isOwnedLiveSessionEvent(event, callbackGeneration)
          || !liveCueUpdatesAllowedRef.current) return;
        liveController.cue.queueLiveSubtitleCueEvent(event);
      },
      onError: (nextError) => {
        if (!isCurrentLiveSessionCallback(callbackGeneration)) return;
        if (suppressReconnectErrorRef.current) {
          suppressReconnectErrorRef.current = false;
          return;
        }

        setError(nextError.message);
        setStatus('error');
        sessionRef.current = null;
        void liveController.recovery.finalizeFailedSession({
          status: 'failed',
          failureReason: 'unknown_error',
          failureCategory: 'unknown'
        });
      },
      onClose: () => {
        if (!isCurrentLiveSessionCallback(callbackGeneration)) return;
        setStatus((current) => (current === 'listening' ? 'stopped' : current));
        sessionRef.current = null;
      },
      onConnectionFailure: (failure) => {
        if (!isCurrentLiveSessionCallback(callbackGeneration)) return;
        if (failure.source === 'microphone_disconnected' && failure.reasonHint === 'selected_device_missing') {
          selectedInputDeviceIdRef.current = '';
          setSelectedInputDeviceId('');
          setDeviceMessage('所選麥克風已中斷，重新連線時會改用瀏覽器預設麥克風。');
        }
        const classification = classifyFailureSignal(failure);
        reconnectFailureDiagnosticRef.current = safeReconnectDiagnostic(failure, classification);
        void appendSessionFailureDiagnostic(reconnectFailureDiagnosticRef.current, classification);
        const failureUiState = failureUiStateForClassification(classification);

        if (!failureUiState.shouldReconnect) {
          suppressReconnectErrorRef.current = failureUiState.suppressSessionError;
          setError(failureUiState.message);
          setStatus(failureUiState.status);
          setStatusLabelOverride(failureUiState.statusLabel);
          void liveController.recovery.finalizeFailedSession({
            status: failureUiState.status === 'expired' ? 'expired' : 'failed',
            failureReason: classification.reason,
            failureCategory: classification.category
          });
          if (failureUiState.clearSession) {
            sessionRef.current = null;
          }
          return;
        }

        suppressReconnectErrorRef.current = failureUiState.suppressSessionError;
        setError(failureUiState.message);
        setStatus(failureUiState.status);
        setStatusLabelOverride(failureUiState.statusLabel);
        void liveController.recovery.reconnectController()
          .scheduleReconnect(classification)
          .then((result) => {
            if (!result.scheduled && !result.ignored && !result.paused) {
              suppressReconnectErrorRef.current = false;
              setStatusLabelOverride('');
              setError(reconnectErrorMessage(result, reconnectFailureDiagnosticRef.current));
              setStatus('error');
            void liveController.recovery.finalizeFailedSession({
                status: 'failed',
                failureReason: classification.reason,
                failureCategory: classification.category
              });
            }
          });
      }
    });
    session.callbackGeneration = callbackGeneration;
    return session;
  }

  function invalidateLiveSessionCallbacks() {
    liveSessionCallbackGenerationRef.current = {
      generation: liveSessionCallbackGenerationRef.current.generation + 1,
      active: false
    };
  }

  function activateLiveSessionCallbacks(callbackGeneration) {
    if (liveSessionCallbackGenerationRef.current !== callbackGeneration) return false;
    callbackGeneration.active = true;
    return true;
  }

  function isCurrentLiveSessionCallback(callbackGeneration) {
    return liveSessionCallbackGenerationRef.current === callbackGeneration && callbackGeneration.active;
  }

  function isOwnedLiveSessionEvent(event, callbackGeneration) {
    return event?.connectionEpoch === undefined
      || event.connectionEpoch === callbackGeneration.generation;
  }

  function isCurrentLiveSessionInstance(callbackGeneration) {
    return liveSessionCallbackGenerationRef.current === callbackGeneration;
  }

  function updateActiveSessionGlossaryEntries(entries) {
    const liveGlossaryEntries = liveGlossaryEntriesForTarget(entries, targetLanguageCode);
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);

    for (const session of sessions) {
      if (session) session.liveGlossaryEntries = liveGlossaryEntries;
    }
  }

  function configuredSegmentSwitchIntervalMs() {
    const testIntervalMs = import.meta.env?.DEV ? window.__liveTranslateSegmentSwitchIntervalMs : undefined;
    return Number.isFinite(testIntervalMs) && testIntervalMs > 0 ? testIntervalMs : SEGMENT_SWITCH_INTERVAL_MS;
  }

  function reportSegmentSwitchError(error) {
    if (sessionStopRequestedRef.current) return;
    console.error('Meeting segment switch failed.', error);
    setStatusLabelOverride('切換失敗');
    setError('長會議分段切換失敗。已保留目前逐字稿，請停止後重新開始。');
    setStatus('error');
    void liveController.recovery.finalizeFailedSession({
      status: 'failed',
      failureReason: 'segment_switch_failed',
      failureCategory: 'provider'
    });
  }

  function generateLiveSessionId() {
    liveSessionIdSequenceRef.current += 1;
    return `live-session-${Date.now()}-${liveSessionIdSequenceRef.current}`;
  }

  function currentMeetingGlossaryEntries() {
    const shared = selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode);
    const privateEntries = (Array.isArray(privateMeetingGlossaryEntries) ? privateMeetingGlossaryEntries : [])
      .map((entry) => ({
        source: entry.source,
        target: entry.translations?.[targetLanguageCode],
        replacementAliases: entry.replacementAliases?.[targetLanguageCode] || []
      }))
      .filter((entry) => entry.target);
    return [...shared, ...privateEntries];
  }

  function applyTranscriptUpdate(update) {
    if (update?.connectionEpoch !== undefined
      && update.connectionEpoch !== liveSessionCallbackGenerationRef.current.generation) return;
    const current = transcriptRef.current;
    const segmentDecision = describeTranscriptSegmentDecision(current, update);
    const next = applyTranscriptEvent(current, update);
    logTranscriptSegmentDecision(update, segmentDecision, current, next);
    if (next === current) return;

    transcriptRef.current = next;
    const activeSessionRecordId = activeSessionRecordIdRef.current;
    const appended = appendNewFinalTranscriptItems(sessionRepositoryRef.current, activeSessionRecordId, current, next);
    liveController.checkpoint.markPendingSessionSnapshotItems(activeSessionRecordId, appended);
    setTranscript((previous) => (
      previous === current ? next : applyTranscriptEvent(previous, update)
    ));

    if (appended.length > 0) {
      const activeSessionRecord = sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
      if (activeSessionRecord) {
        liveController.checkpoint.scheduleSessionSnapshotSync(activeSessionRecordId);
        liveController.checkpoint.scheduleMeetingCheckpointSync(appended);
      }
    }
  }

  function transcriptPolishingLifecycle() {
    if (!transcriptPolishingLifecycleRef.current) {
      transcriptPolishingLifecycleRef.current = createTranscriptPolishingLifecycle({
        apiClient: createTranslationCommandApiClient(),
        onStateChange: (next) => setPolishingState((current) => ({ ...current, status: next.status, error: next.error?.message || '' }))
      });
    }
    return transcriptPolishingLifecycleRef.current;
  }

  function transcriptPolishingCoordinator() {
    if (!transcriptPolishingCoordinatorRef.current) {
      transcriptPolishingCoordinatorRef.current = createCueRefinementCoordinator({
        maxRequestsPerMinute: Number.isInteger(TRANSCRIPT_POLISHING_MAX_RPM) && TRANSCRIPT_POLISHING_MAX_RPM > 0 ? TRANSCRIPT_POLISHING_MAX_RPM : 15,
        submit: ({ cue, contextCues }) => transcriptPolishingLifecycle().submitCue({
          sessionId: activeSessionRecordIdRef.current,
          targetLanguageCode,
          sourceLanguageCode,
          cue,
          contextCues
        }).then((result) => {
          const current = subtitleCueStateRef.current;
          const nextCues = current.finalCues.map((candidate) => candidate.cueId === cue.cueId
            ? {
              ...candidate,
              refinement: {
                ...(candidate.refinement || {}),
                status: 'queued',
                version: result.version,
                inputHash: result.inputHash,
                executionId: result.executionId,
                requestedAt: new Date().toISOString()
              }
            }
            : candidate);
          const next = nextCues.every((candidate, index) => candidate === current.finalCues[index])
            ? current
            : { ...current, finalCues: nextCues };
          if (next !== current) {
            subtitleCueStateRef.current = next;
            setSubtitleCueState(next);
            enqueueCuePersistence(current, next);
          }
          return result;
        }),
        onStateChange: (next) => setPolishingState((current) => ({ ...current, status: next.status, error: next.error?.message || '' }))
      });
    }
    return transcriptPolishingCoordinatorRef.current;
  }

  function scheduleTranscriptPolishing(finalCues = []) {
    if (!TRANSCRIPT_POLISHING_ENABLED) return;
    const cues = finalCues.filter((cue) => cue?.status === 'final' && rawSourceForCue(cue) && rawTranslationForCue(cue));
    if (!activeSessionRecordIdRef.current || cues.length === 0) return;
    transcriptPolishingCoordinator().enqueue(cues);
  }

  function pollRefinedSubtitleResult(sessionId, inputHash, attempt) {
    if (!sessionId || !inputHash || attempt > 5) return;
    window.setTimeout(async () => {
      try {
        const detail = await sessionReadApiClientRef.current.getSessionDetail(sessionId);
        const current = subtitleCueStateRef.current;
        const cues = refinedSubtitleCuesForDisplay(detail?.cues, { inputHash });
        if (cues.length > 0 && applyPersistedRefinedSubtitleCues({ ...detail, cues })) {
          const next = {
            ...subtitleCueStateRef.current,
            finalCues: markCuesCompletedByRefinedSubtitleCues(current.finalCues, cues)
          };
          subtitleCueStateRef.current = next;
          setSubtitleCueState(next);
          enqueueCuePersistence(current, next);
          return;
        }
      } catch {
        // Raw final Cues remain visible while the asynchronous refinement is pending.
      }
      pollRefinedSubtitleResult(sessionId, inputHash, attempt + 1);
    }, 1000);
  }

  async function retryPolishingExecution(executionId) {
    if (!executionId) return;
    try {
      const response = await createTranslationCommandApiClient().retryFailedTranslationExecution(executionId);
      const retryExecution = response?.execution || response;
      const current = subtitleCueStateRef.current;
      const nextCues = current.finalCues.map((cue) => cue.refinement?.executionId === executionId
        ? { ...cue, refinement: { ...(cue.refinement || {}), status: 'queued', executionId: retryExecution?.id || executionId } }
        : cue);
      if (!nextCues.every((cue, index) => cue === current.finalCues[index])) {
        const next = { ...current, finalCues: nextCues };
        subtitleCueStateRef.current = next;
        setSubtitleCueState(next);
        enqueueCuePersistence(current, next);
      }
      setPolishingState((current) => ({ ...current, status: 'queued', error: '' }));
    } catch {
      setPolishingState((current) => ({ ...current, status: 'failed', error: '翻譯潤飾重試失敗，請稍後再試。' }));
    }
  }

  function enqueueCuePersistence(previous, next) {
    const previousCues = new Map((previous?.finalCues || []).map((cue) => [cue.cueId, cue]));
    const changedCues = (next?.finalCues || []).filter((cue) => {
      const previousCue = previousCues.get(cue.cueId);
      return !previousCue || JSON.stringify(previousCue) !== JSON.stringify(cue);
    });
    const checkpoint = cueCheckpointForState(next);
    void publishMeetingCues(changedCues, activeMeetingCheckpointRef.current, activeSessionRecordIdRef.current);
    liveController.checkpoint.meetingCheckpointSyncCoordinator().enqueueCues(changedCues, checkpoint);
  }

  async function publishMeetingCues(cues, meetingCheckpoint, sessionId) {
    if (!meetingCheckpoint?.meetingId || !meetingCheckpoint?.segmentId || !sessionId || !Array.isArray(cues) || cues.length === 0) return;
    await Promise.all(cues.filter((cue) => cue?.status === 'final').map((cue) => (
      meetingCueApiClientRef.current.publish({
        meetingId: meetingCheckpoint.meetingId,
        segmentId: meetingCheckpoint.segmentId,
        sessionId,
        cue,
        producedAt: cue.finalizedAt || Date.now()
      }).catch(() => null)
    )));
  }

  function cueCheckpointForState(state) {
    const lastCue = state?.finalCues?.at(-1);
    return {
      mode: 'transcription',
      currentCue: state?.currentCue || null,
      pendingCues: state?.pendingCues || [],
      nextSequence: state?.nextSequence || 1,
      finalizedCueKeys: state?.finalizedCueKeys || [],
      processedEventIds: state?.processedEventIds || [],
      pendingBoundary: state?.pendingBoundary || { turnComplete: false, generationComplete: false },
      pendingBoundaryAtMs: state?.pendingBoundaryAtMs ?? null,
      lastFinalizedCueId: state?.lastFinalizedCueId || null,
      lastFinalizedAtMs: state?.lastFinalizedAtMs ?? null,
      lastFinalizedStream: state?.lastFinalizedStream || null,
      lastFinalizedReason: state?.lastFinalizedReason || null,
      lastCommittedCueSequence: lastCue?.sequence || 0,
      lastCommittedEndTimeMs: lastCue?.endTimeMs ?? null,
      refinedSubtitleCues: state?.refinedSubtitleCues || [],
      refinedSubtitleRevision: state?.refinedSubtitleRevision || 0,
      refinedSubtitleInputHash: state?.refinedSubtitleInputHash || null,
      refinedSubtitleStatus: state?.refinedSubtitleStatus || 'pending'
    };
  }

  function sessionTimeForSubtitleCues() {
    const origin = transcriptTimeOriginRef.current;
    return Number.isFinite(origin) ? Math.max(0, Date.now() - origin) : null;
  }

  function setTranscriptTimeOriginValue(origin = Date.now()) {
    setTranscriptTimeOrigin(origin);
    transcriptTimeOriginRef.current = origin;
    return origin;
  }

  async function updateCurrentSessionStatus(nextStatus, patch = {}) {
    const sessionId = activeSessionRecordIdRef.current;
    if (!sessionId) return null;
    const updated = sessionRepositoryRef.current.updateSessionRecord(sessionId, {
      status: nextStatus,
      ...patch
    });
    const synced = await liveController.checkpoint.flushSessionSnapshot(sessionId);
    if (synced) clearSessionSnapshotSyncError();
    return updated;
  }

  async function appendSessionFailureDiagnostic(diagnostic, classification = {}) {
    const sessionId = activeSessionRecordIdRef.current;
    if (!sessionId || !diagnostic) return null;
    const current = sessionRepositoryRef.current.getSessionRecord(sessionId)?.sessionRecord;
    if (!current) return null;
    const failureDiagnostics = [...(current.failureDiagnostics || []), diagnostic].slice(-10);
    const updated = sessionRepositoryRef.current.updateSessionRecord(sessionId, {
      failureDiagnostics,
      failureReason: classification.reason || diagnostic.reason || 'unknown_error',
      failureCategory: classification.category || diagnostic.category || 'unknown',
      lastLifecycleState: 'reconnecting'
    });
    await liveController.checkpoint.flushSessionSnapshot(sessionId);
    return updated;
  }

  function clearSessionSnapshotSyncError() {
    setError((current) => current.startsWith('無法儲存翻譯紀錄') || current.startsWith('翻譯紀錄內容超過伺服器保存上限')
      ? ''
      : current);
  }

  function reportSessionSnapshotSyncError(error) {
    console.error('Session snapshot persistence failed.', error);
    if (error?.status === 413 || error?.code === 'request_too_large') {
      setError('翻譯紀錄內容超過伺服器保存上限，但目前逐字稿仍保留在畫面上。請調高 SESSION_SNAPSHOT_MAX_BYTES 或稍後重新儲存翻譯紀錄。');
      return;
    }
    setError('無法儲存翻譯紀錄，但目前逐字稿仍保留在畫面上。');
  }

  function reportMeetingCheckpointSyncError(error) {
    console.error('Meeting checkpoint persistence failed.', error);
    const diagnostic = error?.requestId ? `（請提供 Request ID：${error.requestId}）` : '';
    if (error?.status === 413 || error?.code === 'request_too_large') {
      setError(`長會議同步內容超過伺服器保存上限，未同步片段會保留並重試；請調高 MEETING_CHECKPOINT_MAX_BYTES。${diagnostic}`);
      return;
    }
    if (error?.status === 409 || error?.code === 'checkpoint_conflict') {
      setError(`長會議同步發生 checkpoint 衝突，未同步片段會保留；請重新載入會議後再繼續。${diagnostic}`);
      return;
    }
    if (error?.status === 404 || error?.code === 'meeting_not_found' || error?.code === 'meeting_segment_not_found') {
      setError(`長會議同步找不到目前的會議段落，未同步片段已保留。${diagnostic}`);
      return;
    }
    setError(`長會議同步暫時失敗，已保留未同步片段並會在下一次同步時重試。${diagnostic}`);
  }

  function archiveActiveTranscriptSegment() {
    const currentTranscript = transcriptRef.current;
    const finalItemCount = transcriptHasFinalItems(currentTranscript);
    if (finalItemCount > 0) {
      archivedTranscriptSegmentsRef.current = [
        ...archivedTranscriptSegmentsRef.current,
        {
          id: `active-segment-${Date.now()}-${currentTranscript.nextSequence}`,
          transcript: currentTranscript
        }
      ];
      const archived = archivedTranscriptFromSegments(archivedTranscriptSegmentsRef.current, currentTranscript.nextSequence);
      archivedTranscriptRef.current = archived;
      setArchivedTranscript(() => archived);
    }
    resetActiveTranscriptForNextSegment(currentTranscript.nextSequence);

    if (finalItemCount > 0) {
      setMeetingViewStats((current) => ({
        archivedSegmentCount: current.archivedSegmentCount + 1,
        loadedSegmentCount: Math.max(current.loadedSegmentCount, current.archivedSegmentCount + 1)
      }));
    }
  }

  function resetActiveTranscriptForNextSegment(nextSequence) {
    const nextTranscript = emptyTranscriptStateWithNextSequence(nextSequence);
    transcriptRef.current = nextTranscript;
    setTranscript(() => nextTranscript);
  }

  async function refreshMeetingRecords() {
    try {
      const meetings = await meetingReadApiClientRef.current.listMeetingHistory();
      setMeetingRecords([...meetings].sort((a, b) => meetingRecordSortTime(b) - meetingRecordSortTime(a)));
      return meetings;
    } catch {
      return null;
    }
  }

  async function getSessionDetailWithTranslationHistory(sessionId) {
    const [sessionDetail, translationHistory] = await Promise.all([
      sessionReadApiClientRef.current.getSessionDetail(sessionId),
      sessionReadApiClientRef.current.getSessionTranslations(sessionId)
    ]);
    return mergeRetranslationHistoryIntoDetail(sessionDetail, translationHistory);
  }

  async function loadMeetingResumeDraft(meetingId) {
    if (sessionRef.current || activeSessionRecordIdRef.current || runtimeMeetingIdsRef.current.has(meetingId)) {
      return;
    }

    const requestId = meetingResumeDraftRequestIdRef.current + 1;
    meetingResumeDraftRequestIdRef.current = requestId;

    try {
      setMeetingCheckpointStatus('syncing');
      const result = await meetingCheckpointApiClientRef.current.listSegments({ meetingId });
      if (meetingResumeDraftRequestIdRef.current !== requestId) {
        return;
      }

      const segments = [...result.segments].sort((left, right) => left.sequence - right.sequence);
      const resumableSegment = [...segments].reverse().find((segment) => ['active', 'created'].includes(segment.status));
      if (!resumableSegment) {
        setResumeDraft(null);
        setMeetingCheckpointStatus('idle');
        return;
      }

      const checkpoints = await Promise.all(segments.map((segment) => (
        meetingCheckpointApiClientRef.current
          .getCheckpoint({ meetingId, segmentId: segment.id })
          .catch(() => null)
      )));
      if (meetingResumeDraftRequestIdRef.current !== requestId) {
        return;
      }

      const chunks = checkpoints.flatMap((checkpointResult) => (
        checkpointResult?.checkpoint?.durableChunks || []
      ));
      const persistedCues = checkpoints.flatMap((checkpointResult) => (
        checkpointResult?.checkpoint?.finalCues || []
      )).filter((cue) => cue?.status === 'final').sort((left, right) => left.sequence - right.sequence);
      const refinedSubtitleCues = checkpoints.flatMap((checkpointResult) => (
        checkpointResult?.checkpoint?.refinedSubtitleCues || []
      )).filter((cue) => cue?.status === 'final').sort((left, right) => left.startTimeMs - right.startTimeMs);
      const latestCueCheckpoint = [...checkpoints].reverse().map((result) => result?.checkpoint?.cueCheckpoint).find(Boolean);
      if (persistedCues.length > 0 || latestCueCheckpoint) {
        const restoredCueState = createSubtitleCueState({
          ...(latestCueCheckpoint || {}),
          finalCues: persistedCues,
          refinedSubtitleCues,
          nextSequence: Math.max(latestCueCheckpoint?.nextSequence || 1, (persistedCues.at(-1)?.sequence || 0) + 1)
        });
        const restoredFinalCues = markCuesCompletedByRefinedSubtitleCues(
          restoredCueState.finalCues,
          restoredCueState.refinedSubtitleCues
        );
        const restoredState = restoredFinalCues === restoredCueState.finalCues
          ? restoredCueState
          : { ...restoredCueState, finalCues: restoredFinalCues };
        subtitleCueStateRef.current = restoredState;
        setSubtitleCueState(restoredState);
      }
      const resumeTranscript = transcriptStateFromCheckpointChunks(chunks);
      const archivedSegments = transcriptSegmentsFromCheckpoints({ segments, checkpoints });
      archivedTranscriptSegmentsRef.current = archivedSegments;
      const archivedResumeTranscript = archivedTranscriptFromSegments(archivedTranscriptSegmentsRef.current, resumeTranscript.nextSequence);
      archivedTranscriptRef.current = archivedResumeTranscript;
      setArchivedTranscript(() => archivedResumeTranscript);
      resetActiveTranscriptForNextSegment(resumeTranscript.nextSequence);
      setTranscriptTimeOriginValue();
      setCopiedArticleStream('');
      activeMeetingCheckpointRef.current = {
        meetingId,
        segmentId: resumableSegment.id
      };
      setResumeDraft({
        sessionId: (await sessionReadApiClientRef.current.listSessionHistory().catch(() => []))
          .find((record) => record.meetingId === meetingId && ['active', 'paused'].includes(record.status))?.id || null,
        meetingId,
        segmentId: resumableSegment.id,
        transcriptState: resumeTranscript,
        hasTranscript: transcriptHasFinalItems(resumeTranscript) > 0
      });
      setMeetingViewStats({
        archivedSegmentCount: Math.max(0, segments.length - 1),
        loadedSegmentCount: archivedTranscriptSegmentsRef.current.length
      });
      setMeetingCheckpointStatus('synced');
      setStatus('idle');
      setError('');
    } catch {
      if (meetingResumeDraftRequestIdRef.current !== requestId) {
        return;
      }

      setResumeDraft(null);
      setMeetingCheckpointStatus('error');
      setError('無法載入長會議續錄資料。');
    }
  }

  function translationCommandLifecycle() {
    if (!translationCommandLifecycleRef.current) {
      translationCommandLifecycleRef.current = createTranslationCommandLifecycle({
        translationCommandApiClient: createTranslationCommandApiClient(),
        onError: reportTranslationCommandError
      });
    }

    return translationCommandLifecycleRef.current;
  }

  function reportTranslationCommandError(error, context) {
    console.error('Translation command persistence failed.', error);
    setError(formatTranslationCommandPersistenceError(error, context));
  }

  async function loadMeetingDetail(id) {
    const requestId = meetingDetailRequestIdRef.current + 1;
    meetingDetailRequestIdRef.current = requestId;
    selectedMeetingIdRef.current = id;
    setSelectedMeetingId(id);
    setMeetingDetailError('');
    const cachedDetail = meetingDetailCacheRef.current.get(id);
    setSelectedMeetingDetail(cachedDetail || undefined);

    if (cachedDetail) {
      return;
    }

    try {
      const detail = await meetingReadApiClientRef.current.getMeetingDetail(id);

      if (meetingDetailRequestIdRef.current !== requestId || selectedMeetingIdRef.current !== id) {
        return;
      }

      if (detail) {
        meetingDetailCacheRef.current.set(id, detail);
      } else {
        meetingDetailCacheRef.current.delete(id);
      }
      setSelectedMeetingDetail(detail);
    } catch {
      if (meetingDetailRequestIdRef.current !== requestId || selectedMeetingIdRef.current !== id) {
        return;
      }

      setSelectedMeetingDetail(null);
      setMeetingDetailError('會議詳細資料載入失敗。請重試。');
    }
  }

  function openMeetingDetail(id, sourcePage = page) {
    if (!id) return;

    const from = sourcePage === 'meetings' ? 'meetings' : 'history';
    void loadMeetingDetail(id);
    window.location.hash = `#meeting-detail?meetingId=${encodeURIComponent(id)}&from=${from}`;
  }

  async function refreshSelectedMeetingDetail(id) {
    if (!id || selectedMeetingIdRef.current !== id) {
      return false;
    }

    const requestId = meetingDetailRequestIdRef.current + 1;
    meetingDetailRequestIdRef.current = requestId;

    try {
      const detail = await meetingReadApiClientRef.current.getMeetingDetail(id);

      if (meetingDetailRequestIdRef.current !== requestId || selectedMeetingIdRef.current !== id) {
        return false;
      }

      if (detail) {
        meetingDetailCacheRef.current.set(id, detail);
      } else {
        meetingDetailCacheRef.current.delete(id);
      }
      setSelectedMeetingDetail(detail);
      return true;
    } catch {
      if (meetingDetailRequestIdRef.current === requestId && selectedMeetingIdRef.current === id) {
        setMeetingDetailError('會議詳細資料無法更新。');
      }

      return false;
    }
  }

  function closeMeetingDetail() {
    meetingDetailRequestIdRef.current += 1;
    selectedMeetingIdRef.current = null;
    setSelectedMeetingId(null);
    setSelectedMeetingDetail(null);
    setMeetingDetailError('');
  }

  function returnFromMeetingDetail() {
    const returnPage = meetingDetailReturnPage();
    closeMeetingDetail();
    window.location.hash = `#${returnPage}`;
  }

  function selectedInputDeviceSnapshot() {
    const selectedDevice = inputDevices.find((device) => device.deviceId === selectedInputDeviceId);

    return {
      selectedInputDeviceId: selectedDevice?.deviceId || '',
      inputDeviceLabelSnapshot: selectedDevice?.label || null
    };
  }

  async function resetLiveMeetingState() {
    invalidateLiveSessionCallbacks();
    meetingDetailRequestIdRef.current += 1;
    selectedMeetingIdRef.current = null;
    setSelectedMeetingId(null);
    setSelectedMeetingDetail(null);
    setMeetingDetailError('');
    liveController.recovery.reconnectController().cancel();
    liveController.segmentSwitch.cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
    meetingResumeDraftRequestIdRef.current += 1;
    cancelLiveCueIdleTimers();
    liveController.audio.cancelAudioUploadRetries();
    await Promise.resolve(liveController.audio.cleanup()).catch(() => {});

    const resetTranscript = resetTranscriptState();
    transcriptRef.current = resetTranscript;
    setTranscript(resetTranscript);
    const resetCues = resetSubtitleCueState();
    subtitleCueStateRef.current = resetCues;
    setSubtitleCueState(resetCues);
    const resetArchivedTranscript = resetTranscriptState();
    archivedTranscriptRef.current = resetArchivedTranscript;
    archivedTranscriptSegmentsRef.current = [];
    setArchivedTranscript(resetArchivedTranscript);
    transcriptTimeOriginRef.current = null;
    setTranscriptTimeOrigin(null);
    setPolishingState({ status: 'idle', text: '', version: null, updatedAt: null, error: '' });
    setPolishedArticle({ text: '', items: [], version: null, updatedAt: null });
    transcriptPolishingLifecycleRef.current?.reset(polishingSessionIdRef.current);
    transcriptPolishingCoordinatorRef.current?.reset();
    polishingSessionIdRef.current = null;
    liveController.audio.resetInputAudioDownload();
    liveController.audio.resetTranslatedAudioDownload();
    setRecordingState(shouldRecordInputAudio ? { status: 'idle', blob: null, mimeType: '', extension: '', fileName: '', errorMessage: '' } : INPUT_AUDIO_RECORDING_SKIPPED_STATE);
    pendingMicrophoneStreamRef.current = null;
    activeMeetingCheckpointRef.current = null;
    runtimeMeetingIdsRef.current.clear();
    setResumeDraft(null);
    setMeetingCheckpointStatus('idle');
    setMeetingViewStats({ archivedSegmentCount: 0, loadedSegmentCount: 0 });
    setCopiedArticleStream('');
    setError('');
    setNavigationNotice('');
    setStatusLabelOverride('');
    setStatus('idle');
    activeSessionRecordIdRef.current = null;
    setHasSessionControl(false);
  }

  async function openMeetingLiveWorkspace(meetingId) {
    if (!meetingId) return;

    if (isNavigationLocked) {
      setError('錄音進行中，請先結束目前工作階段後再切換目錄。');
      return;
    }

    await resetLiveMeetingState();
    window.location.hash = `#live?meetingId=${encodeURIComponent(meetingId)}`;
  }

  function selectLiveTranslationMode(value) {
    const meetingId = value.replace(/^meeting:/, '');
    if (!meetingId || isNavigationLocked) return;
    if (pageInfoFromLocation().meetingId) {
      void resetLiveMeetingState();
    }
    window.location.hash = `live?meetingId=${encodeURIComponent(meetingId)}`;
  }

  function redirectToMeetingWithError() {
    setError('');
    setNavigationNotice(INVALID_MEETING_ROUTE_MESSAGE);
    if (pageFromLocation() !== 'meetings') window.location.hash = '#meetings';
  }

  function updateLiveMeetingUrl(meetingId) {
    if (!meetingId || pageFromLocation() !== 'live') return;
    runtimeMeetingIdsRef.current.add(meetingId);
    window.history.replaceState(null, '', `#live?meetingId=${encodeURIComponent(meetingId)}`);
  }

  async function copyLiveSource() {
    const sourceText = sourceTextForCopy(subtitleCueState.finalCues);
    if (!sourceText) return;

    try {
      await navigator.clipboard.writeText(sourceText);
      setCopiedArticleStream('source');
      window.setTimeout(() => setCopiedArticleStream((current) => current === 'source' ? '' : current), 1500);
    } catch {
      setError('無法複製原文。');
    }
  }

  async function copyLiveTranslation() {
    const translationText = translationTextForCopy(subtitleCueState.finalCues);
    if (!translationText) return;

    try {
      await navigator.clipboard.writeText(translationText);
      setCopiedArticleStream('translation');
      window.setTimeout(() => setCopiedArticleStream((current) => current === 'translation' ? '' : current), 1500);
    } catch {
      setError('無法複製翻譯。');
    }
  }

  const hasSelectedResumableMeeting = meetingRecords.some((meeting) => meeting.id === routeMeetingId && ['created', 'active', 'interrupted'].includes(meeting.status));
  const liveMeeting = selectedMeetingDetail?.meeting || meetingRecords.find((meeting) => meeting.id === routeMeetingId) || null;
  const views = {
    viewer: () => {
      const viewerInfo = pageInfoFromLocation();
      return <MeetingViewerPage token={viewerInfo.shareToken} code={viewerInfo.shareCode} />;
    },
    meetingSettings: () => {
      const settingsInfo = pageInfoFromLocation();
      return (
      <MeetingSettingsLayout
        mode={settingsInfo.settingsMode}
        onBack={() => { window.location.hash = '#meetings'; }}
      >
        <MeetingSettingsPage
          mode={settingsInfo.settingsMode}
          meetingId={settingsInfo.meetingId}
          onBack={() => { window.location.hash = '#meetings'; }}
          onOpenLive={openMeetingLiveWorkspace}
        />
      </MeetingSettingsLayout>
      );
    },
  };

  const workspaceView = () => {
    const isMeetingManagementPage = page === 'meetings';
    const isGlobalGlossaryPage = page === 'glossary';
    const isMeetingDetailPage = page === 'meeting-detail';
    const usesMeetingManagementShell = isMeetingManagementPage || isGlobalGlossaryPage || isLiveSurface;

    return (
    <WorkspacePage
      managementShell={usesMeetingManagementShell}
      className={isLiveSurface ? 'live-recording-app-shell' : isMeetingDetailPage ? 'meeting-detail-app-shell' : ''}
      title={isMeetingManagementPage ? '會議管理' : isGlobalGlossaryPage ? '全域字典' : isMeetingDetailPage ? '會議紀錄' : '即時字幕'}
      titleId={isMeetingManagementPage ? 'meeting-management-title' : isGlobalGlossaryPage ? 'glossary-page-title' : isMeetingDetailPage ? 'meeting-detail-page-title' : undefined}
      subtitle={isMeetingManagementPage ? '先建立會議並完成設定，再分享給參與者錄音。' : isGlobalGlossaryPage ? '管理所有會議室都可以查看並選擇的共用詞條。' : isMeetingDetailPage ? '查看這場會議的完整時間軸、逐字稿與匯出內容。' : '會議字幕工作台'}
      headerAction={isGlobalGlossaryPage || isLiveSurface || isMeetingDetailPage ? (
        <a
          className="button secondary meeting-header-action"
          href="#meetings"
          onClick={isLiveSurface ? (event) => {
            event.preventDefault();
            setError('');
            window.location.hash = '#meetings';
          } : undefined}
        >
          <ArrowRight size={18} aria-hidden="true" />
          返回會議管理
        </a>
      ) : (
        <button className="button primary meeting-create-header-button" type="button" onClick={() => { window.location.hash = '#meeting-settings?mode=create'; }} disabled={isNavigationLocked}>
          <Plus size={18} aria-hidden="true" />
          建立會議
        </button>
      )}
    >

      {page === 'meetings' && navigationNotice ? <p className="error-message" role="alert">{navigationNotice}</p> : null}
      {error && !isLiveSurface ? <p className="error-message" role="alert">{error}</p> : null}

      {isMeetingManagementPage ? <MeetingManagementPage
        onOpenLive={openMeetingLiveWorkspace}
        onOpenHistory={(meetingId) => openMeetingDetail(meetingId, 'meetings')}
        initialStatusFilter={workspaceInfo.statusFilter}
        initialPanel={workspaceInfo.panel}
        initialCreate={false}
        onOpenSettings={(meetingId) => { window.location.hash = `#meeting-settings?mode=edit&meetingId=${encodeURIComponent(meetingId)}`; }}
      /> : null}
      {page === 'meeting-detail' ? <MeetingDetailPage
        detail={selectedMeetingDetail}
        detailError={meetingDetailError}
        returnPage={meetingDetailReturnPage()}
        onBack={returnFromMeetingDetail}
        onRetry={() => refreshSelectedMeetingDetail(routeMeetingId)}
      /> : null}
      {isLiveSurface ? <LiveRecordingPage
        error={liveController.error || meetingDetailError}
        status={meetingDetailError ? 'error' : liveController.status}
        onRetry={() => {
          if (meetingDetailError) {
            void loadMeetingDetail(routeMeetingId);
            return;
          }
          setError('');
          void (liveController.resumeDraft?.hasTranscript
            ? liveController.actions.resumeMeetingSession()
            : liveController.actions.startSession());
        }}
      >
        <div className="live-workspace-stack">
        <div className="live-session-toolbar meeting-settings-card" data-testid="live-session-toolbar">
          <div className="control-status-row">
            <div className="live-meeting-summary-column">
              <div className="live-meeting-summary">
                <div className="live-meeting-summary-main">
                  <p className="eyebrow">MEETING CONTROL</p>
                  <h2>{liveMeeting?.name || (routeMeetingId ? '正在載入會議…' : '尚未選擇會議')}</h2>
                  <p className="live-meeting-language">{liveMeeting ? `來源語言：${targetLanguageLabelFor(liveMeeting.sourceLanguageCode) || liveMeeting.sourceLanguageCode}` : '請先選擇一場可錄音的會議'}</p>
                </div>
                <span className="live-meeting-status status-pill">{liveMeetingStatusLabel(liveMeeting)}</span>
              </div>
              {!routeMeetingId ? <LiveMeetingPicker meetings={meetingRecords} selectedMeetingId="" disabled={controlsLocked} onChange={(meetingId) => selectLiveTranslationMode(`meeting:${meetingId}`)} /> : null}
            </div>

            <div className="live-session-status">
              {controlLeaseSnapshot && !hasSessionControl ? (
                <p className="device-note">目前已有工作階段由其他頁籤控制；本頁面只能唯讀查看。</p>
              ) : null}
              {liveController.status === 'reconnecting' ? <p className="device-note">正在重新連線即時字幕…</p> : null}
              {liveController.status === 'switching-segment' ? <p className="device-note">正在切換下一段即時字幕…</p> : null}
              {liveController.status === 'paused' ? (
                <p className="device-note">
                  {shouldRecordInputAudio
                    ? '工作階段已暫停；字幕與本機錄音片段會保留到結束本次工作階段。'
                    : '工作階段已暫停；字幕會保留到結束本次工作階段。'}
                </p>
              ) : null}
              {deviceMessage ? <p className="device-note">{deviceMessage}</p> : null}
              <p
                className={`checkpoint-note checkpoint-note-${meetingCheckpointStatus}`}
                role={hasAudioStatusError({
                  shouldRecordInputAudio,
                  recordingState,
                  translatedAudioState
                }) ? 'alert' : undefined}
              >
                {composeCheckpointStatusMessage({
                  meetingCheckpointStatus,
                  shouldRecordInputAudio,
                  recordingState,
                  translatedAudioState
                }).map((message, index) => (
                  <React.Fragment key={`${message}-${index}`}>
                    {index > 0 ? <br /> : null}
                    {message}
                  </React.Fragment>
                ))}
              </p>
              {meetingViewStats.archivedSegmentCount > 0 ? (
                <p className="checkpoint-note">
                  保存狀態：長會議已保存 {meetingViewStats.archivedSegmentCount} 段 · 目前段落 {activeSegmentTranscriptCount(transcript)} 筆
                </p>
              ) : null}
            </div>

            <div className="control-actions">
              <div className="session-actions">
              {liveController.status === 'listening' ? (
                  <>
                    <button className="button secondary" type="button" onClick={liveController.actions.pauseSession}>
                      <Pause size={18} aria-hidden="true" />
                      暫停
                    </button>
                    <button className="button secondary" type="button" onClick={liveController.actions.endCurrentSession}>
                      <Square size={18} aria-hidden="true" />
                      結束本次工作階段
                    </button>
                  </>
                ) : liveController.status === 'reconnecting' || liveController.status === 'switching-segment' ? (
                  <button className="button secondary" type="button" onClick={liveController.actions.endCurrentSession}>
                    <Square size={18} aria-hidden="true" />
                    結束本次工作階段
                  </button>
                ) : liveController.status === 'paused' ? (
                  <>
                    <button className="button primary" type="button" onClick={liveController.actions.continuePausedSession}>
                      <Play size={18} aria-hidden="true" />
                      繼續
                    </button>
                    <button className="button secondary" type="button" onClick={liveController.actions.endCurrentSession}>
                      <Square size={18} aria-hidden="true" />
                      結束本次工作階段
                    </button>
                  </>
                ) : hasSelectedResumableMeeting || (routeMeetingId && resumeDraft?.meetingId === routeMeetingId && resumeDraft?.hasTranscript) ? (
                  <button
                    className="button primary meeting-live-action-button"
                    type="button"
                    onClick={liveController.resumeDraft?.hasTranscript ? liveController.actions.resumeMeetingSession : liveController.actions.startSession}
                    disabled={isActive || Boolean(controlLeaseSnapshot && !hasSessionControl) || !hasSelectedResumableMeeting}
                  >
                    {liveController.isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                    {liveController.isActive ? '正在開始' : liveController.resumeDraft?.hasTranscript ? '繼續錄製' : '開始'}
                  </button>
                ) : null}
                {routeMeetingId && liveController.resumeDraft?.meetingId === routeMeetingId && !liveController.isActive && liveController.status === 'idle' ? (
                  <button className="button secondary meeting-live-action-button" type="button" onClick={liveController.actions.completeResumableMeeting}>
                    結束會議
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="live-transcript-column">
        <LiveCuePanelView
          cueState={liveController.subtitleCueState}
          fallbackTranscriptItems={unrepresentedTranscriptItems({
            archivedTranscript: liveController.archivedTranscript,
            transcript: liveController.transcript,
            cues: liveController.subtitleCueState.finalCues
          })}
          status={liveController.status}
          statusLabelOverride={liveController.statusLabelOverride}
          isPaused={liveController.status === 'paused'}
          isStopped={liveController.status === 'stopped'}
          copiedSource={copiedArticleStream === 'source'}
          onCopySource={liveController.actions.copyLiveSource}
        />
        </div>
        </div>
      </LiveRecordingPage> : null}

      {page === 'glossary' ? (
      <GlobalGlossaryPage
        entries={glossaryEntries}
        onEntriesChange={setGlossaryEntries}
      >
        <GlobalGlossaryPanel
          entries={glossaryEntries}
          onEntriesChange={setGlossaryEntries}
          categories={glossaryCategories}
          onCategoriesChange={setGlossaryCategories}
        />
      </GlobalGlossaryPage>
      ) : null}
    </WorkspacePage>
    );
  };

  return <AppRouter page={page} views={{ ...views, workspace: workspaceView }} />;
}
