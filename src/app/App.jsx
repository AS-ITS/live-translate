import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { dataGridProps } from '../lib/dataGrid.js';
import { Activity, ArrowRight, BookOpen, CalendarDays, Check, CheckCircle2, Clock3, Copy, Download, FileText, Filter, Globe2, MoreHorizontal, Mic, MicOff, Pause, Play, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Square, Tag, Trash2, X } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../lib/languages.js';
import { classifyConnectionFailure } from '../lib/connectionFailures.js';
import { failureUiStateForClassification } from '../lib/failureUiState.js';
import { audioInputDevices, requestAudioInputStream } from '../lib/mediaDevices.js';
import { createReconnectController } from '../lib/reconnectController.js';
import { createMemorySessionRepository } from '../lib/sessionRepository.js';
import { createSessionReadApiClient } from '../lib/sessionReadApiClient.js';
import { createSessionControlLease } from '../lib/sessionControlLease.js';
import { createMeetingReadApiClient } from '../lib/meetingReadApiClient.js';
import { createSessionSnapshotApiClient } from '../lib/sessionSnapshotApiClient.js';
import { createSessionCommandApiClient } from '../lib/sessionCommandApiClient.js';
import { createSessionSnapshotSyncCoordinator } from '../lib/sessionSnapshotSyncCoordinator.js';
import { createMeetingCheckpointApiClient } from '../lib/meetingCheckpointApiClient.js';
import { createMeetingCueApiClient } from '../lib/meetingCueApiClient.js';
import {
  checkpointChunksForTranscriptItems,
  createMeetingCheckpointSyncCoordinator
} from '../lib/meetingCheckpointSyncCoordinator.js';
import { createSegmentSwitchOrchestrator } from '../lib/segmentSwitchOrchestrator.js';
import { createTranslationCommandApiClient } from '../lib/translationCommandApiClient.js';
import { createGlossaryApiClient } from '../lib/glossaryApiClient.js';
import { selectedMeetingGlossaryEntries } from '../lib/meetingGlossary.js';
import { createMeetingManagementApiClient } from '../lib/meetingManagementApiClient.js';
import {
  filterMeetingManagementItems,
  meetingManagementLastUpdated,
  meetingManagementStatusLabel,
  MEETING_STATUS_FILTERS
} from '../lib/meetingManagement.js';
import { accessTokenHeaders, authenticatedFetch } from '../lib/accessToken.js';
import { applyGlossaryReplacements } from '../lib/glossaryReplacement.js';
import { missingNumericIntegrity } from '../lib/numericIntegrity.js';
import { createTranslationCommandLifecycle } from '../lib/translationCommandLifecycle.js';
import { formatTranslationCommandPersistenceError } from '../lib/translationCommandError.js';
import { createTranscriptPolishingLifecycle } from '../lib/transcriptPolishingLifecycle.js';
import { createCueRefinementCoordinator, mergePolishedItemsFromOutputs } from '../lib/transcriptPolishing.js';
import { applyCueRefinementExecutionStates, completedCueRefinementOutputs, markCuesCompletedByRefinedSubtitleCues, mergeCuesByIdPreferRefinement, refinedSubtitleCuesForDisplay } from '../lib/cueRefinement.js';
import { effectiveSourceForCue, effectiveTranslationForCue, rawSourceForCue, rawTranslationForCue } from '../lib/cueContent.js';
import { mergeRetranslationHistoryIntoDetail } from '../lib/sessionTranslationHistory.js';
import { createExportApplicationService } from '../application/exportApplicationService.js';
import {
  appendNewFinalTranscriptItems,
  buildFinalizePatch,
  buildSessionRecordInput,
  createActiveSessionRecord,
  finalizeActiveSessionRecord
} from '../lib/sessionRecordLifecycle.js';
import {
  buildSavedSessionFileName,
  canExportSavedSession
} from '../lib/sessionRecordExport.js';
import { canExportTranscript } from '../lib/transcriptExport.js';
import { meetingExportSources } from '../lib/meetingTranscriptExport.js';
import {
  canExportCues,
  wrapSubtitleText
} from '../lib/subtitleCueExport.js';
import { toTraditionalChineseSourceContent, toTraditionalChineseText } from '../lib/chineseText.js';
import {
  applyTranscriptEvent,
  buildTranscriptArticleParagraphs,
  createTranscriptState,
  describeTranscriptSegmentDecision,
  formatTranscriptArticleText,
  finalizePendingTranscriptItems,
  resetTranscriptState,
  transcriptItemsForStream
} from '../lib/transcript.js';
import { createMicrophoneRecordingController } from '../lib/microphoneRecording.js';
import { createAudioUploadController } from '../lib/audioUploadController.js';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  dismissSubtitleCue,
  finalizePendingSubtitleCue,
  prepareSubtitleCueStateForNewSegment,
  resetSubtitleCueState,
  resolveIdleSubtitleCue,
  markNumericCorrectionRequested,
  DEFAULT_TURN_COMPLETE_DEBOUNCE_MS
} from '../lib/subtitleCues.js';
import {
  cueListForDisplay,
  sourceTextForCopy,
  translationTextForCopy
} from '../lib/cueUi.js';
import {
  INPUT_SAMPLE_RATE,
  buildInputAudioFileName,
  buildTranslatedAudioFileName,
  pcm16ChunksToWavBlob
} from '../lib/audio.js';
import { canonicalHashForLocation, FEATURE_PAGES, pageFromLocation, pageInfoFromLocation } from './routes.js';
import { AppRouter } from './AppRouter.jsx';
import { MeetingLayout, MeetingSettingsLayout, PublicSessionLayout } from '../layouts/AppLayout.jsx';
import { MeetingSettingsPage } from '../pages/meetings/MeetingSettingsPage.jsx';
import { MeetingViewerPage } from '../pages/viewer/MeetingViewerPage.jsx';
import { GlobalGlossaryPage } from '../pages/glossary/GlobalGlossaryPage.jsx';
import { LiveMeetingPicker, LiveRecordingPage, liveMeetingStatusLabel } from '../pages/live/LiveRecordingPage.jsx';
import { LiveCuePanel as LiveCuePanelView } from '../features/live/LiveCuePanel.jsx';
import { applyCompletedRefinementOutputs } from '../features/live/liveRecordingController.js';
import { AudioArtifactDownloads } from '../features/history/AudioArtifactDownloads.jsx';

const RECONNECT_FAILED_MESSAGE = '無法重新連線即時字幕。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時字幕多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);
const DEFAULT_GLOSSARY_CATEGORIES = [
  { id: 'product', label: '產品名稱' },
  { id: 'department', label: '部門／職能' },
  { id: 'abbreviation', label: '縮寫' },
  { id: 'meeting', label: '會議常用語' },
  { id: 'technical', label: '技術名詞' },
  { id: 'other', label: '其他' }
];
const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const LIVE_CUE_IDLE_FINALIZE_MS = DEFAULT_TURN_COMPLETE_DEBOUNCE_MS;
const SESSION_SNAPSHOT_SYNC_DELAY_MS = 1000;
const SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE = 20;
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const TRANSCRIPT_POLISHING_ENABLED = import.meta.env?.VITE_TRANSCRIPT_POLISHING_ENABLED !== 'false';
const TRANSCRIPT_POLISHING_INTERVAL_MS = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_INTERVAL_MS || '30000', 10);
const TRANSCRIPT_POLISHING_MIN_CHARS = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MIN_CHARS || '200', 10);
const TRANSCRIPT_POLISHING_MAX_RPM = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MAX_RPM || '15', 10);
const SEGMENT_SWITCH_INTERVAL_MS = 10 * 60 * 1000;
const exportApplicationService = createExportApplicationService();
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
  const [meetingLoadError, setMeetingLoadError] = useState('');
  const [isLoadingMeetings, setIsLoadingMeetings] = useState(false);
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
  const recordingControllerRef = useRef(null);
  const inputAudioUploadChunksRef = useRef([]);
  const inputAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const translatedAudioUploadChunksRef = useRef([]);
  const translatedAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const audioUploadSegmentsRef = useRef(createAudioUploadSegmentState());
  const audioUploadRetryTimersRef = useRef({ input: null, translation: null });
  const audioUploadRetryAttemptsRef = useRef({ input: 0, translation: 0 });
  const audioUploadControllerRef = useRef(null);
  const transcriptRef = useRef(transcript);
  const subtitleCueStateRef = useRef(subtitleCueState);
  const transcriptTimeOriginRef = useRef(null);
  const archivedTranscriptRef = useRef(archivedTranscript);
  const archivedTranscriptSegmentsRef = useRef([]);
  const reconnectControllerRef = useRef(null);
  const inputDevicesRef = useRef(inputDevices);
  const selectedInputDeviceIdRef = useRef(selectedInputDeviceId);
  const reconnectSessionRef = useRef(null);
  const sessionRepositoryRef = useRef(createMemorySessionRepository());
  const sessionSnapshotApiClientRef = useRef(createSessionSnapshotApiClient());
  const sessionCommandApiClientRef = useRef(createSessionCommandApiClient());
  const sessionSnapshotSyncCoordinatorRef = useRef(null);
  const pendingSessionSnapshotItemIdsRef = useRef(new Map());
  const meetingCheckpointApiClientRef = useRef(createMeetingCheckpointApiClient());
  const meetingCueApiClientRef = useRef(createMeetingCueApiClient({ fetchImpl: authenticatedFetch(fetch) }));
  const meetingCheckpointSyncCoordinatorRef = useRef(null);
  const segmentSwitchOrchestratorRef = useRef(null);
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
      reconnectController().setConnectivity(false);
      setStatusLabelOverride('網路離線');
      setError('網路已中斷，等待恢復後重新連線。');
      if (sessionRef.current) {
        void sessionRef.current.handleNetworkOffline();
      }
    };
    const handleOnline = () => {
      reconnectController().setConnectivity(true);
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
    reconnectControllerRef.current?.cancel();
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);
    sessionRef.current = null;
    reconnectSessionRef.current = null;
    sessionSnapshotSyncCoordinatorRef.current?.cancel();
    meetingCheckpointSyncCoordinatorRef.current?.cancel();
    if (refinementRateLimitTimerRef.current) window.clearTimeout(refinementRateLimitTimerRef.current);
    refinementRateLimitTimerRef.current = null;
    cancelAudioUploadRetries();
    segmentSwitchOrchestratorRef.current?.cancel();
    for (const session of sessions) {
      void session?.stop().catch(() => {});
    }
    void recordingControllerRef.current?.cleanup({ discard: true }).catch(() => {});
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
        requestNumericCorrection(nextState);
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

  async function startSession() {
    if (status === 'active' || status === 'paused' || isActive || sessionRef.current || activeSessionRecordIdRef.current) {
      setError('目前已有工作階段正在進行或暫停中，請先暫停或結束目前工作階段。');
      return;
    }
    if (sessionControlLeaseRef.current?.current()) {
      setError('目前已有工作階段由其他頁籤控制。請先在原頁籤結束後再開始。');
      return;
    }
    const selectedRouteMeetingId = pageInfoFromLocation().meetingId;
    const selectedResumableMeeting = meetingRecords.find((meeting) => meeting.id === selectedRouteMeetingId && ['created', 'active', 'interrupted'].includes(meeting.status));
    if (!selectedResumableMeeting) {
      setError('請先選擇一個可錄音的會議。');
      return;
    }
    invalidateLiveSessionCallbacks();
    sessionStopRequestedRef.current = false;
    meetingResumeDraftRequestIdRef.current += 1;
    reconnectController().reset();
    reconnectFailureDiagnosticRef.current = null;
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = true;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    let session;
    let record = null;
    setStatus('requesting-permission');
    const inputDeviceIdForSession = inputDevicesRef.current.some((device) => device.deviceId === selectedInputDeviceIdRef.current)
      ? selectedInputDeviceIdRef.current
      : '';
    const microphoneStreamPromise = requestAudioInputStream(inputDeviceIdForSession).catch((nextError) => {
      if (inputDeviceIdForSession && (nextError?.name === 'NotFoundError' || nextError?.name === 'OverconstrainedError')) {
        selectedInputDeviceIdRef.current = '';
        setSelectedInputDeviceId('');
        setDeviceMessage('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
        return requestAudioInputStream('');
      }
      throw nextError;
    });

    try {
      const microphoneStream = await microphoneStreamPromise;
      await recordingController().cleanup({ discard: true });
      resetInputAudioDownload();
      resetTranslatedAudioDownload();
      pendingMicrophoneStreamRef.current = null;
      const liveSessionId = generateLiveSessionId();
      const routeMeetingId = selectedRouteMeetingId;
      let meetingCheckpoint;
      if (routeMeetingId) {
        const segmentsResult = await meetingCheckpointApiClientRef.current.listSegments({ meetingId: routeMeetingId });
        const segment = [...segmentsResult.segments].reverse().find((item) => ['created', 'active'].includes(item.status) && !item.liveSessionId);
        if (!segment) throw new Error('此會議目前沒有可開始的錄音段落。');
        const started = await meetingCheckpointApiClientRef.current.startMeeting({ meetingId: routeMeetingId, segmentId: segment.id, liveSessionId });
        meetingCheckpoint = { meetingId: started.meeting.id, segmentId: started.segment.id };
        activeMeetingCheckpointRef.current = meetingCheckpoint;
        meetingCheckpointSyncCoordinator().start(meetingCheckpoint);
      } else {
        meetingCheckpoint = await createMeetingCheckpointForSession({
          liveSessionId,
          glossaryEntries: selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode),
          privateGlossaryEntries: privateMeetingGlossaryEntries
        });
      }
      record = await createCurrentSessionRecord(meetingCheckpoint);
      if (!sessionControlLeaseRef.current?.tryAcquire(record.id)) {
        throw new Error('目前已有工作階段由其他頁籤控制。');
      }
      setHasSessionControl(true);
      session = await createSession({ preserveTranscript: false, liveSessionId });
      sessionRef.current = session;

      await session.start({ inputStream: microphoneStream });
      activateLiveSessionCallbacks(session.callbackGeneration);
      const activeRecord = sessionRepositoryRef.current.updateSessionRecord(record.id, {
        status: 'active',
        startedAt: record.startedAt || Date.now(),
        lastLifecycleState: 'listening'
      });
      await flushSessionSnapshot(record.id);
      await startRecordingForSession(activeRecord);
      setStatus('listening');
      updateLiveMeetingUrl(meetingCheckpoint.meetingId);
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
      if (sessionStopRequestedRef.current) return;
      if (record?.id) {
        sessionControlLeaseRef.current?.release(record.id);
        setHasSessionControl(false);
        sessionRepositoryRef.current.updateSessionRecord(record.id, {
          status: 'failed',
          failureReason: 'live_connect_failed',
          failureCategory: 'provider'
        });
        await flushSessionSnapshot(record.id).catch(() => {});
        activeSessionRecordIdRef.current = null;
      }
      activeMeetingCheckpointRef.current = null;
      meetingCheckpointSyncCoordinatorRef.current?.cancel();
      segmentSwitchOrchestratorRef.current?.cancel();
      applyStartFailure(nextError, '無法開始即時字幕。');
    }
  }

  async function pauseSession() {
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    const reconnectingSession = reconnectSessionRef.current;
    reconnectSessionRef.current = null;
    await pauseRawAudioRecording();
    await reconnectingSession?.stop().catch(() => {});
    await sessionRef.current?.stop();
    sessionRef.current = null;
    invalidateLiveSessionCallbacks();
    liveCueUpdatesAllowedRef.current = false;
    await finalizePendingTranscriptItemsForStop();
    flushSubtitleCues('pause');
    await flushMeetingCheckpointSync();
    await updateCurrentSessionStatus('paused');
    pendingMicrophoneStreamRef.current = null;
    setStatus('paused');
  }

  async function continuePausedSession() {
    if (status !== 'paused') return;

    invalidateLiveSessionCallbacks();
    sessionStopRequestedRef.current = false;
    reconnectController().reset();
    reconnectFailureDiagnosticRef.current = null;
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    setError('');
    pendingMicrophoneStreamRef.current = null;
    const preparedCueState = prepareSubtitleCueStateForNewSegment(subtitleCueStateRef.current, {
      sessionTimeMs: sessionTimeForSubtitleCues(),
      reason: 'continue'
    });
    subtitleCueStateRef.current = preparedCueState;
    setSubtitleCueState(preparedCueState);

    let session;
    try {
      session = await createSession({ preserveTranscript: true, liveSessionId: generateLiveSessionId() });
      sessionRef.current = session;
      await session.start();
      setTranscriptTimeOriginValue();
      if (!activateLiveSessionCallbacks(session.callbackGeneration)) {
        throw new Error('即時字幕 callback 啟動失敗。');
      }
      await resumeRawAudioRecording();
      liveCueUpdatesAllowedRef.current = true;
      await updateCurrentSessionStatus('active', { lastLifecycleState: 'listening' });
      clearSessionSnapshotSyncError();
      setStatus('listening');
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
      if (sessionStopRequestedRef.current) return;
      sessionRef.current = null;
      applyStartFailure(nextError, '無法繼續即時字幕。');
    }
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

  async function endCurrentSession() {
    sessionStopRequestedRef.current = true;
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    const reconnectingSession = reconnectSessionRef.current;
    const activeSession = sessionRef.current;
    reconnectSessionRef.current = null;
    sessionRef.current = null;
    const inputAudioState = await finalizeRawAudioRecording();
    await reconnectingSession?.stop().catch(() => {});
    if (activeSession !== reconnectingSession) {
      await activeSession?.stop().catch(() => {});
    }
    // A stop can synchronously enqueue terminal Cue events. Drain them before
    // invalidating the callback generation so the final live view is complete.
    flushQueuedLiveCueEvents();
    invalidateLiveSessionCallbacks();
    liveCueUpdatesAllowedRef.current = false;
    await finalizePendingTranscriptItemsForStop();
    flushSubtitleCues('stop');
    await flushMeetingCheckpointSync();
    pendingMicrophoneStreamRef.current = null;
    setResumeDraft(null);
    await finalizeCurrentSessionRecord({
      status: 'stopped',
      failureReason: 'user_stop',
      failureCategory: 'user_intent',
      audioStates: { input: inputAudioState }
    });
    setStatus('stopped');
    window.location.hash = '#meetings';
  }

  async function completeResumableMeeting() {
    const currentMeetingId = pageInfoFromLocation().meetingId;
    if (!resumeDraft || !currentMeetingId || resumeDraft.meetingId !== currentMeetingId || isActive || status !== 'idle') return;
    if (!window.confirm('確定要結束這場會議嗎？既有逐字稿會保留，之後將無法繼續錄製。')) return;

    setError('');
    try {
      flushSubtitleCues('complete');
      const checkpointFlushed = await flushMeetingCheckpointSync();
      if (!checkpointFlushed) throw new Error('Unable to flush meeting checkpoint before completion.');
      await meetingCheckpointApiClientRef.current.completeMeeting({ meetingId: resumeDraft.meetingId });
      setResumeDraft(null);
      activeMeetingCheckpointRef.current = null;
      setMeetingCheckpointStatus('synced');
      await refreshMeetingRecords();
      window.location.hash = '#meetings';
    } catch {
      setError('無法結束會議，請稍後再試。');
    }
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

    const { LiveTranslateSession } = await import('../lib/liveSession.js');
    const callbackGeneration = {
      generation: liveSessionCallbackGenerationRef.current.generation + 1,
      active: false
    };
    liveSessionCallbackGenerationRef.current = callbackGeneration;

    const session = new LiveTranslateSession({
      liveSessionId,
      connectionEpoch: callbackGeneration.generation,
      sessionId: activeSessionRecordIdRef.current,
      meetingId: activeMeetingCheckpointRef.current?.meetingId || null,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || liveSessionId,
      sessionClock: () => sessionTimeForSubtitleCues(),
      targetLanguageCode,
      sourceLanguageCode,
      echoTargetLanguage,
      liveGlossaryEntries: liveGlossaryEntriesForTarget(currentMeetingGlossaryEntries(), targetLanguageCode),
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
        if (isCurrentLiveSessionInstance(callbackGeneration)) handleInputAudioChunk(chunk);
      },
      onInputTranscript: (update) => {
        if (isCurrentLiveSessionCallback(callbackGeneration) && isOwnedLiveSessionEvent(update, callbackGeneration)) {
          applyTranscriptUpdate({ ...update, eventId: update.eventId, connectionEpoch: callbackGeneration.generation, stream: 'source' });
        }
      },
      onOutputTranscript: (update) => {
        if (isCurrentLiveSessionCallback(callbackGeneration) && isOwnedLiveSessionEvent(update, callbackGeneration)) {
          applyTranscriptUpdate({ ...update, eventId: update.eventId, connectionEpoch: callbackGeneration.generation, stream: 'translation' });
        }
      },
      onCueEvent: (event) => {
        if (!isCurrentLiveSessionCallback(callbackGeneration)
          || !isOwnedLiveSessionEvent(event, callbackGeneration)
          || !liveCueUpdatesAllowedRef.current) return;
        const activeGlossaryEntries = sessionRef.current?.liveGlossaryEntries
          || liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode);
        const cueEvent = event?.stream === 'translation'
          ? { ...event, text: applyGlossaryReplacements(event.text, activeGlossaryEntries) }
          : event;
        queueLiveSubtitleCueEvent(cueEvent);
      },
      onOutputAudioChunk: (chunk) => {
        if (isCurrentLiveSessionCallback(callbackGeneration)) handleTranslatedAudioChunk(chunk);
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
        void finalizeFailedSession({
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
          void finalizeFailedSession({
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
        void reconnectController()
          .scheduleReconnect(classification)
          .then((result) => {
            if (!result.scheduled && !result.ignored && !result.paused) {
              suppressReconnectErrorRef.current = false;
              setStatusLabelOverride('');
              setError(reconnectErrorMessage(result, reconnectFailureDiagnosticRef.current));
              setStatus('error');
              void finalizeFailedSession({
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

  function recordingController() {
    if (!recordingControllerRef.current) {
      recordingControllerRef.current = createMicrophoneRecordingController({
        onStateChange: setRecordingState,
        collectChunks: false
      });
    }

    return recordingControllerRef.current;
  }

  async function startRecordingForSession(record) {
    if (!shouldRecordInputAudio) {
      resetInputAudioDownload();
      setRecordingState(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
      return;
    }

    prepareInputAudioDownload(record);
    const stream = pendingMicrophoneStreamRef.current;
    const state = await recordingController().start({
      stream,
      sessionId: record?.id,
      startedAt: record?.startedAt
    });

    if (state.status === 'error') {
      setRecordingState(state);
    }
  }

  function prepareInputAudioDownload(record) {
    inputAudioMetadataRef.current = {
      sessionId: record?.id || '',
      startedAt: record?.startedAt ?? Date.now()
    };
    inputAudioUploadChunksRef.current = [];
    resetAudioUploadSegment('input');
  }

  function resetInputAudioDownload() {
    inputAudioUploadChunksRef.current = [];
    inputAudioMetadataRef.current = { sessionId: '', startedAt: null };
    resetAudioUploadSegment('input');
  }

  function handleInputAudioChunk(bytes) {
    if (!shouldRecordInputAudio) {
      return;
    }

    if (!bytes || !Number.isFinite(bytes.byteLength) || bytes.byteLength === 0) {
      return;
    }

    inputAudioUploadChunksRef.current.push(new Uint8Array(bytes));
    void flushAudioSegmentIfDue('input');
  }

  async function pauseRawAudioRecording() {
    if (!shouldRecordInputAudio) {
      setRecordingState(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
      return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
    }

    const state = await recordingController().pause().catch((nextError) => ({
      status: 'error',
      blob: null,
      mimeType: '',
      extension: '',
      fileName: '',
      errorMessage: nextError?.message || '原始語音錄音無法暫停。'
    }));
    setRecordingState(state);
    return state;
  }

  async function resumeRawAudioRecording() {
    if (!shouldRecordInputAudio) {
      setRecordingState(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
      return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
    }

    const state = await recordingController().resume({ stream: pendingMicrophoneStreamRef.current }).catch((nextError) => ({
      status: 'error',
      blob: null,
      mimeType: '',
      extension: '',
      fileName: '',
      errorMessage: nextError?.message || '原始語音錄音無法繼續。'
    }));
    setRecordingState(state);
    return state;
  }

  async function finalizeRawAudioRecording() {
    if (!shouldRecordInputAudio) {
      setRecordingState(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
      return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
    }

    const inputUploadSegment = audioUploadSegmentsRef.current.input;
    const hasAudio = inputAudioUploadChunksRef.current.length > 0 || inputUploadSegment.nextIndex > 0;
    const state = await recordingController().cleanup({ discard: true }).catch((nextError) => ({
      status: 'error',
      blob: null,
      mimeType: '',
      extension: '',
      fileName: '',
      errorMessage: nextError?.message || '原始語音音檔無法建立。'
    }));

    const savedState = {
      ...state,
      status: hasAudio ? 'saved' : 'idle',
      blob: null,
      mimeType: 'audio/wav',
      extension: 'wav',
      fileName: '',
      errorMessage: ''
    };
    setRecordingState(savedState);
    return savedState;
  }

  function prepareTranslatedAudioDownload(record) {
    translatedAudioMetadataRef.current = {
      sessionId: record?.id || '',
      startedAt: record?.startedAt ?? Date.now()
    };
    translatedAudioUploadChunksRef.current = [];
    resetAudioUploadSegment('translation');
  }

  function resetTranslatedAudioDownload() {
    translatedAudioUploadChunksRef.current = [];
    translatedAudioMetadataRef.current = { sessionId: '', startedAt: null };
    resetAudioUploadSegment('translation');
    setTranslatedAudioState(TRANSLATED_AUDIO_IDLE_STATE);
  }

  function handleTranslatedAudioChunk(bytes) {
    if (!bytes || !Number.isFinite(bytes.byteLength) || bytes.byteLength === 0) {
      return;
    }

    translatedAudioUploadChunksRef.current.push(new Uint8Array(bytes));
    void flushAudioSegmentIfDue('translation');
    setTranslatedAudioState((current) => (
      current.status === 'ready'
        ? current
        : { status: 'recording', blob: null, fileName: '', errorMessage: '' }
    ));
  }

  function finalizeTranslatedAudioDownload(sessionId) {
    const translationUploadSegment = audioUploadSegmentsRef.current.translation;
    const hasAudio = translatedAudioUploadChunksRef.current.length > 0 || translationUploadSegment.nextIndex > 0;
    if (!hasAudio) {
      let nextState = null;
      setTranslatedAudioState((current) => (
        current.status === 'recording' ? (nextState = TRANSLATED_AUDIO_IDLE_STATE) : (nextState = current)
      ));
      return nextState || TRANSLATED_AUDIO_IDLE_STATE;
    }

    const nextState = { status: 'saved', blob: null, fileName: '', errorMessage: '' };
    setTranslatedAudioState(nextState);
    return nextState;
  }

  function updateActiveSessionGlossaryEntries(entries) {
    const liveGlossaryEntries = liveGlossaryEntriesForTarget(entries, targetLanguageCode);
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);

    for (const session of sessions) {
      if (session) session.liveGlossaryEntries = liveGlossaryEntries;
    }
  }

  async function startReconnectSession({ generationId, classification }) {
    if (generationId !== reconnectController().currentGeneration() || sessionStopRequestedRef.current) {
      return;
    }

    setError('');
    invalidateLiveSessionCallbacks();
    setStatusLabelOverride('');
    setStatus('reconnecting');
    segmentSwitchOrchestrator().cancel();

    const meetingCheckpoint = activeMeetingCheckpointRef.current;
    const nextLiveSessionId = generateLiveSessionId();
    let recovery;
    let reconnectStage = 'create_session';
    const session = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
    reconnectSessionRef.current = session;

    try {
      if (!meetingCheckpoint) {
        throw new Error('Missing active meeting checkpoint.');
      }

      reconnectStage = 'flush_audio';
      await pauseRawAudioRecording();
      await finalizePendingTranscriptItemsForStop();
      flushSubtitleCues('reconnect');
      if (generationId !== reconnectController().currentGeneration() || sessionStopRequestedRef.current) {
        await session.stop().catch(() => {});
        return;
      }

      reconnectStage = 'flush_checkpoint';
      const flushed = await flushMeetingCheckpointSync();
      if (!flushed) {
        throw new Error('Unable to flush meeting checkpoint before reconnect.');
      }
      archiveActiveTranscriptSegment();

      reconnectStage = 'recover_segment';
      recovery = await meetingCheckpointApiClientRef.current.recoverSegment({
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

      if (generationId !== reconnectController().currentGeneration() || sessionStopRequestedRef.current) {
        await session.stop().catch(() => {});
        return;
      }

      reconnectStage = 'connect_live_session';
      await session.start();
      if (generationId !== reconnectController().currentGeneration() || sessionStopRequestedRef.current) {
        await session.stop().catch(() => {});
        return;
      }
      activateLiveSessionCallbacks(session.callbackGeneration);
      reconnectStage = 'resume_audio';
      await resumeRawAudioRecording();
    } catch (nextError) {
      if (generationId !== reconnectController().currentGeneration() || sessionStopRequestedRef.current) {
        await session.stop().catch(() => {});
        return;
      }

      await session.stop().catch(() => {});
      reconnectSessionRef.current = null;
      sessionRef.current = null;
      setStatusLabelOverride('');
      const diagnostic = safeReconnectDiagnostic({
        source: 'reconnect_session',
        stage: reconnectStage,
        rawError: nextError,
        reasonHint: classification.reason
      }, classification);
      reconnectFailureDiagnosticRef.current = diagnostic;
      void appendSessionFailureDiagnostic(diagnostic, classification);
      setError(reconnectErrorMessage({ decision: { stopReason: 'reconnect_session_failed' } }, diagnostic));
      setStatus('error');
      void finalizeFailedSession({
        status: 'failed',
        failureReason: classification.reason,
        failureCategory: classification.category
      });
      return;
    }

    if (generationId !== reconnectController().currentGeneration() || segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) {
      await session.stop().catch(() => {});
      return;
    }

    reconnectSessionRef.current = null;
    sessionRef.current = session;
    const nextMeetingCheckpoint = {
      meetingId: meetingCheckpoint.meetingId,
      segmentId: recovery.segment.id
    };
    activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
    meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
    segmentSwitchOrchestrator().start();
    setStatusLabelOverride('');
    setStatus('listening');
  }

  async function resumeMeetingSession() {
    if (!resumeDraft || isActive) return;
    const draft = resumeDraft;

    reconnectController().reset();
    reconnectFailureDiagnosticRef.current = null;
    invalidateLiveSessionCallbacks();
    sessionStopRequestedRef.current = false;
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
    setStatusLabelOverride('');
    setError('');
    setResumeDraft(null);
    resetTranslatedAudioDownload();

    let session;
    let recoveredMeetingCheckpoint = null;
    let resumedSessionRecordId = null;
    let resumedLiveSessionId = null;
    try {
      const nextLiveSessionId = generateLiveSessionId();
      resumedLiveSessionId = nextLiveSessionId;
      setStatus('reconnecting');
      const preparedCueState = prepareSubtitleCueStateForNewSegment(subtitleCueStateRef.current, {
        sessionTimeMs: sessionTimeForSubtitleCues(),
        reason: 'resume'
      });
      subtitleCueStateRef.current = preparedCueState;
      setSubtitleCueState(preparedCueState);
      const segmentsResult = await meetingCheckpointApiClientRef.current.listSegments({ meetingId: draft.meetingId });
      const currentSegment = segmentsResult.segments.find((segment) => segment.id === draft.segmentId);
      const recovery = currentSegment?.status === 'created'
        ? await meetingCheckpointApiClientRef.current.startMeeting({
          meetingId: draft.meetingId,
          segmentId: draft.segmentId,
          liveSessionId: nextLiveSessionId
        })
        : await meetingCheckpointApiClientRef.current.recoverSegment({
          meetingId: draft.meetingId,
          segmentId: draft.segmentId,
          idempotencyKey: `recover:${draft.segmentId}:${nextLiveSessionId}`,
          checkpoint: {
            idempotencyKey: `checkpoint:${draft.segmentId}:resume:${nextLiveSessionId}`,
            durableChunks: [],
            pendingPartial: null,
            finalCues: preparedCueState.finalCues.filter((cue) => cue.segmentId === draft.segmentId),
            cueCheckpoint: cueCheckpointForState(preparedCueState)
          },
          nextLiveSessionId,
          failureReason: 'manual_resume',
          failureCategory: 'user_intent',
          outcome: 'interrupted'
        });
      const nextMeetingCheckpoint = {
        meetingId: draft.meetingId,
        segmentId: recovery.segment.id
      };
      recoveredMeetingCheckpoint = nextMeetingCheckpoint;
      activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
      meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
      const resumedRecord = await createCurrentSessionRecord(nextMeetingCheckpoint, draft.transcriptState, draft.sessionId);
      resumedSessionRecordId = resumedRecord.id;
      resetActiveTranscriptForNextSegment(draft.transcriptState.nextSequence);
      session = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
      sessionRef.current = session;
      await session.start();
      setTranscriptTimeOriginValue();
      if (!activateLiveSessionCallbacks(session.callbackGeneration)) {
        throw new Error('即時字幕 callback 啟動失敗。');
      }
      liveCueUpdatesAllowedRef.current = true;
      sessionRepositoryRef.current.updateSessionRecord(activeSessionRecordIdRef.current, {
        status: 'active',
        startedAt: Date.now(),
        lastLifecycleState: 'listening'
      });
      const snapshotSynced = await flushSessionSnapshot(activeSessionRecordIdRef.current);
      if (snapshotSynced) clearSessionSnapshotSyncError();
      setStatus('listening');
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
      if (recoveredMeetingCheckpoint) {
        await meetingCheckpointApiClientRef.current.recoverSegment({
          meetingId: recoveredMeetingCheckpoint.meetingId,
          segmentId: recoveredMeetingCheckpoint.segmentId,
          idempotencyKey: `resume-failed:${recoveredMeetingCheckpoint.segmentId}:${resumedLiveSessionId || 'unknown'}`,
          checkpoint: {
            idempotencyKey: `checkpoint:${recoveredMeetingCheckpoint.segmentId}:resume-failed`,
            durableChunks: [],
            pendingPartial: null
          },
          nextLiveSessionId: null,
          failureReason: 'resume_start_failed',
          failureCategory: 'startup',
          outcome: 'interrupted'
        }).catch(() => {});
      }
      const failedSessionRecordId = resumedSessionRecordId || activeSessionRecordIdRef.current;
      if (failedSessionRecordId) {
        const classification = classifyFailureSignal({
          source: 'startup',
          rawError: nextError,
          reasonHint: 'live_connect_failed'
        });
        const diagnostic = safeReconnectDiagnostic({
          source: 'startup',
          stage: 'resume_session',
          rawError: nextError,
          reasonHint: classification.reason
        }, classification);
        const current = sessionRepositoryRef.current.getSessionRecord(failedSessionRecordId)?.sessionRecord;
        sessionControlLeaseRef.current?.release(failedSessionRecordId);
        setHasSessionControl(false);
        sessionRepositoryRef.current.updateSessionRecord(failedSessionRecordId, {
          status: 'failed',
          failureReason: 'live_connect_failed',
          failureCategory: 'provider',
          failureDiagnostics: [...(current?.failureDiagnostics || []), diagnostic].slice(-10)
        });
        await flushSessionSnapshot(failedSessionRecordId).catch(() => {});
        activeSessionRecordIdRef.current = null;
      }
      if (sessionStopRequestedRef.current) return;
      sessionRef.current = null;
      activeMeetingCheckpointRef.current = null;
      meetingCheckpointSyncCoordinatorRef.current?.cancel();
      segmentSwitchOrchestratorRef.current?.cancel();
      setError(nextError.message || '無法續錄長會議。');
      setStatus('error');
    }
  }

  async function switchMeetingSegment() {
    const meetingCheckpoint = activeMeetingCheckpointRef.current;
    const previousSession = sessionRef.current;
    if (!meetingCheckpoint || !previousSession || segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) return;

    invalidateLiveSessionCallbacks();
    setError('');
    setStatusLabelOverride('切換下一段中');
    setStatus('switching-segment');

    await finalizePendingTranscriptItemsForStop();
    flushSubtitleCues('segment-rollover');
    if (segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) return;

    const flushed = await flushMeetingCheckpointSync();
    if (!flushed) throw new Error('無法同步目前段落 checkpoint。');
    if (segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) return;
    archiveActiveTranscriptSegment();

    const nextLiveSessionId = generateLiveSessionId();
    const rollover = await meetingCheckpointApiClientRef.current.rolloverSegment({
      meetingId: meetingCheckpoint.meetingId,
      segmentId: meetingCheckpoint.segmentId,
      idempotencyKey: `rollover:${meetingCheckpoint.segmentId}:${nextLiveSessionId}`,
      checkpoint: {
        idempotencyKey: `checkpoint:${meetingCheckpoint.segmentId}:rollover`,
        durableChunks: [],
        pendingPartial: null
      },
      nextLiveSessionId
    });

    if (segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) return;

    await pauseRawAudioRecording();
    await previousSession.stop().catch(() => {});
    flushSubtitleCues('segment-rollover');
    if (sessionRef.current === previousSession) {
      sessionRef.current = null;
    }

    const nextSession = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
    try {
      await nextSession.start();
      if (segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) {
        await nextSession.stop().catch(() => {});
        return;
      }
      activateLiveSessionCallbacks(nextSession.callbackGeneration);
      await resumeRawAudioRecording();
    } catch (error) {
      await nextSession.stop().catch(() => {});
      throw error;
    }

    if (segmentSwitchCancelledRef.current || sessionStopRequestedRef.current) {
      await nextSession.stop().catch(() => {});
      return;
    }

    sessionRef.current = nextSession;
    const nextMeetingCheckpoint = {
      meetingId: meetingCheckpoint.meetingId,
      segmentId: rollover.segment.id
    };
    activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
    meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
    setStatusLabelOverride('下一段已開始');
    setStatus('listening');
  }

  function reconnectController() {
    if (!reconnectControllerRef.current) {
      reconnectControllerRef.current = createReconnectController({
        executeReconnect: startReconnectSession
      });
    }

    return reconnectControllerRef.current;
  }

  function segmentSwitchOrchestrator() {
    if (!segmentSwitchOrchestratorRef.current) {
      segmentSwitchOrchestratorRef.current = createSegmentSwitchOrchestrator({
        switchSegment: switchMeetingSegment,
        intervalMs: configuredSegmentSwitchIntervalMs(),
        onStatusChange: (nextStatus) => {
          if (nextStatus === 'switching') setMeetingCheckpointStatus('switching');
          if (nextStatus === 'switched') setMeetingCheckpointStatus('switched');
        },
        onError: reportSegmentSwitchError
      });
    }

    return segmentSwitchOrchestratorRef.current;
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
    void finalizeFailedSession({
      status: 'failed',
      failureReason: 'segment_switch_failed',
      failureCategory: 'provider'
    });
  }

  function generateLiveSessionId() {
    liveSessionIdSequenceRef.current += 1;
    return `live-session-${Date.now()}-${liveSessionIdSequenceRef.current}`;
  }

  async function createMeetingCheckpointForSession({ liveSessionId, glossaryEntries = [], privateGlossaryEntries = [] } = {}) {
    try {
      setMeetingCheckpointStatus('syncing');
      const result = await meetingCheckpointApiClientRef.current.createMeeting({ liveSessionId, glossaryEntries, privateGlossaryEntries });
      const meetingCheckpoint = {
        meetingId: result.meeting.id,
        segmentId: result.segment.id
      };
      activeMeetingCheckpointRef.current = meetingCheckpoint;
      meetingCheckpointSyncCoordinator().start(meetingCheckpoint);
      return meetingCheckpoint;
    } catch (nextError) {
      activeMeetingCheckpointRef.current = null;
      meetingCheckpointSyncCoordinatorRef.current?.cancel();
      setMeetingCheckpointStatus('error');
      throw new Error('無法建立長會議同步紀錄。請稍後再試。', { cause: nextError });
    }
  }

  async function createCurrentSessionRecord(meetingCheckpoint = activeMeetingCheckpointRef.current, initialTranscript = null, existingSessionId = null) {
    const persisted = existingSessionId
      ? await sessionCommandApiClientRef.current.update(existingSessionId, { status: 'active' })
      : await sessionCommandApiClientRef.current.create({
      name: sessionName.trim() || `即時翻譯 ${new Date().toLocaleString('zh-TW')}`,
      targetLanguageCode,
      targetLanguageLabel: targetLanguageLabelFor(targetLanguageCode),
      sourceLanguageCode,
      echoTargetLanguage,
      shouldRecordInputAudio,
      meetingGlossaryEntries: currentMeetingGlossaryEntries(),
      selectedInputDeviceId: selectedInputDeviceId || null,
      inputDeviceLabelSnapshot: selectedInputDeviceSnapshot().inputDeviceLabelSnapshot
      });
    const record = createActiveSessionRecord(
      sessionRepositoryRef.current,
      buildSessionRecordInput({
        id: persisted?.session?.id,
        startedAt: null,
        status: 'created',
        name: persisted?.session?.name,
        targetLanguageCode,
        targetLanguageLabel: targetLanguageLabelFor(targetLanguageCode),
        sourceLanguageCode,
        echoTargetLanguage,
        shouldRecordInputAudio,
        meetingId: meetingCheckpoint?.meetingId,
        segmentId: meetingCheckpoint?.segmentId || liveSessionId,
        meetingGlossaryEntries: currentMeetingGlossaryEntries(),
        ...selectedInputDeviceSnapshot()
      })
    );
    activeSessionRecordIdRef.current = record.id;
    polishingSessionIdRef.current = record.id;
    prepareInputAudioDownload(record);
    prepareTranslatedAudioDownload(record);
    const initialItems = appendInitialTranscriptItems(record.id, initialTranscript);
    markPendingSessionSnapshotItems(record.id, initialItems);
    await flushSessionSnapshot(record.id);
    void translationCommandLifecycle().recordSessionStarted(record);
    if (initialItems.length > 0) {
      void translationCommandLifecycle().recordFinalTranscriptItems(record, initialItems);
    }
    return record;
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

  function appendInitialTranscriptItems(sessionId, initialTranscript) {
    if (!sessionId || !initialTranscript) return [];
    return transcriptItemsForStream(initialTranscript, 'source')
      .concat(transcriptItemsForStream(initialTranscript, 'translation'))
      .filter((item) => item.status === 'final')
      .map((item) => sessionRepositoryRef.current.appendTranscriptItem(sessionId, item));
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
    markPendingSessionSnapshotItems(activeSessionRecordId, appended);
    setTranscript((previous) => (
      previous === current ? next : applyTranscriptEvent(previous, update)
    ));

    if (appended.length > 0) {
      const activeSessionRecord = sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
      if (activeSessionRecord) {
        scheduleSessionSnapshotSync(activeSessionRecordId);
        scheduleMeetingCheckpointSync(appended);
        void translationCommandLifecycle().recordFinalTranscriptItems(activeSessionRecord, appended);
      }
    }
  }

  function applyLiveSubtitleCueEvent(event) {
    if (event?.connectionEpoch !== undefined
      && event.connectionEpoch !== liveSessionCallbackGenerationRef.current.generation) return;
    const current = subtitleCueStateRef.current;
    let next = applySubtitleCueEvent(current, event, {
      targetLanguageCode,
      sourceLanguageCode,
      sessionId: activeSessionRecordIdRef.current,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || null,
      sessionClock: () => sessionTimeForSubtitleCues()
    });
    if (event?.localFinalize) {
      next = finalizePendingSubtitleCue(next, {
        sessionTimeMs: sessionTimeForSubtitleCues(),
        reason: event.finalizedReason || 'localSilence',
        targetLanguageCode,
        sourceLanguageCode
      });
    }
    if (next === current) return;
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
    requestNumericCorrection(next);
  }

  function queueLiveSubtitleCueEvent(event) {
    if (event?.connectionEpoch !== undefined
      && event.connectionEpoch !== liveSessionCallbackGenerationRef.current.generation) return;

    const shouldFlushImmediately = Boolean(
      event?.localFinalize
      || event?.isFinal
      || event?.turnComplete
      || event?.generationComplete
      || event?.eventType === 'boundary'
    );

    if (shouldFlushImmediately) {
      pendingLiveCueEventsRef.current.push(event);
      flushQueuedLiveCueEvents();
      return;
    }

    // Partial provider updates for one turn are cumulative. Keep only the
    // newest update for each stream/turn so a long continuous utterance does
    // not create an ever-growing UI work queue.
    const key = `${event?.stream || 'unknown'}:${event?.eventType || 'partial'}:${event?.turnIndex ?? 'current'}`;
    const existingIndex = pendingLiveCueEventsRef.current.findIndex((candidate) => (
      `${candidate?.stream || 'unknown'}:${candidate?.eventType || 'partial'}:${candidate?.turnIndex ?? 'current'}` === key
    ));
    if (existingIndex >= 0) {
      pendingLiveCueEventsRef.current[existingIndex] = event;
    } else {
      pendingLiveCueEventsRef.current.push(event);
    }

    if (liveCueFlushTimerRef.current !== null) return;
    liveCueFlushTimerRef.current = window.setTimeout(() => {
      liveCueFlushTimerRef.current = null;
      flushQueuedLiveCueEvents();
    }, 16);
  }

  function flushQueuedLiveCueEvents() {
    if (liveCueFlushTimerRef.current !== null) {
      window.clearTimeout(liveCueFlushTimerRef.current);
      liveCueFlushTimerRef.current = null;
    }

    const currentGeneration = liveSessionCallbackGenerationRef.current.generation;
    const events = pendingLiveCueEventsRef.current.splice(0).filter((event) => (
      event?.connectionEpoch === undefined || event.connectionEpoch === currentGeneration
    ));
    for (const event of events) applyLiveSubtitleCueEvent(event);
  }

  function requestNumericCorrection(state) {
    const cue = [...(state.finalCues || [])].reverse().find((candidate) => (
      candidate.status === 'final' &&
      candidate.sourceText && candidate.translatedText &&
      !candidate.numericCorrectionRequested &&
      missingNumericIntegrity(candidate.sourceText, candidate.translatedText)
    ));
    if (!cue) return;

    const next = markNumericCorrectionRequested(state, cue.cueId);
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(state, next);
    sessionRef.current?.retranslateSourceText(cue.sourceText, cue.cueId);
  }

  function flushSubtitleCues(reason) {
    flushQueuedLiveCueEvents();
    const current = subtitleCueStateRef.current;
    const next = finalizePendingSubtitleCue(current, {
      sessionTimeMs: sessionTimeForSubtitleCues(),
      reason
    });
    if (next === current) return;
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
    if (reason === 'stop' || reason === 'complete') {
      scheduleTranscriptPolishing(next.finalCues);
    }
    return next;
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
    meetingCheckpointSyncCoordinator().enqueueCues(changedCues, checkpoint);
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

  async function finalizeCurrentSessionRecord(options) {
    const sessionId = activeSessionRecordIdRef.current;
    const translatedAudioFinalState = finalizeTranslatedAudioDownload(sessionId);
    polishingSessionIdRef.current = sessionId;
    activeSessionRecordIdRef.current = null;
    const meetingId = activeMeetingCheckpointRef.current?.meetingId || null;

    try {
      const checkpointFlushed = await flushMeetingCheckpointSync();
      if (!checkpointFlushed) {
        setError('長會議同步尚未完成，但目前逐字稿仍會保存；未同步片段會保留以便重試。');
      }
      const finalized = finalizeActiveSessionRecord(sessionRepositoryRef.current, sessionId, buildFinalizePatch(options));

      if (finalized) {
        await flushSessionSnapshot(sessionId);
        await translationCommandLifecycle().recordSessionFinalized(finalized);
        void uploadFinalizedSessionAudioArtifacts(sessionId, {
          input: options?.audioStates?.input,
          translation: translatedAudioFinalState
        }, { meetingId });
      }

      return finalized;
    } catch {
      return null;
    } finally {
      sessionControlLeaseRef.current?.release(sessionId);
      setHasSessionControl(false);
      activeMeetingCheckpointRef.current = null;
    }
  }

  async function interruptActiveMeeting({ failureReason, failureCategory } = {}) {
    const meetingCheckpoint = activeMeetingCheckpointRef.current;
    if (!meetingCheckpoint) return null;

    try {
      await flushMeetingCheckpointSync();
      return await meetingCheckpointApiClientRef.current.recoverSegment({
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
  }

  async function finalizeFailedSession({ status = 'failed', failureReason, failureCategory } = {}) {
    await interruptActiveMeeting({ failureReason, failureCategory });
    await finalizeCurrentSessionRecord({ status, failureReason, failureCategory });
  }

  async function uploadFinalizedSessionAudioArtifacts(sessionId, states = {}, options = {}) {
    try {
      await Promise.all([
        flushAudioSegment('input', { force: true, sessionId }),
        flushAudioSegment('translation', { force: true, sessionId })
      ]);
      await refreshAudioArtifactDetails(sessionId, options);
    } catch (nextError) {
      console.error('Session audio artifact persistence failed.', nextError);
      if (nextError?.status === 413) {
        setError('語音紀錄分段超過伺服器保存上限，但逐字稿保存不受影響。請調高 SESSION_AUDIO_MAX_BYTES 或縮短分段時間。');
        return;
      }
      if (isRetryableAudioUploadError(nextError)) {
        setError('語音紀錄暫時無法同步，未上傳片段已保留並會在背景持續重試。');
        return;
      }
      setError('語音紀錄無法儲存到翻譯紀錄，但逐字稿保存不受影響。');
    }
  }

  async function refreshAudioArtifactDetails(sessionId, { meetingId = null } = {}) {
    if (!sessionId) return;

    if (meetingId) {
      meetingDetailCacheRef.current.delete(meetingId);
      if (selectedMeetingIdRef.current === meetingId) {
        await refreshSelectedMeetingDetail(meetingId);
      }
    }
  }

  function audioUploadController() {
    if (!audioUploadControllerRef.current) {
      audioUploadControllerRef.current = createAudioUploadController({
        chunks: { input: inputAudioUploadChunksRef, translation: translatedAudioUploadChunksRef },
        metadata: { input: inputAudioMetadataRef, translation: translatedAudioMetadataRef },
        segments: audioUploadSegmentsRef,
        retryTimers: audioUploadRetryTimersRef,
        retryAttempts: audioUploadRetryAttemptsRef,
        getActiveSessionId: () => activeSessionRecordIdRef.current,
        setError
      });
    }
    return audioUploadControllerRef.current;
  }

  function flushAudioSegmentIfDue(kind) {
    return audioUploadController().flushIfDue(kind);
  }

  function flushAudioSegment(kind, options) {
    return audioUploadController().flush(kind, options);
  }

  function resetAudioUploadSegment(kind) {
    audioUploadController().resetSegment(kind);
  }

  function audioUploadSessionId(kind) {
    return audioUploadController().sessionIdFor(kind);
  }

  function scheduleAudioUploadRetry(kind, sessionId) {
    audioUploadController().scheduleRetry(kind, sessionId);
  }

  function clearAudioUploadRetry(kind) {
    audioUploadController().clearRetry(kind);
  }

  function cancelAudioUploadRetries() {
    audioUploadController().cancelRetries();
  }

  function isRetryableAudioUploadError(error) {
    return audioUploadController().isRetryableError(error);
  }

  async function uploadSessionAudioSegment(sessionId, kind, { blob, segmentIndex, fileName }) {
    return audioUploadController().uploadSegment(sessionId, kind, { blob, segmentIndex, fileName });
  }

  async function finalizePendingTranscriptItemsForStop() {
    await finalizePendingTranscriptItemsForStreams();
  }

  async function finalizePendingTranscriptItemsForStreams(options = {}) {
    const currentTranscript = transcriptRef.current;

    if (!expectedPendingPartialsStillCurrent(currentTranscript, options.expectedPartialByStream)) {
      return;
    }

    const nextTranscript = finalizePendingTranscriptItems(currentTranscript, { streams: options.streams });

    if (nextTranscript === currentTranscript) {
      return;
    }

    const activeSessionRecordId = activeSessionRecordIdRef.current;
    const appended = appendNewFinalTranscriptItems(
      sessionRepositoryRef.current,
      activeSessionRecordId,
      currentTranscript,
      nextTranscript
    );
    transcriptRef.current = nextTranscript;
    setTranscript((previous) => {
      if (previous === currentTranscript) {
        return nextTranscript;
      }

      if (!expectedPendingPartialsStillCurrent(previous, options.expectedPartialByStream)) {
        return previous;
      }

      return finalizePendingTranscriptItems(previous, { streams: options.streams });
    });

    if (appended.length === 0) {
      return;
    }

    const activeSessionRecord = sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
    if (activeSessionRecord) {
      scheduleSessionSnapshotSync(activeSessionRecordId);
      scheduleMeetingCheckpointSync(appended);
      void translationCommandLifecycle().recordFinalTranscriptItems(activeSessionRecord, appended);
    }
  }

  function expectedPendingPartialsStillCurrent(transcriptState, expectedPartialByStream) {
    if (!expectedPartialByStream) {
      return true;
    }

    return Object.entries(expectedPartialByStream).every(([stream, expected]) => {
      const currentPartial = transcriptState?.[stream]?.currentPartial;
      return currentPartial?.id === expected.id && currentPartial.text === expected.text;
    });
  }

  async function syncSessionSnapshot(sessionId) {
    const detail = sessionRepositoryRef.current.getSessionRecord(sessionId);
    if (!detail) return null;
    const pendingIds = pendingSessionSnapshotItemIdsRef.current.get(sessionId) || new Set();
    const transcriptItems = detail.transcriptItems.filter((item) => pendingIds.has(item.id));
    const result = await sessionSnapshotApiClientRef.current.sync({ session: detail.sessionRecord, transcriptItems });
    for (const item of transcriptItems) {
      pendingIds.delete(item.id);
    }
    if (pendingIds.size === 0) {
      pendingSessionSnapshotItemIdsRef.current.delete(sessionId);
    }
    return result;
  }

  function markPendingSessionSnapshotItems(sessionId, items = []) {
    if (!sessionId || items.length === 0) return;
    const pendingIds = pendingSessionSnapshotItemIdsRef.current.get(sessionId) || new Set();
    for (const item of items) {
      if (item?.id) pendingIds.add(item.id);
    }
    pendingSessionSnapshotItemIdsRef.current.set(sessionId, pendingIds);
  }

  function sessionSnapshotSyncCoordinator() {
    if (!sessionSnapshotSyncCoordinatorRef.current) {
      sessionSnapshotSyncCoordinatorRef.current = createSessionSnapshotSyncCoordinator({
        syncSessionSnapshot,
        delayMs: SESSION_SNAPSHOT_SYNC_DELAY_MS,
        onError: reportSessionSnapshotSyncError
      });
    }

    return sessionSnapshotSyncCoordinatorRef.current;
  }

  function scheduleSessionSnapshotSync(sessionId) {
    if ((pendingSessionSnapshotItemIdsRef.current.get(sessionId)?.size || 0) >= SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE) {
      void flushSessionSnapshot(sessionId);
      return;
    }
    sessionSnapshotSyncCoordinator().schedule(sessionId);
  }

  function flushSessionSnapshot(sessionId) {
    return sessionSnapshotSyncCoordinator().flush(sessionId);
  }

  async function updateCurrentSessionStatus(nextStatus, patch = {}) {
    const sessionId = activeSessionRecordIdRef.current;
    if (!sessionId) return null;
    const updated = sessionRepositoryRef.current.updateSessionRecord(sessionId, {
      status: nextStatus,
      ...patch
    });
    const synced = await flushSessionSnapshot(sessionId);
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
    await flushSessionSnapshot(sessionId);
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

  function meetingCheckpointSyncCoordinator() {
    if (!meetingCheckpointSyncCoordinatorRef.current) {
      meetingCheckpointSyncCoordinatorRef.current = createMeetingCheckpointSyncCoordinator({
        updateCheckpoint: (payload) => meetingCheckpointApiClientRef.current.updateCheckpoint(payload),
        getCheckpoint: (payload) => meetingCheckpointApiClientRef.current.getCheckpoint(payload),
        delayMs: MEETING_CHECKPOINT_SYNC_DELAY_MS,
        onStatusChange: (status) => {
          setMeetingCheckpointStatus(status);
          if (status === 'synced') {
            setError((current) => current.startsWith('長會議同步') ? '' : current);
          }
        },
        onError: reportMeetingCheckpointSyncError
      });
    }

    return meetingCheckpointSyncCoordinatorRef.current;
  }

  function scheduleMeetingCheckpointSync(transcriptItems) {
    const meetingCheckpoint = activeMeetingCheckpointRef.current;
    const chunks = checkpointChunksForTranscriptItems({
      meetingId: meetingCheckpoint?.meetingId,
      segmentId: meetingCheckpoint?.segmentId,
      transcriptItems
    });
    meetingCheckpointSyncCoordinator().enqueue(chunks);
  }

  function flushMeetingCheckpointSync() {
    return meetingCheckpointSyncCoordinatorRef.current?.flush() || Promise.resolve(true);
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
    setIsLoadingMeetings(true);
    setMeetingLoadError('');
    try {
      const meetings = await meetingReadApiClientRef.current.listMeetingHistory();
      setMeetingRecords([...meetings].sort((a, b) => meetingRecordSortTime(b) - meetingRecordSortTime(a)));
      return meetings;
    } catch {
      setMeetingLoadError('長會議紀錄載入失敗。請檢查連線後重試。');
      return null;
    } finally {
      setIsLoadingMeetings(false);
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
    closeHistoryRecordDetail();
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

  function navigateTo(nextPage, event) {
    event?.preventDefault();

    if (isNavigationLocked) {
      setError('錄音進行中，請先結束目前工作階段後再切換目錄。');
      return;
    }

    if (nextPage === page) {
      return;
    }

    window.location.hash = nextPage;
  }

  async function resetLiveMeetingState() {
    invalidateLiveSessionCallbacks();
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
    meetingResumeDraftRequestIdRef.current += 1;
    cancelLiveCueIdleTimers();
    cancelAudioUploadRetries();
    await recordingController().cleanup({ discard: true }).catch(() => {});

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
    resetInputAudioDownload();
    resetTranslatedAudioDownload();
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

  async function copyArticle(stream) {
    const articleText = articleTextForItems(stream === 'source' ? completedSourceSegments : completedTranslationSegments, stream);
    if (!articleText) return;
    try {
      await navigator.clipboard.writeText(articleText);
      setCopiedArticleStream(stream);
      window.setTimeout(() => setCopiedArticleStream((current) => current === stream ? '' : current), 1500);
    } catch {
      setError('無法複製文章內容。');
    }
  }

  function downloadArticle(stream) {
    const articleText = articleTextForItems(stream === 'source' ? completedSourceSegments : completedTranslationSegments, stream);
    if (!articleText) return;
    downloadTextFile(articleText, buildArticleFileName(stream), 'text/plain;charset=utf-8');
  }

  const sourceTranscriptItems = [
    ...archivedTranscript.source.finalItems,
    ...transcriptItemsForStream(transcript, 'source')
  ];
  const translationTranscriptItems = [
    ...archivedTranscript.translation.finalItems,
    ...transcriptItemsForStream(transcript, 'translation')
  ];
  const transcriptItems = [...sourceTranscriptItems, ...translationTranscriptItems];
  const completedSourceSegments = [
    ...archivedTranscript.source.finalItems,
    ...transcript.source.finalItems
  ];
  const completedTranslationSegments = [
    ...archivedTranscript.translation.finalItems,
    ...transcript.translation.finalItems
  ];
  const sourceArticleParagraphs = buildTranscriptArticleParagraphs(completedSourceSegments).map(toTraditionalChineseText);
  const translationArticleParagraphs = buildTranscriptArticleParagraphs(completedTranslationSegments);
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
          onOpenLive={(meetingId) => { window.location.hash = `#live?meetingId=${encodeURIComponent(meetingId)}`; }}
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
    <MeetingLayout
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
        error={error}
        status={status}
        onRetry={() => {
          setError('');
          void (resumeDraft?.hasTranscript ? resumeMeetingSession() : startSession());
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
                  <p className="live-meeting-language">{liveMeeting ? `${targetLanguageLabelFor(liveMeeting.sourceLanguageCode) || liveMeeting.sourceLanguageCode} → ${targetLanguageLabelFor(liveMeeting.targetLanguageCode) || liveMeeting.targetLanguageCode}` : '請先選擇一場可錄音的會議'}</p>
                </div>
                <span className="live-meeting-status status-pill">{liveMeetingStatusLabel(liveMeeting)}</span>
              </div>
              {!routeMeetingId ? <LiveMeetingPicker meetings={meetingRecords} selectedMeetingId="" disabled={controlsLocked} onChange={(meetingId) => selectLiveTranslationMode(`meeting:${meetingId}`)} /> : null}
            </div>

            <div className="live-session-status">
              {controlLeaseSnapshot && !hasSessionControl ? (
                <p className="device-note">目前已有工作階段由其他頁籤控制；本頁面只能唯讀查看。</p>
              ) : null}
              {status === 'reconnecting' ? <p className="device-note">正在重新連線即時字幕…</p> : null}
              {status === 'switching-segment' ? <p className="device-note">正在切換下一段即時字幕…</p> : null}
              {status === 'paused' ? (
                <p className="device-note">
                  {shouldRecordInputAudio
                    ? '工作階段已暫停；逐字稿、翻譯與本機錄音片段會保留到結束本次工作階段。'
                    : '工作階段已暫停；逐字稿與翻譯會保留到結束本次工作階段。'}
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
                {status === 'listening' ? (
                  <>
                    <button className="button secondary" type="button" onClick={pauseSession}>
                      <Pause size={18} aria-hidden="true" />
                      暫停
                    </button>
                    <button className="button secondary" type="button" onClick={endCurrentSession}>
                      <Square size={18} aria-hidden="true" />
                      結束本次工作階段
                    </button>
                  </>
                ) : status === 'reconnecting' || status === 'switching-segment' ? (
                  <button className="button secondary" type="button" onClick={endCurrentSession}>
                    <Square size={18} aria-hidden="true" />
                    結束本次工作階段
                  </button>
                ) : status === 'paused' ? (
                  <>
                    <button className="button primary" type="button" onClick={continuePausedSession}>
                      <Play size={18} aria-hidden="true" />
                      繼續
                    </button>
                    <button className="button secondary" type="button" onClick={endCurrentSession}>
                      <Square size={18} aria-hidden="true" />
                      結束本次工作階段
                    </button>
                  </>
                ) : hasSelectedResumableMeeting || (routeMeetingId && resumeDraft?.meetingId === routeMeetingId && resumeDraft?.hasTranscript) ? (
                  <button
                    className="button primary meeting-live-action-button"
                    type="button"
                    onClick={resumeDraft?.hasTranscript ? resumeMeetingSession : startSession}
                    disabled={isActive || Boolean(controlLeaseSnapshot && !hasSessionControl) || !hasSelectedResumableMeeting}
                  >
                    {isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                    {isActive ? '正在開始' : resumeDraft?.hasTranscript ? '繼續錄製' : '開始'}
                  </button>
                ) : null}
                {routeMeetingId && resumeDraft?.meetingId === routeMeetingId && !isActive && status === 'idle' ? (
                  <button className="button secondary meeting-live-action-button" type="button" onClick={completeResumableMeeting}>
                    結束會議
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="live-transcript-column">
        <LiveCuePanelView
          cueState={subtitleCueState}
          fallbackTranscriptItems={unrepresentedTranscriptItems({
            archivedTranscript: archivedTranscript,
            transcript,
            cues: subtitleCueState.finalCues
          })}
          status={status}
          statusLabelOverride={statusLabelOverride}
          isPaused={status === 'paused'}
          isStopped={status === 'stopped'}
          polishingState={polishingState}
          polishedArticle={polishedArticle}
          onPolishingRetry={retryPolishingExecution}
          copiedSource={copiedArticleStream === 'source'}
          copiedTranslation={copiedArticleStream === 'translation'}
          onCopySource={copyLiveSource}
          onCopyTranslation={copyLiveTranslation}
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
    </MeetingLayout>
    );
  };

  return <AppRouter page={page} views={{ ...views, workspace: workspaceView }} />;
}


function logTranscriptSegmentDecision(update, decision, previous, next) {
  if (!TRANSCRIPT_SEGMENT_LOG_ENABLED) {
    return;
  }

  const streamState = next?.[update.stream] || previous?.[update.stream];
  console.debug('[Transcript segmenter]', {
    stream: update.stream,
    inputText: update.stream === 'source' ? update.text : '',
    outputText: update.stream === 'translation' ? update.text : '',
    turnFinal: Boolean(update.isFinal),
    decision,
    completedSegments: streamState?.finalItems?.map((item) => item.text) || [],
    pendingText: streamState?.currentPartial?.text || ''
  });
}

function transcriptStateFromCheckpointChunks(chunks = []) {
  const state = createTranscriptState();
  const transcriptItems = chunks
    .filter((chunk) => (
      chunk &&
      (chunk.stream === 'source' || chunk.stream === 'translation') &&
      Number.isInteger(chunk.sequence) &&
      typeof chunk.text === 'string' &&
      chunk.text.trim().length > 0
    ))
    .map((chunk) => ({
      id: chunk.idempotencyKey || `checkpoint:${chunk.segmentId}:${chunk.stream}:${chunk.sequence}`,
      stream: chunk.stream,
      status: 'final',
      text: chunk.text,
      sequence: chunk.sequence,
      startedAt: chunk.timestamp,
      finalizedAt: chunk.timestamp
    }))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));

  const maxSequence = transcriptItems.reduce((max, item) => Math.max(max, item.sequence), 0);

  return {
    ...state,
    source: {
      ...state.source,
      finalItems: transcriptItems.filter((item) => item.stream === 'source')
    },
    translation: {
      ...state.translation,
      finalItems: transcriptItems.filter((item) => item.stream === 'translation')
    },
    nextSequence: maxSequence + 1
  };
}

function transcriptSegmentsFromCheckpoints({ segments = [], checkpoints = [] } = {}) {
  return segments
    .map((segment, index) => ({
      id: segment.id,
      sequence: segment.sequence,
      transcript: transcriptStateFromCheckpointChunks(checkpoints[index]?.checkpoint?.durableChunks || [])
    }))
    .filter((segment) => transcriptHasFinalItems(segment.transcript) > 0)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function unrepresentedTranscriptItems({ archivedTranscript, transcript, cues = [] } = {}) {
  const items = [
    ...(archivedTranscript?.source?.finalItems || []),
    ...(archivedTranscript?.translation?.finalItems || []),
    ...(transcript?.source?.finalItems || []),
    ...(transcript?.translation?.finalItems || [])
  ];
  return items
    .filter((item) => item?.status === 'final' && typeof item.text === 'string' && item.text.trim())
    .filter((item) => !cues.some((cue) => transcriptItemCoveredByCue(item, cue)))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}
function transcriptItemCoveredByCue(item, cue) {
  if (!cue || cue.status !== 'final' || cue.segmentId !== item.segmentId) return false;
  const cueText = item.stream === 'source' ? cue.sourceText : cue.translatedText;
  const itemText = normalizeFallbackText(item.text);
  const normalizedCueText = normalizeFallbackText(cueText);
  return Boolean(itemText && normalizedCueText && (
    normalizedCueText.includes(itemText) || itemText.includes(normalizedCueText)
  ));
}

function normalizeFallbackText(value) {
  return String(value || '').replace(/\s+/gu, '').trim();
}

function archivedTranscriptFromSegments(segments = [], fallbackNextSequence = 1) {
  const transcripts = segments.map((segment) => segment.transcript);
  const archivedSource = mergeTranscriptItems(transcripts.flatMap((transcript) => transcript?.source?.finalItems || []));
  const archivedTranslation = mergeTranscriptItems(transcripts.flatMap((transcript) => transcript?.translation?.finalItems || []));
  const nextSequence = Math.max(
    fallbackNextSequence,
    ...transcripts.map((transcript) => transcript?.nextSequence || 1)
  );

  return {
    source: { finalItems: archivedSource, currentPartial: null },
    translation: { finalItems: archivedTranslation, currentPartial: null },
    nextSequence
  };
}

function mergeTranscriptItems(items = []) {
  const byId = new Map();
  for (const item of items) {
    if (item?.status === 'final' && typeof item.id === 'string') {
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values()).sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function emptyTranscriptStateWithNextSequence(nextSequence) {
  return {
    ...createTranscriptState(),
    nextSequence: Number.isFinite(nextSequence) && nextSequence > 0 ? nextSequence : 1
  };
}

function transcriptHasFinalItems(transcriptState) {
  return (transcriptState?.source?.finalItems?.length || 0) + (transcriptState?.translation?.finalItems?.length || 0);
}

function activeSegmentTranscriptCount(transcriptState) {
  return transcriptHasFinalItems(transcriptState) +
    (transcriptState?.source?.currentPartial ? 1 : 0) +
    (transcriptState?.translation?.currentPartial ? 1 : 0);
}

function reconnectErrorMessage(result, diagnostic = null) {
  const detail = diagnostic ? `（來源：${diagnostic.source}；原因：${diagnostic.reason}${diagnostic.code ? `；代碼：${diagnostic.code}` : ''}${diagnostic.status ? `；狀態：${diagnostic.status}` : ''}）` : '';
  if (result?.decision?.stopReason === 'max_attempts_exceeded') {
    return `${RECONNECT_EXHAUSTED_MESSAGE}${detail}`;
  }

  return `${RECONNECT_FAILED_MESSAGE}${detail}`;
}

function safeReconnectDiagnostic(failure = {}, classification = {}) {
  const sourceDiagnostic = failure.diagnostic || {};
  return {
    at: sourceDiagnostic.at || new Date().toISOString(),
    source: failure.source || 'unknown',
    stage: failure.stage || sourceDiagnostic.stage || null,
    reason: classification.reason || failure.reasonHint || 'unknown_error',
    category: classification.category || null,
    code: safeDiagnosticValue(sourceDiagnostic.code || failure.rawEvent?.code),
    status: safeDiagnosticStatus(sourceDiagnostic.status || failure.rawError?.status || failure.rawError?.response?.status),
    connectionEpoch: sourceDiagnostic.connectionEpoch ?? null,
    liveSessionId: sourceDiagnostic.liveSessionId || null,
    segmentId: sourceDiagnostic.segmentId || null,
    audioCallbackCount: sourceDiagnostic.audioCallbackCount ?? null,
    pcmSendAttemptCount: sourceDiagnostic.pcmSendAttemptCount ?? null,
    pcmSendSyncThrowCount: sourceDiagnostic.pcmSendSyncThrowCount ?? null,
    pcmSendAsyncRejectCount: sourceDiagnostic.pcmSendAsyncRejectCount ?? null
  };
}

function safeDiagnosticValue(value) {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function safeDiagnosticStatus(value) {
  return Number.isInteger(value) ? value : null;
}

function articleTextForItems(items, stream) {
  const articleText = formatTranscriptArticleText(items || []);
  return stream === 'source' ? toTraditionalChineseText(articleText) : articleText;
}

function traditionalChineseTranscriptItem(item) {
  if (!item) {
    return item;
  }

  return {
    ...item,
    text: toTraditionalChineseText(item.text)
  };
}

function buildArticleFileName(stream) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `live-translate-article-${stream}-${stamp}.txt`;
}

const CUE_PAGE_FOLLOW_THRESHOLD_PX = 80;

function GlossarySourceCell({ data }) {
  return <strong>{data.source}</strong>;
}

function GlossaryActionsCell({ context, data }) {
  return (
    <div className="glossary-actions">
      <button className="button detail-button" type="button" onClick={() => context.onEdit(data)}>編輯</button>
      <button className="button detail-button danger-button" type="button" onClick={() => context.onDelete(data)}>刪除</button>
    </div>
  );
}

function isCueListAtLatestPosition(list) {
  if (!list) return false;
  return list.scrollHeight - list.clientHeight - list.scrollTop <= CUE_PAGE_FOLLOW_THRESHOLD_PX;
}

function latestPolishingOutput(detail) {
  return completedPolishingOutputs(detail)
    .sort((left, right) => (right.version || 0) - (left.version || 0) || String(right.completedAt || '').localeCompare(String(left.completedAt || '')))[0] || null;
}

function completedPolishingOutputs(detail) {
  return completedCueRefinementOutputs(detail);
}

function rawCuesFromDetail(cues = []) {
  return (Array.isArray(cues) ? cues : [])
    .filter((cue) => !cue?.cueId?.startsWith('refined-subtitle:'));
}

function latestPolishingExecution(detail) {
  return (detail?.translationHistory?.executions || [])
    .filter((execution) => execution.operation === 'transcript_polishing')
    .sort((left, right) => (
      timestampMs(right.startedAt || right.completedAt || right.createdAt) - timestampMs(left.startedAt || left.completedAt || left.createdAt)
      || String(right.id || '').localeCompare(String(left.id || ''))
    ))[0] || null;
}

function ArticlePanel({
  title,
  stream,
  paragraphs,
  currentPartial,
  currentLabel,
  emptyText,
  copied,
  onCopy,
  onExport
}) {
  const hasArticle = paragraphs.length > 0;

  return (
    <article className="transcript-panel">
      <div className="article-panel-header">
        <h2>{title}</h2>
        <div className="article-actions">
          <button className="button detail-button" type="button" onClick={onCopy} disabled={!hasArticle}>
            <Copy size={16} aria-hidden="true" />
            {copied ? '已複製' : '複製'}
          </button>
          <button className="button detail-button" type="button" onClick={onExport} disabled={!hasArticle}>
            <Download size={16} aria-hidden="true" />
            匯出 TXT
          </button>
        </div>
      </div>
      {hasArticle ? (
        <div className="article-content" aria-label={`${title}內容`}>
          {paragraphs.map((paragraph, index) => (
            <p key={`${stream}-article-${index}`}>{paragraph}</p>
          ))}
        </div>
      ) : null}
      {currentPartial ? (
        <p className="transcript-current"><span>{currentLabel}</span>{currentPartial.text}</p>
      ) : null}
      {!hasArticle && !currentPartial ? (
        <p className="transcript-text empty">{`${emptyText} 等待完成片段。`}</p>
      ) : null}
    </article>
  );
}

function MeetingManagementPage({ onOpenLive, onOpenHistory, onOpenSettings, initialStatusFilter = 'all', initialPanel = '', initialCreate = false }) {
  const managementClientRef = useRef(createMeetingManagementApiClient());
  const readClientRef = useRef(createMeetingReadApiClient());
  const glossaryClientRef = useRef(createGlossaryApiClient());
  const [meetings, setMeetings] = useState([]);
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [viewMode, setViewMode] = useState('list');
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [selectedGlossaryIds, setSelectedGlossaryIds] = useState([]);
  const [privateGlossaryEntries, setPrivateGlossaryEntries] = useState([]);
  const [privateGlossarySource, setPrivateGlossarySource] = useState('');
  const [privateGlossaryTranslation, setPrivateGlossaryTranslation] = useState('');
  const [editingPrivateGlossarySource, setEditingPrivateGlossarySource] = useState('');
  const [name, setName] = useState('');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isGlossaryDrawerOpen, setIsGlossaryDrawerOpen] = useState(false);
  const [isGlobalGlossaryPanelOpen, setIsGlobalGlossaryPanelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);

  useEffect(() => {
    setStatusFilter(initialStatusFilter || 'all');
  }, [initialStatusFilter]);

  useEffect(() => {
    if (initialPanel === 'global-glossary') setIsGlobalGlossaryPanelOpen(true);
  }, [initialPanel]);

  useEffect(() => {
    if (initialCreate) openCreateForm();
  }, [initialCreate]);

  const filteredMeetings = useMemo(() => filterMeetingManagementItems(meetings, {
    query,
    status: statusFilter
  }), [meetings, query, statusFilter]);

  useEffect(() => {
    const routeMeetingId = pageInfoFromLocation().meetingId;
    Promise.all([readClientRef.current.listMeetingHistory(), glossaryClientRef.current.listEntries()])
      .then(async ([meetingItems, entries]) => {
        setMeetings(meetingItems);
        setGlossaryEntries(entries);
        if (routeMeetingId) await selectMeeting(routeMeetingId, entries);
      })
      .catch(() => setError('無法載入會議或字典資料。'));
  }, []);

  useEffect(() => {
    if (!isGlossaryDrawerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsGlossaryDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGlossaryDrawerOpen]);

  useEffect(() => {
    if (!isGlobalGlossaryPanelOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsGlobalGlossaryPanelOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGlobalGlossaryPanelOpen]);

  function clearMeetingForm() {
    setSelectedMeeting(null);
    setName('');
    setSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE);
    setTargetLanguageCode('en');
    setSelectedGlossaryIds([]);
    setPrivateGlossaryEntries([]);
    setPrivateGlossarySource('');
    setPrivateGlossaryTranslation('');
    setEditingPrivateGlossarySource('');
    setNotice('');
    setIsGlossaryDrawerOpen(false);
  }

  function openCreateForm() {
    clearMeetingForm();
    setViewMode('form');
  }

  function returnToMeetingList() {
    clearMeetingForm();
    setViewMode('list');
  }

  async function selectMeeting(id, availableGlossaryEntries = glossaryEntries) {
    setError('');
    try {
      const detail = await readClientRef.current.getMeetingDetail(id);
      const meeting = detail?.meeting;
      if (!meeting) throw new Error('meeting_not_found');
      setSelectedMeeting(meeting);
      setName(meeting?.name || '');
      setSourceLanguageCode(meeting?.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE);
      const meetingTargetLanguageCode = meeting?.targetLanguageCode || 'en';
      setTargetLanguageCode(meetingTargetLanguageCode);
      setSelectedGlossaryIds(availableGlossaryEntries.filter((entry) => (meeting?.glossaryEntries || []).some((item) => item.source === entry.source && entry.translations?.[meetingTargetLanguageCode] === item.target)).map((entry) => entry.id));
      setPrivateGlossaryEntries(Array.isArray(meeting?.privateGlossaryEntries) ? meeting.privateGlossaryEntries : []);
      setViewMode('form');
    } catch {
      setError('無法載入會議設定。');
    }
  }

  function selectedEntries() {
    return glossaryEntries.filter((entry) => selectedGlossaryIds.includes(entry.id)).map((entry) => ({
      source: entry.source,
      target: entry.translations?.[targetLanguageCode],
      replacementAliases: entry.replacementAliases?.[targetLanguageCode] || []
    })).filter((entry) => entry.target);
  }

  function savePrivateGlossaryEntry() {
    const source = privateGlossarySource.trim();
    const translation = privateGlossaryTranslation.trim();
    if (!source || !translation) return;
    const existing = privateGlossaryEntries.find((entry) => entry.source === (editingPrivateGlossarySource || source));
    const nextEntry = {
      ...(existing || {}),
      source,
      translations: { ...(existing?.translations || {}), [targetLanguageCode]: translation },
      replacementAliases: { ...(existing?.replacementAliases || {}) }
    };
    setPrivateGlossaryEntries((current) => {
      const withoutEdited = current.filter((entry) => entry.source !== (editingPrivateGlossarySource || source));
      return [nextEntry, ...withoutEdited];
    });
    setPrivateGlossarySource('');
    setPrivateGlossaryTranslation('');
    setEditingPrivateGlossarySource('');
  }

  async function saveMeeting() {
    if (selectedMeeting?.status === 'completed') return;
    setError('');
    setNotice('');
    setIsSaving(true);
    try {
      const isUpdating = Boolean(selectedMeeting?.id);
      const input = { name: name.trim() || null, sourceLanguageCode, targetLanguageCode, glossaryEntries: selectedEntries(), privateGlossaryEntries };
      const meeting = isUpdating
        ? await managementClientRef.current.update(selectedMeeting.id, input)
        : await managementClientRef.current.create(input);
      setSelectedMeeting(meeting);
      setMeetings((current) => [meeting, ...current.filter((item) => item.id !== meeting.id)]);
      setNotice(isUpdating ? '會議設定已更新。' : '會議已建立。');
    } catch (requestError) {
      setError(requestError?.status === 409 ? '已完成會議不可修改設定。' : '無法儲存會議設定。');
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteMeeting(meeting) {
    if (!meeting?.id || meeting.status !== 'created') return;
    if (!window.confirm(`確定要刪除「${meeting.name || meeting.id}」嗎？此操作無法復原。`)) return;

    setError('');
    try {
      await managementClientRef.current.delete(meeting.id);
      setMeetings((current) => current.filter((item) => item.id !== meeting.id));
      setNotice('會議已刪除。');
    } catch (requestError) {
      setError(requestError?.status === 409
        ? '只有尚未開始的會議可以刪除。'
        : '無法刪除會議。');
    }
  }

  function openMeetingCard(meeting) {
    if (!meeting?.id) return;
    if (meeting.status === 'created') onOpenSettings?.(meeting.id);
    else if (meeting.status === 'completed') onOpenHistory(meeting.id);
    else onOpenLive(meeting.id);
  }

  function meetingCardActionLabel(status) {
    if (status === 'active') return '開啟即時字幕';
    if (status === 'interrupted') return '繼續即時字幕';
    if (status === 'completed') return '查看翻譯紀錄';
    return '編輯並開始會議';
  }

  function meetingCardStatusLabel(status) {
    if (status === 'interrupted') return '可續錄';
    return meetingManagementStatusLabel(status);
  }

  function meetingCardDescription(status) {
    if (status === 'active') return '即時字幕正在進行中，可開啟工作區查看。';
    if (status === 'interrupted') return '會議已暫停，現有字幕與翻譯可繼續錄製。';
    if (status === 'completed') return '會議已完成，翻譯紀錄與字幕已保存。';
    return '會議設定已建立，準備好後即可開始。';
  }

  function meetingCardStatusIcon(status) {
    if (status === 'active') return Activity;
    if (status === 'completed') return CheckCircle2;
    if (status === 'created' || status === 'interrupted') return CalendarDays;
    return FileText;
  }

  return (
    <section className="feature-page meeting-center-page meeting-management-page meetings-page" aria-labelledby="meeting-management-title">
      {viewMode === 'form' ? (
        <div className="meeting-management-back-row">
          <button className="button secondary" type="button" onClick={returnToMeetingList}>返回會議清單</button>
        </div>
      ) : null}
      <div className="meeting-management-status">
        {error ? <p className="error-message" role="alert">{error}</p> : null}
        {notice ? <p className="success-message" role="status">{notice}</p> : null}
      </div>
      {viewMode === 'form' ? (
        <div className={`meeting-management-grid ${selectedMeeting ? '' : 'settings-only'}`}>
          <section className="control-panel" aria-label="會議設定">
          <div className="title-block">
            <div className="title-block-header">
              <div><p className="eyebrow">MEETING SETUP</p><h3>{selectedMeeting?.status === 'completed' ? '會議設定' : selectedMeeting ? '編輯會議設定' : '建立會議'}</h3></div>
            </div>
            <p>{selectedMeeting?.status === 'completed' ? '會議已完成，設定內容僅供查看。' : '設定語言與會議字典，儲存後即可開始會議。'}</p>
          </div>
          <label className="field"><span>會議名稱</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：產品會議" maxLength={120} readOnly={selectedMeeting?.status === 'completed'} /></label>
          <label className="field"><span>主要輸入語言</span><select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)} disabled={selectedMeeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <label className="field"><span>目標語言</span><select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)} disabled={selectedMeeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <button
            className="button secondary glossary-drawer-trigger"
            type="button"
            onClick={() => setIsGlossaryDrawerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={isGlossaryDrawerOpen}
            disabled={selectedMeeting?.status === 'completed'}
          >
            <BookOpen size={18} aria-hidden="true" />
            會議字典
            <span className="glossary-count-badge">
              {selectedGlossaryIds.filter((id) => liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode).some((entry) => entry.id === id)).length}
            </span>
          </button>
          <div className="meeting-private-glossary" aria-label="Meeting 私有字典">
            <div className="title-block-header"><h4>Meeting 私有字典</h4></div>
            <p className="export-note">只套用於目前 Meeting，不會出現在全域字典或 Viewer。</p>
            {privateGlossaryEntries.map((entry) => (
              <div className="glossary-choice" key={entry.source}>
                <span><strong>{entry.source}</strong><small>{entry.translations?.[targetLanguageCode] || '尚未設定目前語言翻譯'}</small></span>
                {selectedMeeting?.status !== 'completed' ? <span className="meeting-actions">
                  <button className="button detail-button" type="button" onClick={() => { setEditingPrivateGlossarySource(entry.source); setPrivateGlossarySource(entry.source); setPrivateGlossaryTranslation(entry.translations?.[targetLanguageCode] || ''); }}>編輯</button>
                  <button className="button detail-button danger-button" type="button" onClick={() => setPrivateGlossaryEntries((current) => current.filter((item) => item.source !== entry.source))}>刪除</button>
                </span> : null}
              </div>
            ))}
            {selectedMeeting?.status !== 'completed' ? <div className="glossary-quick-add">
              <label className="field"><span>私有原文</span><input value={privateGlossarySource} onChange={(event) => setPrivateGlossarySource(event.target.value)} placeholder="例如：專案代號" disabled={isSaving} /></label>
              <label className="field"><span>翻譯（{targetLanguageLabelFor(targetLanguageCode) || targetLanguageCode}）</span><input value={privateGlossaryTranslation} onChange={(event) => setPrivateGlossaryTranslation(event.target.value)} placeholder="例如：Project Codename" disabled={isSaving} /></label>
              <button className="button secondary" type="button" onClick={savePrivateGlossaryEntry} disabled={!privateGlossarySource.trim() || !privateGlossaryTranslation.trim()}>{editingPrivateGlossarySource ? '更新私有詞條' : '新增私有詞條'}</button>
            </div> : null}
          </div>
          <div className="meeting-management-actions">
            {selectedMeeting?.status !== 'completed' ? <button className="button primary" type="button" onClick={saveMeeting} disabled={isSaving}>{isSaving ? '儲存中…' : selectedMeeting ? '儲存變更' : '建立會議'}</button> : null}
            {selectedMeeting ? (
              selectedMeeting.status === 'completed'
                ? <button className="button secondary" type="button" onClick={() => onOpenHistory(selectedMeeting.id)}>前往翻譯紀錄</button>
                : <button className="button secondary" type="button" onClick={() => onOpenLive(selectedMeeting.id)}>前往即時字幕</button>
              ) : null}
          </div>
          {selectedMeeting?.status === 'created' ? (
            <section className="meeting-danger-zone" aria-labelledby="meeting-danger-zone-title">
              <div>
                <h4 id="meeting-danger-zone-title">危險操作</h4>
                <p>刪除尚未開始的會議後，設定內容將無法復原。</p>
              </div>
              <button className="button detail-button danger-button" type="button" onClick={() => deleteMeeting(selectedMeeting)}>
                <Trash2 size={16} aria-hidden="true" />
                刪除會議
              </button>
            </section>
          ) : null}
          </section>
        </div>
      ) : null}
      {viewMode === 'list' ? <section className="history-panel" aria-label="會議列表">
        <div className="meeting-table-toolbar">
          <label className="field meeting-search-field">
            <span>搜尋會議</span>
            <div className="meeting-toolbar-input">
              <Search size={20} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋名稱、語言或狀態" />
            </div>
          </label>
          <label className="field meeting-status-filter-field">
            <span>篩選狀態</span>
            <div className="meeting-toolbar-input meeting-toolbar-select">
              <SlidersHorizontal size={20} aria-hidden="true" />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                {MEETING_STATUS_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
              </select>
            </div>
          </label>
          <a className="button secondary meeting-glossary-toolbar-button" href="#glossary">
            <BookOpen size={19} aria-hidden="true" />
            全域字典
          </a>
        </div>
        {meetings.length === 0 ? <p className="history-empty">尚無會議。建立第一場會議開始使用。</p> : null}
        {meetings.length > 0 && filteredMeetings.length === 0 ? <p className="history-empty">找不到符合條件的會議。</p> : null}
        <div className="meeting-card-grid" aria-label="既有會議列表">
          {filteredMeetings.map((meeting) => {
            const StatusIcon = meetingCardStatusIcon(meeting.status);
            const updatedAt = meetingManagementLastUpdated(meeting);
            const fullTime = formatRecordTime(updatedAt);
            return (
              <article
                className={`meeting-card meeting-card-${meeting.status || 'unknown'}`}
                key={meeting.id}
                role="button"
                tabIndex={0}
                onClick={() => openMeetingCard(meeting)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openMeetingCard(meeting);
                  }
                }}
                aria-label={`${meeting.name || meeting.id || '未命名會議'}，${meetingCardStatusLabel(meeting.status)}`}
              >
                <div className="meeting-card-topline">
                  <span className="meeting-status-badge">
                    <span className="meeting-status-dot" aria-hidden="true" />
                    {meetingCardStatusLabel(meeting.status)}
                  </span>
                  <span className="meeting-card-icon" aria-hidden="true"><StatusIcon size={27} strokeWidth={1.8} /></span>
                </div>
                <h3>{meeting.name || meeting.id || '未命名會議'}</h3>
                <div className="meeting-card-metadata">
                  <span><Globe2 size={18} aria-hidden="true" />{meetingLanguageLabel(meeting)}</span>
                  <span><Clock3 size={18} aria-hidden="true" /><time dateTime={updatedAt || undefined} title={fullTime}>{formatMeetingListTime(updatedAt)}</time></span>
                </div>
                <div className="meeting-card-divider" />
                <div className="meeting-card-footer">
                  <p><StatusIcon size={19} aria-hidden="true" />{meetingCardDescription(meeting.status)}</p>
                  <button
                    className="button meeting-card-action"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openMeetingCard(meeting);
                    }}
                  >
                    <span className="meeting-card-action-label">{meetingCardActionLabel(meeting.status)}</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section> : null}
      <LiveGlossaryDrawer
        open={isGlossaryDrawerOpen}
        entries={glossaryEntries}
        targetLanguageCode={targetLanguageCode}
        selectedEntryIds={selectedGlossaryIds}
        disabled={isSaving}
        onClose={() => setIsGlossaryDrawerOpen(false)}
        onEntriesChange={setGlossaryEntries}
        onSelectionChange={setSelectedGlossaryIds}
        onOpenManager={() => {
          setIsGlossaryDrawerOpen(false);
          window.location.hash = '#meetings?panel=global-glossary';
        }}
      />
      {isGlobalGlossaryPanelOpen ? (
        <div className="global-glossary-modal-backdrop" role="presentation" onClick={() => setIsGlobalGlossaryPanelOpen(false)}>
          <section className="global-glossary-modal" role="dialog" aria-modal="true" aria-labelledby="global-glossary-title" onClick={(event) => event.stopPropagation()}>
            <header className="global-glossary-modal-header">
              <div>
                <p className="eyebrow">GLOBAL GLOSSARY</p>
                <h2 id="global-glossary-title">全域字典</h2>
                <p>可供不同 Meeting 選用；不會混入任何單一會議的私有詞彙。</p>
              </div>
              <button className="icon-button" type="button" aria-label="關閉全域字典" onClick={() => setIsGlobalGlossaryPanelOpen(false)}><X size={20} aria-hidden="true" /></button>
            </header>
            <GlossaryPanel entries={glossaryEntries} onEntriesChange={setGlossaryEntries} />
          </section>
        </div>
      ) : null}
    </section>
  );
}

function MeetingDetailPage({ detail, detailError = '', onRetry }) {
  const [activeSection, setActiveSection] = useState('record');

  useEffect(() => {
    setActiveSection('record');
  }, [detail?.meeting?.id]);

  const sections = [
    ['record', '紀錄'],
    ['translation', '翻譯內容'],
    ['export', '匯出']
  ];

  return (
    <section className="feature-page meeting-detail-page glossary-page" aria-labelledby="meeting-detail-page-title">
      <div className="meeting-detail-layout">
        <aside className="meeting-detail-directory" aria-label="會議內容">
          <div className="meeting-detail-directory-heading"><strong>會議內容</strong></div>
          <nav aria-label="會議內容目錄">
            {sections.map(([id, label]) => (
              <button
                key={id}
                className={activeSection === id ? 'is-active' : ''}
                type="button"
                aria-current={activeSection === id ? 'page' : undefined}
                onClick={() => setActiveSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="meeting-detail-page-scroll">
          <MeetingRecordDetail detail={detail} detailError={detailError} activeSection={activeSection} onRetry={onRetry} />
        </div>
      </div>
    </section>
  );
}

function MeetingRecordDetail({ detail, detailError = '', activeSection, onRetry }) {
  if (activeSection === 'translation') {
    return <MeetingTranslationSection detail={detail} detailError={detailError} onRetry={onRetry} />;
  }

  if (activeSection === 'export') {
    return <MeetingExportSection detail={detail} detailError={detailError} onRetry={onRetry} />;
  }

  if (detail === undefined) {
    return <MeetingDetailState title="正在載入會議詳細資料"><p className="history-empty">正在載入已儲存的會議…</p></MeetingDetailState>;
  }

  if (!detail) {
    return <MeetingDetailState title="無法取得會議詳細資料"><p className="error-message" role="alert">{detailError || '此會議紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p></MeetingDetailState>;
  }

  return (
    <section className="meeting-record-section" aria-label="會議紀錄">
      <div className="meeting-record-section-heading">
        <div>
          <p className="eyebrow">MEETING RECORD</p>
          <h2>{meetingTitle(detail.meeting)}</h2>
          <p>會議基本資訊與完成狀態。</p>
        </div>
      </div>
      <dl className="session-detail-metadata meeting-detail-metadata">
        <div><dt>會議名稱</dt><dd>{meetingTitle(detail.meeting)}</dd></div>
        <div><dt>狀態</dt><dd>{meetingStatusLabel(detail.meeting?.status)}</dd></div>
        <div><dt>開始時間</dt><dd>{formatRecordTime(detail.meeting?.startedAt)}</dd></div>
        <div><dt>結束時間</dt><dd>{formatRecordTime(detail.meeting?.endedAt)}</dd></div>
        <div><dt>持續時間</dt><dd>{formatDuration(detail.meeting?.durationMs)}</dd></div>
        <div><dt>段落數</dt><dd>{detail.meeting?.segmentSummary?.totalSegments || 0}</dd></div>
        <div><dt>原文完成</dt><dd>{detail.meeting?.transcriptSummary?.sourceFinalCount || 0}</dd></div>
        <div><dt>翻譯完成</dt><dd>{detail.meeting?.transcriptSummary?.translationFinalCount || 0}</dd></div>
      </dl>
    </section>
  );
}

function MeetingTranslationSection({ detail, detailError = '', onRetry }) {
  const [translationTab, setTranslationTab] = useState('source');

  if (detail === undefined) return <MeetingDetailState title="正在載入翻譯內容"><p className="history-empty">正在載入已儲存的會議…</p></MeetingDetailState>;
  if (!detail) return <MeetingDetailState title="無法取得翻譯內容"><p className="error-message" role="alert">{detailError || '此會議紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p></MeetingDetailState>;

  const readingContent = meetingReadingContent(detail);
  const content = translationTab === 'source' ? readingContent.sourceTranscript : readingContent.translationArticle;
  const contentTitle = translationTab === 'source' ? '原始逐字稿' : '翻譯內容';
  return (
    <section className="meeting-record-section" aria-label="翻譯內容">
      <div className="meeting-record-section-heading"><div><p className="eyebrow">TRANSLATION</p><h2>翻譯內容</h2><p>查看這場會議完成的翻譯結果。</p></div></div>
      <div className="reading-tabs" role="tablist" aria-label="原文與翻譯內容切換">
        <button className={`reading-tab${translationTab === 'source' ? ' active' : ''}`} type="button" role="tab" aria-selected={translationTab === 'source'} onClick={() => setTranslationTab('source')}>原文</button>
        <button className={`reading-tab${translationTab === 'translation' ? ' active' : ''}`} type="button" role="tab" aria-selected={translationTab === 'translation'} onClick={() => setTranslationTab('translation')}>翻譯</button>
      </div>
      <ReadingContentMetadata content={content} />
      <section className="meeting-record-content-block" aria-label={contentTitle}>
        <div className="meeting-detail-section-heading"><h3>{contentTitle}</h3></div>
        {content.paragraphs.length > 0 ? <div className="session-transcript-article article-content">{content.paragraphs.map((paragraph, index) => <p key={`meeting-${translationTab}-${index}`}>{paragraph}</p>)}</div> : <p className="history-empty">{translationTab === 'source' ? '尚無原始逐字稿。' : '尚無翻譯內容。'}</p>}
      </section>
    </section>
  );
}

function MeetingExportSection({ detail, detailError = '', onRetry }) {
  const [meetingExportFormat, setMeetingExportFormat] = useState('txt');
  const [meetingExportStream, setMeetingExportStream] = useState('translation');
  const [meetingExportError, setMeetingExportError] = useState('');

  if (detail === undefined) return <MeetingDetailState title="正在載入匯出內容"><p className="history-empty">正在載入已儲存的會議…</p></MeetingDetailState>;
  if (!detail) return <MeetingDetailState title="無法取得匯出內容"><p className="error-message" role="alert">{detailError || '此會議紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p></MeetingDetailState>;

  const transcriptItems = Array.isArray(detail.transcriptItems) ? detail.transcriptItems : [];
  const exportSources = meetingExportSources(detail, meetingExportFormat);
  const finalCues = exportSources.cues;
  const timeOrigin = detail.meeting?.startedAt ?? transcriptItems[0]?.startedAt ?? null;
  const canDownload = meetingExportFormat !== 'txt' && finalCues.length > 0
    ? canExportCues(finalCues, { format: meetingExportFormat, stream: meetingExportStream })
    : canExportTranscript(transcriptItems, { format: meetingExportFormat, stream: meetingExportStream, timeOrigin });
  const unavailableReason = meetingExportUnavailableReason({ canExport: canDownload, format: meetingExportFormat, stream: meetingExportStream });

  function downloadMeetingTranscript() {
    setMeetingExportError('');
    try {
      const content = exportApplicationService.exportTranscript({ items: transcriptItems, cues: finalCues, options: { format: meetingExportFormat, stream: meetingExportStream, timeOrigin } });
      downloadTextFile(content, buildMeetingTranscriptFileName(detail.meeting, { format: meetingExportFormat, stream: meetingExportStream }), contentTypeForFormat(meetingExportFormat));
    } catch {
      setMeetingExportError('所選選項無法匯出整場會議逐字稿。');
    }
  }

  return (
    <section className="meeting-record-section meeting-export-section" aria-label="匯出">
      <div className="meeting-record-section-heading"><div><p className="eyebrow">EXPORT</p><h2>匯出</h2><p>下載語音紀錄或匯出字幕檔案。</p></div></div>
      <section className="meeting-export-block" aria-label="語音下載"><h3>語音下載</h3><p className="export-note">下載這場會議保存的原始語音或翻譯語音。</p><AudioArtifactDownloads title="" audioArtifacts={detail.audioArtifacts} inputLabel="下載原始語音" translationLabel="下載翻譯語音" hideUnavailableLinks /></section>
      <section className="meeting-export-block" aria-label="字幕匯出"><h3>字幕匯出</h3><div className="meeting-export-controls"><label className="field"><span>字幕匯出格式</span><select value={meetingExportFormat} onChange={(event) => setMeetingExportFormat(event.target.value)}><option value="txt">TXT</option><option value="srt">SRT</option><option value="vtt">VTT</option></select></label><label className="field"><span>匯出內容</span><select value={meetingExportStream} onChange={(event) => setMeetingExportStream(event.target.value)}><option value="translation">翻譯</option><option value="source">原文</option><option value="both">兩者</option></select></label><button className="button primary" type="button" onClick={downloadMeetingTranscript} disabled={!canDownload}><Download size={16} aria-hidden="true" />下載字幕檔案</button></div><p className="export-note">整場字幕優先依已保存的 Final Cue 輸出；舊紀錄沒有 Final Cue 時會使用逐字稿 fallback。</p>{unavailableReason ? <p className="export-note">{unavailableReason}</p> : null}{meetingExportError ? <p className="error-message" role="alert">{meetingExportError}</p> : null}</section>
    </section>
  );
}

function MeetingDetailState({ title, children }) {
  return <section className="meeting-record-section" aria-label={title}><div className="meeting-record-section-heading"><h2>{title}</h2></div>{children}</section>;
}

function MeetingDetail({ detail, detailError = '', activeSection = 'overview', onRetryDetail }) {
  const [meetingExportFormat, setMeetingExportFormat] = useState('txt');
  const [meetingExportStream, setMeetingExportStream] = useState('translation');
  const [meetingExportError, setMeetingExportError] = useState('');
  const [readingTab, setReadingTab] = useState('translationArticle');

  const meetingId = detail?.meeting?.id;
  const transcriptItems = useMemo(
    () => Array.isArray(detail?.transcriptItems) ? detail.transcriptItems : [],
    [detail?.transcriptItems]
  );
  const exportSources = useMemo(
    () => meetingExportSources(detail, meetingExportFormat),
    [detail, meetingExportFormat]
  );
  const finalCues = exportSources.cues;
  const readingContent = useMemo(() => meetingReadingContent(detail), [detail]);

  useEffect(() => {
    setMeetingExportFormat('txt');
    setMeetingExportStream('translation');
    setMeetingExportError('');
    setReadingTab('translationArticle');
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId || activeSection === 'overview') return undefined;
    if (activeSection === 'source' || activeSection === 'translation') {
      setReadingTab(activeSection === 'source' ? 'sourceTranscript' : 'translationArticle');
    }
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-history-section="${activeSection === 'translation' ? 'source' : activeSection}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, meetingId]);

  if (detail === undefined) {
    return (
      <section className="session-detail meeting-detail" aria-label="會議詳細資料">
        <div className="session-detail-header">
          <h3>正在載入會議詳細資料</h3>
        </div>
        <p className="history-empty">正在載入已儲存的會議…</p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="session-detail meeting-detail" aria-label="會議詳細資料">
        <div className="session-detail-header">
          <h3>無法取得會議詳細資料</h3>
        </div>
        <p className="error-message" role="alert">{detailError || '此翻譯紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetryDetail}>重試</button></p>
      </section>
    );
  }

  const timeOrigin = detail.meeting?.startedAt ?? transcriptItems[0]?.startedAt ?? null;
  const canDownloadMeetingTranscript = meetingExportFormat !== 'txt' && finalCues.length > 0
    ? canExportCues(finalCues, { format: meetingExportFormat, stream: meetingExportStream })
    : canExportTranscript(transcriptItems, {
        format: meetingExportFormat,
        stream: meetingExportStream,
        timeOrigin
      });
  const exportUnavailableReason = meetingExportUnavailableReason({
    canExport: canDownloadMeetingTranscript,
    format: meetingExportFormat,
    stream: meetingExportStream
  });

  function downloadMeetingTranscript() {
    setMeetingExportError('');

    try {
      const content = exportApplicationService.exportTranscript({
        items: transcriptItems,
        cues: finalCues,
        options: {
          format: meetingExportFormat,
          stream: meetingExportStream,
          timeOrigin
        }
      });
      downloadTextFile(
        content,
        buildMeetingTranscriptFileName(detail.meeting, {
          format: meetingExportFormat,
          stream: meetingExportStream
        }),
        contentTypeForFormat(meetingExportFormat)
      );
    } catch {
      setMeetingExportError('所選選項無法匯出整場會議逐字稿。');
    }
  }

  return (
    <section className="session-detail meeting-detail" aria-label="會議詳細資料">
      <div className="session-detail-header">
        <h3>{meetingTitle(detail.meeting)}詳細資料</h3>
      </div>

      <dl className="session-detail-metadata meeting-detail-metadata" data-history-section="overview">
        <div><dt>狀態</dt><dd>{meetingStatusLabel(detail.meeting?.status)}</dd></div>
        <div><dt>開始時間</dt><dd>{formatRecordTime(detail.meeting?.startedAt)}</dd></div>
        <div><dt>結束時間</dt><dd>{formatRecordTime(detail.meeting?.endedAt)}</dd></div>
        <div><dt>持續時間</dt><dd>{formatDuration(detail.meeting?.durationMs)}</dd></div>
        <div><dt>段落</dt><dd>{meetingSegmentSummaryLabel(detail.meeting?.segmentSummary)}</dd></div>
        <div><dt>逐字稿</dt><dd>{transcriptSummaryLabel(detail.meeting?.transcriptSummary)}</dd></div>
      </dl>

      <AudioArtifactDownloads
        title="整場語音紀錄下載"
        audioArtifacts={detail.audioArtifacts}
        inputLabel="下載整場原始語音"
        translationLabel="下載整場翻譯語音"
      />

      <ReadingContentTabs
        content={readingContent}
        selectedTab={readingTab}
        onSelectTab={setReadingTab}
        historySection="source"
      />

      <section className="saved-export-panel" aria-label="整場會議逐字稿匯出" data-history-section="export">
        <div className="controls saved-export-controls">
          <label className="field">
            <span>整場匯出格式</span>
            <select value={meetingExportFormat} onChange={(event) => setMeetingExportFormat(event.target.value)}>
              <option value="txt">TXT</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
            </select>
          </label>

          <label className="field">
            <span>整場匯出內容</span>
            <select value={meetingExportStream} onChange={(event) => setMeetingExportStream(event.target.value)}>
              <option value="translation">翻譯</option>
              <option value="source">原文</option>
              <option value="both">兩者</option>
            </select>
          </label>

          <button
            className="button detail-button"
            type="button"
            onClick={downloadMeetingTranscript}
            disabled={!canDownloadMeetingTranscript}
          >
            <Download size={16} aria-hidden="true" />
            下載整場逐字稿
          </button>
        </div>
        <p className="export-note">整場字幕優先依已保存的 Final Cue 輸出；中斷或失敗段落已保存的內容仍會保留。舊紀錄沒有 Final Cue 時會使用逐字稿分組 fallback。</p>
        {exportUnavailableReason ? <p className="export-note">{exportUnavailableReason}</p> : null}
        {meetingExportError ? <p className="error-message">{meetingExportError}</p> : null}
      </section>
    </section>
  );
}

function LiveGlossaryDrawer({
  open,
  entries,
  targetLanguageCode,
  selectedEntryIds,
  disabled,
  readOnly = false,
  onClose,
  onEntriesChange,
  onSelectionChange,
  onOpenManager
}) {
  const [source, setSource] = useState('');
  const [translation, setTranslation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [recentlyAddedEntryId, setRecentlyAddedEntryId] = useState('');
  const glossaryListRef = useRef(null);
  const locallyAddedEntryIdsRef = useRef(new Set());
  const apiClientRef = useRef(createGlossaryApiClient());

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError('');
    locallyAddedEntryIdsRef.current = new Set();
    void apiClientRef.current.listEntries()
      .then((loadedEntries) => {
        if (!cancelled) {
          onEntriesChange((currentEntries) => {
            const current = Array.isArray(currentEntries) ? currentEntries : [];
            const loadedIds = new Set(loadedEntries.map((entry) => entry?.id).filter(Boolean));
            const locallyAddedEntries = current.filter((entry) => (
              locallyAddedEntryIdsRef.current.has(entry?.id) && !loadedIds.has(entry?.id)
            ));
            return [...locallyAddedEntries, ...loadedEntries];
          });
        }
      })
      .catch(() => {
        if (!cancelled) setError('無法載入字典。請稍後再試。');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, onEntriesChange]);

  function resetQuickAdd() {
    setSource('');
    setTranslation('');
  }

  async function saveQuickEntry() {
    setIsSaving(true);
    setStatus('');
    setError('');
    try {
      const entry = await apiClientRef.current.createEntry({
        source: source.trim(),
        translations: { [targetLanguageCode]: translation.trim() },
        scope: 'live'
      });
      locallyAddedEntryIdsRef.current.add(entry.id);
      onEntriesChange(mergeGlossaryEntry(entries, entry));
      onSelectionChange((current) => [...new Set([...current, entry.id])]);
      setRecentlyAddedEntryId(entry.id);
      setStatus('詞條已新增並套用。');
      resetQuickAdd();
    } catch {
      setError('無法新增詞條。請確認原文與翻譯皆已填寫。');
    } finally {
      setIsSaving(false);
    }
  }

  const targetEntries = liveGlossaryEntriesForTarget(entries, targetLanguageCode);
  const settingsDisabled = disabled || readOnly;
  const canSave = source.trim().length > 0 && translation.trim().length > 0 && !isSaving && !settingsDisabled;

  useEffect(() => {
    if (!recentlyAddedEntryId || !targetEntries.some((entry) => entry.id === recentlyAddedEntryId)) return;
    glossaryListRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    setRecentlyAddedEntryId('');
  }, [recentlyAddedEntryId, targetEntries]);

  return (
    <>
      <div className={`glossary-drawer-backdrop${open ? ' is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`glossary-drawer${open ? ' is-open' : ''}`} aria-label="本次翻譯字典" aria-hidden={!open}>
        <div className="glossary-drawer-header">
          <div>
            <p className="eyebrow">即時字幕</p>
            <h2>本次使用字典</h2>
            <p>{readOnly ? '這些詞條來自會議建立設定；如需修改，請回會議管理。' : '選取的詞條會套用到本次翻譯與後續分段。'}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉字典" tabIndex={open ? 0 : -1}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="glossary-drawer-body">
          {isLoading ? <p className="history-empty">正在載入字典…</p> : null}
          {error ? <p className="error-message" role="alert">{error}</p> : null}
          {!isLoading && targetEntries.length === 0 ? (
            <div className="glossary-drawer-empty">
              <BookOpen size={28} aria-hidden="true" />
              <strong>目前沒有可用詞條</strong>
              <p>新增常用名稱或專有名詞，讓翻譯更一致。</p>
            </div>
          ) : null}
          {targetEntries.length > 0 ? (
            <div className="glossary-drawer-list" ref={glossaryListRef}>
              {targetEntries.map((entry) => (
                <label className={`glossary-choice${selectedEntryIds.includes(entry.id) ? ' is-selected' : ''}`} key={entry.id}>
                  <input
                    type="checkbox"
                    checked={selectedEntryIds.includes(entry.id)}
                    onChange={(event) => onSelectionChange((current) => event.target.checked
                      ? [...new Set([...current, entry.id])]
                      : current.filter((id) => id !== entry.id))}
                    disabled={settingsDisabled}
                    tabIndex={open ? 0 : -1}
                  />
                  <span>
                    <strong>{entry.source}</strong>
                    <small>{entry.target}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {!readOnly ? (
            <div className="glossary-quick-add">
              <h3>快速新增詞條</h3>
              <label className="field">
                <span>原文</span>
                <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如：產品名稱" disabled={settingsDisabled || isSaving} tabIndex={open ? 0 : -1} />
              </label>
              <label className="field">
                <span>翻譯（{targetLanguageLabelFor(targetLanguageCode) || targetLanguageCode}）</span>
                <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="例如：正式翻譯" disabled={settingsDisabled || isSaving} tabIndex={open ? 0 : -1} />
              </label>
              <button className="button primary" type="button" onClick={saveQuickEntry} disabled={!canSave} tabIndex={open ? 0 : -1}>
                {isSaving ? '儲存中…' : '新增並套用'}
              </button>
              {status ? <p className="success-message" role="status">{status}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="glossary-drawer-footer">
          <button className="button secondary" type="button" onClick={onOpenManager} tabIndex={open ? 0 : -1}>{readOnly ? '回會議管理修改' : '前往完整字典管理'}</button>
        </div>
      </aside>
    </>
  );
}

function GlobalGlossaryPanel({ entries: sharedEntries = [], onEntriesChange, categories: sharedCategories = [], onCategoriesChange }) {
  const [entries, setEntries] = useState(sharedEntries);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [language, setLanguage] = useState('all');
  const [sort, setSort] = useState('updated');
  const [selectedIds, setSelectedIds] = useState([]);
  const [editingEntry, setEditingEntry] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [categories, setCategories] = useState(sharedCategories);
  const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryLabel, setCategoryLabel] = useState('');
  const [isCategorySaving, setIsCategorySaving] = useState(false);
  const entriesRef = useRef([]);
  const apiRef = useRef(createGlossaryApiClient());

  useEffect(() => { entriesRef.current = sharedEntries; setEntries(sharedEntries); }, [sharedEntries]);
  useEffect(() => { setCategories(sharedCategories); }, [sharedCategories]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiRef.current.listEntries(), apiRef.current.listCategories()]).then(([loaded, loadedCategories]) => {
      if (!cancelled) { entriesRef.current = loaded; setEntries(loaded); setCategories(loadedCategories); onEntriesChange?.(loaded); onCategoriesChange?.(loadedCategories); setError(''); }
    }).catch(() => { if (!cancelled) setError('無法載入全域字典，請稍後再試。'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const categoryOptions = useMemo(() => [
    { value: 'all', label: '全部分類' },
    ...(categories.length > 0 ? categories : DEFAULT_GLOSSARY_CATEGORIES).map((item) => ({ value: item.id, label: item.label }))
  ], [categories]);

  useEffect(() => {
    if (!isDrawerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeEditor();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDrawerOpen]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...entries].filter((entry) => {
      const text = [entry.source, entry.notes, ...(entry.tags || []), ...Object.values(entry.translations || {})].join(' ').toLocaleLowerCase();
      return (!normalizedQuery || text.includes(normalizedQuery)) && (category === 'all' || (entry.category || 'other') === category) && (language === 'all' || Object.hasOwn(entry.translations || {}, language));
    }).sort((a, b) => sort === 'source' ? a.source.localeCompare(b.source) : sort === 'created' ? String(b.createdAt || '').localeCompare(String(a.createdAt || '')) : String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }, [entries, query, category, language, sort]);

  const allVisibleSelected = filteredEntries.length > 0 && filteredEntries.every((entry) => selectedIds.includes(entry.id));
  function publish(next) { entriesRef.current = next; setEntries(next); onEntriesChange?.(next); }
  function openEditor(entry = null) { setEditingEntry(entry ? { ...entry, translations: { ...entry.translations }, tags: [...(entry.tags || [])] } : { source: '', sourceLanguageCode: 'zh-Hant', translations: { en: '' }, category: categories.find((item) => item.id === 'other')?.id || categories[0]?.id || 'other', tags: [], enabled: true, notes: '', scope: 'both' }); setStatus(''); setError(''); setIsDrawerOpen(true); }
  function closeEditor() { setIsDrawerOpen(false); setEditingEntry(null); }
  function updateEditor(field, value) { setEditingEntry((current) => ({ ...current, [field]: value })); }
  function updateTranslation(code, value) { setEditingEntry((current) => ({ ...current, translations: { ...current.translations, [code]: value } })); }
  function removeTranslation(code) { setEditingEntry((current) => { const translations = { ...current.translations }; delete translations[code]; return { ...current, translations }; }); }
  async function saveEntry(event) {
    event.preventDefault();
    const translations = Object.fromEntries(Object.entries(editingEntry.translations || {}).filter(([, value]) => value.trim()));
    if (!editingEntry.source.trim() || !Object.keys(translations).length) { setError('請填寫原文與至少一個目標語言翻譯。'); return; }
    setIsSaving(true); setError(''); setStatus('');
    try {
      const payload = { ...editingEntry, source: editingEntry.source.trim(), translations, tags: editingEntry.tags || [], scope: 'live' };
      const saved = editingEntry.id ? await apiRef.current.updateEntry(editingEntry.id, payload) : await apiRef.current.createEntry(payload);
      publish(editingEntry.id ? entriesRef.current.map((entry) => entry.id === saved.id ? saved : entry) : mergeGlossaryEntry(entriesRef.current, saved));
      closeEditor(); setStatus(editingEntry.id ? '全域詞條已更新。' : '全域詞條已新增。');
    } catch { setError('無法儲存全域詞條。請確認欄位內容正確。'); } finally { setIsSaving(false); }
  }
  async function deleteEntry(entry) {
    if (!window.confirm(`確定要刪除「${entry.source}」嗎？`)) return;
    try { await apiRef.current.deleteEntry(entry.id); publish(entriesRef.current.filter((item) => item.id !== entry.id)); setSelectedIds((ids) => ids.filter((id) => id !== entry.id)); closeEditor(); setStatus('全域詞條已刪除。'); } catch { setError('無法刪除全域詞條。'); }
  }
  async function bulkUpdate(patch) {
    setError('');
    try {
      const updated = await Promise.all(selectedIds.map((id) => { const entry = entriesRef.current.find((item) => item.id === id); return apiRef.current.updateEntry(id, { ...entry, ...patch }); }));
      const map = new Map(updated.map((entry) => [entry.id, entry])); publish(entriesRef.current.map((entry) => map.get(entry.id) || entry)); setSelectedIds([]); setStatus('批次操作已完成。');
    } catch { setError('批次操作失敗，請稍後再試。'); }
  }
  function toggleAllVisible() {
    setSelectedIds(allVisibleSelected
      ? selectedIds.filter((id) => !filteredEntries.some((entry) => entry.id === id))
      : [...new Set([...selectedIds, ...filteredEntries.map((entry) => entry.id)])]);
  }
  function publishCategories(next) { setCategories(next); onCategoriesChange?.(next); }
  function openCategoryManager() { setEditingCategory(null); setCategoryLabel(''); setIsCategoryDialogOpen(true); setError(''); }
  async function saveCategory(event) {
    event.preventDefault();
    if (!categoryLabel.trim()) { setError('分類名稱不可為空白。'); return; }
    setIsCategorySaving(true); setError('');
    try {
      const saved = editingCategory ? await apiRef.current.updateCategory(editingCategory.id, { label: categoryLabel.trim() }) : await apiRef.current.createCategory({ label: categoryLabel.trim() });
      publishCategories(editingCategory ? categories.map((item) => item.id === saved.id ? saved : item) : [...categories, saved]);
      setEditingCategory(null); setCategoryLabel(''); setStatus(editingCategory ? '分類名稱已更新。' : '分類已新增。');
    } catch (operationError) { setError(glossaryOperationErrorMessage(operationError, '分類名稱不可空白或重複。')); }
    finally { setIsCategorySaving(false); }
  }
  async function moveCategory(category, direction) {
    const index = categories.findIndex((item) => item.id === category.id); const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= categories.length) return;
    const next = [...categories]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    try { publishCategories(await apiRef.current.reorderCategories(next.map((item) => item.id))); setStatus('分類順序已更新。'); } catch (operationError) { setError(glossaryOperationErrorMessage(operationError, '無法更新分類順序。')); }
  }
  async function deleteCategory(category) {
    if (category.id === 'other' || !window.confirm(`確定要刪除「${category.label}」嗎？相關詞條會改歸其他。`)) return;
    try { const result = await apiRef.current.deleteCategory(category.id); publishCategories(categories.filter((item) => item.id !== category.id)); publish(entriesRef.current.map((entry) => entry.category === category.id ? { ...entry, category: 'other' } : entry)); setStatus(`分類已刪除，${result.reassignedEntryCount || 0} 筆詞條已改歸其他。`); } catch { setError('無法刪除分類。'); }
  }

  return <section className="global-glossary" aria-label="全域字典詞條管理">
    <div className="global-glossary-toolbar">
      <div className="global-glossary-toolbar-main">
        <label className="field glossary-search"><span>搜尋詞條</span><div className="meeting-toolbar-input"><Search size={19} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋原文、翻譯或標籤" /></div></label>
        <div className="global-glossary-primary-actions"><button className="button secondary" type="button" onClick={openCategoryManager}><Settings size={18} aria-hidden="true" />管理分類</button><button className="button primary" type="button" onClick={() => openEditor()}><Plus size={18} aria-hidden="true" />新增詞條</button></div>
      </div>
      <div className="global-glossary-filter-row">
        <label className="field"><span>目標語言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="all">所有語言</option>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
        <label className="field"><span>分類</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="field"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">最近更新</option><option value="created">最近建立</option><option value="source">原文 A–Z</option></select></label>
        <button className="button secondary" type="button" onClick={() => { setQuery(''); setCategory('all'); setLanguage('all'); }}><Filter size={17} aria-hidden="true" />清除篩選</button>
      </div>
    </div>
    {selectedIds.length ? <div className="glossary-bulk-bar" role="toolbar"><strong>已選取 {selectedIds.length} 筆</strong><button className="button detail-button" type="button" onClick={() => bulkUpdate({ enabled: true })}><Check size={16} aria-hidden="true" />批次啟用</button><button className="button detail-button" type="button" onClick={() => bulkUpdate({ enabled: false })}>批次停用</button><button className="button secondary" type="button" onClick={() => setSelectedIds([])}>取消選取</button></div> : null}
    {status ? <p className="success-message" role="status">{status}</p> : null}{error ? <p className="error-message" role="alert">{error}</p> : null}
    <div className="global-glossary-layout"><aside className="glossary-category-sidebar"><div className="glossary-sidebar-heading"><strong>詞條分類</strong><span>{entries.length}</span></div>{categoryOptions.map((item) => { const count = item.value === 'all' ? entries.length : entries.filter((entry) => (entry.category || 'other') === item.value).length; return <button className={category === item.value ? 'is-active' : ''} key={item.value} type="button" onClick={() => setCategory(item.value)}><span>{item.label}</span><small>{count}</small></button>; })}</aside><div className="glossary-card-region"><div className="glossary-card-region-header"><span>{isLoading ? '載入中…' : `共 ${filteredEntries.length} 筆詞條`}</span><label className="glossary-select-all"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />全選目前結果</label></div>{!isLoading && !filteredEntries.length ? <div className="empty-state glossary-empty"><BookOpen size={30} aria-hidden="true" /><strong>找不到符合條件的詞條</strong><span>調整搜尋或新增一筆全域詞條。</span></div> : <div className="glossary-card-grid">{filteredEntries.map((entry) => <article className={`glossary-card${entry.enabled === false ? ' is-disabled' : ''}`} key={entry.id} onClick={() => openEditor(entry)}><div className="glossary-card-topline"><input type="checkbox" aria-label={`選取 ${entry.source}`} checked={selectedIds.includes(entry.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedIds((ids) => ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id])} /><span className={`glossary-status ${entry.enabled === false ? 'is-disabled' : ''}`}><span />{entry.enabled === false ? '已停用' : '啟用中'}</span><button className="icon-button" type="button" aria-label={`更多操作：${entry.source}`} onClick={(event) => { event.stopPropagation(); openEditor(entry); }}><MoreHorizontal size={19} aria-hidden="true" /></button></div><div className="glossary-card-source"><small>{targetLanguageLabelFor(entry.sourceLanguageCode) || entry.sourceLanguageCode || '來源語言'}</small><h3>{entry.source}</h3></div><div className="glossary-card-translations">{Object.entries(entry.translations || {}).slice(0, 2).map(([code, text]) => <div key={code}><small>{targetLanguageLabelFor(code) || code}</small><p>{text}</p></div>)}{Object.keys(entry.translations || {}).length > 2 ? <small>+{Object.keys(entry.translations).length - 2} 個翻譯</small> : null}</div><div className="glossary-card-footer"><span className="glossary-category-tag">{categoryOptions.find((item) => item.value === (entry.category || 'other'))?.label}</span>{entry.tags?.slice(0, 2).map((tag) => <span className="glossary-tag" key={tag}><Tag size={12} aria-hidden="true" />{tag}</span>)}</div></article>)}</div>}</div></div>
    {isDrawerOpen && editingEntry ? <><div className="global-glossary-dialog-backdrop" onClick={closeEditor} aria-hidden="true" /><section className="global-glossary-dialog" role="dialog" aria-modal="true" aria-labelledby="global-glossary-editor-title" onClick={(event) => event.stopPropagation()}><div className="global-glossary-dialog-header"><div><p className="eyebrow">GLOBAL ENTRY</p><h2 id="global-glossary-editor-title">{editingEntry.id ? '編輯詞條' : '新增詞條'}</h2></div><button className="icon-button" type="button" aria-label="關閉編輯對話框" onClick={closeEditor}><X size={20} aria-hidden="true" /></button></div><form className="global-glossary-form" onSubmit={saveEntry}><label className="field"><span>原文字詞</span><input value={editingEntry.source} onChange={(event) => updateEditor('source', event.target.value)} autoFocus required /></label><label className="field"><span>來源語言</span><select value={editingEntry.sourceLanguageCode} onChange={(event) => updateEditor('sourceLanguageCode', event.target.value)}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><div className="glossary-form-section"><div className="glossary-form-section-heading"><strong>目標語言翻譯</strong><button className="button detail-button" type="button" onClick={() => updateEditor('translations', { ...editingEntry.translations, ja: editingEntry.translations?.ja || '' })}>＋新增語言</button></div>{Object.entries(editingEntry.translations || {}).map(([code, text]) => <div className="translation-row" key={code}><select aria-label="翻譯語言" value={code} onChange={(event) => { const next = {}; Object.entries(editingEntry.translations).forEach(([oldCode, oldText]) => { next[oldCode === code ? event.target.value : oldCode] = oldText; }); updateEditor('translations', next); }}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select><input aria-label={`翻譯內容：${code}`} value={text} onChange={(event) => updateTranslation(code, event.target.value)} placeholder="輸入翻譯" required /><button className="icon-button" type="button" aria-label="移除翻譯" onClick={() => removeTranslation(code)} disabled={Object.keys(editingEntry.translations).length <= 1}><X size={16} aria-hidden="true" /></button></div>)}</div><label className="field"><span>分類</span><select value={editingEntry.category} onChange={(event) => updateEditor('category', event.target.value)}>{categoryOptions.slice(1).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field"><span>標籤（以逗號分隔）</span><input value={(editingEntry.tags || []).join(', ')} onChange={(event) => updateEditor('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} placeholder="例如：產品、Q3" /></label><label className="field"><span>備註</span><textarea rows="4" value={editingEntry.notes || ''} onChange={(event) => updateEditor('notes', event.target.value)} placeholder="補充使用情境或翻譯說明" /></label><label className="glossary-enabled-toggle"><input type="checkbox" checked={editingEntry.enabled !== false} onChange={(event) => updateEditor('enabled', event.target.checked)} /><span><strong>啟用詞條</strong><small>停用後仍保留在全域字典，但不會被會議選用。</small></span></label><div className="global-glossary-dialog-actions">{editingEntry.id ? <button className="button danger-button" type="button" onClick={() => deleteEntry(editingEntry)}>刪除詞條</button> : null}<button className="button secondary" type="button" onClick={closeEditor}>取消</button><button className="button primary" type="submit" disabled={isSaving}>{isSaving ? '儲存中…' : editingEntry.id ? '儲存變更' : '新增全域詞條'}</button></div></form></section></> : null}
    {isCategoryDialogOpen ? <><div className="global-glossary-dialog-backdrop" onClick={() => setIsCategoryDialogOpen(false)} aria-hidden="true" /><section className="global-glossary-dialog category-management-dialog" role="dialog" aria-modal="true" aria-labelledby="category-management-title" onClick={(event) => event.stopPropagation()}><div className="global-glossary-dialog-header"><div><p className="eyebrow">GLOBAL CATEGORIES</p><h2 id="category-management-title">管理分類</h2></div><button className="icon-button" type="button" aria-label="關閉分類管理" onClick={() => setIsCategoryDialogOpen(false)}><X size={20} aria-hidden="true" /></button></div><form className="category-create-form" onSubmit={saveCategory}><label className="field"><span>{editingCategory ? '編輯分類名稱' : '新增分類'}</span><input value={categoryLabel} onChange={(event) => setCategoryLabel(event.target.value)} placeholder="例如：專案名詞" autoFocus /></label><button className="button primary" type="submit" disabled={isCategorySaving}>{isCategorySaving ? '儲存中…' : editingCategory ? '儲存名稱' : '新增分類'}</button></form><div className="category-management-list">{categories.map((item, index) => <div className="category-management-row" key={item.id}><span><strong>{item.label}</strong><small>{item.id}{item.id === 'other' ? ' · 不可刪除' : ''}</small></span><div className="category-management-actions"><button className="icon-button" type="button" aria-label={`上移 ${item.label}`} onClick={() => moveCategory(item, -1)} disabled={index === 0}>↑</button><button className="icon-button" type="button" aria-label={`下移 ${item.label}`} onClick={() => moveCategory(item, 1)} disabled={index === categories.length - 1}>↓</button><button className="button detail-button" type="button" onClick={() => { setEditingCategory(item); setCategoryLabel(item.label); }}>編輯</button><button className="button danger-button" type="button" onClick={() => deleteCategory(item)} disabled={item.id === 'other'}>刪除</button></div></div>)}</div></section></> : null}
  </section>;
}

function GlossaryPanel({ entries: sharedEntries = [], onEntriesChange }) {
  const [entries, setEntries] = useState(sharedEntries);
  const [source, setSource] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [translation, setTranslation] = useState('');
  const [scope, setScope] = useState('history');
  const [editingEntry, setEditingEntry] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const entriesRef = useRef([]);
  const glossaryApiClientRef = useRef(createGlossaryApiClient());

  useEffect(() => {
    entriesRef.current = sharedEntries;
    setEntries(sharedEntries);
  }, [sharedEntries]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    glossaryApiClientRef.current.listEntries()
      .then((loadedEntries) => {
        if (!cancelled) {
          publishEntries(loadedEntries);
          setError('');
        }
      })
      .catch(() => {
        if (!cancelled) setError('無法載入字典。請確認伺服器正在執行且字典儲存檔可寫入。');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function resetForm() {
    setSource('');
    setTargetLanguageCode('en');
    setTranslation('');
    setScope('history');
    setEditingEntry(null);
  }

  async function saveEntry() {
    setIsSaving(true);
    setStatus('');
    setError('');
    try {
      const translations = {
        ...(editingEntry?.translations || {}),
        [targetLanguageCode]: translation
      };
      const payload = { source, translations, scope };
      if (editingEntry && hasReplacementAliases(editingEntry.replacementAliases)) {
        payload.replacementAliases = editingEntry.replacementAliases;
      }
      const entry = editingEntry
        ? await glossaryApiClientRef.current.updateEntry(editingEntry.id, payload)
        : await glossaryApiClientRef.current.createEntry(payload);
      publishEntries(editingEntry
        ? entriesRef.current.map((item) => item.id === entry.id ? entry : item)
        : mergeGlossaryEntry(entriesRef.current, entry));
      setStatus(editingEntry ? '字典詞條已更新。' : '字典詞條已新增。');
      resetForm();
    } catch {
      setError('無法儲存字典詞條。請確認原文與翻譯皆已填寫。');
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteEntry(entry) {
    if (!window.confirm('確定要刪除此字典詞條？')) {
      return;
    }

    setStatus('');
    setError('');
    try {
      await glossaryApiClientRef.current.deleteEntry(entry.id);
      publishEntries(entriesRef.current.filter((item) => item.id !== entry.id));
      if (editingEntry?.id === entry.id) resetForm();
      setStatus('字典詞條已刪除。');
    } catch {
      setError('無法刪除字典詞條。');
    }
  }

  function startEditing(entry) {
    const firstLanguageCode = Object.keys(entry.translations || {})[0] || 'en';
    setEditingEntry(entry);
    setSource(entry.source || '');
    setTargetLanguageCode(firstLanguageCode);
    setTranslation(entry.translations?.[firstLanguageCode] || '');
    setScope(entry.scope || 'history');
    setStatus('');
    setError('');
  }

  function publishEntries(next) {
    entriesRef.current = next;
    setEntries(next);
    onEntriesChange?.(next);
  }

  const canSave = source.trim().length > 0 && translation.trim().length > 0 && !isSaving;

  return (
    <section className="glossary-panel" aria-label="翻譯字典詞條管理">
      <div className="controls glossary-controls">
        <label className="field">
          <span>詞條</span>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如：產品名稱" />
        </label>
        <label className="field">
          <span>目標語言</span>
          <select value={targetLanguageCode} onChange={(event) => {
            const nextLanguageCode = event.target.value;
            setTargetLanguageCode(nextLanguageCode);
            setTranslation(editingEntry?.translations?.[nextLanguageCode] || '');
          }}>
            {SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>替換成</span>
          <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="例如：正式翻譯" />
        </label>
        <label className="field">
          <span>套用範圍</span>
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="live">即時字幕</option>
            <option value="history">歷史重新翻譯</option>
            <option value="both">兩者</option>
          </select>
        </label>
        <button className="button detail-button" type="button" disabled={!canSave} onClick={saveEntry}>
          {isSaving ? '儲存中…' : editingEntry ? '更新詞條' : '新增詞條'}
        </button>
        {editingEntry ? <button className="button detail-button" type="button" onClick={resetForm}>取消編輯</button> : null}
      </div>
      <div className="glossary-feedback">
        {error ? <p className="error-message glossary-form-message" role="alert">{error}</p> : null}
        {!canSave && !isSaving && !editingEntry ? <p className="form-hint">請填寫詞條與替換內容後，才能新增。</p> : null}
        {status ? <p className="success-message" role="status">{status}</p> : null}
        {isLoading ? <p className="history-empty">正在載入字典…</p> : null}
        {!isLoading && entries.length === 0 ? <div className="empty-state"><p className="history-empty">尚無字典詞條。</p><p className="history-empty">新增常用名稱或專有名詞後，翻譯會更一致。</p></div> : null}
      </div>
      <div className="glossary-table-scroll">
        <AgGridReact
            {...dataGridProps('glossary-data-grid', { fixedHeight: true })}
            aria-label="翻譯字典詞條列表"
            columnDefs={[
              { headerName: '詞條', field: 'source', width: 220, cellRenderer: GlossarySourceCell },
              { headerName: '翻譯內容', valueGetter: ({ data }) => glossaryTranslationLabel(data.translations), minWidth: 280, flex: 1 },
              { headerName: '套用範圍', valueGetter: ({ data }) => glossaryScopeLabel(data.scope), width: 150 },
              { headerName: '操作', width: 220, sortable: false, cellRenderer: GlossaryActionsCell }
            ]}
            context={{ onEdit: startEditing, onDelete: deleteEntry }}
            rowData={entries}
            getRowId={({ data }) => data.id || data.source}
        />
      </div>
    </section>
  );
}

function SessionDetail({ detail, historyRecord, activeSection = 'overview', detailError = '', onRetryDetail }) {
  const [savedExportFormat, setSavedExportFormat] = useState('txt');
  const [savedExportStream, setSavedExportStream] = useState('translation');
  const [savedExportError, setSavedExportError] = useState('');
  const [readingTab, setReadingTab] = useState('translationArticle');
  const sessionRecordId = detail?.session?.id;

  useEffect(() => {
    setSavedExportFormat('txt');
    setSavedExportStream('translation');
    setSavedExportError('');
    setReadingTab('translationArticle');
  }, [sessionRecordId]);

  useEffect(() => {
    if (!sessionRecordId || activeSection === 'overview') return undefined;
    if (activeSection === 'source' || activeSection === 'translation') {
      setReadingTab(activeSection === 'source' ? 'sourceTranscript' : 'translationArticle');
    }
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-history-section="${activeSection === 'translation' ? 'source' : activeSection}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, sessionRecordId]);

  const sessionRecord = useMemo(
    () => sessionRecordForDetailDTO(detail, historyRecord),
    [detail, historyRecord]
  );
  const sourceItems = useMemo(
    () => finalTranscriptItemsForStream(detail?.sourceTranscript?.items, 'source'),
    [detail?.sourceTranscript?.items]
  );
  const translationItems = useMemo(
    () => finalTranscriptItemsForStream(detail?.selectedTranslationOutput?.items, 'translation'),
    [detail?.selectedTranslationOutput?.items]
  );
  const historyCues = useMemo(
    () => cueListForDisplay({ finalCues: detail?.cues || [] }, { includePartial: false }),
    [detail?.cues]
  );
  const readingContent = useMemo(
    () => readingContentForDetail(detail, { sourceItems, translationItems, sessionRecord }),
    [detail, sourceItems, translationItems, sessionRecord]
  );
  const exportDetail = useMemo(
    () => exportDetailForSessionDetailDTO(detail, historyRecord),
    [detail, historyRecord]
  );

  if (detail === undefined) {
    return (
      <section className="session-detail" aria-label="工作階段詳細資料">
        <div className="session-detail-header">
          <h3>正在載入工作階段詳細資料</h3>
        </div>
        <p className="history-empty">正在載入已儲存的工作階段…</p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="session-detail" aria-label="工作階段詳細資料">
        <div className="session-detail-header">
          <h3>無法取得工作階段詳細資料</h3>
        </div>
        <p className="error-message" role="alert">{detailError || '此翻譯紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetryDetail}>重試</button></p>
      </section>
    );
  }

  const canDownloadSavedTranscript = canExportSavedSession(exportDetail, { format: savedExportFormat, stream: savedExportStream });
  const savedExportUnavailableReason = savedSessionExportUnavailableReason(exportDetail, { format: savedExportFormat, stream: savedExportStream });

  function downloadSavedTranscript() {
    setSavedExportError('');

    try {
      const content = exportApplicationService.exportCombinedSessionView({
        sessionDetail: exportDetail,
        options: {
          format: savedExportFormat,
          stream: savedExportStream
        }
      });
      const fileName = buildSavedSessionFileName(exportDetail.sessionRecord, {
        format: savedExportFormat,
        stream: savedExportStream
      });
      downloadTextFile(content, fileName, contentTypeForFormat(savedExportFormat));
    } catch {
      setSavedExportError('所選選項無法匯出已儲存的逐字稿。');
    }
  }

  return (
    <section className="session-detail" aria-label="工作階段詳細資料">
      <div className="session-detail-header">
        <h3>{historyLanguageLabel(sessionRecord)}詳細資料</h3>
      </div>

      <dl className="session-detail-metadata" data-history-section="overview">
        <div>
          <dt>目標語言</dt>
          <dd>{targetLanguageLabelFor(sessionRecord.targetLanguageCode) || sessionRecord.targetLanguageLabel || sessionRecord.targetLanguageCode || '未知語言'}</dd>
        </div>
        {sessionRecord.sourceLanguageCode ? (
          <div>
            <dt>主要輸入語言</dt>
            <dd>{targetLanguageLabelFor(sessionRecord.sourceLanguageCode) || sessionRecord.sourceLanguageCode}</dd>
          </div>
        ) : null}
        <div>
          <dt>狀態</dt>
          <dd>{historyStatusLabel(sessionRecord.status)}</dd>
        </div>
        <div>
          <dt>開始時間</dt>
          <dd>{formatRecordTime(sessionRecord.startedAt)}</dd>
        </div>
        <div>
          <dt>結束時間</dt>
          <dd>{formatRecordTime(sessionRecord.endedAt)}</dd>
        </div>
        <div>
          <dt>持續時間</dt>
          <dd>{formatDuration(sessionRecord.durationMs)}</dd>
        </div>
        <div>
          <dt>逐字稿</dt>
          <dd>{transcriptSummaryLabel(sessionRecord.transcriptSummary)}</dd>
        </div>
        {shouldShowFailureReason(sessionRecord) ? (
          <div>
            <dt>失敗原因</dt>
            <dd>{sessionRecord.failureReason}</dd>
          </div>
        ) : null}
        {sessionRecord.failureCategory ? (
          <div>
            <dt>失敗類別</dt>
            <dd>{failureCategoryLabel(sessionRecord.failureCategory)}</dd>
          </div>
        ) : null}
        {sessionRecord.inputDeviceLabelSnapshot ? (
          <div>
            <dt>麥克風</dt>
            <dd>{sessionRecord.inputDeviceLabelSnapshot}</dd>
          </div>
        ) : null}
      </dl>

      <AudioArtifactDownloads
        title="語音紀錄下載"
        audioArtifacts={sessionRecord.audioArtifacts}
        inputLabel="下載原始語音紀錄"
        translationLabel="下載翻譯語音紀錄"
      />

      {historyCues.length > 0 ? (
        <section className="session-cue-section" aria-label="已儲存字幕" data-testid="session-cue-list">
          <h4>字幕</h4>
          <div className="cue-history-columns" data-testid="history-cue-columns" aria-hidden="true">
            <span>原文</span>
            <span>翻譯</span>
          </div>
          <div className="cue-list cue-list-history">
            {historyCues.map((cue) => <FinalCueRow key={cue.cueId} cue={cue} />)}
          </div>
        </section>
      ) : (
        <ReadingContentTabs
          content={readingContent}
          selectedTab={readingTab}
          onSelectTab={setReadingTab}
          historySection="source"
        />
      )}
      <section className="saved-export-panel" aria-label="已儲存逐字稿匯出" data-history-section="export">
        <div className="controls saved-export-controls">
          <label className="field">
            <span>已儲存逐字稿匯出格式</span>
            <select value={savedExportFormat} onChange={(event) => setSavedExportFormat(event.target.value)}>
              <option value="txt">TXT</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
            </select>
          </label>

          <label className="field">
            <span>已儲存逐字稿匯出內容</span>
            <select value={savedExportStream} onChange={(event) => setSavedExportStream(event.target.value)}>
            <option value="translation">翻譯</option>
            <option value="source">原文</option>
            <option value="both">兩者</option>
            </select>
          </label>

          <button
            className="button detail-button"
            type="button"
            onClick={downloadSavedTranscript}
            disabled={!canDownloadSavedTranscript}
          >
            <Download size={16} aria-hidden="true" />
            下載已儲存的逐字稿
          </button>
        </div>
        <p className="export-note">已儲存字幕的時間碼採用原始工作階段觀察時間。</p>
        {savedExportUnavailableReason ? <p className="export-note">{savedExportUnavailableReason}</p> : null}
        {savedExportError ? <p className="error-message">{savedExportError}</p> : null}
      </section>
    </section>
  );
}

function ReadingContentTabs({ content, selectedTab, onSelectTab, historySection = '' }) {
  const selectedContent = selectedTab === 'sourceTranscript'
    ? content.sourceTranscript
    : content.translationArticle;
  const selectedTitle = selectedTab === 'sourceTranscript' ? '原始逐字稿' : '翻譯內容';

  return (
    <section className="session-reading-panel" aria-label="歷史紀錄閱讀內容" data-testid="legacy-transcript-fallback" data-history-section={historySection || undefined}>
      <div className="reading-tabs" role="tablist" aria-label="歷史紀錄內容切換">
        <button
          className={`reading-tab${selectedTab === 'translationArticle' ? ' active' : ''}`}
          type="button"
          role="tab"
          aria-selected={selectedTab === 'translationArticle'}
          onClick={() => onSelectTab('translationArticle')}
        >
          翻譯內容
        </button>
        <button
          className={`reading-tab${selectedTab === 'sourceTranscript' ? ' active' : ''}`}
          type="button"
          role="tab"
          aria-selected={selectedTab === 'sourceTranscript'}
          onClick={() => onSelectTab('sourceTranscript')}
        >
          原始逐字稿
        </button>
      </div>

      <section className="session-transcript-section" aria-label={selectedTitle}>
        <div className="reading-content-header">
          <h4>{selectedTitle}</h4>
          <ReadingContentMetadata content={selectedContent} />
        </div>
        {selectedContent.paragraphs.length === 0 ? (
          <p className="history-empty">{readingContentEmptyText(selectedContent)}</p>
        ) : (
          <div className="session-transcript-article article-content">
            {selectedContent.paragraphs.map((paragraph, index) => (
              <p key={`${selectedTab}-article-${index}`}>{paragraph}</p>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function ReadingContentMetadata({ content }) {
  const metadata = [];

  if (content.kind === 'translationArticle') {
    metadata.push(`目標語言：${targetLanguageLabelFor(content.targetLanguageCode) || content.targetLanguageLabel || content.targetLanguageCode || '未知語言'}`);
    metadata.push(`建立時間：${formatRecordTime(content.createdAt)}`);
    metadata.push(`完成時間：${formatRecordTime(content.completedAt)}`);
  } else {
    metadata.push(`建立時間：${formatRecordTime(content.createdAt)}`);
    metadata.push(`完成時間：${formatRecordTime(content.finalizedAt)}`);
  }

  return <p className="reading-metadata">{metadata.join('　')}</p>;
}

function readingContentForDetail(detail, { sourceItems, translationItems, sessionRecord }) {
  if (detail?.readingContent?.translationArticle && detail?.readingContent?.sourceTranscript) {
    return detail.readingContent;
  }

  const translationParagraphs = buildTranscriptArticleParagraphs(translationItems);
  const sourceParagraphs = buildTranscriptArticleParagraphs(sourceItems);
  const fallbackStatus = terminalContentStatus(sessionRecord);

  return {
    translationArticle: {
      kind: 'translationArticle',
      status: translationParagraphs.length > 0 ? 'available' : fallbackStatus,
      targetLanguageCode: detail?.selectedTranslationOutput?.targetLanguageCode || sessionRecord.targetLanguageCode || null,
      targetLanguageLabel: detail?.selectedTranslationOutput?.targetLanguageLabel || sessionRecord.targetLanguageLabel || null,
      version: detail?.selectedTranslationOutput?.version ?? null,
      paragraphs: translationParagraphs,
      text: translationParagraphs.join('\n\n'),
      createdAt: detail?.selectedTranslationOutput?.createdAt ?? sessionRecord.startedAt ?? null,
      completedAt: detail?.selectedTranslationOutput?.completedAt ?? sessionRecord.endedAt ?? null,
      emptyReason: translationParagraphs.length > 0 ? null : emptyReasonForContentStatus(fallbackStatus)
    },
    sourceTranscript: {
      kind: 'sourceTranscript',
      status: sourceParagraphs.length > 0 ? 'available' : fallbackStatus,
      paragraphs: sourceParagraphs,
      text: sourceParagraphs.join('\n\n'),
      createdAt: detail?.sourceTranscript?.createdAt ?? sessionRecord.startedAt ?? null,
      finalizedAt: detail?.sourceTranscript?.finalizedAt ?? sessionRecord.endedAt ?? null,
      emptyReason: sourceParagraphs.length > 0 ? null : emptyReasonForContentStatus(fallbackStatus)
    }
  };
}

function terminalContentStatus(sessionRecord) {
  if (!['completed', 'stopped', 'failed', 'expired'].includes(sessionRecord?.status)) {
    return 'processing';
  }

  return sessionRecord.status === 'failed' ? 'failed' : 'empty';
}

function emptyReasonForContentStatus(status) {
  if (status === 'processing') return 'processing';
  if (status === 'failed') return 'finalize_failed';
  return 'no_content';
}

function readingContentEmptyText(content) {
  if (content.emptyReason === 'processing') {
    return '此工作階段尚未結束，正式內容仍在處理中。';
  }

  if (content.emptyReason === 'finalize_failed') {
    return '工作階段結束時未能產生新的正式內容；已保留既有歷史資料。';
  }

  return content.kind === 'translationArticle'
    ? '尚無翻譯內容。'
    : '尚無原始逐字稿。';
}

function historyLanguageLabel(record) {
  return sessionDisplayName(record);
}

function sessionDisplayName(record = {}) {
  const sourceLanguage = targetLanguageLabelFor(record.sourceLanguageCode) || record.sourceLanguageLabel || record.sourceLanguageCode || targetLanguageLabelFor(DEFAULT_SOURCE_LANGUAGE_CODE) || '來源語言未標記';
  const targetLanguage = targetLanguageLabelFor(record.targetLanguageCode) || record.targetLanguageLabel || record.targetLanguageCode || '未知語言';
  const purpose = record.recordKind === 'retranslation' ? '重新翻譯' : '即時翻譯';
  return `${formatRecordTime(record.startedAt)} · ${sourceLanguage} → ${targetLanguage} · ${purpose}`;
}

function failureCategoryLabel(category) {
  const labels = {
    user_intent: '使用者手動停止',
    microphone_capture: '麥克風無法使用',
    connection: '連線中斷',
    token: '工作階段授權失敗',
    provider: '翻譯服務暫時失敗'
  };

  return labels[category] || category;
}

function historyStatusLabel(status) {
  const labels = {
    active: '進行中',
    stopped: '已停止',
    failed: '失敗',
    expired: '已過期',
    completed: '已完成',
    interrupted: '已中斷'
  };

  return labels[status] || status;
}

function translationExecutionStatusLabel(executionOrStatus) {
  const status = typeof executionOrStatus === 'string' ? executionOrStatus : executionOrStatus?.status;
  const providerAttemptStatus = typeof executionOrStatus === 'string' ? '' : executionOrStatus?.providerAttemptStatus;
  const failureInfo = typeof executionOrStatus === 'string' ? null : executionOrStatus?.failureInfo;

  if ((status === 'running' || status === 'processing' || status === 'queued') && providerAttemptStatus === 'in_flight') {
    return '正在送往 Gemini';
  }

  if (status === 'failed' && isProviderTimeoutFailure(failureInfo)) {
    return '已逾時';
  }

  const labels = {
    queued: '已排隊',
    processing: '處理中',
    running: '處理中',
    failed: '失敗',
    cancelled: '已取消'
  };

  return labels[status] || status || '未知狀態';
}

function translationExecutionTimingText(execution, nowMs = Date.now()) {
  const startValue = execution?.providerAttemptedAt || execution?.startedAt || execution?.createdAt;
  const startMs = timestampMs(startValue);
  if (!Number.isFinite(startMs)) {
    return '';
  }

  const endMs = timestampMs(execution?.providerCompletedAt || execution?.completedAt);
  const durationMs = Number.isFinite(endMs)
    ? endMs - startMs
    : nowMs - startMs;

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  return `已等待 ${formatDuration(durationMs)}`;
}

function translationFailureReasonText(failureInfo) {
  return `失敗原因：${translationFailureReasonLabel(failureInfo)}`;
}

function translationFailureReasonLabel(failureInfo = {}) {
  const code = typeof failureInfo?.code === 'string' ? failureInfo.code : '';
  const status = Number.isInteger(failureInfo?.status) ? failureInfo.status : null;

  if (code === 'unauthorized' || status === 401) {
    return 'Gemini API 金鑰未授權，請確認後端 GEMINI_API_KEY。';
  }

  if (isProviderTimeoutFailure(failureInfo)) {
    return 'Gemini 回應逾時，請稍後重試。';
  }

  if (code === 'forbidden' || status === 403) {
    return 'Gemini API 權限不足或專案未啟用此模型。';
  }

  if (code === 'bad_request' || status === 400) {
    return `Gemini 拒絕此翻譯請求（${providerDiagnosticText(failureInfo)}），請確認模型與翻譯內容格式。`;
  }

  if (code === 'rate_limited' || status === 429) {
    return 'Gemini 暫時限制此請求，可能是短時間速率、Token、模型容量或滾動用量限制；不一定代表每日用量已達上限，請稍後重試。';
  }

  if (code === 'server_error' || (status >= 500 && status <= 599)) {
    return 'Gemini 服務暫時失敗，請稍後重試。';
  }

  if (typeof failureInfo?.message === 'string' && failureInfo.message.trim()) {
    return failureInfo.message.trim();
  }

  const reason = typeof failureInfo?.reason === 'string' && failureInfo.reason.trim() ? failureInfo.reason.trim() : '';
  if (reason === 'provider_execution_failed' || failureInfo?.category === 'provider') {
    return 'Gemini 翻譯提供者執行失敗，請稍後重試。';
  }
  if (reason) {
    return `翻譯失敗（${reason}），請稍後重試。`;
  }

  return '翻譯提供者執行失敗，請稍後重試。';
}

function providerDiagnosticText(failureInfo = {}) {
  const status = Number.isInteger(failureInfo.status) ? `HTTP ${failureInfo.status}` : '';
  const code = failureInfo.providerCode ?? failureInfo.providerStatus ?? failureInfo.code;
  const message = typeof failureInfo.providerMessage === 'string' && failureInfo.providerMessage.trim()
    ? failureInfo.providerMessage.trim()
    : '';
  const model = typeof failureInfo.model === 'string' && failureInfo.model.trim() ? `model=${failureInfo.model.trim()}` : '';
  return [status, code ? `code=${code}` : '', message, model].filter(Boolean).join('；') || 'provider error';
}

function isProviderTimeoutFailure(failureInfo = {}) {
  const code = typeof failureInfo?.code === 'string' ? failureInfo.code : '';
  const status = Number.isInteger(failureInfo?.status) ? failureInfo.status : null;
  return code === 'provider_timeout' || status === 504;
}

function timestampMs(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return NaN;
  }

  return new Date(value).getTime();
}

function translationOutputTitle(output) {
  const languageLabel = targetLanguageLabelFor(output.targetLanguageCode) || output.targetLanguageCode || '未知語言';
  return `${languageLabel}重新翻譯`;
}

function glossaryReplacementLabel(entry = {}) {
  const replacements = Object.entries(entry.translations || {})
    .map(([, text]) => `${entry.source} → ${text}`);
  return replacements.join('、') || entry.source || '未命名字典詞條';
}

function glossaryOperationErrorMessage(error, fallback) {
  const details = [];
  if (Number.isInteger(error?.status)) details.push(`HTTP ${error.status}`);
  if (typeof error?.code === 'string' && error.code.trim()) details.push(`錯誤代碼：${error.code}`);
  return details.length > 0 ? `${fallback}（${details.join('，')}）` : fallback;
}

function mergeGlossaryEntry(entries = [], entry) {
  if (!entry?.id) return entries;
  const withoutEntry = entries.filter((item) => item.id !== entry.id);
  return [entry, ...withoutEntry];
}

function glossaryLanguagesLabel(translations = {}) {
  const label = Object.entries(translations)
    .map(([languageCode]) => targetLanguageLabelFor(languageCode) || languageCode)
    .join('、');
  return label ? `目標語言：${label}` : '目標語言：未設定';
}

function glossaryTranslationLabel(translations = {}) {
  const values = Object.entries(translations)
    .map(([languageCode, text]) => `${targetLanguageLabelFor(languageCode) || languageCode}：${text}`)
    .join('、');
  return values || '尚未設定翻譯';
}

function hasReplacementAliases(replacementAliases = {}) {
  return Object.values(replacementAliases)
    .some((aliases) => Array.isArray(aliases) && aliases.length > 0);
}

function liveGlossaryEntriesForTarget(entries = [], targetLanguageCode) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .filter((entry) => entry?.enabled !== false)
    .filter((entry) => entry?.scope === 'live' || entry?.scope === 'both')
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      target: entry.translations?.[targetLanguageCode],
      replacementAliases: Array.isArray(entry.replacementAliases?.[targetLanguageCode])
        ? entry.replacementAliases[targetLanguageCode]
        : []
    }))
    .filter((entry) => (
      typeof entry.source === 'string' &&
      entry.source.length > 0 &&
      typeof entry.target === 'string' &&
      entry.target.length > 0
    ));
}

function glossaryScopeLabel(scope) {
  const labels = {
    live: '套用範圍：即時字幕',
    history: '套用範圍：歷史重新翻譯',
    both: '套用範圍：兩者'
  };

  return labels[scope] || labels.history;
}

function transcriptSummaryLabel(summary = {}) {
  const sourceFinalCount = summary.sourceFinalCount || 0;
  const translationFinalCount = summary.translationFinalCount || 0;

  if (!summary.hasTranscript && sourceFinalCount === 0 && translationFinalCount === 0) {
    return '沒有逐字稿';
  }

  return `原文完成：${sourceFinalCount} · 翻譯完成：${translationFinalCount}`;
}

function shouldShowFailureReason(record) {
  return (record.status === 'failed' || record.status === 'expired') && record.failureReason;
}

function finalTranscriptItemsForStream(items = [], stream) {
  return items
    .filter((item) => item.stream === stream && item.status === 'final')
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

function sessionRecordForDetailDTO(detail, historyRecord) {
  const session = detail?.session || {};
  const selectedTranslationOutput = detail?.selectedTranslationOutput || {};

  return {
    ...session,
    targetLanguageCode: historyRecord?.targetLanguageCode || selectedTranslationOutput.targetLanguageCode || null,
    targetLanguageLabel: historyRecord?.targetLanguageLabel || selectedTranslationOutput.targetLanguageLabel || null,
    recordKind: historyRecord?.recordKind || session.recordKind || 'session',
    retranslatedFrom: historyRecord?.retranslatedFrom || session.retranslatedFrom || null
  };
}

function exportDetailForSessionDetailDTO(detail, historyRecord) {
  return {
    sessionRecord: sessionRecordForDetailDTO(detail, historyRecord),
    cues: Array.isArray(detail?.cues) ? detail.cues : [],
    transcriptItems: [
      ...(detail?.sourceTranscript?.items || []),
      ...translationExportItemsForDetail(detail)
    ]
  };
}

function translationExportItemsForDetail(detail) {
  const selectedItems = detail?.selectedTranslationOutput?.items || [];
  if (selectedItems.length > 0) {
    return selectedItems;
  }

  const article = detail?.readingContent?.translationArticle;
  if (!article || article.status !== 'available' || typeof article.text !== 'string' || article.text.trim().length === 0) {
    return [];
  }

  return [{
    id: `${detail?.selectedTranslationOutput?.id || 'formal-output'}:article`,
    stream: 'translation',
    status: 'final',
    text: article.text,
    sequence: Number.MAX_SAFE_INTEGER,
    startedAt: detail?.session?.startedAt ?? null,
    finalizedAt: article.completedAt ?? detail?.session?.endedAt ?? null
  }];
}

function savedSessionExportUnavailableReason(detail, options) {
  if ((options.format === 'srt' || options.format === 'vtt') && options.stream === 'both') {
    return 'SRT 與 VTT 一次只能匯出一個內容。';
  }

  if (!canExportSavedSession(detail, options)) {
    return '所選選項無法匯出已儲存的逐字稿。';
  }

  return '';
}

function meetingReadingContent(detail) {
  const source = detail?.readingContent?.sourceTranscript;
  const translation = detail?.readingContent?.translationArticle;

  return {
    sourceTranscript: source
      ? toTraditionalChineseSourceContent({
          ...source,
          createdAt: source.createdAt ?? detail?.meeting?.startedAt ?? null,
          finalizedAt: source.finalizedAt ?? detail?.meeting?.endedAt ?? null,
          emptyReason: source.emptyReason || (source.status === 'empty' ? 'no_content' : null)
        })
      : {
          kind: 'sourceTranscript',
          status: 'empty',
          text: '',
          paragraphs: [],
          emptyReason: 'no_content',
          createdAt: detail?.meeting?.startedAt ?? null,
          finalizedAt: detail?.meeting?.endedAt ?? null
        },
    translationArticle: translation
      ? {
          ...translation,
          createdAt: translation.createdAt ?? detail?.meeting?.startedAt ?? null,
          completedAt: translation.completedAt ?? detail?.meeting?.endedAt ?? null,
          emptyReason: translation.emptyReason || (translation.status === 'empty' ? 'no_content' : null)
        }
      : {
          kind: 'translationArticle',
          status: 'empty',
          text: '',
          paragraphs: [],
          emptyReason: 'no_content',
          targetLanguageCode: null,
          targetLanguageLabel: null,
          createdAt: detail?.meeting?.startedAt ?? null,
          completedAt: detail?.meeting?.endedAt ?? null
        }
  };
}

function meetingExportUnavailableReason({ canExport, format, stream }) {
  if ((format === 'srt' || format === 'vtt') && stream === 'both') {
    return 'SRT 與 VTT 一次只能匯出一個內容。';
  }

  if (!canExport) {
    return '所選選項無法匯出整場會議逐字稿。';
  }

  return '';
}

function buildMeetingTranscriptFileName(meeting = {}, options = {}) {
  const format = String(options.format || 'txt').replace(/[^a-zA-Z0-9]+/g, '') || 'txt';
  const stream = String(options.stream || 'translation').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'translation';
  const startedAt = meeting.startedAt ? new Date(meeting.startedAt) : new Date();
  const stamp = Number.isNaN(startedAt.getTime())
    ? new Date().toISOString()
    : startedAt.toISOString();
  const safeStamp = stamp.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const safeMeetingId = String(meeting.id || 'meeting').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return `live-translate-meeting-${safeMeetingId}-${safeStamp}-${stream}.${format}`;
}

function meetingTitle(record = {}) {
  return record.name || `長會議 · ${formatRecordTime(record.startedAt)}`;
}

function meetingStatusLabel(status) {
  const labels = {
    created: '已建立',
    active: '進行中',
    completed: '已完成',
    interrupted: '已中斷',
    failed: '失敗'
  };

  return labels[status] || status || '未知狀態';
}

function meetingSegmentStatusLabel(status) {
  return meetingStatusLabel(status);
}

function meetingSegmentSummaryLabel(summary = {}) {
  const total = summary.totalSegments || 0;
  const counts = summary.countsByStatus || {};
  const parts = [
    counts.completed ? `完成 ${counts.completed}` : '',
    counts.active ? `進行中 ${counts.active}` : '',
    counts.interrupted ? `中斷 ${counts.interrupted}` : '',
    counts.failed ? `失敗 ${counts.failed}` : ''
  ].filter(Boolean);

  return parts.length > 0 ? `${total} 段（${parts.join('、')}）` : `${total} 段`;
}

function meetingExceptionSummaryLabel(summary = {}) {
  const counts = summary.countsByStatus || {};
  const interrupted = counts.interrupted || 0;
  const failed = counts.failed || 0;

  if (interrupted === 0 && failed === 0) {
    return '無';
  }

  return [`中斷 ${interrupted}`, `失敗 ${failed}`].join(' · ');
}

function formatRecordTime(value) {
  if (!value) {
    return '無資料';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('zh-Hant');
}

function formatMeetingListTime(value) {
  if (!value) return '無資料';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(/\s+/g, ' ');
}

function meetingLanguageLabel(meeting = {}) {
  const source = targetLanguageLabelFor(meeting.sourceLanguageCode) || meeting.sourceLanguageCode || '未設定';
  const target = targetLanguageLabelFor(meeting.targetLanguageCode) || meeting.targetLanguageCode || '未設定';
  return `${source} → ${target}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return '無資料';
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds} 秒`;
  }

  return `${minutes} 分 ${seconds} 秒`;
}

function meetingRecordSortTime(record) {
  const startedAt = new Date(record.startedAt).getTime();

  if (Number.isFinite(startedAt)) {
    return startedAt;
  }

  const endedAt = new Date(record.endedAt).getTime();

  return Number.isFinite(endedAt) ? endedAt : 0;
}

function statusLabel(status, override = '') {
  if (override) {
    return override;
  }

  const labels = {
    idle: '準備就緒',
    'requesting-permission': '正在請求麥克風權限',
    connecting: '正在連線',
    listening: '聆聽中',
    reconnecting: '正在重新連線',
    'switching-segment': '切換下一段中',
    paused: '已暫停',
    stopped: '已停止',
    expired: '工作階段已過期',
    error: '需要處理'
  };

  return labels[status] || status;
}

function recordingStatusLabel(status) {
  const labels = {
    idle: '尚無可下載的原始語音。',
    skipped: '未錄製講者原音。',
    recording: '正在保留本機麥克風輸入。',
    paused: '錄音已暫停，已保留目前片段。',
    finalizing: '正在完成錄音檔。',
    ready: '原始語音已可下載。',
    saved: '音檔已保存，請到翻譯紀錄下載。',
    error: '原始語音錄音無法使用。'
  };

  return labels[status] || labels.idle;
}

function translatedAudioStatusLabel(status) {
  const labels = {
    idle: '尚無可下載的翻譯語音。',
    recording: '正在保留即時字幕輸出。',
    ready: '翻譯語音已可下載。',
    saved: '音檔已保存，請到翻譯紀錄下載。',
    error: '翻譯語音音檔無法使用。'
  };

  return labels[status] || labels.idle;
}

function composeCheckpointStatusMessage({
  meetingCheckpointStatus,
  shouldRecordInputAudio,
  recordingState,
  translatedAudioState
}) {
  const messages = [meetingCheckpointStatusLabel(meetingCheckpointStatus)];
  const inputAudioIsActive = shouldRecordInputAudio && ['recording', 'paused', 'finalizing', 'ready', 'saved', 'error'].includes(recordingState?.status);
  const translationAudioIsActive = ['recording', 'ready', 'saved', 'error'].includes(translatedAudioState?.status);

  if (inputAudioIsActive) {
    messages.push(`原始語音：${recordingStatusLabel(recordingState.status)}`);
    if (recordingState.errorMessage) messages.push(`原始語音錯誤：${recordingState.errorMessage}`);
  }

  if (translationAudioIsActive) {
    messages.push(`翻譯語音：${translatedAudioStatusLabel(translatedAudioState.status)}`);
    if (translatedAudioState.errorMessage) messages.push(`翻譯語音錯誤：${translatedAudioState.errorMessage}`);
  }

  return messages;
}

function hasAudioStatusError({ shouldRecordInputAudio, recordingState, translatedAudioState }) {
  return (shouldRecordInputAudio && recordingState?.status === 'error') || translatedAudioState?.status === 'error';
}

function createAudioUploadSegmentState() {
  return {
    input: { nextIndex: 0, lastFlushedAt: Date.now(), inFlight: false, currentPromise: null },
    translation: { nextIndex: 0, lastFlushedAt: Date.now(), inFlight: false, currentPromise: null }
  };
}

function meetingCheckpointStatusLabel(status) {
  const labels = {
    idle: '會議模式：尚未啟用',
    ready: '會議模式：準備中',
    syncing: '會議模式：保存中',
    synced: '會議模式：已保存',
    switching: '會議模式：切換段落中',
    switched: '會議模式：下一段已開始',
    error: '會議模式：保存失敗，等待重試'
  };

  return labels[status] || labels.idle;
}

function targetLanguageLabelFor(code) {
  return SUPPORTED_LANGUAGES.find((language) => language.code === code)?.label || null;
}

function classifyFailureSignal(failure) {
  const rawClassification = classifyConnectionFailure({
    error: failure.rawError,
    rawError: failure.rawError,
    rawEvent: failure.rawEvent,
    code: failure.rawError?.code || failure.rawEvent?.code,
    status: failure.rawError?.status || failure.rawEvent?.status,
    context: failure.source
  });

  if (rawClassification.reason !== 'unknown_error') {
    return rawClassification;
  }

  return classifyConnectionFailure({
    reason: failure.reasonHint,
    error: failure.rawError,
    rawError: failure.rawError,
    rawEvent: failure.rawEvent,
    context: failure.source
  });
}

function contentTypeForFormat(format) {
  const types = {
    txt: 'text/plain;charset=utf-8',
    srt: 'application/x-subrip;charset=utf-8',
    vtt: 'text/vtt;charset=utf-8'
  };

  return types[format] || 'text/plain;charset=utf-8';
}

function downloadTextFile(content, fileName, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
