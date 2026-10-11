import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, Maximize2, Mic, MicOff, Minimize2, Pause, Pencil, Play, Plus, Square } from 'lucide-react';
import { targetLanguageLabelFor } from '../lib/languages.js';
import { failureUiStateForClassification } from '../lib/failureUiState.js';
import { audioInputDevices, audioOutputDevices, requestAudioInputStream } from '../lib/mediaDevices.js';
import { createMemorySessionRepository } from '../lib/sessionRepository.js';
import { createSessionReadApiClient, isSessionReadCloudUnavailable, readSessionDetailWithTranslationHistory } from '../lib/sessionReadApiClient.js';
import { createSessionControlLease } from '../lib/sessionControlLease.js';
import { createMeetingReadApiClient } from '../lib/meetingReadApiClient.js';
import { meetingApiErrorMessage } from '../lib/meetingApiError.js';
import { createSessionSnapshotApiClient } from '../lib/sessionSnapshotApiClient.js';
import { createSessionCommandApiClient } from '../lib/sessionCommandApiClient.js';
import { createMeetingCheckpointApiClient } from '../lib/meetingCheckpointApiClient.js';
import { createMeetingCueApiClient } from '../lib/meetingCueApiClient.js';
import { createCloudSaveCoordinator } from '../lib/cloudSaveCoordinator.js';
import { createLocalMeetingPersistence } from '../lib/localMeetingPersistence.js';
import { createLocalMeetingRetention } from '../lib/localMeetingRetention.js';
import { mergeMeetingDetailWithLocalCues, persistFinalMeetingCues } from '../lib/meetingLocalTranscript.js';
import { createTranslationCommandApiClient } from '../lib/translationCommandApiClient.js';
import { createGlossaryApiClient } from '../lib/glossaryApiClient.js';
import { applyGlossaryCorrectionToCue } from '../lib/glossaryReplacement.js';
import { effectiveGlossaryRevision } from '../lib/glossaryRevision.js';
import { createCorrectionGlossaryRegistry } from '../lib/correctionGlossarySnapshot.js';
import { hasLiveCredential, subscribeToLiveCredentialClear } from '../lib/liveCredentialHolder.js';
import { stopSessionSafely } from '../lib/stopSessionSafely.js';
import { effectiveMeetingGlossaryEntries, selectedMeetingGlossaryEntries } from '../lib/meetingGlossary.js';
import { completeMeetingAfterRecordingFinalize } from '../features/live/useLiveRecordingController.js';
import { authenticatedFetch } from '../lib/accessToken.js';
import { userMessageForErrorCode, withHttpStatus } from '../lib/connectionFailures.js';
import { createTranslationCommandLifecycle } from '../lib/translationCommandLifecycle.js';
import { formatTranslationCommandPersistenceError } from '../lib/translationCommandError.js';
import { createTranscriptPolishingLifecycle } from '../lib/transcriptPolishingLifecycle.js';
import { createCueRefinementCoordinator, mergePolishedItemsFromOutputs } from '../lib/transcriptPolishing.js';
import { applyCueRefinementExecutionStates, markCuesCompletedByRefinedSubtitleCues, mergeCuesByIdPreferRefinement, refinedSubtitleCuesForDisplay } from '../lib/cueRefinement.js';
import { effectiveTranslationForCue, rawSourceForCue, rawTranslationForCue } from '../lib/cueContent.js';
import { liveCueLatencyTracker } from '../lib/liveCueLatency.js';
import { configureLivePipelineElapsedContext, recordLivePipelineTrace } from '../lib/livePipelineTrace.js';
import { attachClientDiagnosticLifecycle } from '../lib/clientDiagnostics.js';
import { waitForDurabilityPromises } from '../lib/durabilityBarrier.js';
import {
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
import { canonicalHashForLocation, pageFromLocation, pageInfoFromLocation } from './routes.js';
import { AppRouter } from './AppRouter.jsx';
import { MeetingSettingsLayout } from '../layouts/AppLayout.jsx';
import { MeetingSettingsPage } from '../pages/meetings/MeetingSettingsPage.jsx';
import { GeminiCredentialPage } from '../pages/settings/GeminiCredentialPage.jsx';
import { AccountManagementPage } from '../pages/settings/AccountManagementPage.jsx';
import { AuditLogPage } from '../pages/settings/AuditLogPage.jsx';
import { MeetingViewerPage } from '../pages/viewer/MeetingViewerPage.jsx';
import { MeetingElapsedTimer } from '../features/live/MeetingElapsedTimer.jsx';
import { GlobalGlossaryPage } from '../pages/glossary/GlobalGlossaryPage.jsx';
import { LiveMeetingPicker, LiveRecordingPage } from '../pages/live/LiveRecordingPage.jsx';
import { DiagnosticExportButton } from '../components/DiagnosticExportButton.jsx';
import { LiveCuePanel as LiveCuePanelView } from '../features/live/LiveCuePanel.jsx';
import { applyCompletedRefinementOutputs } from '../features/live/liveRecordingController.js';
import { WorkspacePage } from '../features/workspace/WorkspacePage.jsx';
import { MeetingDetailPage, MeetingManagementPage } from '../features/meetings/index.js';
import { GlobalGlossaryPanel } from '../features/glossary/index.js';
import { activeSegmentTranscriptCount, archivedTranscriptFromSegments, completedPolishingOutputs, emptyTranscriptStateWithNextSequence, latestPolishingExecution, latestPolishingOutput, logTranscriptSegmentDecision, rawCuesFromDetail, reconnectErrorMessage, safeReconnectDiagnostic, transcriptHasFinalItems, transcriptSegmentsFromCheckpoints, transcriptStateFromCheckpointChunks, unrepresentedTranscriptItems } from '../features/live/liveTranscriptRecovery.js';
import { createAudioUploadSegmentState } from '../features/live/liveAudioBindings.js';
import { finalizedTranscriptItemsForRecording, recordCueTransitionTrace, useLiveRecordingController } from '../features/live/useLiveRecordingController.js';
import { useWebRtcDeviceSidecar, webRtcConnectionLabel } from '../webrtc/useWebRtcDeviceSidecar.js';
import { classifyFailureSignal, composeCheckpointStatusMessage, hasAudioStatusError, isLiveMeetingStartReady, liveMeetingStatusLabel, meetingCheckpointErrorMessageFor, meetingCheckpointStatusLabel } from '../features/live/liveStatus.js';
import { LiveTranslateSession } from '../lib/liveSession.js';
import { createRecordingDiagnostics } from '../lib/recordingDiagnostics.js';
import { getMeetingAudioPreference, hasConfirmedMeetingAudioPreference } from '../lib/meetingAudioPreferences.js';

const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const LIVE_DIAGNOSTICS_ENABLED = Boolean(import.meta.env?.DEV || (typeof __LIVE_TRANSLATE_DIAGNOSTICS__ !== 'undefined' && __LIVE_TRANSLATE_DIAGNOSTICS__));
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

function mergeMeetingDetailWithLocalAudio(detail, localArtifacts = [], localAudioStatus = 'idle') {
  if (!detail) return detail;
  const input = localArtifacts.find((artifact) => artifact?.kind === 'input');
  const displayStatus = !input && localAudioStatus === 'idle' && detail.meeting?.shouldRecordInputAudio === false
    ? 'disabled'
    : localAudioStatus;
  if (!input && !['processing', 'disabled'].includes(displayStatus)) return detail;
  return {
    ...detail,
    audioArtifacts: {
      ...(detail.audioArtifacts || {}),
      input: input
        ? { ...(detail.audioArtifacts?.input || {}), ...input, status: 'ready' }
        : { ...(detail.audioArtifacts?.input || {}), kind: 'input', status: displayStatus }
    }
  };
}

export function App() {
  const [page, setPage] = useState(pageFromLocation);
  const [locationVersion, setLocationVersion] = useState(0);
  const [status, setStatus] = useState('idle');
  const [hasSessionControl, setHasSessionControl] = useState(false);
  const [controlLeaseSnapshot, setControlLeaseSnapshot] = useState(null);
  const [statusLabelOverride, setStatusLabelOverride] = useState('');
  const [isLiveFocusMode, setIsLiveFocusMode] = useState(false);
  const [isLiveStatusDetailsOpen, setIsLiveStatusDetailsOpen] = useState(false);
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
  const [outputDevices, setOutputDevices] = useState([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState('');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [error, setError] = useState('');
  const [liveErrorCode, setLiveErrorCode] = useState('');
  const [navigationNotice, setNavigationNotice] = useState('');
  const [meetingRecords, setMeetingRecords] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [selectedMeetingDetail, setSelectedMeetingDetail] = useState(null);
  const [meetingDetailError, setMeetingDetailError] = useState('');
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [glossaryCategories, setGlossaryCategories] = useState([]);
  const [selectedMeetingGlossaryIds, setSelectedMeetingGlossaryIds] = useState([]);
  const [privateMeetingGlossaryEntries, setPrivateMeetingGlossaryEntries] = useState([]);
  const [correctionGlossaryStatus, setCorrectionGlossaryStatus] = useState('idle');
  const correctionGlossaryRegistryRef = useRef(createCorrectionGlossaryRegistry());
  const correctionGlossaryRefreshGenerationRef = useRef(0);
  const [meetingCheckpointStatus, setMeetingCheckpointStatus] = useState('idle');
  const [segmentRolloverStatus, setSegmentRolloverStatus] = useState('idle');
  const [meetingCheckpointErrorMessage, setMeetingCheckpointErrorMessage] = useState('');
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
  const [isStartingLiveRecording, setIsStartingLiveRecording] = useState(false);
  const endMeetingOperationRef = useRef(null);
  const sessionRef = useRef(null);
  const startLiveRecordingInFlightRef = useRef(false);
  const sessionSnapshotCloudErrorSessionsRef = useRef(new Set());
  const sessionReadCloudErrorSessionsRef = useRef(new Set());
  const pendingMicrophoneStreamRef = useRef(null);
  const liveSessionCallbackGenerationRef = useRef({ generation: 0, active: false });
  const inputAudioUploadChunksRef = useRef([]);
  const inputAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const translatedAudioUploadChunksRef = useRef([]);
  const translatedAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const audioUploadSegmentsRef = useRef(createAudioUploadSegmentState());
  const audioUploadRetryTimersRef = useRef({ input: null, translation: null });
  const audioUploadRetryAttemptsRef = useRef({ input: 0, translation: 0 });
  const meetingCuePublishQueuesRef = useRef(new Map());
  const cloudSaveCoordinatorRef = useRef(null);
  if (!cloudSaveCoordinatorRef.current) {
    cloudSaveCoordinatorRef.current = createCloudSaveCoordinator({
      onChange: applyCloudSaveSnapshot
    });
  }
  const recordingDiagnosticsRef = useRef(createRecordingDiagnostics({ enabled: LIVE_DIAGNOSTICS_ENABLED }));
  useEffect(() => {
    if (!LIVE_DIAGNOSTICS_ENABLED || typeof window === 'undefined') return undefined;
    const debugApi = {
      getSnapshot: () => recordingDiagnosticsRef.current.snapshot(),
      reset: () => recordingDiagnosticsRef.current.reset()
    };
    window.__liveTranslateRecordingDebug = debugApi;
    return () => {
      if (window.__liveTranslateRecordingDebug === debugApi) delete window.__liveTranslateRecordingDebug;
      recordingDiagnosticsRef.current.destroy();
    };
  }, []);
  const transcriptRef = useRef(transcript);
  const subtitleCueStateRef = useRef(subtitleCueState);
  const transcriptTimeOriginRef = useRef(null);
  const archivedTranscriptRef = useRef(archivedTranscript);
  const archivedTranscriptSegmentsRef = useRef([]);
  const inputDevicesRef = useRef(inputDevices);
  const selectedInputDeviceIdRef = useRef(selectedInputDeviceId);
  const selectedOutputDeviceIdRef = useRef(selectedOutputDeviceId);
  const reconnectSessionRef = useRef(null);
  const sessionRepositoryRef = useRef(createMemorySessionRepository());
  const sessionSnapshotApiClientRef = useRef(createSessionSnapshotApiClient());
  const sessionCommandApiClientRef = useRef(createSessionCommandApiClient());
  const pendingSessionSnapshotItemIdsRef = useRef(new Map());
  const meetingCheckpointApiClientRef = useRef(createMeetingCheckpointApiClient());
  const meetingCueApiClientRef = useRef(createMeetingCueApiClient({ fetchImpl: authenticatedFetch(fetch) }));
const localMeetingPersistenceRef = useRef(null);
const localMeetingRetentionRef = useRef(null);
  const localMeetingCuePersistenceQueueRef = useRef(Promise.resolve());
const meetingRecordsRequestRef = useRef(null);
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
  const handledLiveFailureGenerationsRef = useRef(new Set());
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
  const statusRef = useRef(status);
  const previousSessionStatusRef = useRef(status);
  const lastSafeHashRef = useRef(canonicalHashForLocation());
  const pendingForcedNavigationHashRef = useRef(null);
  const forcedNavigationStopPromiseRef = useRef(null);
  statusRef.current = status;

  const routeMeetingId = pageInfoFromLocation().meetingId;
  const workspaceInfo = pageInfoFromLocation();
  const isLiveSurface = page === 'live-recording';

  useEffect(() => {
    if (previousSessionStatusRef.current === status) return;
    recordLivePipelineTrace({
      stage: 'SESSION_STATE_CHANGED',
      ...currentLiveTraceIdentity(),
      recorderEpoch: liveSessionCallbackGenerationRef.current.generation,
      eventType: `${previousSessionStatusRef.current}->${status}`,
      realtimeState: status,
      recordingState: status
    });
    previousSessionStatusRef.current = status;
  }, [routeMeetingId, status]);

  useEffect(() => {
    if (!isLiveSurface) return undefined;
    return attachClientDiagnosticLifecycle({
      role: 'recorder',
      getContext: () => ({
        ...currentLiveTraceIdentity(),
        generation: liveSessionCallbackGenerationRef.current.generation,
        recordingState: statusRef.current
      })
    });
  }, [isLiveSurface, routeMeetingId]);

  useEffect(() => {
    setIsLiveFocusMode(false);
    setIsLiveStatusDetailsOpen(false);
  }, [isLiveSurface, routeMeetingId]);

  const isActive =
    status === 'requesting-permission' ||
    status === 'connecting' ||
    status === 'listening' ||
    status === 'reconnecting' ||
    status === 'switching-segment' ||
    status === 'stopping';
  const controlsLocked = isActive || status === 'paused' || meetingCheckpointStatus === 'ending' || Boolean(controlLeaseSnapshot && !hasSessionControl);
  const isNavigationLocked = isActive;
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
      recordingDiagnostics: recordingDiagnosticsRef.current,
      getLocalMeetingPersistence,
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
      getLiveGlossaryEntries: () => correctionGlossaryRegistryRef.current.active()?.entries || [],
      getGlossaryEntriesForCue: (cue) => correctionGlossaryRegistryRef.current
        .entriesForRevision(cue?.correctionGlossaryRevision),
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
      getLocalMeetingPersistence,
      cloudSaveCoordinator: cloudSaveCoordinatorRef.current,
      setMeetingCheckpointStatus,
      clearCheckpointError: clearMeetingCheckpointError,
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
      reconnectController: () => liveController.recovery.reconnectController(),
      resetReconnect: () => liveController.recovery.reconnectController().reset(),
      activeMeetingCheckpointRef,
      sessionRef,
      segmentSwitchCancelledRef,
      sessionStopRequestedRef,
      flushMeetingCuePublishes,
      suppressReconnectErrorRef,
      meetingCheckpointApiClientRef,
      setResumeDraft,
      getTranscriptState: () => transcriptRef.current,
      findActiveMeetingSessionId: async (meetingId) => (await sessionReadApiClientRef.current.listSessionHistory().catch(() => []))
        .find((record) => record.meetingId === meetingId && ['active', 'paused'].includes(record.status))?.id || null,
      setError,
      setMeetingCheckpointStatus,
      setMeetingCheckpointErrorMessage,
      setStatusLabelOverride,
      setStatus,
      invalidateLiveSessionCallbacks,
      suspendLiveSessionCallbacks,
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
      onStatusChange: (nextStatus, details = {}) => {
        if (nextStatus === 'scheduled') {
          recordLivePipelineTrace({
            stage: 'ROLLOVER_SCHEDULED',
            ...currentLiveTraceIdentity(),
            rolloverGeneration: details.rolloverGeneration,
            durationMs: details.delayMs,
            reason: 'segment_interval'
          });
        }
        if (nextStatus === 'switching') {
          setSegmentRolloverStatus('switching');
          setMeetingCheckpointStatus('switching');
        }
        if (nextStatus === 'switched') {
          setSegmentRolloverStatus('healthy');
          setMeetingCheckpointStatus('switched');
        }
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
      segmentRolloverStatus,
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
    configureLivePipelineElapsedContext({ meetingStartedAt: liveController.meetingStartedAt });
  }, [liveController.meetingStartedAt, routeMeetingId]);
  const webRtcDevice = useWebRtcDeviceSidecar({
    meetingId: routeMeetingId,
    enabled: Boolean(routeMeetingId && ['listening', 'reconnecting', 'switching-segment'].includes(liveController.status)),
    lifecycleStatus: liveController.status,
    cues: liveController.subtitleCueState?.finalCues || [],
    segmentId: activeMeetingCheckpointRef.current?.segmentId,
    segmentSequence: activeMeetingCheckpointRef.current?.segmentSequence,
    segments: selectedMeetingDetail?.segments || [],
  });

  useEffect(() => subscribeToLiveCredentialClear(() => {
    sessionStopRequestedRef.current = true;
    startLiveRecordingInFlightRef.current = false;
    liveController.recovery.reconnectController().cancel();
    liveController.segmentSwitch.cancel();
    invalidateLiveSessionCallbacks();
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);
    sessionRef.current = null;
    reconnectSessionRef.current = null;
    for (const session of sessions) {
      session?.clearEphemeralToken?.();
      void stopSessionSafely(session);
    }
  }), [liveController]);

  // Finalized Cues are translated asynchronously after they are persisted.
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
  selectedOutputDeviceIdRef.current = selectedOutputDeviceId;

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
      const next = pageInfoFromLocation();
      const activeMeetingId = activeMeetingCheckpointRef.current?.meetingId || '';
      const activeSession = ['requesting-permission', 'connecting', 'listening', 'reconnecting', 'switching-segment'].includes(statusRef.current);
      const leavesActiveLiveRoute = next.page !== 'live-recording' || (activeMeetingId && next.meetingId !== activeMeetingId);

      if (activeSession && leavesActiveLiveRoute) {
        pendingForcedNavigationHashRef.current = canonicalHash;
        const liveHash = activeMeetingId
          ? `#live?meetingId=${encodeURIComponent(activeMeetingId)}`
          : (lastSafeHashRef.current.startsWith('#live') ? lastSafeHashRef.current : '#live');
        window.history.replaceState(null, '', liveHash);
        void forceStopForNavigation();
        return;
      }

      if (statusRef.current === 'paused' && next.page === 'live-recording' && activeMeetingId && next.meetingId !== activeMeetingId) {
        window.history.replaceState(null, '', lastSafeHashRef.current);
        setError('目前錄音已暫停，請先結束目前工作階段後再切換其他會議。');
        return;
      }

      if (canonicalHash !== window.location.hash) {
        window.history.replaceState(null, '', canonicalHash);
      }
      lastSafeHashRef.current = canonicalHash;
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
    const handlePageHide = () => {
      if (!['requesting-permission', 'connecting', 'listening', 'reconnecting', 'switching-segment'].includes(statusRef.current)) return;
      void forceStopForNavigation();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  useEffect(() => {
    if (!globalThis.indexedDB || !globalThis.navigator?.storage) return undefined;
    const retention = createLocalMeetingRetention();
    localMeetingRetentionRef.current = retention;
    const sweep = () => {
      void retention.check().catch(() => {});
      setMeetingRecords((items) => items.map((item) =>
        isVisibleMeetingExpired(item) ? { ...item, contentState: 'expired' } : item));
      setSelectedMeetingDetail((detail) => stripExpiredMeetingContent(detail));
      for (const [id, detail] of meetingDetailCacheRef.current) {
        meetingDetailCacheRef.current.set(id, stripExpiredMeetingContent(detail));
      }
    };
    sweep();
    const interval = window.setInterval(sweep, 60_000);
    const foreground = () => { if (document.visibilityState === 'visible') sweep(); };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', foreground);
    };
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
    if (page !== 'live-recording' || !routeMeetingId) return;
    void refreshCorrectionGlossarySnapshot(routeMeetingId);
  }, [page, routeMeetingId, locationVersion]);

  useEffect(() => {
    const canReadBackgroundSessionData = status === 'stopped' || status === 'error';
    if (!canReadBackgroundSessionData || !(activeSessionRecordIdRef.current || polishingSessionIdRef.current)) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      const sessionId = activeSessionRecordIdRef.current || polishingSessionIdRef.current;
      try {
        const detail = await getSessionDetailWithTranslationHistory(sessionId);
        applyInitialTranslationOutputs(detail);
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
      } catch (error) {
        if (isSessionReadCloudUnavailable(error)) {
          if (sessionId && !sessionReadCloudErrorSessionsRef.current.has(sessionId)) {
            sessionReadCloudErrorSessionsRef.current.add(sessionId);
            console.warn('Session read polling unavailable.', safePersistenceDiagnostic(error));
          }
          if (timer) window.clearInterval(timer);
          return;
        }
        // Polishing read failures are isolated from the Live session.
      }
    };
    void poll();
    timer = window.setInterval(poll, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [status]);

  function applyInitialTranslationOutputs(detail) {
    const outputs = (detail?.translationHistory?.outputs || []).filter((output) => (
      output?.operation === 'cue_translation' && output?.cueId && typeof output.translatedText === 'string' && output.translatedText.trim()
    ));
    if (outputs.length === 0) return;
    const current = subtitleCueStateRef.current;
    const byId = new Map(outputs.map((output) => [output.cueId, output]));
    let changed = false;
    const nextCues = current.finalCues.map((cue) => {
      const output = byId.get(cue.cueId);
      if (!output || cue.initialTranslation === output.translatedText || cue.refinedTranslation) return cue;
      changed = true;
      return applyGlossaryCorrectionToCue({
        ...cue,
        targetLanguageCode,
        initialTranslation: output.translatedText,
        rawTranslation: output.translatedText,
        translatedText: output.translatedText,
        translationStatus: 'finalized',
        refinement: { ...(cue.refinement || {}), status: 'pending' }
      }, correctionGlossaryEntriesForCue(cue));
    });
    if (!changed) return;
    const next = { ...current, finalCues: nextCues };
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
    nextCues.filter((cue) => cue.initialTranslation && cue.refinement?.status === 'pending').forEach((cue) => {
      void scheduleTranscriptPolishing([cue]).then(() => transcriptPolishingCoordinator().flush()).catch(() => {});
    });
  }

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
    const nextCues = refinement.cues.map((cue) => (
      applyGlossaryCorrectionToCue(cue, correctionGlossaryEntriesForCue(cue))
    ));
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

  function applyPersistedRefinedSubtitleCues(detail, { persist = true } = {}) {
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
    if (persist) {
      enqueueCuePersistence(current, next);
    }
    return true;
  }

  function mergeDisplayedCues(existingCues = [], incomingCues = []) {
    const existing = Array.isArray(existingCues) ? existingCues : [];
    const incoming = Array.isArray(incomingCues) ? incomingCues.filter((cue) => cue?.cueId) : [];
    const mergedExisting = mergeCuesByIdPreferRefinement(existing, incoming);
    const existingIds = new Set(existing.map((cue) => cue?.cueId).filter(Boolean));
    return [...mergedExisting, ...incoming.filter((cue) => !existingIds.has(cue.cueId))]
      .sort((left, right) => (
        (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0)
        || (Number(left?.startTimeMs) || 0) - (Number(right?.startTimeMs) || 0)
        || String(left?.cueId || '').localeCompare(String(right?.cueId || ''))
      ));
  }

  function applyPersistedFinalCues(persistedCues = [], { persist = true } = {}) {
    if (!Array.isArray(persistedCues) || persistedCues.length === 0) return;
    const current = subtitleCueStateRef.current;
    const mergedCues = mergeDisplayedCues(current.finalCues, persistedCues);
    if (mergedCues.every((cue, index) => cue === current.finalCues[index])) return;
    const next = { ...current, finalCues: mergedCues };
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    if (persist) {
      enqueueCuePersistence(current, next);
    }
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
        applyPersistedFinalCues(rawCuesFromDetail(detail?.cues), { persist: false });
        applyPersistedRefinedSubtitleCues(detail, { persist: false });
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

  useEffect(() => {
    recordLivePipelineTrace({ stage: 'LIVE_COMPONENT_MOUNTED', ...currentLiveTraceIdentity() });
    return () => {
      const traceIdentity = currentLiveTraceIdentity();
      recordLivePipelineTrace({ stage: 'LIVE_COMPONENT_UNMOUNTED', ...traceIdentity });
      if (traceIdentity.recorderSessionId || sessionRef.current) {
        recordLivePipelineTrace({
          stage: 'RECORDING_STATE_RESET',
          ...traceIdentity,
          reason: 'live_component_unmounted'
        });
      }
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
      for (const activeSession of sessions) {
        void stopSessionSafely(activeSession);
      }
      void Promise.resolve(liveController.audio.cleanup()).catch(() => {});
    };
  }, []);

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
          if (result.action === 'finalized') {
            recordCueTransitionTrace({
              cue: liveController.cue,
              event: { eventType: result.action || 'idle', isFinal: true, audioTurnId: cue.audioTurnId || null },
              previous,
              next: nextState,
              cueAction: 'transition'
            });
          }
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
      const normalizedDevices = await navigator.mediaDevices.enumerateDevices();
      const devices = audioInputDevices(normalizedDevices);
      setInputDevices(devices);
      setOutputDevices(audioOutputDevices(normalizedDevices));
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

  async function selectInputDevice(deviceId) {
    const nextDeviceId = deviceId || '';
    if (!sessionRef.current || !['listening', 'reconnecting'].includes(status)) {
      selectedInputDeviceIdRef.current = nextDeviceId;
      setSelectedInputDeviceId(nextDeviceId);
      return;
    }

    try {
      const nextStream = await requestAudioInputStream(nextDeviceId);
      const replaced = await sessionRef.current.replaceInputStream(nextStream);
      if (!replaced) {
        nextStream.getTracks?.().forEach((track) => track.stop?.());
        throw new Error('無法切換麥克風。');
      }
      selectedInputDeviceIdRef.current = nextDeviceId;
      setSelectedInputDeviceId(nextDeviceId);
      setDeviceMessage('已切換麥克風，字幕工作階段未中斷。');
    } catch (nextError) {
      setDeviceMessage(nextError?.message || '無法切換麥克風，已保留原裝置。');
    }
  }

  async function selectOutputDevice(deviceId) {
    selectedOutputDeviceIdRef.current = deviceId || '';
    setSelectedOutputDeviceId(deviceId || '');
    if (!sessionRef.current) return;
    const supported = await sessionRef.current.setOutputDevice(deviceId || '');
    if (!supported && deviceId) setDeviceMessage('此瀏覽器不支援切換輸出裝置，已維持預設揚聲器。');
  }

  function cancelLiveCueIdleTimers() {
    for (const timer of liveCueIdleTimersRef.current.values()) clearTimeout(timer);
    liveCueIdleTimersRef.current.clear();
  }

  function applyStartFailure(nextError, fallbackMessage) {
    const startupReason = nextError?.reasonHint || (
      nextError?.startupStage === 'getUserMedia' ? 'audio_capture_failed' : 'unknown_error'
    );
    const classification = classifyFailureSignal({
      source: 'microphone_capture',
      rawError: nextError,
      reasonHint: startupReason
    });
    const noDefaultInputDevice =
      classification.reason === 'selected_device_missing' && !selectedInputDeviceId;
    const errorCode = nextError?.code || nextError?.error?.code || nextError?.error?.error?.code;
    const codeMessage = userMessageForErrorCode(errorCode);
    const baseMessage = nextError?.userMessage || codeMessage || (noDefaultInputDevice
      ? '找不到可用的麥克風。請連接或允許麥克風後再試一次。'
      : classification.safeMessage || nextError?.message || fallbackMessage);
    const message = withHttpStatus(baseMessage, classification.httpStatus);

    const diagnostic = safeReconnectDiagnostic({
      source: 'startup',
      stage: nextError?.startupStage || 'start_session',
      rawError: nextError,
      reasonHint: classification.reason
    }, classification);
    reconnectFailureDiagnosticRef.current = diagnostic;
    void appendSessionFailureDiagnostic(diagnostic, classification);

    setStatusLabelOverride('');
    setError(message);
    setStatus('error');
  }

  async function createSession({
    preserveTranscript,
    liveSessionId = generateLiveSessionId(),
    startupStartedAt = null,
    continueStartedAt = null,
    meetingId = activeMeetingCheckpointRef.current?.meetingId || routeMeetingId,
    segmentId = activeMeetingCheckpointRef.current?.segmentId || liveSessionId
  }) {
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

    const audioPreference = getMeetingAudioPreference(meetingId);
    const inputDeviceIdForSession = hasConfirmedMeetingAudioPreference(audioPreference) ? audioPreference.inputDeviceId || '' : '';

    const callbackGeneration = {
      generation: liveSessionCallbackGenerationRef.current.generation + 1,
      active: false
    };
    liveSessionCallbackGenerationRef.current = callbackGeneration;
    recordLivePipelineTrace({
      stage: 'RECORDER_GENERATION_CHANGED',
      meetingId,
      sessionId: activeSessionRecordIdRef.current,
      segmentId: segmentId || liveSessionId,
      recorderEpoch: callbackGeneration.generation,
      decision: 'session_created'
    });
    handledLiveFailureGenerationsRef.current.clear();

    const session = new LiveTranslateSession({
      liveSessionId,
      correctionGlossaryRegistry: correctionGlossaryRegistryRef.current,
      connectionEpoch: callbackGeneration.generation,
      sessionId: activeSessionRecordIdRef.current,
      recordingId: sessionRepositoryRef.current.getSessionRecord(activeSessionRecordIdRef.current)?.sessionRecord?.recordingId || null,
      meetingId: meetingId || null,
      segmentId: segmentId || liveSessionId,
      startupStartedAt,
      continueStartedAt,
      sessionClock: () => sessionTimeForSubtitleCues(),
      sourceLanguageCode,
      targetLanguageCode,
      echoTargetLanguage,
      inputDeviceId: inputDeviceIdForSession,
      outputDeviceId: hasConfirmedMeetingAudioPreference(audioPreference) ? audioPreference.outputDeviceId || '' : '',
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
      onInputBufferOverflow: (diagnostic) => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        setMeetingCheckpointStatus('error');
        setMeetingCheckpointErrorMessage('Provider 暫存音訊已達上限；原始錄音仍保留，但這段音訊可能無法由 Gemini 產生字幕。');
        recordLivePipelineTrace({
          stage: 'PCM_BUFFER_CAPACITY_EXCEEDED',
          meetingId: meetingId || null,
          sessionId: activeSessionRecordIdRef.current,
          segmentId: diagnostic.segmentId,
          providerEpoch: diagnostic.providerEpoch,
          audioTurnId: diagnostic.audioTurnId,
          queueDepth: session.pendingInputAudioChunks.length,
          reason: diagnostic.code
        });
      },
      onProviderReady: () => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        setLiveErrorCode('');
        setStatusLabelOverride('');
      },
      onPlaybackStateChange: ({ state: playbackState } = {}) => {
        if (!isCurrentLiveSessionInstance(callbackGeneration)) return;
        if (playbackState === 'error') setDeviceMessage('翻譯聲音播放失敗，字幕仍會繼續接收。');
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
        if (handledLiveFailureGenerationsRef.current.has(callbackGeneration.generation)) return;
        handledLiveFailureGenerationsRef.current.add(callbackGeneration.generation);
        if (suppressReconnectErrorRef.current) {
          suppressReconnectErrorRef.current = false;
          return;
        }

        setLiveErrorCode(nextError.code || '');
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
        if (handledLiveFailureGenerationsRef.current.has(callbackGeneration.generation)) return;
        handledLiveFailureGenerationsRef.current.add(callbackGeneration.generation);
        setLiveErrorCode(failure.rawError?.code || failure.rawEvent?.code || '');
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
    recordLivePipelineTrace({
      stage: 'RECORDER_GENERATION_CHANGED',
      meetingId: activeMeetingCheckpointRef.current?.meetingId,
      sessionId: activeSessionRecordIdRef.current,
      segmentId: activeMeetingCheckpointRef.current?.segmentId,
      recorderEpoch: liveSessionCallbackGenerationRef.current.generation,
      decision: 'callbacks_invalidated'
    });
  }

  function suspendLiveSessionCallbacks() {
    liveSessionCallbackGenerationRef.current.active = false;
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

  function configuredSegmentSwitchIntervalMs() {
    const testIntervalMs = import.meta.env?.DEV ? window.__liveTranslateSegmentSwitchIntervalMs : undefined;
    return Number.isFinite(testIntervalMs) && testIntervalMs > 0 ? testIntervalMs : SEGMENT_SWITCH_INTERVAL_MS;
  }

  function currentLiveTraceIdentity() {
    const recorderSessionId = activeSessionRecordIdRef.current;
    const record = recorderSessionId
      ? sessionRepositoryRef.current.getSessionRecord(recorderSessionId)?.sessionRecord
      : null;
    return {
      meetingId: activeMeetingCheckpointRef.current?.meetingId || routeMeetingId || null,
      recordingId: record?.recordingId || null,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || null,
      sessionId: recorderSessionId || null,
      recorderSessionId: recorderSessionId || null,
      geminiSessionId: sessionRef.current?.liveSessionId || null,
      recordingState: statusRef.current || null
    };
  }

  function reportSegmentSwitchError(error) {
    if (sessionStopRequestedRef.current) return;
    console.error('Meeting segment switch failed.', {
      stage: error?.rolloverStage || null,
      code: error?.code || error?.cause?.code || null,
      status: error?.status || error?.cause?.status || null,
      requestId: error?.requestId || error?.cause?.requestId || null,
      endpoint: error?.endpoint || error?.cause?.endpoint || null,
      cause: error?.cause?.name || null
    });
    setStatusLabelOverride('分段切換失敗，錄音持續中');
    setSegmentRolloverStatus('recovery-pending');
    setMeetingCheckpointStatus('error');
    setMeetingCheckpointErrorMessage('分段切換暫時失敗；麥克風、即時字幕與本機錄音仍持續。請保留此頁面以便後續重試。');
  }

  function generateLiveSessionId() {
    liveSessionIdSequenceRef.current += 1;
    return `live-session-${Date.now()}-${liveSessionIdSequenceRef.current}`;
  }

  function currentMeetingGlossaryEntries() {
    const meeting = selectedMeetingDetail?.meeting;
    const selectedEntries = Array.isArray(meeting?.glossaryEntries)
      ? meeting.glossaryEntries
      : selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode);
    const privateEntries = Array.isArray(meeting?.privateGlossaryEntries)
      ? meeting.privateGlossaryEntries
      : privateMeetingGlossaryEntries;
    return effectiveMeetingGlossaryEntries(
      glossaryEntries,
      [...selectedEntries, ...privateEntries],
      targetLanguageCode
    );
  }

  function correctionGlossaryEntriesForCue(cue) {
    return correctionGlossaryRegistryRef.current
      .entriesForRevision(cue?.correctionGlossaryRevision);
  }

  async function refreshCorrectionGlossarySnapshot(meetingId) {
    const generation = ++correctionGlossaryRefreshGenerationRef.current;
    setCorrectionGlossaryStatus('refreshing');
    try {
      const [globalEntries, detail] = await Promise.all([
        createGlossaryApiClient().listEntries(),
        meetingReadApiClientRef.current.getMeetingDetail(meetingId)
      ]);
      if (generation !== correctionGlossaryRefreshGenerationRef.current) return null;
      const meeting = detail?.meeting;
      if (!meeting || meeting.id !== meetingId) throw new Error('Meeting glossary snapshot unavailable.');
      const meetingEntries = [
        ...(Array.isArray(meeting.glossaryEntries) ? meeting.glossaryEntries : []),
        ...(Array.isArray(meeting.privateGlossaryEntries) ? meeting.privateGlossaryEntries : [])
      ];
      const entries = effectiveMeetingGlossaryEntries(
        globalEntries,
        meetingEntries,
        meeting.targetLanguageCode || targetLanguageCode
      );
      const revision = await effectiveGlossaryRevision({
        sourceLanguageCode: meeting.sourceLanguageCode || sourceLanguageCode,
        targetLanguageCode: meeting.targetLanguageCode || targetLanguageCode,
        entries
      });
      if (generation !== correctionGlossaryRefreshGenerationRef.current) return null;
      const snapshot = correctionGlossaryRegistryRef.current.activate({ revision, entries });
      setGlossaryEntries(globalEntries);
      setPrivateMeetingGlossaryEntries(Array.isArray(meeting.privateGlossaryEntries)
        ? meeting.privateGlossaryEntries
        : []);
      setCorrectionGlossaryStatus('applied');
      recordLivePipelineTrace({
        stage: 'CORRECTION_GLOSSARY_UPDATED',
        meetingId,
        segmentId: activeMeetingCheckpointRef.current?.segmentId || null,
        revision: snapshot.revision,
        glossaryEntryCount: snapshot.entries.length,
        timestamp: new Date().toISOString()
      });
      return snapshot;
    } catch (refreshError) {
      if (generation !== correctionGlossaryRefreshGenerationRef.current) return null;
      setCorrectionGlossaryStatus('pending');
      recordLivePipelineTrace({
        stage: 'CORRECTION_GLOSSARY_PENDING',
        meetingId,
        segmentId: activeMeetingCheckpointRef.current?.segmentId || null,
        revision: correctionGlossaryRegistryRef.current.active()?.revision || null,
        reason: refreshError?.code || refreshError?.name || 'refresh_failed',
        timestamp: new Date().toISOString()
      });
      return null;
    }
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
    const lifecycleContractVersion = liveController.checkpoint.isLifecycleV2Session(activeSessionRecordId) ? 2 : 1;
    const appended = finalizedTranscriptItemsForRecording({
      lifecycleContractVersion,
      repository: sessionRepositoryRef.current,
      sessionId: activeSessionRecordId,
      previousTranscriptState: current,
      nextTranscriptState: next
    });
    if (lifecycleContractVersion !== 2) {
      liveController.checkpoint.markPendingSessionSnapshotItems(activeSessionRecordId, appended);
    }
    setTranscript((previous) => (
      previous === current ? next : applyTranscriptEvent(previous, update)
    ));

    if (appended.length > 0) {
      const activeSessionRecord = sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
      if (activeSessionRecord) {
        if (lifecycleContractVersion !== 2) liveController.checkpoint.scheduleSessionSnapshotSync(activeSessionRecordId);
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
    if (!TRANSCRIPT_POLISHING_ENABLED) return Promise.resolve(null);
    const cues = finalCues.filter((cue) => cue?.status === 'final' && rawSourceForCue(cue) && rawTranslationForCue(cue));
    if (!activeSessionRecordIdRef.current || cues.length === 0) return Promise.resolve(null);
    return transcriptPolishingCoordinator().enqueue(cues);
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
      } catch (error) {
        // Raw final Cues remain visible while the asynchronous refinement is pending.
        if (isSessionReadCloudUnavailable(error)) return;
      }
      pollRefinedSubtitleResult(sessionId, inputHash, attempt + 1);
    }, Math.min(1000 * (2 ** attempt), 8000));
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

  function getLocalMeetingPersistence() {
    if (!localMeetingPersistenceRef.current) {
      localMeetingPersistenceRef.current = createLocalMeetingPersistence();
    }
    localMeetingPersistenceRef.current.setRecordingEnabled?.(shouldRecordInputAudio);
    return localMeetingPersistenceRef.current;
  }

  function endMeetingFromManagement(meetingId) {
    if (endMeetingOperationRef.current) return endMeetingOperationRef.current;
    const operation = (async () => {
      if (!window.confirm('確定要結束這場會議嗎？既有逐字稿會保留，之後將無法繼續錄製。')) return false;
      setMeetingCheckpointStatus('ending');
      try {
        await completeMeetingAfterRecordingFinalize({
          flushAudio: () => liveController.audio.finalizeRawAudioRecording?.(),
          flushCues: () => liveController.cue.flushSubtitleCues?.('complete'),
          flushCheckpoint: async () => {
            const flushed = await liveController.checkpoint.flushMeetingCheckpointSync?.();
            if (flushed === false) throw new Error('Unable to flush meeting checkpoint before completion.');
          },
          flushCuePublishes: () => flushMeetingCuePublishes(activeSessionRecordIdRef.current, { forceCloud: true }),
          completeMeeting: () => meetingCheckpointApiClientRef.current.completeMeeting({ meetingId })
        });
        applyCloudSaveSnapshot(cloudSaveCoordinatorRef.current.snapshot());
        setNavigationNotice('會議已結束。');
        window.location.hash = '#meetings';
        return true;
      } catch {
        setMeetingCheckpointStatus('error');
        setError('無法結束會議，請稍後再試。');
        return false;
      }
    })();
    endMeetingOperationRef.current = operation;
    void operation.finally(() => {
      if (endMeetingOperationRef.current === operation) endMeetingOperationRef.current = null;
    }).catch(() => {});
    return operation;
  }

  function enqueueCuePersistence(previous, next) {
    const previousCues = new Map((previous?.finalCues || []).map((cue) => [cue.cueId, cue]));
    const changedCues = (next?.finalCues || []).filter((cue) => {
      const previousCue = previousCues.get(cue.cueId);
      return !previousCue || JSON.stringify(previousCue) !== JSON.stringify(cue);
    });
    const checkpoint = cueCheckpointForState(next);
    const checkpointCues = changedCues.map((cue) => ({
      ...cue,
      sessionId: cue.sessionId || activeSessionRecordIdRef.current,
      segmentId: cue.segmentId || activeMeetingCheckpointRef.current?.segmentId,
      sourceLanguageCode: cue.sourceLanguageCode || sourceLanguageCode,
      targetLanguageCode: cue.targetLanguageCode === undefined ? targetLanguageCode : cue.targetLanguageCode,
      sourceText: cue.rawSource ?? cue.sourceText ?? '',
      translatedText: cue.translatedText ?? cue.rawTranslation ?? '',
      status: cue.status || 'final',
      finalizedReason: cue.finalizedReason || 'final'
    })).filter((cue) => (
      typeof cue.cueId === 'string' && cue.cueId.trim() !== ''
      && typeof cue.sessionId === 'string' && cue.sessionId.trim() !== ''
      && typeof cue.segmentId === 'string' && cue.segmentId.trim() !== ''
      && Number.isInteger(cue.sequence) && cue.sequence > 0
      && Number.isFinite(cue.startTimeMs) && Number.isFinite(cue.endTimeMs)
      && typeof cue.sourceText === 'string' && typeof cue.translatedText === 'string'
      && (cue.sourceText.trim() !== '' || cue.translatedText.trim() !== '')
    ));
    const activeMeetingCheckpoint = activeMeetingCheckpointRef.current;
    const activeSessionId = activeSessionRecordIdRef.current;
    const localSave = localMeetingCuePersistenceQueueRef.current.catch(() => {}).then(() => (
      Promise.all(checkpointCues.map((cue) => getLocalMeetingPersistence().saveCue({
        meetingId: activeMeetingCheckpoint?.meetingId,
        segmentId: cue.segmentId,
        sessionId: cue.sessionId,
        cue,
        producedAt: cue.finalizedAt || Date.now()
      })))
    ));
    localMeetingCuePersistenceQueueRef.current = localSave;
    void localSave.then(async () => {
      for (const cue of checkpointCues) {
        recordLivePipelineTrace({
          stage: 'LOCAL_CUE_SAVED',
          meetingId: activeMeetingCheckpoint?.meetingId,
          sessionId: cue.sessionId,
          segmentId: cue.segmentId,
          cueId: cue.cueId,
          persistenceState: 'local_saved'
        });
      }
      try {
        await publishMeetingCues(checkpointCues, activeMeetingCheckpoint, activeSessionId);
      } catch {
        setMeetingCheckpointStatus('error');
        setMeetingCheckpointErrorMessage('字幕已保存在本機，但雲端同步失敗。結束時會再重試。');
      }
    }).catch(() => {
      setMeetingCheckpointStatus('error');
      setMeetingCheckpointErrorMessage('本機字幕保存失敗，資料仍保留在當前頁面。請勿關閉頁面，並再次結束以重試。');
    });
    liveController.checkpoint.meetingCheckpointSyncCoordinator().enqueueCues(checkpointCues, checkpoint);
  }

  async function publishMeetingCues(cues, meetingCheckpoint, sessionId, { allowInactive = false, cloudKind = 'cue' } = {}) {
    if (!meetingCheckpoint?.meetingId || !meetingCheckpoint?.segmentId || !sessionId || !Array.isArray(cues) || cues.length === 0) return;
    if (!allowInactive && (activeMeetingCheckpointRef.current?.meetingId !== meetingCheckpoint.meetingId
      || activeMeetingCheckpointRef.current?.segmentId !== meetingCheckpoint.segmentId
      || activeSessionRecordIdRef.current !== sessionId)) {
      return;
    }

    const finalCues = cues.filter((cue) => (
      cue?.status === 'final'
      && (!cue.sessionId || cue.sessionId === sessionId)
      && (!cue.segmentId || cue.segmentId === meetingCheckpoint.segmentId)
    ));
    await Promise.all(finalCues.map((cue) => enqueueMeetingCuePublish(cue, meetingCheckpoint, sessionId, { allowInactive, cloudKind })));
  }

  async function flushMeetingCuePublishes(sessionId, { forceCloud = false } = {}) {
    if (!sessionId) return { localSaved: true, cloudSynced: true };
    const meetingCheckpoint = activeMeetingCheckpointRef.current;
    const localSave = localMeetingCuePersistenceQueueRef.current.catch(() => {}).then(() => persistFinalMeetingCues({
      persistence: getLocalMeetingPersistence(),
      meetingId: meetingCheckpoint?.meetingId,
      sessionId,
      segmentId: meetingCheckpoint?.segmentId,
      cues: subtitleCueStateRef.current?.finalCues || []
    }));
    localMeetingCuePersistenceQueueRef.current = localSave;
    try {
      await localSave;
    } catch (error) {
      setMeetingCheckpointStatus('error');
      setMeetingCheckpointErrorMessage('本機字幕保存失敗，資料仍保留在當前頁面。請勿關閉頁面，並再次結束以重試。');
      throw error;
    }

    const cloudResults = [];
    if (forceCloud) {
      if (meetingCheckpoint?.meetingId) {
        const localCues = await getLocalMeetingPersistence().listCues(meetingCheckpoint.meetingId);
        const groups = new Map();
        for (const record of localCues) {
          const key = `${record.sessionId}:${record.segmentId}`;
          const group = groups.get(key) || { sessionId: record.sessionId, segmentId: record.segmentId, cues: [] };
          group.cues.push(record.cue);
          groups.set(key, group);
        }
        cloudResults.push(...await Promise.allSettled([...groups.values()].map((group) => publishMeetingCues(
          group.cues,
          { meetingId: meetingCheckpoint.meetingId, segmentId: group.segmentId },
          group.sessionId,
              { allowInactive: true, cloudKind: 'terminal' }
        ))));
      }
    }
    const queued = [...meetingCuePublishQueuesRef.current.entries()]
      .filter(([key]) => key.startsWith(`cue:${sessionId}:`))
      .map(([, promise]) => promise);
    if (queued.length > 0) {
      recordLivePipelineTrace({
        stage: 'DURABLE_BARRIER_WAITING',
        meetingId: meetingCheckpoint?.meetingId,
        sessionId,
        segmentId: meetingCheckpoint?.segmentId,
        persistenceState: 'waiting',
        decision: 'terminal_flush_only',
        eventSequence: queued.length
      });
    }
    const barrier = await waitForDurabilityPromises(queued, { timeoutMs: 5_000 });
    cloudResults.push(...barrier.settlements);
    if (barrier.timedOut) {
      recordLivePipelineTrace({
        stage: 'DURABLE_BARRIER_TIMEOUT',
        meetingId: meetingCheckpoint?.meetingId,
        sessionId,
        segmentId: meetingCheckpoint?.segmentId,
        persistenceState: 'local-durable-cloud-pending',
        queueDepth: queued.length,
        inFlight: barrier.pendingCount,
        reason: 'cue_publish_timeout'
      });
    }
    return {
      localSaved: true,
      cloudSynced: !barrier.timedOut && cloudResults.every((result) => result.status === 'fulfilled'),
      pendingCount: barrier.pendingCount
    };
  }

  function enqueueMeetingCuePublish(cue, meetingCheckpoint, sessionId, { allowInactive = false, cloudKind = 'cue' } = {}) {
    const operation = Object.freeze({
      meetingId: meetingCheckpoint.meetingId,
      sessionId,
      segmentId: cue.segmentId || meetingCheckpoint.segmentId,
      operationId: `cue:${sessionId}:${cue.segmentId || meetingCheckpoint.segmentId}:${cue.cueId}`,
      cueId: cue.cueId,
      cue
    });
    const key = operation.operationId;
    recordLivePipelineTrace({
      stage: 'DURABLE_OPERATION_CREATED',
      meetingId: operation.meetingId,
      sessionId: operation.sessionId,
      segmentId: operation.segmentId,
      operationId: operation.operationId,
      cueId: operation.cueId
    });
    const previous = meetingCuePublishQueuesRef.current.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!allowInactive && (activeMeetingCheckpointRef.current?.meetingId !== operation.meetingId
        || activeMeetingCheckpointRef.current?.segmentId !== operation.segmentId
        || activeSessionRecordIdRef.current !== operation.sessionId)) return;
      cloudSaveCoordinatorRef.current.begin({ id: key, kind: cloudKind });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!allowInactive && attempt > 0 && (activeMeetingCheckpointRef.current?.meetingId !== operation.meetingId
          || activeMeetingCheckpointRef.current?.segmentId !== operation.segmentId
          || activeSessionRecordIdRef.current !== operation.sessionId)) return;
        if (attempt > 0) cloudSaveCoordinatorRef.current.retry(key);
        recordLivePipelineTrace({
          stage: attempt === 0 ? 'CUE_PERSIST_REQUEST' : 'DURABLE_OPERATION_RETRY',
          meetingId: operation.meetingId,
          sessionId: operation.sessionId,
          segmentId: operation.segmentId,
          operationId: operation.operationId,
          cueId: operation.cueId,
          audioTurnId: operation.cue.audioTurnId || null
        });
        recordLivePipelineTrace({
          stage: attempt === 0 ? 'CLOUD_CUE_SAVE_STARTED' : 'DURABLE_QUEUE_RETRYING',
          meetingId: operation.meetingId,
          sessionId: operation.sessionId,
          segmentId: operation.segmentId,
          operationId: operation.operationId,
          cueId: operation.cueId,
          recorderEpoch: liveSessionCallbackGenerationRef.current.generation,
          providerEpoch: sessionRef.current?.connectionEpoch ?? reconnectSessionRef.current?.connectionEpoch ?? null,
          persistenceState: attempt === 0 ? 'saving' : 'retrying'
        });
        try {
          await meetingCueApiClientRef.current.publish({
            meetingId: operation.meetingId,
            segmentId: operation.segmentId,
            sessionId: operation.sessionId,
            cue: operation.cue,
            producedAt: operation.cue.finalizedAt || Date.now()
          });
          cloudSaveCoordinatorRef.current.succeed(key);
          recordLivePipelineTrace({
            stage: 'CUE_PUBLISHED',
            meetingId: operation.meetingId,
            sessionId: operation.sessionId,
            recordingId: operation.sessionId,
            segmentId: operation.segmentId,
            operationId: operation.operationId,
            cueId: operation.cueId,
            sourceText: operation.cue.rawSource ?? operation.cue.sourceText ?? '',
            translationText: operation.cue.translatedText || '',
            turnKey: operation.cue.turnKey || null,
            audioTurnId: operation.cue.audioTurnId || null,
            reason: 'meeting_cue_publish_succeeded'
          });
          recordLivePipelineTrace({
            stage: 'CLOUD_CUE_SAVE_SUCCEEDED',
            meetingId: operation.meetingId,
            sessionId: operation.sessionId,
            segmentId: operation.segmentId,
            operationId: operation.operationId,
            cueId: operation.cueId,
            persistenceState: 'synced'
          });
          liveCueLatencyTracker.recordViewerPublished({ cue: operation.cue });
          return;
        } catch (error) {
          cloudSaveCoordinatorRef.current.fail(key, error);
          recordLivePipelineTrace({
            stage: 'CUE_PERSIST_FAILED',
            meetingId: operation.meetingId,
            sessionId: operation.sessionId,
            segmentId: operation.segmentId,
            operationId: operation.operationId,
            cueId: operation.cueId,
            audioTurnId: operation.cue.audioTurnId || null,
            httpStatus: error?.status,
            serverErrorCode: error?.code
          });
          recordLivePipelineTrace({
            stage: 'CLOUD_CUE_SAVE_FAILED',
            meetingId: operation.meetingId,
            sessionId: operation.sessionId,
            segmentId: operation.segmentId,
            operationId: operation.operationId,
            cueId: operation.cueId,
            recorderEpoch: liveSessionCallbackGenerationRef.current.generation,
            persistenceState: 'retrying',
            httpStatus: error?.status,
            errorCode: error?.code
          });
          const retryableBindingFailure = error?.status === 403 || error?.status === 404 || error?.status === 409;
          if (retryableBindingFailure && attempt === 0) continue;
          if (import.meta.env?.DEV) {
            console.warn('[meeting-cue-publish]', {
              status: Number.isInteger(error?.status) ? error.status : null,
              code: typeof error?.code === 'string' ? error.code : null,
              requestId: typeof error?.requestId === 'string' ? error.requestId : null
            });
          }
          throw error;
        }
      }
    });
    meetingCuePublishQueuesRef.current.set(key, next);
    void next.finally(() => {
      if (meetingCuePublishQueuesRef.current.get(key) === next) meetingCuePublishQueuesRef.current.delete(key);
    }).catch(() => {});
    return next;
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

  function clearMeetingCheckpointError() {
    setMeetingCheckpointErrorMessage('');
  }

  function applyCloudSaveSnapshot(snapshot) {
    if (snapshot.state === 'cloud_failed') {
      setMeetingCheckpointStatus('error');
      return;
    }
    if (snapshot.state === 'cloud_retrying') {
      setMeetingCheckpointStatus('retrying');
      return;
    }
    if (snapshot.state === 'cloud_pending') {
      setMeetingCheckpointStatus('syncing');
      return;
    }
    setMeetingCheckpointStatus('synced');
    clearMeetingCheckpointError();
  }

  function safePersistenceDiagnostic(error) {
    return {
      status: Number.isInteger(error?.status) ? error.status : null,
      code: typeof error?.code === 'string' ? error.code : null,
      operation: typeof error?.operation === 'string' ? error.operation : null,
      requestId: typeof error?.requestId === 'string' ? error.requestId : null
    };
  }

  function reportSessionSnapshotSyncError(error, sessionId) {
    if (isSessionReadCloudUnavailable(error)) {
      const diagnosticKey = sessionId || 'unknown-session';
      if (!sessionSnapshotCloudErrorSessionsRef.current.has(diagnosticKey)) {
        sessionSnapshotCloudErrorSessionsRef.current.add(diagnosticKey);
        console.warn('Session snapshot persistence unavailable.', safePersistenceDiagnostic(error));
      }
      return;
    }

    console.error('Session snapshot persistence failed.', safePersistenceDiagnostic(error));
    if (error?.status === 413 || error?.code === 'request_too_large') {
      setError('翻譯紀錄內容超過伺服器保存上限，但目前逐字稿仍保留在畫面上。請調高 SESSION_SNAPSHOT_MAX_BYTES 或稍後重新儲存翻譯紀錄。');
      return;
    }
    setError('無法儲存翻譯紀錄，但目前逐字稿仍保留在畫面上。');
  }

  function reportMeetingCheckpointSyncError(error) {
    console.error('Meeting checkpoint persistence failed.', safePersistenceDiagnostic(error));
    const diagnostic = error?.requestId ? `（請提供 Request ID：${error.requestId}）` : '';
    const invalidMessage = meetingCheckpointErrorMessageFor(error);
    if (invalidMessage) {
      setMeetingCheckpointErrorMessage(`${invalidMessage}${diagnostic}`);
      return;
    }
    if (error?.status === 413 || error?.code === 'request_too_large') {
      setMeetingCheckpointErrorMessage(`長會議同步內容超過伺服器保存上限，未同步片段會保留並重試；請調高 MEETING_CHECKPOINT_MAX_BYTES。${diagnostic}`);
      return;
    }
    if (error?.status === 409 || error?.code === 'checkpoint_conflict') {
      setMeetingCheckpointErrorMessage(`長會議同步發生 checkpoint 衝突，未同步片段會保留；請重新載入會議後再繼續。${diagnostic}`);
      return;
    }
    if (error?.status === 404 || error?.code === 'meeting_not_found' || error?.code === 'meeting_segment_not_found') {
      setMeetingCheckpointErrorMessage(`長會議同步找不到目前的會議段落，未同步片段已保留。${diagnostic}`);
      return;
    }
    setMeetingCheckpointErrorMessage(`長會議同步暫時失敗，已保留未同步片段並會在下一次同步時重試。${diagnostic}`);
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

  function isValidUuid(value) {
    return typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  }

  async function refreshMeetingRecords() {
    if (meetingRecordsRequestRef.current) return meetingRecordsRequestRef.current;

    const request = meetingReadApiClientRef.current.listMeetingHistory()
      .then((meetings) => {
        setMeetingRecords([...meetings].sort((a, b) => meetingRecordSortTime(b) - meetingRecordSortTime(a)));
        void localMeetingRetentionRef.current?.syncMeetings(meetings).catch(() => {});
        return meetings;
      })
      .catch(() => null)
      .finally(() => {
        if (meetingRecordsRequestRef.current === request) meetingRecordsRequestRef.current = null;
      });
    meetingRecordsRequestRef.current = request;
    return request;
  }

  async function getSessionDetailWithTranslationHistory(sessionId) {
    return readSessionDetailWithTranslationHistory({
      apiClient: sessionReadApiClientRef.current,
      sessionId
    });
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

    const checkpointReadErrors = [];
    const checkpoints = await Promise.all(segments.map(async (segment) => {
      const checkpointUrl = `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segment.id)}/checkpoint`;
      const invalidMeetingId = !isValidUuid(meetingId);
      const invalidSegmentId = !isValidUuid(segment.id);
      if (invalidMeetingId || invalidSegmentId) {
        const error = new Error('Checkpoint path contains an invalid UUID.');
        error.status = 400;
        error.code = 'invalid_request';
        error.details = [invalidMeetingId
          ? 'meetingId must be a valid UUID.'
          : 'segmentId must be a valid UUID.'];
        error.apiMessage = error.details[0];
        error.requestId = globalThis.crypto?.randomUUID?.() || `resume-${Date.now()}`;
        checkpointReadErrors.push({ segmentId: segment.id, error });
        if (import.meta.env?.DEV) {
          console.error('[resume-checkpoint]', {
            meetingId,
            segmentId: segment.id,
            method: 'GET',
            url: checkpointUrl,
            hasBody: false,
            status: error.status,
            code: error.code,
            requestId: error.requestId,
            details: error.details
          });
        }
        return null;
      }
        try {
          const localCheckpoint = await getLocalMeetingPersistence().getCheckpoint({
            meetingId,
            segmentId: segment.id
          });
          if (localCheckpoint) return localCheckpoint;
          return await meetingCheckpointApiClientRef.current.getCheckpoint({ meetingId, segmentId: segment.id });
      } catch (error) {
        checkpointReadErrors.push({ segmentId: segment.id, error });
        if (import.meta.env?.DEV) {
          console.error('[resume-checkpoint-failed]', {
            meetingId,
            segmentId: segment.id,
            status: error?.status,
            code: error?.code,
            requestId: error?.requestId,
            message: error?.apiMessage || error?.message
          });
        }
        return null;
      }
    }));
    if (meetingResumeDraftRequestIdRef.current !== requestId) {
      return;
    }

    const contractErrors = checkpointReadErrors.filter(({ error }) => error?.status !== 404);
    if (contractErrors.length > 0) {
      const requestId = contractErrors.find(({ error }) => error?.requestId)?.error.requestId;
      setError(requestId
        ? `部分 checkpoint 無法讀取（Request ID: ${requestId}），仍可繼續錄製。`
        : '部分 checkpoint 無法讀取，仍可繼續錄製。');
    }

      const chunks = checkpoints.flatMap((checkpointResult) => (
        checkpointResult?.checkpoint?.durableChunks || []
      ));
      const checkpointCues = checkpoints.flatMap((checkpointResult) => (
        checkpointResult?.checkpoint?.finalCues || []
      )).filter((cue) => cue?.status === 'final').sort((left, right) => left.sequence - right.sequence);
      const localCues = (await getLocalMeetingPersistence().listCues(meetingId))
        .map((record) => record.cue)
        .filter((cue) => cue?.status === 'final');
      const persistedCues = mergeDisplayedCues(checkpointCues, localCues);
      const refinedSubtitleCues = checkpoints.flatMap((checkpointResult) => (
        checkpointResult?.checkpoint?.refinedSubtitleCues || []
      )).filter((cue) => cue?.status === 'final').sort((left, right) => left.startTimeMs - right.startTimeMs);
      const latestCueCheckpoint = [...checkpoints].reverse().map((result) => result?.checkpoint?.cueCheckpoint).find(Boolean);
      if (persistedCues.length > 0 || latestCueCheckpoint) {
        const currentCueState = subtitleCueStateRef.current;
        const mergedFinalCues = mergeDisplayedCues(currentCueState.finalCues, persistedCues);
        const restoredRefinedSubtitleCues = mergeDisplayedCues(currentCueState.refinedSubtitleCues, refinedSubtitleCues);
        const restoredCueState = createSubtitleCueState({
          ...currentCueState,
          ...(latestCueCheckpoint || {}),
          finalCues: mergedFinalCues,
          refinedSubtitleCues: restoredRefinedSubtitleCues,
          nextSequence: Math.max(
            currentCueState.nextSequence || 1,
            latestCueCheckpoint?.nextSequence || 1,
            (mergedFinalCues.at(-1)?.sequence || 0) + 1
          )
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
      segmentId: resumableSegment.id,
      segmentSequence: resumableSegment.sequence
    };
      setResumeDraft({
        sessionId: (await sessionReadApiClientRef.current.listSessionHistory().catch(() => []))
          .find((record) => record.meetingId === meetingId && ['active', 'paused'].includes(record.status))?.id || null,
        meetingId,
        segmentId: resumableSegment.id,
        transcriptState: resumeTranscript,
        hasTranscript: transcriptHasFinalItems(resumeTranscript) > 0,
        hasBoundLiveSession: Boolean(resumableSegment.liveSessionId)
      });
      setMeetingViewStats({
        archivedSegmentCount: Math.max(0, segments.length - 1),
        loadedSegmentCount: archivedTranscriptSegmentsRef.current.length
      });
      applyCloudSaveSnapshot(cloudSaveCoordinatorRef.current.snapshot());
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

    try {
      const detail = await loadMeetingDetailWithLocalTranscript(id);

      if (meetingDetailRequestIdRef.current !== requestId || selectedMeetingIdRef.current !== id) {
        return;
      }

      if (detail) {
        meetingDetailCacheRef.current.set(id, detail);
      } else {
        meetingDetailCacheRef.current.delete(id);
      }
      setSelectedMeetingDetail(detail);
    } catch (loadError) {
      if (meetingDetailRequestIdRef.current !== requestId || selectedMeetingIdRef.current !== id) {
        return;
      }

      setSelectedMeetingDetail(null);
      setMeetingDetailError(loadError?.code === 'local_transcript_read_failed'
        ? '本機字幕資料載入失敗，未以空白會議取代。請在這台設備重試。'
        : meetingApiErrorMessage(loadError, '會議詳細資料載入失敗。請重試。'));
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
      const detail = await loadMeetingDetailWithLocalTranscript(id);

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
    } catch (loadError) {
      if (meetingDetailRequestIdRef.current === requestId && selectedMeetingIdRef.current === id) {
        setMeetingDetailError(loadError?.code === 'local_transcript_read_failed'
          ? '本機字幕資料載入失敗，請保留這個瀏覽器的本機資料後重試。'
          : meetingApiErrorMessage(loadError, '會議詳細資料無法更新。'));
      }

      return false;
    }
  }

  async function loadMeetingDetailWithLocalTranscript(id) {
    const detail = await meetingReadApiClientRef.current.getMeetingDetail(id);
    if (!detail) return detail;
    await localMeetingRetentionRef.current?.observeMeeting(detail.meeting);
    if (detail.meeting?.contentState === 'expired') {
      void localMeetingRetentionRef.current?.check(id).catch(() => {});
      return detail;
    }

    try {
      const persistence = getLocalMeetingPersistence();
      const localCues = await persistence.listCues(id);
      const merged = mergeMeetingDetailWithLocalCues(detail, localCues);
      const [localAudio, localAudioStatus] = await Promise.all([
        persistence.listFinalizedAudioArtifacts?.(id),
        persistence.getLocalAudioStatus?.(id)
      ]);
      return mergeMeetingDetailWithLocalAudio(merged, localAudio, localAudioStatus);
    } catch (error) {
      const wrapped = new Error('Local meeting transcript could not be read.', { cause: error });
      wrapped.code = 'local_transcript_read_failed';
      throw wrapped;
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

  async function forceStopForNavigation() {
    if (forcedNavigationStopPromiseRef.current) return forcedNavigationStopPromiseRef.current;

    forcedNavigationStopPromiseRef.current = (async () => {
      try {
        await liveController.actions.endCurrentSession({ redirectHash: null });
      } finally {
        const targetHash = pendingForcedNavigationHashRef.current;
        pendingForcedNavigationHashRef.current = null;
        forcedNavigationStopPromiseRef.current = null;
        if (targetHash && window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
      }
    })();
    return forcedNavigationStopPromiseRef.current;
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
    setMeetingCheckpointErrorMessage('');
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

    const activeMeetingId = activeMeetingCheckpointRef.current?.meetingId || '';
    const samePausedMeeting = status === 'paused' && activeMeetingId === meetingId;
    if (isNavigationLocked || (status === 'paused' && activeMeetingId && activeMeetingId !== meetingId)) {
      setError('錄音進行中，請先結束目前工作階段後再切換目錄。');
      return;
    }

    if (!samePausedMeeting) await resetLiveMeetingState();
    window.location.hash = `#live?meetingId=${encodeURIComponent(meetingId)}`;
  }

  function preventLiveNavigationWhileRecording(event) {
    if (!isActive) return;
    event.preventDefault();
    setError('請先暫停或停止目前錄音，再修改設定或返回會議管理。');
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
  const liveAudioPreference = getMeetingAudioPreference(routeMeetingId);
  const canRecordLiveMeeting = Boolean(
    routeMeetingId && (
      ['created', 'active', 'interrupted'].includes(liveMeeting?.status) ||
      resumeDraft?.meetingId === routeMeetingId
    )
  );
  const liveMeetingStartReady = isLiveMeetingStartReady({
    meetingId: routeMeetingId,
    resumeDraft: liveController.resumeDraft
  });
  const startLiveRecording = async () => {
    if (!liveMeetingStartReady) {
      setError('會議資料仍在準備中，請稍候。');
      return;
    }
    if (!hasLiveCredential()) {
      setLiveErrorCode('gemini_api_key_required');
      setError('請貼上 Gemini API Key，再開始錄製。');
      return;
    }
    if (!hasConfirmedMeetingAudioPreference(liveAudioPreference)) {
      setError('請先回到會議設定確認音訊裝置，再開始錄製。');
      window.location.hash = `#meeting-settings?mode=edit&meetingId=${encodeURIComponent(routeMeetingId)}`;
      return;
    }
    if (startLiveRecordingInFlightRef.current) return;

    startLiveRecordingInFlightRef.current = true;
    setIsStartingLiveRecording(true);
    try {
      setError('');
      setLiveErrorCode('');
      await (liveController.resumeDraft?.hasTranscript || liveController.resumeDraft?.hasBoundLiveSession
        ? liveController.actions.resumeMeetingSession()
        : liveController.actions.startSession());
    } finally {
      startLiveRecordingInFlightRef.current = false;
      setIsStartingLiveRecording(false);
    }
  };
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
    settings: () => <GeminiCredentialPage />,
    admin: () => (
      <WorkspacePage
        managementShell
        className="account-management-shell"
        title="帳號管理"
        titleId="account-management-title"
        subtitle="管理工作區成員與資產移轉。"
        headerAction={<a className="button secondary meeting-header-action" href="#meetings">返回會議管理</a>}
      >
        <AccountManagementPage />
      </WorkspacePage>
    ),
    audit: () => (
      <WorkspacePage
        managementShell
        className="account-management-shell"
        title="稽核紀錄"
        titleId="audit-log-page-title"
        subtitle="查看工作區管理操作的安全紀錄。"
        headerAction={<a className="button secondary meeting-header-action" href="#meetings">返回會議管理</a>}
      >
        <AuditLogPage />
      </WorkspacePage>
    ),
  };

  const workspaceView = () => {
    const isMeetingManagementPage = page === 'meetings';
    const isGlobalGlossaryPage = page === 'glossary';
    const isMeetingDetailPage = page === 'meeting-detail';
    const usesMeetingManagementShell = isMeetingManagementPage || isGlobalGlossaryPage || isLiveSurface;
    const liveAudioStatusHasError = hasAudioStatusError({
      shouldRecordInputAudio,
      recordingState,
      translatedAudioState
    });
    const liveCheckpointMessages = [
      ...composeCheckpointStatusMessage({
        meetingCheckpointStatus,
        checkpointErrorMessage: meetingCheckpointErrorMessage,
        shouldRecordInputAudio,
        recordingState,
        translatedAudioState
      }),
      ...(correctionGlossaryStatus === 'pending'
        ? ['字典更新尚未同步；錄音會繼續使用上一個已確認版本，可返回此頁重試。']
        : [])
    ];
    const liveStatusNeedsAttention = Boolean(
      controlLeaseSnapshot && !hasSessionControl
    ) || meetingCheckpointStatus === 'error' || correctionGlossaryStatus === 'pending'
      || liveAudioStatusHasError || Boolean(deviceMessage);

    return (
    <WorkspacePage
      managementShell={usesMeetingManagementShell}
      className={isLiveSurface ? `live-recording-app-shell${isLiveFocusMode ? ' is-live-focus-mode' : ''}` : isMeetingDetailPage ? 'meeting-detail-app-shell' : ''}
      title={isMeetingManagementPage ? '會議管理' : isGlobalGlossaryPage ? '全域字典' : isMeetingDetailPage ? '會議紀錄' : '即時字幕'}
      titleId={isMeetingManagementPage ? 'meeting-management-title' : isGlobalGlossaryPage ? 'glossary-page-title' : isMeetingDetailPage ? 'meeting-detail-page-title' : undefined}
      subtitle={isMeetingManagementPage ? '先建立會議並完成設定，再分享給參與者錄音。' : isGlobalGlossaryPage ? '管理所有會議室都可以查看並選擇的共用詞條。' : isMeetingDetailPage ? '查看這場會議的完整時間軸、逐字稿與匯出內容。' : '會議字幕工作台'}
      headerAction={isLiveSurface ? (
        <div className="live-header-actions">
          {routeMeetingId ? <a className="button secondary meeting-header-action live-meeting-settings-button" href={`#meeting-settings?mode=edit&meetingId=${encodeURIComponent(routeMeetingId)}`} onClick={preventLiveNavigationWhileRecording}><Pencil size={16} aria-hidden="true" />修改會議設定</a> : null}
          <a
            className="button secondary meeting-header-action"
            href="#meetings"
            onClick={(event) => {
              if (isActive) {
                preventLiveNavigationWhileRecording(event);
                return;
              }
              event.preventDefault();
              setError('');
              window.location.hash = '#meetings';
            }}
          >
            <ArrowRight size={18} aria-hidden="true" />
            返回會議管理
          </a>
        </div>
      ) : isGlobalGlossaryPage || isMeetingDetailPage ? (
        <a
          className="button secondary meeting-header-action"
          href="#meetings"
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
        onEndMeeting={endMeetingFromManagement}
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
        errorCode={liveErrorCode}
        status={meetingDetailError ? 'error' : liveController.status}
        onRetry={() => {
          if (meetingDetailError) {
            void loadMeetingDetail(routeMeetingId);
            return;
          }
          void startLiveRecording();
        }}
      >
        <div className="live-workspace-stack">
        <div className="live-session-toolbar meeting-settings-card" data-testid="live-session-toolbar">
          <div className="control-status-row">
            <div className="live-meeting-summary-column">
              <div className="live-meeting-summary">
                <div className="live-meeting-summary-main">
                  <h2>{liveMeeting?.name || (routeMeetingId ? '正在載入會議…' : '尚未選擇會議')}</h2>
                  <p className="live-meeting-language">{liveMeeting ? `來源語言：${targetLanguageLabelFor(liveMeeting.sourceLanguageCode) || liveMeeting.sourceLanguageCode}` : '請先選擇一場可錄音的會議'}</p>
                </div>
                <span className="live-meeting-status status-pill">{liveMeetingStatusLabel(liveMeeting, liveController.status)}</span>
              </div>
              {!routeMeetingId ? <LiveMeetingPicker meetings={meetingRecords} selectedMeetingId="" disabled={controlsLocked} onChange={(meetingId) => selectLiveTranslationMode(`meeting:${meetingId}`)} /> : null}
            </div>

            <div className="live-toolbar-status">
              {liveController.meetingStartedAt && ['connecting', 'listening', 'reconnecting', 'switching-segment', 'paused'].includes(liveController.status)
                ? <MeetingElapsedTimer startedAt={liveController.meetingStartedAt} />
                : null}
              <span className={`live-save-status status-pill checkpoint-note-${meetingCheckpointStatus}`}>
                {meetingCheckpointStatusLabel(meetingCheckpointStatus)}
              </span>
              <button
                className="button detail-button live-status-details-button"
                type="button"
                aria-expanded={isLiveStatusDetailsOpen}
                aria-controls="live-session-status-details"
                onClick={() => setIsLiveStatusDetailsOpen((current) => !current)}
              >
                詳細狀態
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="control-actions">
              <DiagnosticExportButton role="recorder" meetingId={routeMeetingId} className="recorder-diagnostic-export" />
              <button
                className="button detail-button live-focus-mode-button"
                type="button"
                aria-label={isLiveFocusMode ? '退出專注' : '專注模式'}
                aria-pressed={isLiveFocusMode}
                title={isLiveFocusMode ? '退出專注模式' : '進入專注模式'}
                onClick={() => setIsLiveFocusMode((current) => !current)}
              >
                {isLiveFocusMode ? <Minimize2 size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
                <span>{isLiveFocusMode ? '退出專注' : '專注模式'}</span>
              </button>
              <div className="session-actions">
              {liveController.status === 'listening' ? (
                  <>
                    <button className="button secondary" type="button" onClick={liveController.actions.pauseSession} disabled={meetingCheckpointStatus === 'ending'}>
                      <Pause size={18} aria-hidden="true" />
                      停止錄音
                    </button>
                    <button className="button secondary" type="button" onClick={() => liveController.actions.endCurrentSession({ completeMeeting: true })} disabled={meetingCheckpointStatus === 'ending'}>
                      <Square size={18} aria-hidden="true" />
                      結束會議
                    </button>
                  </>
                ) : liveController.status === 'reconnecting' || liveController.status === 'switching-segment' ? (
                  <button className="button secondary" type="button" onClick={() => liveController.actions.endCurrentSession({ completeMeeting: true })} disabled={meetingCheckpointStatus === 'ending'}>
                    <Square size={18} aria-hidden="true" />
                    結束會議
                  </button>
                ) : liveController.status === 'paused' ? (
                  <>
                    <button className="button primary" type="button" onClick={liveController.actions.continuePausedSession} disabled={meetingCheckpointStatus === 'ending'}>
                      <Play size={18} aria-hidden="true" />
                      繼續
                    </button>
                    <button className="button secondary" type="button" onClick={liveController.actions.completeResumableMeeting} disabled={meetingCheckpointStatus === 'ending'}>
                      <Square size={18} aria-hidden="true" />
                      結束會議
                    </button>
                  </>
              ) : canRecordLiveMeeting ? (
                  <button
                    className="button primary meeting-live-action-button"
                    type="button"
                    onClick={startLiveRecording}
                    disabled={!liveMeetingStartReady || isActive || isStartingLiveRecording || meetingCheckpointStatus === 'ending' || Boolean(controlLeaseSnapshot && !hasSessionControl)}
                  >
                    {liveController.isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                    {!liveMeetingStartReady
                      ? '正在準備會議…'
                      : isStartingLiveRecording
                        ? '正在檢查設定…'
                        : liveController.isActive
                        ? '正在開始'
                        : (liveController.resumeDraft?.hasTranscript || liveController.resumeDraft?.hasBoundLiveSession) ? '繼續錄製' : '開始錄製'}
                  </button>
                ) : null}
                {routeMeetingId && liveController.resumeDraft?.meetingId === routeMeetingId && !liveController.isActive && liveController.status === 'idle' ? (
                  <button className="button secondary meeting-live-action-button" type="button" onClick={liveController.actions.completeResumableMeeting} disabled={meetingCheckpointStatus === 'ending'}>
                    結束會議
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          {liveStatusNeedsAttention ? (
            <div className="live-status-attention" role={meetingCheckpointStatus === 'error' || liveAudioStatusHasError ? 'alert' : 'status'}>
              {controlLeaseSnapshot && !hasSessionControl ? <p>目前已有工作階段由其他頁籤控制；本頁面只能唯讀查看。</p> : null}
              {deviceMessage ? <p>{deviceMessage}</p> : null}
          {meetingCheckpointStatus === 'error' || correctionGlossaryStatus === 'pending' || liveAudioStatusHasError
            ? <p>{liveCheckpointMessages.join(' ')}</p>
            : null}
            </div>
          ) : null}
          {isLiveStatusDetailsOpen ? (
            <div className="live-session-status live-session-status-details" id="live-session-status-details">
              <div className="live-device-summary" aria-label="已確認的音訊裝置">
                <span>麥克風：{liveAudioPreference?.inputDeviceLabel || '尚未確認'}</span>
                <span>揚聲器：{liveAudioPreference?.outputDeviceLabel || '瀏覽器預設揚聲器'}</span>
              </div>
              <p className="device-note" data-testid="recording-health">
                錄音：{['listening', 'switching-segment', 'reconnecting'].includes(liveController.status)
                  ? '持續中'
                  : liveController.status === 'paused' ? '已暫停' : '未進行'}
              </p>
              <p className="device-note" data-testid="segment-health">
                分段：{segmentRolloverStatus === 'switching'
                  ? '切換中'
                  : segmentRolloverStatus === 'recovery-pending' ? '切換失敗，保留恢復狀態' : '目前段落正常'}
              </p>
              <p className={`checkpoint-note checkpoint-note-${meetingCheckpointStatus}`} data-testid="persistence-health">
                雲端保存：{meetingCheckpointStatusLabel(meetingCheckpointStatus)}
              </p>
              <p className="device-note" data-testid="viewer-health">
                Viewer：{webRtcConnectionLabel(webRtcDevice.value, { device: true })}
                {['failed', 'recovery_failed'].includes(webRtcDevice.value) ? (
                  <button className="button detail-button" type="button" onClick={webRtcDevice.retry}>重試</button>
                ) : null}
              </p>
              {liveController.status === 'reconnecting' ? <p className="device-note">正在重新連線即時字幕…</p> : null}
              {liveController.status === 'switching-segment' ? <p className="device-note">正在切換下一段即時字幕…</p> : null}
              {liveController.status === 'paused' ? (
                <p className="device-note">
                  {shouldRecordInputAudio
                    ? '工作階段已暫停；字幕與本機錄音片段會保留到結束本次工作階段。'
                    : '工作階段已暫停；字幕會保留到結束本次工作階段。'}
                </p>
              ) : null}
              <p className={`checkpoint-note checkpoint-note-${meetingCheckpointStatus}`}>{liveCheckpointMessages.join(' ')}</p>
              {meetingViewStats.archivedSegmentCount > 0 ? (
                <p className="checkpoint-note">
                  保存狀態：長會議已保存 {meetingViewStats.archivedSegmentCount} 段 · 目前段落 {activeSegmentTranscriptCount(transcript)} 筆
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="live-transcript-column">
        <LiveCuePanelView
          cueState={liveController.subtitleCueState}
          fallbackTranscriptItems={unrepresentedTranscriptItems({
            archivedTranscript: liveController.archivedTranscript,
            transcript: liveController.transcript,
            cues: [
              ...liveController.subtitleCueState.finalCues,
              liveController.subtitleCueState.currentCue,
              ...(liveController.subtitleCueState.pendingCues || [])
            ].filter(Boolean)
          })}
          status={liveController.status}
          statusLabelOverride={liveController.statusLabelOverride}
          isPaused={liveController.status === 'paused'}
          isStopped={liveController.status === 'stopped'}
          copiedSource={copiedArticleStream === 'source'}
          copiedTranslation={copiedArticleStream === 'translation'}
          onCopySource={liveController.actions.copyLiveSource}
          onCopyTranslation={liveController.actions.copyLiveTranslation}
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

function isVisibleMeetingExpired(meeting, now = Date.now()) {
  const deadline = Date.parse(meeting?.expiresAt || '');
  return meeting?.status === 'completed' && Number.isFinite(deadline) && deadline <= now;
}

function stripExpiredMeetingContent(detail) {
  if (!detail?.meeting || !isVisibleMeetingExpired(detail.meeting)) return detail;
  if (detail.meeting.contentState === 'expired' && !detail.segments?.length &&
    !detail.timeline?.length && !detail.transcriptItems?.length && !detail.cues?.length &&
    !Object.keys(detail.audioArtifacts || {}).length && !detail.cloudAudioArtifacts?.length &&
    !detail.readingContent?.sourceTranscript?.text && !detail.readingContent?.translationArticle?.text) return detail;
  const meeting = { ...detail.meeting, contentState: 'expired' };
  const readingContent = {
    sourceTranscript: { kind: 'sourceTranscript', status: 'empty', text: '', paragraphs: [] },
    translationArticle: { kind: 'translationArticle', status: 'empty', text: '', paragraphs: [] }
  };
  return { ...detail, meeting, segments: [], timeline: [], transcriptItems: [], cues: [],
    audioArtifacts: {}, cloudAudioArtifacts: [], readingContent };
}
