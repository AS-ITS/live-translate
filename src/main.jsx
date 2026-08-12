import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { BookOpen, Copy, Download, Mic, MicOff, Pause, Play, Radio, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from './lib/languages.js';
import { classifyConnectionFailure } from './lib/connectionFailures.js';
import { failureUiStateForClassification } from './lib/failureUiState.js';
import { audioInputDevices } from './lib/mediaDevices.js';
import { createReconnectController } from './lib/reconnectController.js';
import { createMemorySessionRepository } from './lib/sessionRepository.js';
import { createSessionReadApiClient } from './lib/sessionReadApiClient.js';
import { createSessionControlLease } from './lib/sessionControlLease.js';
import { createSessionShareApiClient } from './lib/sessionShareApiClient.js';
import { createMeetingReadApiClient } from './lib/meetingReadApiClient.js';
import { createSessionSnapshotApiClient } from './lib/sessionSnapshotApiClient.js';
import { createSessionCommandApiClient } from './lib/sessionCommandApiClient.js';
import { createSessionSnapshotSyncCoordinator } from './lib/sessionSnapshotSyncCoordinator.js';
import { createMeetingCheckpointApiClient } from './lib/meetingCheckpointApiClient.js';
import {
  checkpointChunksForTranscriptItems,
  createMeetingCheckpointSyncCoordinator
} from './lib/meetingCheckpointSyncCoordinator.js';
import { createSegmentSwitchOrchestrator } from './lib/segmentSwitchOrchestrator.js';
import { createTranslationCommandApiClient } from './lib/translationCommandApiClient.js';
import { createSessionRetranslationApiClient } from './lib/sessionRetranslationApiClient.js';
import { createGlossaryApiClient } from './lib/glossaryApiClient.js';
import { createMeetingManagementApiClient } from './lib/meetingManagementApiClient.js';
import { createDeadLetterQueueApiClient } from './lib/deadLetterQueueApiClient.js';
import { authenticatedFetch } from './lib/accessToken.js';
import { applyGlossaryReplacements } from './lib/glossaryReplacement.js';
import { missingNumericIntegrity } from './lib/numericIntegrity.js';
import { createTranslationCommandLifecycle } from './lib/translationCommandLifecycle.js';
import { formatTranslationCommandPersistenceError } from './lib/translationCommandError.js';
import { createTranscriptPolishingLifecycle } from './lib/transcriptPolishingLifecycle.js';
import { createTranscriptPolishingCoordinator, mergePolishedItemsFromOutputs } from './lib/transcriptPolishing.js';
import {
  compactTranslationHistoryForDetail,
  mergeRetranslationHistoryIntoDetail,
  removeRetranslationOutputFromDetail,
  retryLineagesForExecutions
} from './lib/sessionTranslationHistory.js';
import { createExportApplicationService } from './application/exportApplicationService.js';
import {
  appendNewFinalTranscriptItems,
  buildFinalizePatch,
  buildSessionRecordInput,
  createActiveSessionRecord,
  finalizeActiveSessionRecord
} from './lib/sessionRecordLifecycle.js';
import {
  buildSavedSessionFileName,
  canExportSavedSession
} from './lib/sessionRecordExport.js';
import { buildTranscriptFileName, canExportTranscript } from './lib/transcriptExport.js';
import {
  canExportCues,
  wrapSubtitleText
} from './lib/subtitleCueExport.js';
import { toTraditionalChineseSourceContent, toTraditionalChineseText } from './lib/chineseText.js';
import {
  applyTranscriptEvent,
  buildTranscriptArticleParagraphs,
  createTranscriptState,
  describeTranscriptSegmentDecision,
  formatTranscriptArticleText,
  finalizePendingTranscriptItems,
  resetTranscriptState,
  transcriptItemsForStream
} from './lib/transcript.js';
import { HISTORY_REFRESH_MS, selectedOutputFor } from './lib/sessionHistoryState.js';
import { subscribeToExecutionEvents } from './lib/executionEventsWebSocket.js';
import { hasPendingRetranslationItems, retranslationProgressFor } from './lib/retranslationProgress.js';
import { createMicrophoneRecordingController } from './lib/microphoneRecording.js';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  finalizePendingSubtitleCue,
  resetSubtitleCueState,
  resolveIdleSubtitleCue,
  markNumericCorrectionRequested,
  DEFAULT_TURN_COMPLETE_DEBOUNCE_MS
} from './lib/subtitleCues.js';
import {
  cueListForDisplay,
  sourceTextForCopy,
  translationTextForCopy
} from './lib/cueUi.js';
import {
  INPUT_SAMPLE_RATE,
  buildInputAudioFileName,
  buildTranslatedAudioFileName,
  pcm16ChunksToWavBlob
} from './lib/audio.js';
import './styles.css';
import QRCode from 'qrcode';

ModuleRegistry.registerModules([AllCommunityModule]);

const DATA_GRID_LOCALE_TEXT = {
  page: '頁',
  more: '更多',
  to: '至',
  of: '共',
  nextPage: '下一頁',
  lastPage: '最後一頁',
  firstPage: '第一頁',
  previousPage: '上一頁',
  pageSizeSelectorLabel: '每頁顯示：',
  noRowsToShow: '尚無資料。',
  noMatches: '找不到符合條件的資料。'
};

const DATA_GRID_THEME = themeQuartz.withParams({
  borderColor: '#d8dee6',
  headerBackgroundColor: '#f3f6f9',
  headerFontSize: 15,
  headerFontWeight: 700,
  rowBorder: { color: '#e4e8ed' },
  rowHoverColor: '#f8fafc',
  fontSize: 15,
  rowHeight: 64,
  headerHeight: 56,
  paginationPanelHeight: 56
});

const DATA_GRID_DEFAULT_COL_DEF = {
  sortable: true,
  resizable: false,
  wrapText: true,
  autoHeight: true,
  suppressHeaderMenuButton: true
};

function dataGridProps(className) {
  return {
    className: `data-grid ${className}`,
    theme: DATA_GRID_THEME,
    defaultColDef: DATA_GRID_DEFAULT_COL_DEF,
    pagination: true,
    paginationPageSize: 12,
    paginationPageSizeSelector: [12, 24, 48],
    localeText: DATA_GRID_LOCALE_TEXT,
    domLayout: 'autoHeight',
    animateRows: false,
    suppressCellFocus: false
  };
}

const RECONNECT_FAILED_MESSAGE = '無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時翻譯多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);
const FEATURE_PAGES = new Set(['live', 'history', 'meetings', 'meeting', 'retranslate', 'glossary', 'watch', 'record', 'dead-letter-queue']);
const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const PENDING_TRANSCRIPT_IDLE_FINALIZE_MS = 3000;
const LIVE_CUE_IDLE_FINALIZE_MS = DEFAULT_TURN_COMPLETE_DEBOUNCE_MS;
const SESSION_SNAPSHOT_SYNC_DELAY_MS = 1000;
const SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE = 20;
const AUDIO_SEGMENT_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const AUDIO_UPLOAD_RETRY_DELAY_MS = 5000;
const AUDIO_UPLOAD_RETRY_MAX_DELAY_MS = 60000;
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const TRANSCRIPT_POLISHING_ENABLED = import.meta.env?.VITE_TRANSCRIPT_POLISHING_ENABLED !== 'false';
const TRANSCRIPT_POLISHING_INTERVAL_MS = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_INTERVAL_MS || '30000', 10);
const TRANSCRIPT_POLISHING_MIN_CHARS = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MIN_CHARS || '200', 10);
const TRANSCRIPT_POLISHING_MAX_RPM = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MAX_RPM || '15', 10);
const SEGMENT_SWITCH_INTERVAL_MS = 10 * 60 * 1000;
const ARCHIVED_TRANSCRIPT_SEGMENT_CACHE_LIMIT = 3;
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

function pageFromLocation() {
  return pageInfoFromLocation().page;
}

function pageInfoFromLocation() {
  const rawHash = window.location.hash.replace('#', '');
  const [pageName, queryString = ''] = rawHash.split('?');
  const page = FEATURE_PAGES.has(pageName) ? pageName : 'live';
  const params = new URLSearchParams(queryString);
  return {
    page,
    sessionId: params.get('sessionId') || '',
    meetingId: params.get('meetingId') || '',
    shareToken: params.get('token') || '',
    shareCode: params.get('code') || ''
  };
}

function App() {
  const [page, setPage] = useState(pageFromLocation);
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
  const [exportFormat, setExportFormat] = useState('txt');
  const [exportStream, setExportStream] = useState('translation');
  const [inputDevices, setInputDevices] = useState([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState('');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [error, setError] = useState('');
  const [historyRecords, setHistoryRecords] = useState([]);
  const [historyLoadError, setHistoryLoadError] = useState('');
  const [deadLetterQueue, setDeadLetterQueue] = useState({ items: [], size: 0 });
  const [deadLetterQueueLoadError, setDeadLetterQueueLoadError] = useState(null);
  const [isLoadingDeadLetterQueue, setIsLoadingDeadLetterQueue] = useState(false);
  const [replayingDeadLetterExecutionId, setReplayingDeadLetterExecutionId] = useState('');
  const [deadLetterQueueNotice, setDeadLetterQueueNotice] = useState('');
  const [meetingLoadError, setMeetingLoadError] = useState('');
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMeetings, setIsLoadingMeetings] = useState(false);
  const [selectedHistoryRecordId, setSelectedHistoryRecordId] = useState(null);
  const [selectedHistoryDetail, setSelectedHistoryDetail] = useState(null);
  const [historyDetailError, setHistoryDetailError] = useState('');
  const [retryingHistoryExecutionId, setRetryingHistoryExecutionId] = useState('');
  const [meetingRecords, setMeetingRecords] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [selectedMeetingDetail, setSelectedMeetingDetail] = useState(null);
  const [meetingDetailError, setMeetingDetailError] = useState('');
  const [retranslationSessionId, setRetranslationSessionId] = useState(() => pageInfoFromLocation().sessionId);
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [selectedMeetingGlossaryIds, setSelectedMeetingGlossaryIds] = useState([]);
  const [isLiveGlossaryDrawerOpen, setIsLiveGlossaryDrawerOpen] = useState(false);
  const [isLiveExportDrawerOpen, setIsLiveExportDrawerOpen] = useState(false);
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
  const meetingCheckpointSyncCoordinatorRef = useRef(null);
  const segmentSwitchOrchestratorRef = useRef(null);
  const activeMeetingCheckpointRef = useRef(null);
  const runtimeMeetingIdsRef = useRef(new Set());
  const liveSessionIdSequenceRef = useRef(0);
  const segmentSwitchCancelledRef = useRef(false);
  const sessionReadApiClientRef = useRef(createSessionReadApiClient());
  const sessionShareApiClientRef = useRef(createSessionShareApiClient());
  const translationCommandApiClientRef = useRef(createTranslationCommandApiClient());
  const deadLetterQueueApiClientRef = useRef(createDeadLetterQueueApiClient());
  const meetingReadApiClientRef = useRef(createMeetingReadApiClient());
  const sessionDetailCacheRef = useRef(new Map());
  const meetingDetailCacheRef = useRef(new Map());
  const translationCommandLifecycleRef = useRef(null);
  const transcriptPolishingLifecycleRef = useRef(null);
  const transcriptPolishingCoordinatorRef = useRef(null);
  const activeSessionRecordIdRef = useRef(null);
  const sessionControlLeaseRef = useRef(null);
  const polishingSessionIdRef = useRef(null);
  const suppressReconnectErrorRef = useRef(false);
  const detailRequestIdRef = useRef(0);
  const selectedHistoryRecordIdRef = useRef(null);
  const meetingDetailRequestIdRef = useRef(0);
  const selectedMeetingIdRef = useRef(null);
  const meetingResumeDraftRequestIdRef = useRef(0);
  const liveCueUpdatesAllowedRef = useRef(false);
  const liveCueIdleTimersRef = useRef(new Map());

  const routeSessionId = pageInfoFromLocation().sessionId;
  const routeMeetingId = pageInfoFromLocation().meetingId;
  const isViewingReadOnlySession = page === 'live' && Boolean(routeSessionId) && routeSessionId !== activeSessionRecordIdRef.current;
  const isReadOnlyControlView = page === 'live' && !resumeDraft && !routeMeetingId && (isViewingReadOnlySession || Boolean(activeSessionRecordIdRef.current && !hasSessionControl));

  const isActive =
    status === 'requesting-permission' ||
    status === 'connecting' ||
    status === 'listening' ||
    status === 'reconnecting' ||
    status === 'switching-segment';
  const controlsLocked = isActive || status === 'paused' || Boolean(controlLeaseSnapshot && !hasSessionControl);

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
      const next = pageInfoFromLocation();
      setPage(next.page);
      if (next.page === 'retranslate') {
        setRetranslationSessionId(next.sessionId);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (page === 'history' || page === 'retranslate') {
      void refreshHistoryRecords();
    }
  }, [page]);

  useEffect(() => {
    if (page === 'history' || page === 'meetings') {
      void refreshMeetingRecords();
    }
  }, [page]);

  useEffect(() => {
    if (page === 'dead-letter-queue') void refreshDeadLetterQueue();
  }, [page]);

  useEffect(() => {
    if (page !== 'live') return undefined;
    let cancelled = false;
    void createGlossaryApiClient().listEntries()
      .then((entries) => {
        if (!cancelled) setGlossaryEntries(entries);
      })
      .catch(() => {
        // The drawer reports glossary loading failures when the user opens it.
      });
    return () => { cancelled = true; };
  }, [page]);

  useEffect(() => {
    if (!isLiveGlossaryDrawerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsLiveGlossaryDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLiveGlossaryDrawerOpen]);

  useEffect(() => {
    if (!(activeSessionRecordIdRef.current || polishingSessionIdRef.current) || status === 'idle') return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const sessionId = activeSessionRecordIdRef.current || polishingSessionIdRef.current;
        const detail = await getSessionDetailWithTranslationHistory(sessionId);
        const outputs = completedPolishingOutputs(detail);
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
          const polishedItems = mergePolishedItemsFromOutputs(outputs);
          applyPolishedOutput({
            ...output,
            polishedItems,
            translatedText: polishedItems.map((item) => item.polishedText).join('\n')
          });
          setPolishingState({ status: 'completed', text: output.translatedText || '', version: output.version ?? null, updatedAt: output.completedAt || output.createdAt || null, error: '', executionId: output.executionId || null });
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

  useEffect(() => {
    const { page: currentPage, meetingId } = pageInfoFromLocation();
    if (currentPage !== 'live' || !meetingId || status !== 'idle') {
      return;
    }

    void meetingReadApiClientRef.current.getMeetingDetail(meetingId)
      .then((detail) => {
        const meeting = detail?.meeting;
        if (!meeting) return;
        const nextTargetLanguageCode = meeting.targetLanguageCode || 'en';
        setSessionName(meeting.name || '');
        setSourceLanguageCode(meeting.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE);
        setTargetLanguageCode(nextTargetLanguageCode);
        setSelectedMeetingGlossaryIds((current) => {
          if (current.length > 0) return current;
          return glossaryEntries.filter((entry) => (meeting.glossaryEntries || []).some((item) => item.source === entry.source && entry.translations?.[nextTargetLanguageCode] === item.target)).map((entry) => entry.id);
        });
      })
      .catch(() => {})
      .finally(() => loadMeetingResumeDraft(meetingId));
  }, [page, status]);

  useEffect(() => () => {
    invalidateLiveSessionCallbacks();
    reconnectControllerRef.current?.cancel();
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);
    sessionRef.current = null;
    reconnectSessionRef.current = null;
    sessionSnapshotSyncCoordinatorRef.current?.cancel();
    meetingCheckpointSyncCoordinatorRef.current?.cancel();
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

  useEffect(() => schedulePendingTranscriptIdleFinalize('source', transcript.source.currentPartial), [
    transcript.source.currentPartial?.id,
    transcript.source.currentPartial?.text
  ]);

  useEffect(() => schedulePendingTranscriptIdleFinalize('translation', transcript.translation.currentPartial), [
    transcript.translation.currentPartial?.id,
    transcript.translation.currentPartial?.text
  ]);

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
        if (result.state !== subtitleCueStateRef.current) {
          const previous = subtitleCueStateRef.current;
          subtitleCueStateRef.current = result.state;
          setSubtitleCueState(result.state);
          enqueueCuePersistence(previous, result.state);
        }
        if (result.action === 'needs-retranslation') {
          sessionRef.current?.retranslateSourceText(result.cue?.sourceText, result.cue?.cueId);
        }
        requestNumericCorrection(result.state);
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
    invalidateLiveSessionCallbacks();
    meetingResumeDraftRequestIdRef.current += 1;
    reconnectController().reset();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = true;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    let session;
    let record = null;

    try {
      await recordingController().cleanup({ discard: true });
      resetInputAudioDownload();
      resetTranslatedAudioDownload();
      pendingMicrophoneStreamRef.current = null;
      const liveSessionId = generateLiveSessionId();
      const routeMeetingId = pageInfoFromLocation().meetingId;
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
          glossaryEntries: selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode)
        });
      }
      record = await createCurrentSessionRecord(meetingCheckpoint);
      if (!sessionControlLeaseRef.current?.tryAcquire(record.id)) {
        throw new Error('目前已有工作階段由其他頁籤控制。');
      }
      setHasSessionControl(true);
      session = await createSession({ preserveTranscript: false, liveSessionId });
      sessionRef.current = session;

      await session.start();
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
      applyStartFailure(nextError, '無法開始即時翻譯。');
    }
  }

  async function pauseSession() {
    invalidateLiveSessionCallbacks();
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    const reconnectingSession = reconnectSessionRef.current;
    reconnectSessionRef.current = null;
    await pauseRawAudioRecording();
    await reconnectingSession?.stop().catch(() => {});
    await sessionRef.current?.stop();
    sessionRef.current = null;
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
    reconnectController().reset();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = true;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    setError('');
    pendingMicrophoneStreamRef.current = null;

    let session;
    try {
      session = await createSession({ preserveTranscript: true, liveSessionId: generateLiveSessionId() });
      sessionRef.current = session;
      await session.start();
      activateLiveSessionCallbacks(session.callbackGeneration);
      await resumeRawAudioRecording();
      await updateCurrentSessionStatus('active', { lastLifecycleState: 'listening' });
      setStatus('listening');
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
      sessionRef.current = null;
      applyStartFailure(nextError, '無法繼續即時翻譯。');
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

    setStatusLabelOverride('');
    setError(message);
    setStatus('error');
  }

  async function endCurrentSession() {
    invalidateLiveSessionCallbacks();
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
    cancelLiveCueIdleTimers();
    setStatusLabelOverride('');
    const reconnectingSession = reconnectSessionRef.current;
    reconnectSessionRef.current = null;
    const inputAudioState = await finalizeRawAudioRecording();
    await reconnectingSession?.stop().catch(() => {});
    await sessionRef.current?.stop().catch(() => {});
    sessionRef.current = null;
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
  }

  async function createSession({ preserveTranscript, liveSessionId = generateLiveSessionId() }) {
    if (!preserveTranscript) {
      setError('');
      setDeviceMessage('');
      const sessionStartedAt = Date.now();
      setTranscriptTimeOrigin(sessionStartedAt);
      transcriptTimeOriginRef.current = sessionStartedAt;
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

    const { LiveTranslateSession } = await import('./lib/liveSession.js');
    const callbackGeneration = {
      generation: liveSessionCallbackGenerationRef.current.generation + 1,
      active: false
    };
    liveSessionCallbackGenerationRef.current = callbackGeneration;

    const session = new LiveTranslateSession({
      liveSessionId,
      sessionId: activeSessionRecordIdRef.current,
      meetingId: activeMeetingCheckpointRef.current?.meetingId || null,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || liveSessionId,
      sessionClock: () => sessionTimeForSubtitleCues(),
      targetLanguageCode,
      sourceLanguageCode,
      echoTargetLanguage,
      liveGlossaryEntries: liveGlossaryEntriesForTarget(
        selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode),
        targetLanguageCode
      ),
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
      },
      onInputAudioChunk: (chunk) => {
        if (isCurrentLiveSessionCallback(callbackGeneration)) handleInputAudioChunk(chunk);
      },
      onInputTranscript: (update) => {
        if (isCurrentLiveSessionCallback(callbackGeneration)) applyTranscriptUpdate({ ...update, eventId: update.eventId, stream: 'source' });
      },
      onOutputTranscript: (update) => {
        if (isCurrentLiveSessionCallback(callbackGeneration)) applyTranscriptUpdate({ ...update, eventId: update.eventId, stream: 'translation' });
      },
      onCueEvent: (event) => {
        if (!isCurrentLiveSessionCallback(callbackGeneration) || !liveCueUpdatesAllowedRef.current) return;
        const activeGlossaryEntries = sessionRef.current?.liveGlossaryEntries
          || liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode);
        const cueEvent = event?.stream === 'translation'
          ? { ...event, text: applyGlossaryReplacements(event.text, activeGlossaryEntries) }
          : event;
        applyLiveSubtitleCueEvent(cueEvent);
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
        finalizeCurrentSessionRecord({
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
        const failureUiState = failureUiStateForClassification(classification);

        if (!failureUiState.shouldReconnect) {
          suppressReconnectErrorRef.current = failureUiState.suppressSessionError;
          setError(failureUiState.message);
          setStatus(failureUiState.status);
          setStatusLabelOverride(failureUiState.statusLabel);
          finalizeCurrentSessionRecord({
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
              setError(reconnectErrorMessage(result));
              setStatus('error');
              finalizeCurrentSessionRecord({
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
    if (generationId !== reconnectController().currentGeneration()) {
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
    const session = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
    reconnectSessionRef.current = session;

    try {
      if (!meetingCheckpoint) {
        throw new Error('Missing active meeting checkpoint.');
      }

      await pauseRawAudioRecording();
      await finalizePendingTranscriptItemsForStop();
      flushSubtitleCues('reconnect');
      if (generationId !== reconnectController().currentGeneration()) {
        await session.stop().catch(() => {});
        return;
      }

      const flushed = await flushMeetingCheckpointSync();
      if (!flushed) {
        throw new Error('Unable to flush meeting checkpoint before reconnect.');
      }
      archiveActiveTranscriptSegment();

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

      if (generationId !== reconnectController().currentGeneration()) {
        await session.stop().catch(() => {});
        return;
      }

      await session.start();
      activateLiveSessionCallbacks(session.callbackGeneration);
      await resumeRawAudioRecording();
    } catch (nextError) {
      if (generationId !== reconnectController().currentGeneration()) {
        await session.stop().catch(() => {});
        return;
      }

      await session.stop().catch(() => {});
      reconnectSessionRef.current = null;
      sessionRef.current = null;
      setStatusLabelOverride('');
      setError(RECONNECT_FAILED_MESSAGE);
      setStatus('error');
      finalizeCurrentSessionRecord({
        status: 'failed',
        failureReason: classification.reason,
        failureCategory: classification.category
      });
      return;
    }

    if (generationId !== reconnectController().currentGeneration() || segmentSwitchCancelledRef.current) {
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
    invalidateLiveSessionCallbacks();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = true;
    setStatusLabelOverride('');
    setError('');
    setResumeDraft(null);
    resetTranslatedAudioDownload();

    let session;
    try {
      const nextLiveSessionId = generateLiveSessionId();
      setStatus('reconnecting');
      const recovery = await meetingCheckpointApiClientRef.current.recoverSegment({
        meetingId: draft.meetingId,
        segmentId: draft.segmentId,
        idempotencyKey: `recover:${draft.segmentId}:${nextLiveSessionId}`,
        checkpoint: {
          idempotencyKey: `checkpoint:${draft.segmentId}:resume:${nextLiveSessionId}`,
          durableChunks: [],
          pendingPartial: null
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
      activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
      meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
      await createCurrentSessionRecord(nextMeetingCheckpoint, draft.transcriptState, draft.sessionId);
      resetActiveTranscriptForNextSegment(draft.transcriptState.nextSequence);
      session = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
      sessionRef.current = session;
      await session.start();
      activateLiveSessionCallbacks(session.callbackGeneration);
      sessionRepositoryRef.current.updateSessionRecord(activeSessionRecordIdRef.current, {
        status: 'active',
        startedAt: Date.now(),
        lastLifecycleState: 'listening'
      });
      await flushSessionSnapshot(activeSessionRecordIdRef.current);
      setStatus('listening');
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
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
    if (!meetingCheckpoint || !previousSession || segmentSwitchCancelledRef.current) return;

    invalidateLiveSessionCallbacks();
    setError('');
    setStatusLabelOverride('切換下一段中');
    setStatus('switching-segment');

    await finalizePendingTranscriptItemsForStop();
    flushSubtitleCues('segment-rollover');
    if (segmentSwitchCancelledRef.current) return;

    const flushed = await flushMeetingCheckpointSync();
    if (!flushed) throw new Error('無法同步目前段落 checkpoint。');
    if (segmentSwitchCancelledRef.current) return;
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

    if (segmentSwitchCancelledRef.current) return;

    await pauseRawAudioRecording();
    await previousSession.stop().catch(() => {});
    flushSubtitleCues('segment-rollover');
    if (sessionRef.current === previousSession) {
      sessionRef.current = null;
    }

    const nextSession = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
    try {
      await nextSession.start();
      activateLiveSessionCallbacks(nextSession.callbackGeneration);
      await resumeRawAudioRecording();
    } catch (error) {
      await nextSession.stop().catch(() => {});
      throw error;
    }

    if (segmentSwitchCancelledRef.current) {
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
    console.error('Meeting segment switch failed.', error);
    setStatusLabelOverride('切換失敗');
    setError('長會議分段切換失敗。已保留目前逐字稿，請停止後重新開始。');
    setStatus('error');
    void finalizeCurrentSessionRecord({
      status: 'failed',
      failureReason: 'segment_switch_failed',
      failureCategory: 'provider'
    });
  }

  function generateLiveSessionId() {
    liveSessionIdSequenceRef.current += 1;
    return `live-session-${Date.now()}-${liveSessionIdSequenceRef.current}`;
  }

  async function createMeetingCheckpointForSession({ liveSessionId, glossaryEntries = [] } = {}) {
    try {
      setMeetingCheckpointStatus('syncing');
      const result = await meetingCheckpointApiClientRef.current.createMeeting({ liveSessionId, glossaryEntries });
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
      meetingGlossaryEntries: selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode),
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
        meetingId: meetingCheckpoint?.meetingId,
        segmentId: meetingCheckpoint?.segmentId || liveSessionId,
        meetingGlossaryEntries: selectedMeetingGlossaryEntries(glossaryEntries, selectedMeetingGlossaryIds, targetLanguageCode),
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

  function appendInitialTranscriptItems(sessionId, initialTranscript) {
    if (!sessionId || !initialTranscript) return [];
    return transcriptItemsForStream(initialTranscript, 'source')
      .concat(transcriptItemsForStream(initialTranscript, 'translation'))
      .filter((item) => item.status === 'final')
      .map((item) => sessionRepositoryRef.current.appendTranscriptItem(sessionId, item));
  }

  function applyTranscriptUpdate(update) {
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
    const current = subtitleCueStateRef.current;
    const next = applySubtitleCueEvent(current, event, {
      targetLanguageCode,
      sourceLanguageCode,
      sessionId: activeSessionRecordIdRef.current,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || null,
      sessionClock: () => sessionTimeForSubtitleCues()
    });
    if (next === current) return;
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
    scheduleTranscriptPolishing(next.finalCues);
    requestNumericCorrection(next);
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
    const current = subtitleCueStateRef.current;
    const next = finalizePendingSubtitleCue(current, {
      sessionTimeMs: sessionTimeForSubtitleCues(),
      reason
    });
    if (next === current) return;
    subtitleCueStateRef.current = next;
    setSubtitleCueState(next);
    enqueueCuePersistence(current, next);
    scheduleTranscriptPolishing(next.finalCues, { force: true });
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
      transcriptPolishingCoordinatorRef.current = createTranscriptPolishingCoordinator({
        intervalMs: Number.isInteger(TRANSCRIPT_POLISHING_INTERVAL_MS) && TRANSCRIPT_POLISHING_INTERVAL_MS > 0 ? TRANSCRIPT_POLISHING_INTERVAL_MS : 30000,
        minChars: Number.isInteger(TRANSCRIPT_POLISHING_MIN_CHARS) && TRANSCRIPT_POLISHING_MIN_CHARS > 0 ? TRANSCRIPT_POLISHING_MIN_CHARS : 200,
        maxRequestsPerMinute: Number.isInteger(TRANSCRIPT_POLISHING_MAX_RPM) && TRANSCRIPT_POLISHING_MAX_RPM > 0 ? TRANSCRIPT_POLISHING_MAX_RPM : 15,
        submit: (input) => transcriptPolishingLifecycle().submit({
          sessionId: activeSessionRecordIdRef.current,
          targetLanguageCode,
          sourceLanguageCode,
          ...input
        }),
        onStateChange: (next) => setPolishingState((current) => ({ ...current, status: next.status, error: next.error?.message || '' }))
      });
    }
    return transcriptPolishingCoordinatorRef.current;
  }

  function scheduleTranscriptPolishing(finalCues = [], { force = false } = {}) {
    if (!TRANSCRIPT_POLISHING_ENABLED) return;
    const cues = finalCues
      .filter((cue) => cue?.status === 'final' && cue?.sourceText && cue?.translatedText)
      .map((cue) => ({ ...cue, translationText: cue.translatedText }));
    if (!activeSessionRecordIdRef.current || cues.length === 0) return;
    void transcriptPolishingCoordinator().add(cues, { force }).catch((nextError) => {
      setPolishingState((current) => ({ ...current, status: 'failed', error: nextError?.message || '翻譯潤飾失敗。' }));
    });
  }

  async function retryPolishingExecution(executionId) {
    if (!executionId) return;
    try {
      await createTranslationCommandApiClient().retryFailedTranslationExecution(executionId);
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
    meetingCheckpointSyncCoordinator().enqueueCues(changedCues, checkpoint);
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
      lastCommittedEndTimeMs: lastCue?.endTimeMs ?? null
    };
  }

  function sessionTimeForSubtitleCues() {
    const origin = transcriptTimeOriginRef.current;
    return Number.isFinite(origin) ? Math.max(0, Date.now() - origin) : null;
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
        await refreshHistoryRecords();
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

    sessionDetailCacheRef.current.delete(sessionId);
    if (selectedHistoryRecordIdRef.current === sessionId) {
      await refreshSelectedHistoryRecordDetail(sessionId);
    }

    if (meetingId) {
      meetingDetailCacheRef.current.delete(meetingId);
      if (selectedMeetingIdRef.current === meetingId) {
        await refreshSelectedMeetingDetail(meetingId);
      }
    }
  }

  async function flushAudioSegmentIfDue(kind) {
    const segment = audioUploadSegmentsRef.current[kind];
    if (!segment || Date.now() - segment.lastFlushedAt < AUDIO_SEGMENT_UPLOAD_INTERVAL_MS) return;
    try {
      await flushAudioSegment(kind);
    } catch (error) {
      scheduleAudioUploadRetry(kind, audioUploadSessionId(kind));
    }
  }

  async function flushAudioSegment(kind, { force = false, sessionId = activeSessionRecordIdRef.current } = {}) {
    const chunksRef = kind === 'input' ? inputAudioUploadChunksRef : translatedAudioUploadChunksRef;
    const metadata = kind === 'input' ? inputAudioMetadataRef.current : translatedAudioMetadataRef.current;
    const segment = audioUploadSegmentsRef.current[kind];
    if (!sessionId || !segment) return null;
    if (segment.inFlight) {
      if (!force) return null;
      await segment.currentPromise?.catch(() => {});
    }
    if (chunksRef.current.length === 0) return null;
    if (!force && Date.now() - segment.lastFlushedAt < AUDIO_SEGMENT_UPLOAD_INTERVAL_MS) return null;

    const uploadChunks = chunksRef.current.slice();
    chunksRef.current = [];
    segment.inFlight = true;
    const uploadPromise = (async () => {
      const blob = pcm16ChunksToWavBlob(uploadChunks, {
        sampleRate: kind === 'input' ? INPUT_SAMPLE_RATE : undefined,
        normalizePeak: true
      });
      await uploadSessionAudioSegment(sessionId, kind, {
        blob,
        segmentIndex: segment.nextIndex,
        fileName: kind === 'input' ? buildInputAudioFileName(metadata) : buildTranslatedAudioFileName({
          sessionId: metadata.sessionId || sessionId,
          startedAt: metadata.startedAt
        })
      });
      segment.nextIndex += 1;
      segment.lastFlushedAt = Date.now();
      clearAudioUploadRetry(kind);
      setError((current) => current.startsWith('語音紀錄暫時無法同步') ? '' : current);
      return true;
    })();
    segment.currentPromise = uploadPromise;
    try {
      return await uploadPromise;
    } catch (nextError) {
      chunksRef.current = uploadChunks.concat(chunksRef.current);
      if (isRetryableAudioUploadError(nextError)) scheduleAudioUploadRetry(kind, sessionId);
      throw nextError;
    } finally {
      segment.inFlight = false;
      if (segment.currentPromise === uploadPromise) {
        segment.currentPromise = null;
      }
    }
  }

  function resetAudioUploadSegment(kind) {
    clearAudioUploadRetry(kind);
    audioUploadSegmentsRef.current[kind] = {
      nextIndex: 0,
      lastFlushedAt: Date.now(),
      inFlight: false,
      currentPromise: null
    };
  }

  function audioUploadSessionId(kind) {
    return (kind === 'input' ? inputAudioMetadataRef : translatedAudioMetadataRef).current.sessionId
      || activeSessionRecordIdRef.current;
  }

  function scheduleAudioUploadRetry(kind, sessionId) {
    if (!sessionId || audioUploadRetryTimersRef.current[kind]) return;
    const attempt = audioUploadRetryAttemptsRef.current[kind] + 1;
    audioUploadRetryAttemptsRef.current[kind] = attempt;
    const delay = Math.min(
      AUDIO_UPLOAD_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
      AUDIO_UPLOAD_RETRY_MAX_DELAY_MS
    );
    audioUploadRetryTimersRef.current[kind] = window.setTimeout(() => {
      audioUploadRetryTimersRef.current[kind] = null;
      void flushAudioSegment(kind, { force: true, sessionId }).catch(() => {});
    }, delay);
  }

  function clearAudioUploadRetry(kind) {
    const timer = audioUploadRetryTimersRef.current[kind];
    if (timer) window.clearTimeout(timer);
    audioUploadRetryTimersRef.current[kind] = null;
    audioUploadRetryAttemptsRef.current[kind] = 0;
  }

  function cancelAudioUploadRetries() {
    clearAudioUploadRetry('input');
    clearAudioUploadRetry('translation');
  }

  function isRetryableAudioUploadError(error) {
    const status = Number(error?.status);
    if (status === 404 || status === 409 || status === 413) return false;
    return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function uploadSessionAudioSegment(sessionId, kind, { blob, segmentIndex, fileName }) {
    const response = await authenticatedFetch(fetch)(`/api/sessions/${encodeURIComponent(sessionId)}/audio/${kind}/segments/${segmentIndex}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-File-Name': fileName || ''
      },
      body: blob
    });

    if (!response.ok) {
      const error = new Error(`Session audio segment upload failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
  }

  async function finalizePendingTranscriptItemsForStop() {
    await finalizePendingTranscriptItemsForStreams();
  }

  function schedulePendingTranscriptIdleFinalize(stream, partial) {
    if (!partial) {
      return undefined;
    }

    const expectedPartial = { id: partial.id, text: partial.text };
    const timer = window.setTimeout(() => {
      void finalizePendingTranscriptItemsForStreams({
        streams: [stream],
        expectedPartialByStream: { [stream]: expectedPartial }
      });
    }, PENDING_TRANSCRIPT_IDLE_FINALIZE_MS);

    return () => window.clearTimeout(timer);
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
    await flushSessionSnapshot(sessionId);
    return updated;
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
      archivedTranscriptSegmentsRef.current = capArchivedTranscriptSegments([
        ...archivedTranscriptSegmentsRef.current,
        {
          id: `active-segment-${Date.now()}-${currentTranscript.nextSequence}`,
          transcript: currentTranscript
        }
      ]);
      const archived = archivedTranscriptFromSegments(archivedTranscriptSegmentsRef.current, currentTranscript.nextSequence);
      archivedTranscriptRef.current = archived;
      setArchivedTranscript(() => archived);
    }
    resetActiveTranscriptForNextSegment(currentTranscript.nextSequence);

    if (finalItemCount > 0) {
      setMeetingViewStats((current) => ({
        archivedSegmentCount: current.archivedSegmentCount + 1,
        loadedSegmentCount: Math.min(
          ARCHIVED_TRANSCRIPT_SEGMENT_CACHE_LIMIT,
          Math.max(current.loadedSegmentCount, current.archivedSegmentCount + 1)
        )
      }));
    }
  }

  function resetActiveTranscriptForNextSegment(nextSequence) {
    const nextTranscript = emptyTranscriptStateWithNextSequence(nextSequence);
    transcriptRef.current = nextTranscript;
    setTranscript(() => nextTranscript);
  }

  async function refreshHistoryRecords() {
    setIsLoadingHistory(true);
    setHistoryLoadError('');
    try {
      const history = await sessionReadApiClientRef.current.listSessionHistory();
      const finalizedRecords = history
        .sort((a, b) => historyRecordSortTime(b) - historyRecordSortTime(a));

      setHistoryRecords(finalizedRecords);
    } catch {
      setHistoryLoadError('Session 紀錄載入失敗。請檢查連線後重試。');
    } finally {
      setIsLoadingHistory(false);
    }
  }

  async function refreshMeetingRecords() {
    setIsLoadingMeetings(true);
    setMeetingLoadError('');
    try {
      const meetings = await meetingReadApiClientRef.current.listMeetingHistory();
      setMeetingRecords([...meetings].sort((a, b) => meetingRecordSortTime(b) - meetingRecordSortTime(a)));
    } catch {
      setMeetingLoadError('長會議紀錄載入失敗。請檢查連線後重試。');
    } finally {
      setIsLoadingMeetings(false);
    }
  }

  async function retryHistoryExecution(execution) {
    if (!execution?.id) return;
    setRetryingHistoryExecutionId(execution.id);
    try {
      await translationCommandApiClientRef.current.retryFailedTranslationExecution(execution.id);
      await refreshSelectedHistoryRecordDetail();
    } catch {
      setHistoryDetailError('無法重試此重新翻譯工作。請稍後再試。');
    } finally {
      setRetryingHistoryExecutionId('');
    }
  }

  async function refreshDeadLetterQueue() {
    setIsLoadingDeadLetterQueue(true);
    setDeadLetterQueueLoadError(null);
    setDeadLetterQueueNotice('');
    try {
      setDeadLetterQueue(await deadLetterQueueApiClientRef.current.list());
    } catch (error) {
      setDeadLetterQueueLoadError(error);
    } finally {
      setIsLoadingDeadLetterQueue(false);
    }
  }

  async function replayDeadLetterItem(item) {
    if (!window.confirm(`確定要重新排入 ${item.executionId} 嗎？原始 DLQ 紀錄會保留。`)) return;
    setReplayingDeadLetterExecutionId(item.executionId);
    setDeadLetterQueueLoadError(null);
    setDeadLetterQueueNotice('');
    try {
      const result = await deadLetterQueueApiClientRef.current.replay(item.executionId);
      await refreshDeadLetterQueue();
      setDeadLetterQueueNotice(`已建立新的 queued execution：${result?.execution?.id || '未提供 ID'}。原始 DLQ 紀錄仍保留。`);
    } catch (error) {
      setDeadLetterQueueLoadError(error);
    } finally {
      setReplayingDeadLetterExecutionId('');
    }
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
      const activeSegment = [...segments].reverse().find((segment) => segment.status === 'active');
      if (!activeSegment) {
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
      const latestCueCheckpoint = [...checkpoints].reverse().map((result) => result?.checkpoint?.cueCheckpoint).find(Boolean);
      if (persistedCues.length > 0 || latestCueCheckpoint) {
        const restoredCueState = createSubtitleCueState({
          ...(latestCueCheckpoint || {}),
          finalCues: persistedCues,
          nextSequence: Math.max(latestCueCheckpoint?.nextSequence || 1, (persistedCues.at(-1)?.sequence || 0) + 1)
        });
        subtitleCueStateRef.current = restoredCueState;
        setSubtitleCueState(restoredCueState);
      }
      const resumeTranscript = transcriptStateFromCheckpointChunks(chunks);
      const archivedSegments = transcriptSegmentsFromCheckpoints({ segments, checkpoints });
      archivedTranscriptSegmentsRef.current = capArchivedTranscriptSegments(archivedSegments);
      const archivedResumeTranscript = archivedTranscriptFromSegments(archivedTranscriptSegmentsRef.current, resumeTranscript.nextSequence);
      archivedTranscriptRef.current = archivedResumeTranscript;
      setArchivedTranscript(() => archivedResumeTranscript);
      resetActiveTranscriptForNextSegment(resumeTranscript.nextSequence);
      setTranscriptTimeOrigin(Date.now());
      setCopiedArticleStream('');
      activeMeetingCheckpointRef.current = {
        meetingId,
        segmentId: activeSegment.id
      };
      setResumeDraft({
        sessionId: (await sessionReadApiClientRef.current.listSessionHistory().catch(() => []))
          .find((record) => record.meetingId === meetingId && ['active', 'paused'].includes(record.status))?.id || null,
        meetingId,
        segmentId: activeSegment.id,
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

  async function openHistoryRecordDetail(id) {
    if (selectedHistoryRecordIdRef.current === id) {
      closeHistoryRecordDetail();
      return;
    }

    const record = historyRecords.find((historyRecord) => historyRecord.id === id);

    if (!record) {
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    selectedHistoryRecordIdRef.current = id;
    setSelectedHistoryRecordId(id);
    setHistoryDetailError('');
    const cachedDetail = sessionDetailCacheRef.current.get(id);
    setSelectedHistoryDetail(cachedDetail || undefined);

    try {
      const detail = await getSessionDetailWithTranslationHistory(id);

      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return;
      }

      if (detail) {
        sessionDetailCacheRef.current.set(id, detail);
      } else {
        sessionDetailCacheRef.current.delete(id);
      }
      setSelectedHistoryDetail(detail);
    } catch {
      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return;
      }

      setSelectedHistoryDetail(null);
      setHistoryDetailError('工作階段詳細資料載入失敗。請重試。');
    }
  }

  async function refreshSelectedHistoryRecordDetail(id) {
    if (!id || selectedHistoryRecordIdRef.current !== id) {
      return false;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;

    try {
      const detail = await getSessionDetailWithTranslationHistory(id);

      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return false;
      }

      if (detail) {
        sessionDetailCacheRef.current.set(id, detail);
      } else {
        sessionDetailCacheRef.current.delete(id);
      }
      setSelectedHistoryDetail(detail);
      return true;
    } catch {
      if (detailRequestIdRef.current === requestId && selectedHistoryRecordIdRef.current === id) {
        setError('工作階段詳細資料無法更新。');
      }

      return false;
    }
  }

  async function getSessionDetailWithTranslationHistory(sessionId) {
    const [sessionDetail, translationHistory] = await Promise.all([
      sessionReadApiClientRef.current.getSessionDetail(sessionId),
      sessionReadApiClientRef.current.getSessionTranslations(sessionId)
    ]);

    return mergeRetranslationHistoryIntoDetail(sessionDetail, translationHistory);
  }

  function closeHistoryRecordDetail() {
    detailRequestIdRef.current += 1;
    selectedHistoryRecordIdRef.current = null;
    setSelectedHistoryRecordId(null);
    setSelectedHistoryDetail(null);
  }

  async function openMeetingDetail(id) {
    if (selectedMeetingIdRef.current === id) {
      closeMeetingDetail();
      return;
    }

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
        setError('會議詳細資料無法更新。');
      }

      return false;
    }
  }

  function closeMeetingDetail() {
    meetingDetailRequestIdRef.current += 1;
    selectedMeetingIdRef.current = null;
    setSelectedMeetingId(null);
    setSelectedMeetingDetail(null);
  }

  async function deleteHistoryRecord(id) {
    if (!window.confirm('確定要刪除此翻譯紀錄？')) {
      return;
    }

    try {
      await sessionReadApiClientRef.current.deleteSessionRecord(id);
      setError('');
      sessionDetailCacheRef.current.delete(id);
      setHistoryRecords((records) => records.filter((record) => record.id !== id));

      if (selectedHistoryRecordIdRef.current === id) {
        closeHistoryRecordDetail();
      }
    } catch {
      setError('無法刪除翻譯紀錄。');
    }
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

    if (nextPage === 'retranslate') {
      setRetranslationSessionId('');
      window.location.hash = 'retranslate';
      return;
    }

    if (nextPage === page) {
      return;
    }

    window.location.hash = nextPage;
  }

  function updateLiveMeetingUrl(meetingId) {
    if (!meetingId || pageFromLocation() !== 'live') return;
    runtimeMeetingIdsRef.current.add(meetingId);
    window.history.replaceState(null, '', `#live?meetingId=${encodeURIComponent(meetingId)}`);
  }

  function openRetranslationWorkflow(sessionId) {
    const encodedSessionId = encodeURIComponent(sessionId);
    window.location.hash = `retranslate?sessionId=${encodedSessionId}`;
  }

  function downloadTranscript() {
    setError('');

    try {
      const content = exportApplicationService.exportTranscript({
        items: transcriptItems,
        cues: subtitleCueState.finalCues,
        options: {
          format: exportFormat,
          stream: exportStream,
          timeOrigin: transcriptTimeOrigin
        }
      });
      const fileName = buildTranscriptFileName({ format: exportFormat });
      downloadTextFile(content, fileName, contentTypeForFormat(exportFormat));
    } catch {
      setError('所選選項無法匯出逐字稿。');
    }
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
  const canDownloadTranscript = exportFormat !== 'txt' && subtitleCueState.finalCues.length > 0
    ? canExportCues(subtitleCueState.finalCues, { format: exportFormat, stream: exportStream })
    : canExportTranscript(transcriptItems, {
      format: exportFormat,
      stream: exportStream,
      timeOrigin: transcriptTimeOrigin
    });
  const exportUnavailableReason = exportFormat !== 'txt' && exportStream === 'both' ? 'SRT 與 VTT 一次只能匯出一個內容。' : '';
  const selectedHistoryRecord = selectedHistoryRecordId
    ? historyRecords.find((historyRecord) => historyRecord.id === selectedHistoryRecordId) || null
    : null;

  if (page === 'watch') {
    const watchInfo = pageInfoFromLocation();
    return <WatchPage token={watchInfo.shareToken} code={watchInfo.shareCode} />;
  }

  if (page === 'record') {
    const recordInfo = pageInfoFromLocation();
    return <RecorderPage token={recordInfo.shareToken} code={recordInfo.shareCode} />;
  }

  if (page === 'meeting') {
    return <MeetingManagementPage onOpenLive={(meetingId) => { window.location.hash = `#live?meetingId=${encodeURIComponent(meetingId)}`; }} />;
  }

  if (isReadOnlyControlView) {
    return <ReadOnlySessionPage sessionId={routeSessionId || activeSessionRecordIdRef.current} />;
  }

  return (
    <main className={`app-shell ${page === 'live' ? 'live-app-shell' : ''}`}>
      {page === 'live' ? (
        <aside className="live-sidebar" aria-label="即時翻譯工作區導覽">
          <a className="live-sidebar-brand" href="#live" aria-label="即時翻譯首頁" onClick={(event) => navigateTo('live', event)}>
            <span className="live-sidebar-mark" aria-hidden="true"><Radio size={20} /></span>
            <h1>即時翻譯</h1>
          </a>
          <nav className="live-sidebar-navigation" aria-label="主要導覽">
            <a href="#meeting" onClick={(event) => navigateTo('meeting', event)}><Play size={18} aria-hidden="true" />會議管理</a>
            <a href="#live" aria-current="page" onClick={(event) => navigateTo('live', event)}><Mic size={18} aria-hidden="true" />即時翻譯</a>
            <a href="#history" onClick={(event) => navigateTo('history', event)}><Radio size={18} aria-hidden="true" />翻譯紀錄</a>
            <a href="#retranslate" onClick={(event) => navigateTo('retranslate', event)}><RefreshCw size={18} aria-hidden="true" />重新翻譯</a>
            <a href="#glossary" onClick={(event) => navigateTo('glossary', event)}><BookOpen size={18} aria-hidden="true" />翻譯字典</a>
          </nav>
        </aside>
      ) : null}
      <header className="app-header" hidden={page === 'live'}>
        <div className="brand-block">
          <h1>即時翻譯</h1>
          <p>由 Gemini Live API 驅動的即時語音翻譯。</p>
        </div>
        <nav className="feature-navigation" aria-label="主要導覽">
          <a href="#meeting" aria-current={page === 'meeting' ? 'page' : undefined} onClick={(event) => navigateTo('meeting', event)}>會議管理</a>
          <a href="#live" aria-current={page === 'live' ? 'page' : undefined} onClick={(event) => navigateTo('live', event)}>即時翻譯</a>
          <a href="#history" aria-current={page === 'history' ? 'page' : undefined} onClick={(event) => navigateTo('history', event)}>翻譯紀錄</a>
          <a href="#retranslate" aria-current={page === 'retranslate' ? 'page' : undefined} onClick={(event) => navigateTo('retranslate', event)}>重新翻譯</a>
          <a href="#glossary" aria-current={page === 'glossary' ? 'page' : undefined} onClick={(event) => navigateTo('glossary', event)}>翻譯字典</a>
        </nav>
      </header>

      {error ? <p className="error-message" role="alert">{error}</p> : null}

      <section className="feature-page live-page" aria-label="即時翻譯工作區" hidden={page !== 'live'}>
        <div className="live-workspace-grid">
        <section className="control-panel live-settings-card">
          <div className="title-block">
            <div className="title-block-header">
              <div><p className="eyebrow">LIVE TRANSLATE</p><h2>本次會議設定</h2></div>
            </div>
            <p>設定語言與音訊來源，準備好後開始即時翻譯。</p>
          </div>

          <div className="controls live-settings-controls" aria-label="翻譯控制項">
            <label className="field">
              <span>工作階段名稱</span>
              <input value={sessionName} onChange={(event) => setSessionName(event.target.value)} placeholder="例如：產品會議" disabled={controlsLocked} maxLength={120} />
            </label>
            <label className="field">
              <span>我主要說的語言</span>
              <select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)} disabled={controlsLocked}>
                {SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
              </select>
            </label>

            <label className="field">
              <span>目標語言</span>
              <select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)} disabled={controlsLocked}>
                {SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
              </select>
            </label>

            <label className="field">
              <span>麥克風</span>
              <select
                value={selectedInputDeviceId}
                onChange={(event) => {
                  setSelectedInputDeviceId(event.target.value);
                  setDeviceMessage('');
                }}
                disabled={controlsLocked}
              >
                <option value="">瀏覽器預設麥克風</option>
                {inputDevices.map((device) => <option key={device.deviceId || device.label} value={device.deviceId}>{device.label}</option>)}
              </select>
            </label>

            <div className="live-audio-settings" aria-label="錄音與播放設定">
              <label className="toggle">
                <input type="checkbox" checked={echoTargetLanguage} onChange={(event) => setEchoTargetLanguage(event.target.checked)} disabled={controlsLocked} />
                <span>播放翻譯聲音</span>
              </label>

              <label className="toggle">
                <input type="checkbox" checked={shouldRecordInputAudio} onChange={(event) => setShouldRecordInputAudio(event.target.checked)} disabled={controlsLocked} />
                <span>錄下原始聲音</span>
              </label>
            </div>

            <button
              className="button secondary glossary-drawer-trigger"
              type="button"
              onClick={() => setIsLiveGlossaryDrawerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={isLiveGlossaryDrawerOpen}
            >
              <BookOpen size={18} aria-hidden="true" />
              字典
              <span className="glossary-count-badge">
                {selectedMeetingGlossaryIds.filter((id) => liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode).some((entry) => entry.id === id)).length}
              </span>
            </button>

            <button
              className="button secondary live-export-trigger"
              type="button"
              onClick={() => setIsLiveExportDrawerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={isLiveExportDrawerOpen}
            >
              <Download size={18} aria-hidden="true" />
              匯出
            </button>
          </div>

          <div className="control-status-row">
            <div className="control-status-messages">
              {controlLeaseSnapshot && !hasSessionControl ? (
                <p className="device-note">目前已有工作階段由其他頁籤控制；本頁面只能唯讀查看。</p>
              ) : null}
              {status === 'reconnecting' ? <p className="device-note">正在重新連線即時翻譯…</p> : null}
              {status === 'switching-segment' ? <p className="device-note">正在切換下一段即時翻譯…</p> : null}
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
              {resumeDraft?.hasTranscript && !isActive && status === 'idle' ? (
                <button className="button secondary" type="button" onClick={resumeMeetingSession}>
                  <RefreshCw size={18} aria-hidden="true" />
                  繼續錄製
                </button>
              ) : null}

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
                ) : (
                  <button className="button primary" type="button" onClick={startSession} disabled={isActive || Boolean(controlLeaseSnapshot && !hasSessionControl)}>
                    {isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                    {isActive ? '正在開始' : '開始'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="live-transcript-column">
        <LiveCuePanel
          cueState={subtitleCueState}
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
      </section>

      <>
        <div className={`export-drawer-backdrop${isLiveExportDrawerOpen ? ' is-open' : ''}`} onClick={() => setIsLiveExportDrawerOpen(false)} aria-hidden="true" />
        <aside className={`export-drawer${isLiveExportDrawerOpen ? ' is-open' : ''}`} aria-label="逐字稿匯出" aria-hidden={!isLiveExportDrawerOpen}>
          <div className="export-drawer-header">
            <div>
              <p className="eyebrow">即時翻譯</p>
              <h2>匯出逐字稿</h2>
              <p>選擇檔案格式與匯出內容後下載。</p>
            </div>
            <button className="icon-button" type="button" onClick={() => setIsLiveExportDrawerOpen(false)} aria-label="關閉匯出" tabIndex={isLiveExportDrawerOpen ? 0 : -1}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="export-drawer-body">
            <label className="field">
              <span>匯出格式</span>
              <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)} tabIndex={isLiveExportDrawerOpen ? 0 : -1}>
                <option value="txt">TXT</option>
                <option value="srt">SRT</option>
                <option value="vtt">VTT</option>
              </select>
            </label>
            <label className="field">
              <span>匯出內容</span>
              <select value={exportStream} onChange={(event) => setExportStream(event.target.value)} tabIndex={isLiveExportDrawerOpen ? 0 : -1}>
                <option value="translation">翻譯</option>
                <option value="source">原文</option>
                <option value="both">兩者</option>
              </select>
            </label>
            <button className="button secondary" type="button" onClick={downloadTranscript} disabled={!canDownloadTranscript} tabIndex={isLiveExportDrawerOpen ? 0 : -1}>
              <Download size={18} aria-hidden="true" />
              下載
            </button>
            {!canDownloadTranscript && !exportUnavailableReason ? <p className="export-note">完成至少一句翻譯後，才可下載檔案。</p> : null}
            {exportUnavailableReason ? <p className="export-note">{exportUnavailableReason}</p> : null}
          </div>
        </aside>
      </>

      <LiveGlossaryDrawer
        open={isLiveGlossaryDrawerOpen}
        entries={glossaryEntries}
        targetLanguageCode={targetLanguageCode}
        selectedEntryIds={selectedMeetingGlossaryIds}
        disabled={controlsLocked}
        onClose={() => setIsLiveGlossaryDrawerOpen(false)}
        onEntriesChange={setGlossaryEntries}
        onSelectionChange={setSelectedMeetingGlossaryIds}
        onOpenManager={() => {
          setIsLiveGlossaryDrawerOpen(false);
          navigateTo('glossary');
        }}
      />

      <section className="feature-page history-page" aria-labelledby="history-page-title" hidden={page !== 'history'}>
        <div className="history-header">
          <div>
            <h2 id="history-page-title">翻譯紀錄</h2>
            <p className="history-description">查看已完成的翻譯工作階段；選取紀錄可閱讀、下載或重新翻譯。</p>
          </div>
        </div>
        <div className="history-load-status">
          {isLoadingHistory ? <p className="history-empty">正在載入 Session 紀錄…</p> : null}
          {historyLoadError ? <p className="error-message" role="alert">{historyRecords.length > 0 || meetingRecords.length > 0 ? '部分翻譯紀錄載入失敗。' : historyLoadError} <button className="inline-retry" type="button" onClick={refreshHistoryRecords}>重試</button></p> : null}
          {meetingLoadError ? <p className="error-message" role="alert">{historyRecords.length > 0 || meetingRecords.length > 0 ? '部分翻譯紀錄載入失敗。' : meetingLoadError} <button className="inline-retry" type="button" onClick={refreshMeetingRecords}>重試</button></p> : null}
        </div>
        <HistoryPanel
          titleId="session-history-title"
          records={historyRecords.filter((record) => record.id !== activeSessionRecordIdRef.current)}
          meetingRecords={meetingRecords}
          selectedRecordId={selectedHistoryRecordId}
          selectedDetail={selectedHistoryDetail}
          selectedRecord={selectedHistoryRecord}
          onViewDetails={openHistoryRecordDetail}
          onDeleteRecord={deleteHistoryRecord}
          onRetranslationSubmitted={refreshSelectedHistoryRecordDetail}
          onOpenRetranslationWorkflow={openRetranslationWorkflow}
          onPolishingRetry={retryPolishingExecution}
          selectedMeetingId={selectedMeetingId}
          selectedMeetingDetail={selectedMeetingDetail}
          onViewMeetingDetails={openMeetingDetail}
          historyDetailError={historyDetailError}
          meetingDetailError={meetingDetailError}
          onRetryHistory={refreshHistoryRecords}
          onRetryMeetingHistory={refreshMeetingRecords}
          onRetryHistoryDetail={refreshSelectedHistoryRecordDetail}
          onRetryExecution={retryHistoryExecution}
          retryingExecutionId={retryingHistoryExecutionId}
        />
      </section>

      <section className="feature-page dead-letter-queue-page" aria-labelledby="dead-letter-queue-page-title" hidden={page !== 'dead-letter-queue'}>
        <DeadLetterQueuePanel
          items={deadLetterQueue.items}
          size={deadLetterQueue.size}
          isLoading={isLoadingDeadLetterQueue}
          loadError={deadLetterQueueLoadError}
          notice={deadLetterQueueNotice}
          replayingExecutionId={replayingDeadLetterExecutionId}
          onReplay={replayDeadLetterItem}
          onRefresh={refreshDeadLetterQueue}
        />
      </section>

      <section className="feature-page meetings-page" aria-labelledby="meetings-page-title" hidden={page !== 'meetings'}>
        <MeetingPanel
          titleId="meetings-page-title"
          records={meetingRecords}
          selectedMeetingId={selectedMeetingId}
          selectedDetail={selectedMeetingDetail}
          onViewDetails={openMeetingDetail}
          detailError={meetingDetailError}
          onRetryDetail={() => refreshSelectedMeetingDetail(selectedMeetingId)}
          loadError={meetingLoadError}
          isLoading={isLoadingMeetings}
          onRetryLoad={refreshMeetingRecords}
        />
      </section>

      <section className="feature-page retranslation-page" aria-labelledby="retranslation-page-title" hidden={page !== 'retranslate'}>
        <RetranslationWorkflow
          titleId="retranslation-page-title"
          records={historyRecords}
          selectedSessionId={retranslationSessionId}
          onSelectSession={openRetranslationWorkflow}
        />
      </section>

      <section className="feature-page glossary-page" aria-labelledby="glossary-page-title" hidden={page !== 'glossary'}>
        <GlossaryPanel
          titleId="glossary-page-title"
          entries={glossaryEntries}
          onEntriesChange={setGlossaryEntries}
        />
      </section>
    </main>
  );
}

function DeadLetterQueuePanel({ items, size, isLoading, loadError, notice, replayingExecutionId, onReplay, onRefresh }) {
  return (
    <div className="dead-letter-queue-panel">
      <div className="history-header">
        <div>
          <h2 id="dead-letter-queue-page-title">Dead-letter queue</h2>
          <p className="history-description">受保護的失敗翻譯工作管理頁面；此頁只透過 #dead-letter-queue 直接進入。</p>
        </div>
        <button className="button secondary" type="button" onClick={onRefresh} disabled={isLoading}>
          <RefreshCw size={18} aria-hidden="true" />
          {isLoading ? '重新整理中…' : '重新整理'}
        </button>
      </div>

      {loadError ? <p className="error-message" role="alert">{deadLetterQueueErrorMessage(loadError)} <button className="inline-retry" type="button" onClick={onRefresh}>重試</button></p> : null}
      {notice ? <p className="success-message" role="status">{notice}</p> : null}
      {isLoading && items.length === 0 ? <p className="history-empty">正在載入 dead-letter queue…</p> : null}
      {!isLoading && !loadError && items.length === 0 ? <p className="history-empty">目前沒有待處理的 dead-letter queue 項目。</p> : null}

      <div className="dead-letter-queue-summary" aria-live="polite">共 {size} 筆，依 FIFO 順序顯示。</div>
      <ol className="dead-letter-queue-list">
        {items.map((item) => (
          <li className="dead-letter-queue-item" key={item.executionId}>
            <div className="history-item-header">
              <div>
                <h3>{item.executionId}</h3>
                <p className="history-summary">Request ID：{item.requestId}</p>
              </div>
              <button className="detail-button primary" type="button" onClick={() => onReplay(item)} disabled={replayingExecutionId === item.executionId}>
                {replayingExecutionId === item.executionId ? 'Replay 中…' : 'Replay'}
              </button>
            </div>
            <dl className="history-metadata dead-letter-queue-metadata">
              <div><dt>Attempt</dt><dd>{item.attempt}</dd></div>
              <div><dt>Failed at</dt><dd>{item.failedAt}</dd></div>
              <div><dt>Provider key</dt><dd>{item.providerKey || '未提供'}</dd></div>
            </dl>
            <div className="dead-letter-queue-failures">
              <MetadataDisclosure label="Failure" value={item.failure} />
              <MetadataDisclosure label="Last failure" value={item.lastFailure} />
              <MetadataDisclosure label="Provider metadata" value={item.providerMetadata} />
              <MetadataDisclosure label="Execution metadata" value={item.executionMetadata} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MetadataDisclosure({ label, value }) {
  return (
    <details className="dead-letter-queue-metadata-disclosure">
      <summary>{label}</summary>
      <pre>{formatDeadLetterMetadata(value)}</pre>
    </details>
  );
}

function formatDeadLetterMetadata(value) {
  if (value === null || value === undefined) return '未提供';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '資料無法顯示。';
  }
}

function deadLetterQueueErrorMessage(error) {
  if (error?.status === 503 || error?.code === 'dead_letter_queue_unavailable') return 'DLQ 目前未啟用，請稍後重試。';
  if (error?.status === 401 || error?.status === 403) return '你沒有權限查看 DLQ，請確認 Access Token 後重試。';
  if (error?.status === 404 || error?.code === 'dead_letter_item_not_found') return '找不到這筆 DLQ 項目，請重新整理清單。';
  return 'DLQ 載入或操作失敗，請檢查連線後重試。';
}

function ReadOnlySessionPage({ sessionId }) {
  const clientRef = useRef(createSessionReadApiClient());
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function load() {
      try {
        const [sessionDetail, translationHistory] = await Promise.all([
          clientRef.current.getSessionDetail(sessionId),
          clientRef.current.getSessionTranslations(sessionId)
        ]);
        if (cancelled) return;
        if (!sessionDetail) {
          setDetail(null);
          setError('找不到此工作階段。');
          if (timer !== null) clearInterval(timer);
          return;
        }
        setDetail(mergeRetranslationHistoryIntoDetail(sessionDetail, translationHistory));
        setError('');
        setIsLoading(false);
        if (TERMINAL_HISTORY_STATUSES.has(sessionDetail?.session?.status) && timer !== null) {
          clearInterval(timer);
        }
      } catch {
        if (!cancelled) {
          setIsLoading(false);
          setError('工作階段內容載入失敗，請稍後重試。');
        }
      }
    }

    void load();
    timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [sessionId]);

  const sourceItems = detail?.sourceTranscript?.items || [];
  const translationItems = detail?.selectedTranslationOutput?.items || [];
  const session = detail?.session;

  return (
    <main className="app-shell watch-page session-read-only-page">
      <header className="app-header">
        <div className="brand-block">
          <h1>{session?.name || '即時翻譯工作階段'}</h1>
          <p>唯讀查看 · 目前不持有錄音控制權</p>
        </div>
        <span className="status-pill">{session ? historyStatusLabel(session.status) : '載入中'}</span>
      </header>
      <p className="device-note">此頁面可以查看內容，但不會取得麥克風，也不能暫停、繼續或結束工作階段。</p>
      {isLoading && !detail ? <p className="history-empty">正在載入工作階段內容…</p> : null}
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {detail ? (
        <section className="transcript-panel" aria-label="工作階段唯讀內容">
          <div className="transcript-columns">
            <div>
              <h2>原文</h2>
              {sourceItems.length > 0 ? sourceItems.map((item) => <p key={item.id}>{item.text}</p>) : <p className="history-empty">尚無原文內容。</p>}
            </div>
            <div>
              <h2>翻譯</h2>
              {translationItems.length > 0 ? translationItems.map((item) => <p key={item.id}>{item.text}</p>) : <p className="history-empty">尚無翻譯內容。</p>}
            </div>
          </div>
        </section>
      ) : null}
      <p><a className="button detail-button" href="#history">返回翻譯紀錄</a></p>
    </main>
  );
}

function WatchPage({ token, code }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const identifier = token || code;
    if (!identifier) {
      setError('分享連結無效或已撤銷。');
      return undefined;
    }
    const basePath = token ? `/api/shared-sessions/${encodeURIComponent(token)}` : `/api/shared-sessions/code/${encodeURIComponent(code)}`;
    let cancelled = false;
    const controller = new AbortController();
    fetch(basePath, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('分享連結無效或已過期。');
        return response.json();
      })
      .then((nextDetail) => { if (!cancelled) setDetail(nextDetail); })
      .catch((nextError) => { if (!cancelled && nextError.name !== 'AbortError') setError(nextError.message); });

    const events = new EventSource(`${basePath}/events`);
    events.addEventListener('session.snapshot', (event) => {
      try {
        if (!cancelled) setDetail(JSON.parse(event.data));
      } catch {
        if (!cancelled) setError('無法讀取分享內容。');
      }
    });
    events.onerror = () => {
      if (!cancelled) setError((current) => current.includes('無效') || current.includes('過期') || current.includes('撤銷') ? current : '分享連線中斷，瀏覽器會自動嘗試重新連線。');
    };
    return () => {
      cancelled = true;
      controller.abort();
      events.close();
    };
  }, [token, code]);

  const sourceItems = detail?.sourceTranscript?.items || [];
  const translationItems = detail?.selectedTranslationOutput?.items || [];
  return (
    <main className="app-shell watch-page">
      <header className="app-header">
        <div className="brand-block">
          <h1>即時翻譯觀看</h1>
          <p>唯讀分享內容</p>
        </div>
        <span className="status-pill">{detail?.session?.status || '載入中'}</span>
      </header>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {!detail && !error ? <p className="history-empty">正在載入分享內容…</p> : null}
      {detail ? (
        <section className="transcript-panel" aria-label="分享翻譯內容">
          <div className="transcript-columns">
            <div><h2>原文</h2>{sourceItems.map((item) => <p key={item.id}>{item.text}</p>)}</div>
            <div><h2>翻譯</h2>{translationItems.map((item) => <p key={item.id}>{item.text}</p>)}</div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function RecorderPage({ token, code = '' }) {
  const [detail, setDetail] = useState(null);
  const [lease, setLease] = useState(null);
  const [recorderGrant, setRecorderGrant] = useState('');
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [transcript, setTranscript] = useState({ source: [], translation: [] });
  const [cueState, setCueState] = useState(createSubtitleCueState);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const liveSessionRef = useRef(null);
  const heartbeatRef = useRef(null);
  const transcriptRef = useRef({ source: [], translation: [] });
  const transcriptSyncTimerRef = useRef(null);
  const audioChunksRef = useRef({ input: [], translation: [] });
  const audioSegmentIndexRef = useRef({ input: 0, translation: 0 });
  const audioFlushPromiseRef = useRef({ input: null, translation: null });
  const leaseRef = useRef(null);
  const grantRef = useRef('');
  const cueStateRef = useRef(createSubtitleCueState());
  const cueTimeOriginRef = useRef(Date.now());
  useEffect(() => {
    if (!token && !code) { setError('錄音連結無效或已過期。'); setLoading(false); return undefined; }
    const detailPath = token
      ? `/api/shared-meetings/${encodeURIComponent(token)}`
      : `/api/shared-meetings/code/${encodeURIComponent(code)}`;
    fetch(detailPath).then(async (response) => {
      if (!response.ok) throw new Error('錄音連結無效或已過期。');
      return response.json();
    }).then((value) => { setDetail(value); setLoading(false); }).catch((value) => { setError(value.message); setLoading(false); });
    return undefined;
  }, [token, code]);
  const sharePath = token
    ? encodeURIComponent(token)
    : `code/${encodeURIComponent(code)}`;
  async function claim() {
    setError('');
    try {
      if (!detail?.session?.id) {
        const startPath = token
          ? `/api/shared-meetings/${encodeURIComponent(token)}/start`
          : `/api/shared-meetings/code/${encodeURIComponent(code)}/start`;
        const startResponse = await fetch(startPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetLanguageCode: 'en', sourceLanguageCode: DEFAULT_SOURCE_LANGUAGE_CODE })
        });
        const startBody = await startResponse.json();
        if (!startResponse.ok) throw new Error(startBody?.error?.message || '無法建立錄音工作階段。');
        setDetail((current) => ({ ...current, session: startBody.session }));
      }
      const response = await fetch(`/api/shared-sessions/${sharePath}/recorder-lease`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || '無法取得錄音控制權。');
      if (body.session) setDetail((current) => ({ ...current, session: body.session }));
      setLease(body.lease);
      setRecorderGrant(body.recorderGrant || '');
      leaseRef.current = body.lease;
      grantRef.current = body.recorderGrant || '';
    } catch (value) { setError(value.message); }
  }
  const recorderHeaders = () => ({
    'X-Recorder-Token': token,
    'X-Recorder-Code': code,
    'X-Recorder-Grant': recorderGrant,
    'X-Recorder-Lease-Id': lease?.leaseId || '',
    'X-Recorder-Fence-Token': String(lease?.fenceToken || ''),
    'X-Recorder-Session-Id': detail?.session?.id || ''
  });
  async function syncSnapshot(status = detail?.session?.status || 'active') {
    if (!detail?.session?.id || !lease) return;
    const items = ['source', 'translation'].flatMap((stream) => transcriptRef.current[stream].map((item, index) => ({
      id: item.id || `${detail.session.id}:recorder:${stream}:${index + 1}`,
      sessionId: detail.session.id,
      stream,
      status: 'final',
      text: item.text,
      sequence: item.sequence || index + 1,
      startedAt: item.startedAt || Date.now(),
      finalizedAt: item.finalizedAt || Date.now(),
      segmentId: item.segmentId || detail.session.segmentId || null
    })));
    const response = await fetch(`/api/sessions/${encodeURIComponent(detail.session.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...recorderHeaders() },
      body: JSON.stringify({ session: { ...detail.session, id: detail.session.id, status, sourceLanguageCode: detail.session.sourceLanguageCode, targetLanguageCode: detail.session.targetLanguageCode }, transcriptItems: items, finalCues: cueStateRef.current.finalCues })
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || '同步錄音內容失敗。');
    if (detail.session.meetingId && detail.session.segmentId && items.length > 0) {
      const durableChunks = items.map((item) => ({
        idempotencyKey: `checkpoint:${item.segmentId || detail.session.segmentId}:${item.id}`,
        meetingId: detail.session.meetingId,
        segmentId: item.segmentId || detail.session.segmentId,
        stream: item.stream,
        sequence: item.sequence,
        text: item.text,
        timestamp: item.finalizedAt
      }));
      const checkpointResponse = await fetch(`/api/meetings/${encodeURIComponent(detail.session.meetingId)}/segments/${encodeURIComponent(detail.session.segmentId)}/checkpoint`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...recorderHeaders() },
        body: JSON.stringify({
          idempotencyKey: `recorder:${detail.session.segmentId}:${items.at(-1).id}`,
          durableChunks,
          pendingPartial: null,
          finalCues: cueStateRef.current.finalCues
        })
      });
      if (!checkpointResponse.ok) throw new Error((await checkpointResponse.json().catch(() => null))?.error?.message || '同步字幕 checkpoint 失敗。');
    }
  }
  async function flushRecorderAudio(kind, force = false) {
    if (audioFlushPromiseRef.current[kind]) {
      await audioFlushPromiseRef.current[kind];
    }
    const chunks = audioChunksRef.current[kind];
    if (!chunks.length || !detail?.session?.id || !lease) return;
    if (!force && chunks.length < 20) return;
    audioChunksRef.current[kind] = [];
    const blob = pcm16ChunksToWavBlob(chunks, {
      sampleRate: kind === 'input' ? INPUT_SAMPLE_RATE : undefined,
      normalizePeak: true
    });
    const segmentIndex = audioSegmentIndexRef.current[kind];
    const fileName = kind === 'input'
      ? buildInputAudioFileName({ sessionId: detail.session.id, startedAt: detail.session.startedAt })
      : buildTranslatedAudioFileName({ sessionId: detail.session.id, startedAt: detail.session.startedAt });
    const upload = (async () => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(detail.session.id)}/audio/${kind}/segments/${segmentIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav', 'X-File-Name': fileName, ...recorderHeaders() },
        body: blob
      });
      if (!response.ok) {
        audioChunksRef.current[kind] = chunks.concat(audioChunksRef.current[kind]);
        throw new Error(`音訊同步失敗（${response.status}）。`);
      }
      audioSegmentIndexRef.current[kind] += 1;
    })();
    audioFlushPromiseRef.current[kind] = upload;
    try {
      await upload;
    } finally {
      if (audioFlushPromiseRef.current[kind] === upload) audioFlushPromiseRef.current[kind] = null;
    }
  }
  function queueRecorderTranscript(update, stream) {
    if (!update?.isFinal || typeof update.text !== 'string' || update.text.trim() === '') return;
    const next = { ...transcriptRef.current };
    const id = update.eventId || `${stream}:${next[stream].length + 1}:${update.text}`;
    if (next[stream].some((item) => item.id === id)) return;
    next[stream] = [...next[stream], {
      id,
      text: update.text,
      sequence: next[stream].length + 1,
      startedAt: update.startedAt || Date.now(),
      finalizedAt: Date.now(),
      segmentId: detail?.session?.segmentId || null
    }];
    transcriptRef.current = next;
    setTranscript(next);
    if (transcriptSyncTimerRef.current) window.clearTimeout(transcriptSyncTimerRef.current);
    transcriptSyncTimerRef.current = window.setTimeout(() => { void syncSnapshot('active'); }, 250);
  }
  function applyRecorderCueEvent(event) {
    const next = applySubtitleCueEvent(cueStateRef.current, event, {
      sessionId: detail?.session?.id,
      segmentId: detail?.session?.segmentId || null,
      sessionClock: () => Date.now() - cueTimeOriginRef.current
    });
    if (next === cueStateRef.current) return;
    cueStateRef.current = next;
    setCueState(next);
  }
  function finalizeRecorderCues(reason) {
    const next = finalizePendingSubtitleCue(cueStateRef.current, {
      sessionId: detail?.session?.id,
      segmentId: detail?.session?.segmentId || null,
      sessionTimeMs: Date.now() - cueTimeOriginRef.current,
      reason
    });
    cueStateRef.current = next;
    setCueState(next);
  }
  async function startRecording() {
    setError('');
    try {
      const { LiveTranslateSession } = await import('./lib/liveSession.js');
      const session = new LiveTranslateSession({
        sessionId: detail.session.id,
        targetLanguageCode: detail.session.targetLanguageCode,
        sourceLanguageCode: detail.session.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE,
        echoTargetLanguage: true,
        authorizationHeaders: recorderHeaders(),
        onInputAudioChunk: (chunk) => {
          audioChunksRef.current.input.push(new Uint8Array(chunk));
          void flushRecorderAudio('input');
        },
        onOutputAudioChunk: (chunk) => {
          audioChunksRef.current.translation.push(new Uint8Array(chunk));
          void flushRecorderAudio('translation');
        },
        onInputTranscript: (item) => queueRecorderTranscript(item, 'source'),
        onOutputTranscript: (item) => queueRecorderTranscript(item, 'translation'),
        onCueEvent: applyRecorderCueEvent
      });
      liveSessionRef.current = session;
      await session.start();
      setRecording(true);
      setPaused(false);
      await syncSnapshot('active');
    } catch (value) { setError(value.message || '無法開始錄音。'); await liveSessionRef.current?.cleanup?.({ closeSession: true }); liveSessionRef.current = null; }
  }
  async function pauseRecording() {
    setError('');
    try {
      await liveSessionRef.current?.stop?.();
      liveSessionRef.current = null;
      finalizeRecorderCues('pause');
      await Promise.all([flushRecorderAudio('input', true), flushRecorderAudio('translation', true)]);
      setRecording(false);
      setPaused(true);
      await syncSnapshot('paused');
    } catch (value) { setError(value.message || '暫停錄音時同步失敗。'); }
  }
  async function stopRecording() {
    setError('');
    try {
      await liveSessionRef.current?.stop?.();
      liveSessionRef.current = null;
      finalizeRecorderCues('stop');
      await Promise.all([flushRecorderAudio('input', true), flushRecorderAudio('translation', true)]);
      setRecording(false);
      setPaused(false);
      await syncSnapshot('stopped');
      await fetch(`/api/shared-sessions/${sharePath}/recorder-lease`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: lease.leaseId, fenceToken: lease.fenceToken }) });
      setLease(null);
      setRecorderGrant('');
      leaseRef.current = null;
      grantRef.current = '';
    } catch (value) { setError(value.message || '停止錄音時同步失敗。'); }
  }
  useEffect(() => {
    if (!lease || !recorderGrant) return undefined;
    heartbeatRef.current = window.setInterval(async () => {
      const response = await fetch(`/api/shared-sessions/${sharePath}/recorder-lease/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: lease.leaseId, fenceToken: lease.fenceToken, recorderGrant }) });
      if (!response.ok) {
        setError('錄音控制權已失效，請重新取得錄音控制權。');
        await liveSessionRef.current?.cleanup?.({ closeSession: true });
        setRecording(false);
        setLease(null);
        setRecorderGrant('');
        leaseRef.current = null;
        grantRef.current = '';
        return;
      }
      const body = await response.json();
      setLease(body.lease); setRecorderGrant(body.recorderGrant || recorderGrant);
      leaseRef.current = body.lease; grantRef.current = body.recorderGrant || recorderGrant;
    }, 3000);
    return () => window.clearInterval(heartbeatRef.current);
  }, [lease?.leaseId, lease?.fenceToken, recorderGrant, token]);
  useEffect(() => {
    leaseRef.current = lease;
    grantRef.current = recorderGrant;
  }, [lease, recorderGrant]);
  useEffect(() => () => {
    if (transcriptSyncTimerRef.current) window.clearTimeout(transcriptSyncTimerRef.current);
    void liveSessionRef.current?.cleanup?.({ closeSession: true });
    const currentLease = leaseRef.current;
    if (currentLease && grantRef.current) {
      void fetch(`/api/shared-sessions/${sharePath}/recorder-lease`, {
        method: 'DELETE', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId: currentLease.leaseId, fenceToken: currentLease.fenceToken })
      });
    }
  }, [token]);
  return <main className="app-shell watch-page">
    <header className="app-header"><div className="brand-block"><h1>{detail?.session?.name || '會議錄音'}</h1><p>Recorder · {detail?.session?.sourceLanguageCode || ''} → {detail?.session?.targetLanguageCode || ''}</p></div><span className="status-pill">{lease ? '已取得錄音控制權' : '尚未開始錄音'}</span></header>
    {loading ? <p className="history-empty">正在載入會議…</p> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {detail && !lease ? <button className="button primary" type="button" onClick={claim}>準備錄音</button> : null}
    {lease && !recording ? <button className="button primary" type="button" onClick={startRecording}>開始錄音</button> : null}
    {recording ? <><button className="button secondary" type="button" onClick={pauseRecording}>暫停錄音</button><button className="button danger-button" type="button" onClick={stopRecording}>停止錄音</button></> : null}
    {lease && paused ? <button className="button primary" type="button" onClick={startRecording}>繼續錄音</button> : null}
    {lease ? <p className="device-note">{recording ? '正在錄音並同步到此 Session。' : paused ? '錄音已暫停，內容已同步。' : '已取得錄音控制權，開始前才會要求麥克風權限。'}</p> : null}
    {recording || paused ? <section className="transcript-panel" aria-label="Recorder transcript"><div className="cue-list">{cueListForDisplay(cueState, { includePartial: recording }).map((cue) => <FinalCueRow key={cue.cueId} cue={cue} />)}</div><div className="transcript-columns"><div><h2>原文</h2>{transcript.source.map((item) => <p key={item}>{item}</p>)}</div><div><h2>翻譯</h2>{transcript.translation.map((item) => <p key={item}>{item}</p>)}</div></div></section> : null}
  </main>;
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

function capArchivedTranscriptSegments(segments = []) {
  return segments.slice(-ARCHIVED_TRANSCRIPT_SEGMENT_CACHE_LIMIT);
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

function reconnectErrorMessage(result) {
  if (result?.decision?.stopReason === 'max_attempts_exceeded') {
    return RECONNECT_EXHAUSTED_MESSAGE;
  }

  return RECONNECT_FAILED_MESSAGE;
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

function HistoryNameCell({ data }) {
  return <strong role="heading" aria-level="3">{data.kind === 'meeting' ? meetingTitle(data.record) : historyLanguageLabel(data.record)}</strong>;
}

function HistoryStatusCell({ data }) {
  return <span className={`history-status history-status-${data.record.status}`}>{data.kind === 'meeting' ? meetingStatusLabel(data.record.status) : historyStatusLabel(data.record.status)}</span>;
}

function HistorySummaryCell({ data }) {
  return <span>{data.kind === 'meeting' ? meetingSegmentSummaryLabel(data.record.segmentSummary) : transcriptSummaryLabel(data.record.transcriptSummary)}</span>;
}

function HistoryActionsCell({ data, context }) {
  const { onDeleteRecord, onViewDetails, onViewMeetingDetails, selectedMeetingId, selectedRecordId } = context;
  const record = data.record;
  if (data.kind === 'meeting') {
    return (
      <div className="history-actions">
        {record.status === 'active' || record.status === 'interrupted' ? (
          <a className="button detail-button" href={`#live?meetingId=${encodeURIComponent(record.id)}`}>
            <Play size={16} aria-hidden="true" />
            {record.status === 'active' ? '繼續翻譯' : '繼續處理'}
          </a>
        ) : null}
        <button className="button detail-button" type="button" aria-label={selectedMeetingId === record.id ? '關閉詳細資料' : '查看詳細資料'} aria-expanded={selectedMeetingId === record.id} onClick={() => onViewMeetingDetails(record.id)}>
          {selectedMeetingId === record.id ? '關閉內容' : '查看內容'}
        </button>
      </div>
    );
  }

  return (
    <div className="history-actions">
      {record.status === 'active' || record.status === 'paused' || record.status === 'interrupted' ? (
        <a className="button detail-button" href={record.meetingId ? `#live?meetingId=${encodeURIComponent(record.meetingId)}` : `#live?sessionId=${encodeURIComponent(record.id)}`}>
          <Play size={16} aria-hidden="true" />
          {record.status === 'paused' || record.status === 'active' ? '繼續翻譯' : '繼續處理'}
        </a>
      ) : null}
      <button className="button detail-button" type="button" aria-label={selectedRecordId === record.id ? '關閉詳細資料' : '查看詳細資料'} aria-expanded={selectedRecordId === record.id} onClick={() => onViewDetails(record.id)}>
        {selectedRecordId === record.id ? '關閉內容' : '查看內容'}
      </button>
      <button className="button detail-button danger-button" type="button" onClick={() => onDeleteRecord(record.id)}><Trash2 size={16} aria-hidden="true" />刪除</button>
    </div>
  );
}

function RetranslationSessionNameCell({ data }) {
  return <strong role="heading" aria-level="3">{data.name || historyLanguageLabel(data)}</strong>;
}

function RetranslationSessionStatusCell({ data }) {
  return <span className={`history-status history-status-${data.status}`}>{historyStatusLabel(data.status)}</span>;
}

function RetranslationSessionActionCell({ context, data }) {
  return <button className="button detail-button" type="button" aria-label="選擇" onClick={() => context.onSelectSession(data.id)}>重新翻譯此紀錄</button>;
}

function RetranslationOutputTitleCell({ data }) {
  return <strong role="heading" aria-level="4">{translationOutputTitle(data)}</strong>;
}

function RetranslationOutputStatusCell() {
  return <span className="history-status history-status-completed">已完成</span>;
}

function RetranslationOutputActionsCell({ context, data }) {
  return (
    <div className="history-actions">
      <button className="button detail-button" type="button" aria-pressed={context.selectedOutputId === data.id} onClick={() => context.onSelect(data.id)}>
        {context.selectedOutputId === data.id ? '已選取' : '查看內容'}
      </button>
      <button className="button detail-button danger-button" type="button" onClick={() => context.onDelete(data)}><Trash2 size={16} aria-hidden="true" />刪除</button>
    </div>
  );
}

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

function LiveCuePanel({
  cueState,
  status,
  statusLabelOverride,
  isPaused,
  isStopped,
  polishingState,
  polishedArticle,
  onPolishingRetry,
  copiedSource,
  copiedTranslation,
  onCopySource,
  onCopyTranslation
}) {
  const panelRef = useRef(null);
  const cueListRef = useRef(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(false);
  const cues = useMemo(() => cueListForDisplay(cueState, { requireSourceTextForPartial: true }), [cueState]);
  const hasContent = cues.length > 0 || Boolean(polishedArticle?.text);

  useEffect(() => {
    const list = cueListRef.current;
    if (!list) return undefined;

    const updateFollowState = () => {
      setIsFollowingLatest(isCueListAtLatestPosition(list));
    };

    updateFollowState();
    window.addEventListener('resize', updateFollowState);
    return () => {
      window.removeEventListener('resize', updateFollowState);
    };
  }, []);

  useEffect(() => {
    const list = cueListRef.current;
    if (!list || !isFollowingLatest || cues.length === 0) return;
    list.scrollTo({ top: list.scrollHeight, behavior: cues.at(-1)?.status === 'final' ? 'smooth' : 'auto' });
  }, [cues.length, cues.at(-1)?.cueId, cues.at(-1)?.updatedTimeMs, isFollowingLatest]);

  function returnToLatest() {
    const list = cueListRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    setIsFollowingLatest(true);
  }

  return (
    <section className="cue-panel" aria-label="即時字幕" data-testid="live-cue-panel" ref={panelRef}>
      <div className="cue-panel-header">
        <div>
          <h2>即時字幕</h2>
          <p>{isPaused ? '已暫停，字幕內容會保留。' : isStopped ? '本次工作階段已結束。' : hasContent ? '原文與譯文會依句子同步顯示。' : '開始翻譯後，原文與翻譯字幕會顯示在這裡'}</p>
        </div>
        <div className="cue-panel-actions">
          <span className={`live-inline-status live-inline-status-${status} status-pill`} aria-label={`即時翻譯狀態：${statusLabel(status, statusLabelOverride)}`}>
            <Radio size={15} aria-hidden="true" />
            {statusLabel(status, statusLabelOverride)}
          </span>
          {hasContent ? <>
          <TranscriptPolishingStatus polishingState={polishingState} onRetry={onPolishingRetry} />
          {!isFollowingLatest ? (
            <button className="button detail-button" type="button" data-testid="follow-latest-button" onClick={returnToLatest}>回到最新字幕</button>
          ) : null}
          </> : null}
        </div>
      </div>
      <div ref={cueListRef} onScroll={(event) => setIsFollowingLatest(isCueListAtLatestPosition(event.currentTarget))} className={`cue-list ${hasContent ? '' : 'cue-list-empty'}`} data-testid="cue-list" role="log" aria-live="polite" aria-label="字幕列表">
        {!hasContent ? <p className="cue-empty cue-empty-prominent" data-testid="cue-empty-state">開始翻譯後，原文與翻譯字幕會顯示在這裡</p> : null}
        {hasContent ? <>
        <section className="cue-language-section" aria-label="即時字幕原文">
          <div className="cue-section-header">
            <h3>輸入／原文</h3>
            <button className="button detail-button" type="button" onClick={onCopySource} disabled={!sourceTextForCopy(cueState.finalCues)}>
              <Copy size={14} aria-hidden="true" />
              {copiedSource ? '已複製' : '複製原文'}
            </button>
          </div>
          <div className="cue-section-list" data-testid="cue-source-list">
            {cues.length === 0 ? <p className="cue-empty" data-testid="cue-empty-state">開始說話後，字幕會顯示在這裡</p> : null}
            {cues.map((cue) => cue.status === 'final'
              ? <FinalCueRow key={cue.cueId} cue={cue} stream="source" />
              : <PartialCueRow key={`partial-${cue.cueId || 'current'}`} cue={cue} stream="source" />)}
          </div>
        </section>
        <section className="cue-language-section" aria-label="即時字幕翻譯">
          <div className="cue-section-header">
            <h3>翻譯</h3>
            <button className="button detail-button" type="button" onClick={onCopyTranslation} disabled={!translationTextForCopy(cueState.finalCues)}>
              <Copy size={14} aria-hidden="true" />
              {copiedTranslation ? '已複製' : '複製翻譯'}
            </button>
          </div>
          <div className="cue-section-list" data-testid="cue-translation-list">
            {cues.length === 0 ? <p className="cue-empty">開始說話後，字幕會顯示在這裡</p> : null}
            {cues.map((cue) => cue.status === 'final'
              ? <FinalCueRow key={cue.cueId} cue={cue} stream="translation" />
              : <PartialCueRow key={`partial-${cue.cueId || 'current'}`} cue={cue} stream="translation" />)}
          </div>
        </section>
        </> : null}
      </div>
      {polishedArticle?.text ? (
        <section className="transcript-panel" data-testid="polished-article" aria-label="潤飾文章版">
          <div className="article-panel-header"><h3>潤飾文章版</h3></div>
          <div className="article-content"><p>{polishedArticle.text}</p></div>
        </section>
      ) : null}
    </section>
  );
}

function FinalCueRow({ cue, stream }) {
  return <CueRow cue={cue} stream={stream} />;
}

function PartialCueRow({ cue, stream }) {
  return <CueRow cue={cue} partial stream={stream} />;
}

function TranscriptPolishingStatus({ polishingState, onRetry }) {
  const status = polishingState?.status || 'idle';
  if (status === 'idle') return null;
  const statusLabel = status === 'running' || status === 'dirty'
    ? '潤飾中'
    : status === 'processing'
      ? '潤飾中'
    : status === 'queued'
      ? '等待潤飾'
      : status === 'failed'
        ? '潤飾失敗'
        : status === 'completed'
          ? '潤飾完成'
          : '尚未開始潤飾';
  const timestamp = polishingState?.updatedAt ? formatPolishingTimestamp(polishingState.updatedAt) : '';
  const errorText = polishingState?.error || '';

  return (
    <span
      className={`transcript-polishing-badge transcript-polishing-badge-${status}`}
      aria-live="polite"
      aria-label={`${statusLabel}${errorText ? `：${errorText}` : ''}`}
      data-testid="transcript-polishing-status"
      title={errorText || undefined}
    >
      {statusLabel}{status === 'completed' && polishingState.version ? ` · v${polishingState.version}` : ''}{timestamp ? ` · ${timestamp}` : ''}{status === 'failed' && errorText ? `：${errorText}` : ''}
      {status === 'failed' && polishingState.executionId ? (
        <button className="button detail-button polishing-retry-button" type="button" onClick={() => onRetry?.(polishingState.executionId)}>重試</button>
      ) : null}
    </span>
  );
}

function formatPolishingTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `最後更新 ${date.toLocaleTimeString()}`;
}

function CueRow({ cue, partial = false, stream }) {
  const label = partial ? '辨識中／翻譯中' : `字幕 ${cue.sequence || ''}`;
  const text = stream === 'translation' ? cue.translatedText : cue.sourceText;
  const textClassName = stream === 'translation' ? 'cue-translation' : 'cue-source';
  const languageCode = stream === 'translation' ? cue.targetLanguageCode : cue.sourceLanguageCode;
  const wrappedText = wrapSubtitleText(text, languageCode);
  return (
    <article
      className={`cue-row${partial ? ' cue-row-partial' : ''}`}
      data-testid={partial ? 'cue-partial-row' : 'cue-final-row'}
      data-cue-id={cue.cueId || undefined}
      aria-label={label}
    >
      {partial ? <div className="cue-row-meta"><span className="cue-partial-status">{label}</span></div> : null}
      <div className="cue-text-toggle">
        {stream ? (
          <span className={textClassName} data-testid={stream === 'translation' ? 'cue-translated-text' : 'cue-source-text'}>{wrappedText || '—'}</span>
        ) : (
          <>
            <span className="cue-source" data-testid="cue-source-text">{wrapSubtitleText(cue.sourceText, cue.sourceLanguageCode) || '—'}</span>
            <span className="cue-translation" data-testid="cue-translated-text">{wrapSubtitleText(cue.translatedText, cue.targetLanguageCode) || '—'}</span>
          </>
        )}
      </div>
    </article>
  );
}

function latestPolishingOutput(detail) {
  return completedPolishingOutputs(detail)
    .sort((left, right) => (right.version || 0) - (left.version || 0) || String(right.completedAt || '').localeCompare(String(left.completedAt || '')))[0] || null;
}

function completedPolishingOutputs(detail) {
  return (detail?.translationHistory?.outputs || [])
    .filter((output) => output.operation === 'transcript_polishing' && typeof output.translatedText === 'string' && output.translatedText.trim().length > 0);
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

function HistoryPanel({
  titleId,
  records,
  meetingRecords = [],
  selectedRecordId,
  selectedDetail,
  selectedRecord,
  onViewDetails,
  onDeleteRecord,
  onRetranslationSubmitted,
  onOpenRetranslationWorkflow,
  onPolishingRetry,
  selectedMeetingId,
  selectedMeetingDetail,
  onViewMeetingDetails,
  historyDetailError = '',
  meetingDetailError = '',
  onRetryHistory,
  onRetryMeetingHistory,
  onRetryHistoryDetail,
  onRetryExecution,
  retryingExecutionId = ''
}) {
  const [query, setQuery] = useState('');
  const entries = useMemo(() => combinedHistoryEntries(records, meetingRecords), [records, meetingRecords]);
  const filteredEntries = useMemo(() => entries.filter((entry) => historyEntryMatches(entry, query)), [entries, query]);
  const gridContext = useMemo(() => ({ onDeleteRecord, onViewDetails, onViewMeetingDetails, selectedMeetingId, selectedRecordId }), [onDeleteRecord, onViewDetails, onViewMeetingDetails, selectedMeetingId, selectedRecordId]);
  const columnDefs = useMemo(() => [
    { headerName: '名稱', valueGetter: ({ data }) => data.kind === 'meeting' ? meetingTitle(data.record) : historyLanguageLabel(data.record), width: 220, cellRenderer: HistoryNameCell },
    { headerName: '狀態', valueGetter: ({ data }) => data.record.status || '', width: 100, cellRenderer: HistoryStatusCell },
    { headerName: '開始時間', valueGetter: ({ data }) => historyRecordSortTime(data.record), width: 150, cellRenderer: ({ data }) => formatRecordTime(data.record.startedAt) },
    { headerName: '結束時間', valueGetter: ({ data }) => data.record.endedAt || '', width: 150, cellRenderer: ({ data }) => formatRecordTime(data.record.endedAt) },
    { headerName: '摘要', valueGetter: ({ data }) => data.kind === 'meeting' ? meetingSegmentSummaryLabel(data.record.segmentSummary) : transcriptSummaryLabel(data.record.transcriptSummary), minWidth: 210, flex: 1, cellRenderer: HistorySummaryCell },
    { headerName: '操作', width: 300, sortable: false, cellRenderer: HistoryActionsCell }
  ], []);
  const selectedEntry = selectedRecordId
    ? entries.find((entry) => entry.kind === 'session' && entry.record.id === selectedRecordId)
    : selectedMeetingId
      ? entries.find((entry) => entry.kind === 'meeting' && entry.record.id === selectedMeetingId)
      : null;

  return (
    <section className="history-panel" aria-labelledby={titleId}>
      <h3 id={titleId} className="sr-only">紀錄清單</h3>
      <label className="field history-search-field">
        <span>搜尋紀錄</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋日期、語言或狀態" />
      </label>

      {entries.length === 0 ? (
        <div className="empty-state">
          <p className="history-empty">尚無翻譯紀錄。</p>
          <p className="history-empty">完成一次即時翻譯後，紀錄會出現在這裡。</p>
          <a className="button primary" href="#live">開始即時翻譯</a>
        </div>
      ) : filteredEntries.length === 0 ? (
        <p className="history-empty">找不到符合條件的紀錄。</p>
      ) : (
        <>
          <AgGridReact
            {...dataGridProps('history-data-grid')}
            aria-label="翻譯紀錄列表"
            columnDefs={columnDefs}
            context={gridContext}
            rowData={filteredEntries}
            getRowId={({ data }) => `${data.kind}-${data.record.id}`}
          />
          {selectedEntry?.kind === 'session' ? <SessionDetail detail={selectedDetail} historyRecord={selectedRecord} onRetranslationSubmitted={onRetranslationSubmitted} onOpenRetranslationWorkflow={onOpenRetranslationWorkflow} onPolishingRetry={onPolishingRetry} onRetryExecution={onRetryExecution} retryingExecutionId={retryingExecutionId} detailError={historyDetailError} onRetryDetail={() => onRetryHistoryDetail?.(selectedRecordId)} /> : null}
          {selectedEntry?.kind === 'meeting' ? <MeetingDetail detail={selectedMeetingDetail} detailError={meetingDetailError} onRetryDetail={() => onRetryMeetingHistory?.()} /> : null}
        </>
      )}
    </section>
  );
}

function historyEntryMatches(entry, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  const record = entry.record || {};
  return [
    entry.kind === 'meeting' ? meetingTitle(record) : sessionDisplayName(record),
    record.status,
    formatRecordTime(record.startedAt),
    record.targetLanguageLabel,
    record.targetLanguageCode
  ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedQuery);
}

function SessionHistoryItem({
  record,
  selectedRecordId,
  selectedDetail,
  selectedRecord,
  onViewDetails,
  onDeleteRecord,
  onRetranslationSubmitted,
  onOpenRetranslationWorkflow,
  onPolishingRetry,
  onRetryExecution,
  retryingExecutionId = '',
  detailError = '',
  onRetryDetail
}) {
  return (
    <li className="history-item" key={record.id}>
      <article aria-label={`${historyLanguageLabel(record)} ${historyStatusLabel(record.status)}工作階段`}>
        <div className="history-item-header">
          <div>
            <h3>{historyLanguageLabel(record)}</h3>
            <span className={`history-status history-status-${record.status}`}>{historyStatusLabel(record.status)}</span>
          </div>
          <div className="history-actions">
            {record.status === 'active' || record.status === 'paused' || record.status === 'interrupted' ? (
              <a className="button detail-button" href={record.meetingId ? `#live?meetingId=${encodeURIComponent(record.meetingId)}` : `#live?sessionId=${encodeURIComponent(record.id)}`}>
                <Play size={16} aria-hidden="true" />
                {record.status === 'paused' ? '繼續翻譯' : record.status === 'active' ? '繼續翻譯' : '繼續處理'}
              </a>
            ) : null}
            <button
              className="button detail-button"
              type="button"
              aria-label={selectedRecordId === record.id ? '關閉詳細資料' : '查看詳細資料'}
              aria-expanded={selectedRecordId === record.id}
              onClick={() => onViewDetails(record.id)}
            >
              {selectedRecordId === record.id ? '關閉內容' : '查看內容'}
            </button>
            <button className="button detail-button danger-button" type="button" onClick={() => onDeleteRecord(record.id)}>
              <Trash2 size={16} aria-hidden="true" />
              刪除
            </button>
          </div>
        </div>

        <dl className="history-metadata">
          <div>
            <dt>開始時間</dt>
            <dd>{formatRecordTime(record.startedAt)}</dd>
          </div>
          <div>
            <dt>結束時間</dt>
            <dd>{formatRecordTime(record.endedAt)}</dd>
          </div>
          <div>
            <dt>持續時間</dt>
            <dd>{formatDuration(record.durationMs)}</dd>
          </div>
        </dl>

        <p className="history-summary">{transcriptSummaryLabel(record.transcriptSummary)}</p>
        {record.recordKind === 'retranslation' ? (
          <p className="history-summary">{retranslationSourceLabel(record.retranslatedFrom)}</p>
        ) : null}
        {shouldShowFailureReason(record) ? <p className="history-reason">原因：{record.failureReason}</p> : null}
      </article>
      {selectedRecordId === record.id ? (
        <SessionDetail
          detail={selectedDetail}
          historyRecord={selectedRecord}
          onRetranslationSubmitted={onRetranslationSubmitted}
          onOpenRetranslationWorkflow={onOpenRetranslationWorkflow}
          onPolishingRetry={onPolishingRetry}
          onRetryExecution={onRetryExecution}
          retryingExecutionId={retryingExecutionId}
          detailError={detailError}
          onRetryDetail={onRetryDetail}
        />
      ) : null}
    </li>
  );
}

function MeetingHistoryItem({ record, selectedMeetingId, selectedDetail, onViewDetails, detailError = '', onRetryDetail }) {
  return (
    <li className="history-item meeting-item" key={record.id}>
      <article aria-label={`${meetingTitle(record)} ${meetingStatusLabel(record.status)}會議`}>
        <div className="history-item-header">
          <div>
            <h3>{meetingTitle(record)}</h3>
            <span className={`history-status history-status-${record.status}`}>{meetingStatusLabel(record.status)}</span>
          </div>
          <div className="history-actions">
            {record.status === 'active' || record.status === 'interrupted' ? (
              <a className="button detail-button" href={`#live?meetingId=${encodeURIComponent(record.id)}`}>
                <Play size={16} aria-hidden="true" />
                {record.status === 'active' ? '繼續翻譯' : '繼續處理'}
              </a>
            ) : null}
            <button
              className="button detail-button"
              type="button"
              aria-label={selectedMeetingId === record.id ? '關閉詳細資料' : '查看詳細資料'}
              aria-expanded={selectedMeetingId === record.id}
              onClick={() => onViewDetails(record.id)}
            >
              {selectedMeetingId === record.id ? '關閉內容' : '查看內容'}
            </button>
          </div>
        </div>

        <dl className="history-metadata">
          <div><dt>開始時間</dt><dd>{formatRecordTime(record.startedAt)}</dd></div>
          <div><dt>結束時間</dt><dd>{formatRecordTime(record.endedAt)}</dd></div>
          <div><dt>持續時間</dt><dd>{formatDuration(record.durationMs)}</dd></div>
          <div><dt>段落</dt><dd>{meetingSegmentSummaryLabel(record.segmentSummary)}</dd></div>
          <div><dt>逐字稿</dt><dd>{transcriptSummaryLabel(record.transcriptSummary)}</dd></div>
          <div><dt>異常段落</dt><dd>{meetingExceptionSummaryLabel(record.segmentSummary)}</dd></div>
        </dl>
      </article>
      {selectedMeetingId === record.id ? <MeetingDetail detail={selectedDetail} detailError={detailError} onRetryDetail={onRetryDetail} /> : null}
    </li>
  );
}

function MeetingManagementPage({ onOpenLive }) {
  const managementClientRef = useRef(createMeetingManagementApiClient());
  const readClientRef = useRef(createMeetingReadApiClient());
  const glossaryClientRef = useRef(createGlossaryApiClient());
  const [meetings, setMeetings] = useState([]);
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [selectedGlossaryIds, setSelectedGlossaryIds] = useState([]);
  const [name, setName] = useState('');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [shares, setShares] = useState([]);
  const [createdShare, setCreatedShare] = useState(null);
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    Promise.all([readClientRef.current.listMeetingHistory(), glossaryClientRef.current.listEntries()])
      .then(([meetingItems, entries]) => { setMeetings(meetingItems); setGlossaryEntries(entries); })
      .catch(() => setError('無法載入會議或字典資料。'));
  }, []);

  function resetForm() {
    setSelectedMeeting(null);
    setName('');
    setSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE);
    setTargetLanguageCode('en');
    setSelectedGlossaryIds([]);
    setShares([]);
    setCreatedShare(null);
    setNotice('');
  }

  async function selectMeeting(id) {
    setError('');
    try {
      const detail = await readClientRef.current.getMeetingDetail(id);
      const meeting = detail?.meeting;
      setSelectedMeeting(meeting);
      setName(meeting?.name || '');
      setSourceLanguageCode(meeting?.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE);
      const meetingTargetLanguageCode = meeting?.targetLanguageCode || 'en';
      setTargetLanguageCode(meetingTargetLanguageCode);
      setSelectedGlossaryIds(glossaryEntries.filter((entry) => (meeting?.glossaryEntries || []).some((item) => item.source === entry.source && entry.translations?.[meetingTargetLanguageCode] === item.target)).map((entry) => entry.id));
      setShares(await managementClientRef.current.listShares(id));
      setCreatedShare(null);
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

  async function saveMeeting() {
    setError('');
    setNotice('');
    setIsSaving(true);
    try {
      const input = { name: name.trim() || null, sourceLanguageCode, targetLanguageCode, glossaryEntries: selectedEntries() };
      const meeting = selectedMeeting
        ? await managementClientRef.current.update(selectedMeeting.id, input)
        : await managementClientRef.current.create(input);
      setSelectedMeeting(meeting);
      setMeetings((current) => [meeting, ...current.filter((item) => item.id !== meeting.id)]);
      setNotice('會議設定已儲存。');
    } catch {
      setError('無法儲存會議設定。');
    } finally {
      setIsSaving(false);
    }
  }

  async function createShare() {
    if (!selectedMeeting?.id) {
      setError('請先儲存會議設定。');
      return;
    }
    try {
      const result = await managementClientRef.current.createShare(selectedMeeting.id, expiry ? Date.now() + Number(expiry) : null);
      const url = new URL(result.url, window.location.href).href;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 180, margin: 1 });
      setCreatedShare({ ...result, absoluteUrl: url, qrDataUrl });
      setShares((current) => [...current, result.share]);
    } catch {
      setError('無法建立會議分享連結。');
    }
  }

  async function revokeShare(shareId) {
    try {
      await managementClientRef.current.revokeShare(selectedMeeting.id, shareId);
      setShares((current) => current.filter((share) => share.id !== shareId));
      setCreatedShare(null);
    } catch {
      setError('無法撤銷分享連結。');
    }
  }

  return (
    <section className="feature-page meeting-management-page" aria-labelledby="meeting-management-title">
      <div className="history-header">
        <div><h2 id="meeting-management-title">會議管理</h2><p className="history-description">先建立會議並完成設定，再分享給參與者錄音。</p></div>
        <button className="button secondary" type="button" onClick={resetForm}>建立新會議</button>
      </div>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {notice ? <p className="success-message" role="status">{notice}</p> : null}
      <div className="meeting-management-grid">
        <section className="control-panel" aria-label="會議設定">
          <h3>{selectedMeeting ? '編輯會議設定' : '建立會議'}</h3>
          <label className="field"><span>會議名稱</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：產品會議" maxLength={120} /></label>
          <label className="field"><span>主要輸入語言</span><select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <label className="field"><span>目標語言</span><select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <h4>會議字典</h4>
          {glossaryEntries.filter((entry) => entry.scope === 'live' || entry.scope === 'both').map((entry) => (
            <label className="toggle" key={entry.id}><input type="checkbox" checked={selectedGlossaryIds.includes(entry.id)} onChange={(event) => setSelectedGlossaryIds((current) => event.target.checked ? [...new Set([...current, entry.id])] : current.filter((id) => id !== entry.id))} /><span>{entry.source} → {entry.translations?.[targetLanguageCode] || '此語言尚未設定'}</span></label>
          ))}
          <button className="button primary" type="button" onClick={saveMeeting} disabled={isSaving}>{isSaving ? '儲存中…' : '儲存會議設定'}</button>
          {selectedMeeting ? <button className="button secondary" type="button" onClick={() => onOpenLive(selectedMeeting.id)}>前往即時翻譯</button> : null}
        </section>
        <section className="control-panel" aria-label="會議分享">
          <h3>分享錄音入口</h3>
          <p className="export-note">完成設定並儲存後，產生 Recorder 連結給參與者。開啟連結不會立即取得麥克風。</p>
          <label className="field"><span>有效期限</span><select value={expiry} onChange={(event) => setExpiry(event.target.value)}><option value="">永久</option><option value="3600000">1 小時</option><option value="86400000">24 小時</option><option value="604800000">7 天</option></select></label>
          <button className="button secondary" type="button" onClick={createShare} disabled={!selectedMeeting}>建立錄音分享連結</button>
          {createdShare ? <div className="share-created">{createdShare.qrDataUrl ? <img src={createdShare.qrDataUrl} alt="會議錄音入口 QR Code" width="180" height="180" /> : null}<p className="share-url"><a href={createdShare.absoluteUrl}>{createdShare.absoluteUrl}</a></p><button className="button detail-button" type="button" onClick={() => navigator.clipboard?.writeText(createdShare.absoluteUrl)}>複製連結</button></div> : null}
          {shares.length > 0 ? <ul className="share-list">{shares.map((share) => <li key={share.id}><span>{share.expiresAt ? `到期：${formatRecordTime(share.expiresAt)}` : '永久有效'}</span><button className="button detail-button danger-button" type="button" onClick={() => revokeShare(share.id)}>撤銷</button></li>)}</ul> : null}
        </section>
      </div>
      <section className="history-panel"><h3>既有會議</h3>{meetings.length === 0 ? <p className="history-empty">尚無會議。</p> : <ul className="history-list">{meetings.map((meeting) => <li className="history-item" key={meeting.id}><strong>{meeting.name || meeting.id}</strong><span>{meetingStatusLabel(meeting.status)}</span><button className="button detail-button" type="button" onClick={() => selectMeeting(meeting.id)}>編輯</button></li>)}</ul>}</section>
    </section>
  );
}

function MeetingPanel({ titleId, records, selectedMeetingId, selectedDetail, onViewDetails, detailError = '', onRetryDetail, loadError = '', isLoading = false, onRetryLoad }) {
  return (
    <section className="history-panel meeting-panel" aria-labelledby={titleId}>
      <div className="history-header">
        <div>
          <h3 id={titleId}>翻譯紀錄</h3>
          <p className="history-description">查看已儲存翻譯的分段時間軸、原文與翻譯內容。</p>
        </div>
      </div>

      {isLoading ? <p className="history-empty">正在載入長會議紀錄…</p> : null}
      {loadError ? <p className="error-message" role="alert">{loadError} <button className="inline-retry" type="button" onClick={onRetryLoad}>重試</button></p> : null}

      {records.length === 0 ? (
        <p className="history-empty">尚無翻譯紀錄。</p>
      ) : (
        <ol className="history-list">
          {records.map((record) => (
            <li className="history-item meeting-item" key={record.id}>
              <article aria-label={`${meetingTitle(record)} ${meetingStatusLabel(record.status)}會議`}>
                <div className="history-item-header">
                  <div>
                    <h3>{meetingTitle(record)}</h3>
                    <span className={`history-status history-status-${record.status}`}>{meetingStatusLabel(record.status)}</span>
                  </div>
                  <div className="history-actions">
                    <button
                      className="button detail-button"
                      type="button"
                      aria-expanded={selectedMeetingId === record.id}
                      onClick={() => onViewDetails(record.id)}
                    >
                      {selectedMeetingId === record.id ? '關閉會議詳細資料' : '查看會議詳細資料'}
                    </button>
                  </div>
                </div>

                <dl className="history-metadata">
                  <div><dt>開始時間</dt><dd>{formatRecordTime(record.startedAt)}</dd></div>
                  <div><dt>結束時間</dt><dd>{formatRecordTime(record.endedAt)}</dd></div>
                  <div><dt>持續時間</dt><dd>{formatDuration(record.durationMs)}</dd></div>
                  <div><dt>段落</dt><dd>{meetingSegmentSummaryLabel(record.segmentSummary)}</dd></div>
                  <div><dt>逐字稿</dt><dd>{transcriptSummaryLabel(record.transcriptSummary)}</dd></div>
                  <div><dt>異常段落</dt><dd>{meetingExceptionSummaryLabel(record.segmentSummary)}</dd></div>
                </dl>
              </article>
              {selectedMeetingId === record.id ? <MeetingDetail detail={selectedDetail} detailError={detailError} onRetryDetail={onRetryDetail} /> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MeetingDetail({ detail, detailError = '', onRetryDetail }) {
  const [meetingExportFormat, setMeetingExportFormat] = useState('txt');
  const [meetingExportStream, setMeetingExportStream] = useState('translation');
  const [meetingExportError, setMeetingExportError] = useState('');
  const [readingTab, setReadingTab] = useState('translationArticle');

  const meetingId = detail?.meeting?.id;
  const transcriptItems = useMemo(
    () => Array.isArray(detail?.transcriptItems) ? detail.transcriptItems : [],
    [detail?.transcriptItems]
  );
  const timeline = useMemo(
    () => Array.isArray(detail?.timeline) ? detail.timeline : [],
    [detail?.timeline]
  );
  const readingContent = useMemo(() => meetingReadingContent(detail), [detail]);

  useEffect(() => {
    setMeetingExportFormat('txt');
    setMeetingExportStream('translation');
    setMeetingExportError('');
    setReadingTab('translationArticle');
  }, [meetingId]);

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
  const canDownloadMeetingTranscript = canExportTranscript(transcriptItems, {
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

      <dl className="session-detail-metadata meeting-detail-metadata">
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

      <section className="meeting-timeline" aria-label="會議段落時間軸">
        <h4>段落時間軸</h4>
        {timeline.length === 0 ? (
          <p className="history-empty">尚無段落資料。</p>
        ) : (
          <ol>
            {timeline.map((segment) => (
              <li key={segment.id}>
                <div className="meeting-timeline-marker" aria-hidden="true" />
                <div>
                  <strong>{`段落 ${segment.sequence + 1}`}</strong>
                  <span className={`history-status history-status-${segment.status}`}>{meetingSegmentStatusLabel(segment.status)}</span>
                  <p>{formatRecordTime(segment.startedAt)} · {formatDuration(segment.durationMs)}</p>
                  {segment.errorInfo?.reason ? <p className="history-reason">原因：{segment.errorInfo.reason}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <MeetingSegmentTranscriptList segments={timeline} transcriptItems={transcriptItems} />

      <ReadingContentTabs
        content={readingContent}
        selectedTab={readingTab}
        onSelectTab={setReadingTab}
      />

      <section className="saved-export-panel" aria-label="整場會議逐字稿匯出">
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
        <p className="export-note">整場字幕依段落與時間順序輸出；中斷或失敗段落已保存的內容仍會保留。</p>
        {exportUnavailableReason ? <p className="export-note">{exportUnavailableReason}</p> : null}
        {meetingExportError ? <p className="error-message">{meetingExportError}</p> : null}
      </section>
    </section>
  );
}

function MeetingSegmentTranscriptList({ segments = [], transcriptItems = [] }) {
  const transcriptItemsBySegment = useMemo(
    () => groupTranscriptItemsBySegment(transcriptItems),
    [transcriptItems]
  );

  return (
    <section className="meeting-segment-content" aria-label="會議段落內容">
      <h4>段落內容</h4>
      {segments.length === 0 ? (
        <p className="history-empty">尚無段落內容。</p>
      ) : (
        <ol>
          {segments.map((segment) => {
            const items = transcriptItemsBySegment.get(segment.id) || [];
            const sourceItems = finalTranscriptItemsForStream(items, 'source');
            const translationItems = finalTranscriptItemsForStream(items, 'translation');
            return (
              <li key={segment.id}>
                <div className="meeting-segment-content-header">
                  <strong>{`段落 ${segment.sequence + 1}`}</strong>
                  <span className={`history-status history-status-${segment.status}`}>{meetingSegmentStatusLabel(segment.status)}</span>
                </div>
                <div className="meeting-segment-streams">
                  <section aria-label={`段落 ${segment.sequence + 1} 原文`}>
                    <h5>原文</h5>
                    {sourceItems.length === 0 ? (
                      <p className="history-empty">此段尚無原文。</p>
                    ) : (
                      sourceItems.map((item) => <p key={item.id}>{toTraditionalChineseText(item.text)}</p>)
                    )}
                  </section>
                  <section aria-label={`段落 ${segment.sequence + 1} 翻譯`}>
                    <h5>翻譯</h5>
                    {translationItems.length === 0 ? (
                      <p className="history-empty">此段尚無翻譯。</p>
                    ) : (
                      translationItems.map((item) => <p key={item.id}>{item.text}</p>)
                    )}
                  </section>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function groupTranscriptItemsBySegment(transcriptItems = []) {
  const groups = new Map();
  for (const item of transcriptItems) {
    if (!item?.segmentId) {
      continue;
    }
    const items = groups.get(item.segmentId) || [];
    items.push(item);
    groups.set(item.segmentId, items);
  }
  return groups;
}

function RetranslationWorkflow({ titleId, records, selectedSessionId, onSelectSession }) {
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [providers, setProviders] = useState([]);
  const [providerError, setProviderError] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [providerKey, setProviderKey] = useState('');
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [trackedRetranslations, setTrackedRetranslations] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetryingExecutionId, setIsRetryingExecutionId] = useState('');
  const [copiedOutputId, setCopiedOutputId] = useState('');
  const [copiedRetranslationSource, setCopiedRetranslationSource] = useState(false);
  const [retranslationExportFormat, setRetranslationExportFormat] = useState('txt');
  const [retranslationExportStream, setRetranslationExportStream] = useState('translation');
  const [statusMessage, setStatusMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const detailRequestIdRef = useRef(0);
  const sessionReadApiClientRef = useRef(createSessionReadApiClient());
  const sessionRetranslationApiClientRef = useRef(createSessionRetranslationApiClient());
  const translationCommandApiClientRef = useRef(createTranslationCommandApiClient());

  useEffect(() => {
    let cancelled = false;
    sessionRetranslationApiClientRef.current.listProviders()
      .then((nextProviders) => {
        if (cancelled) return;
        setProviders(nextProviders);
        setProviderKey((current) => current || nextProviders[0]?.key || '');
        setProviderError('');
      })
      .catch(() => {
        if (!cancelled) setProviderError('無法載入可用的翻譯提供者。');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setDetail(null);
    setDetailError('');
    setSelectedOutputId('');
    setTrackedRetranslations([]);
    setCopiedOutputId('');
    setCopiedRetranslationSource(false);
    setRetranslationExportFormat('txt');
    setRetranslationExportStream('translation');
    setStatusMessage('');
    setOperationError('');

    if (!selectedSessionId) {
      setIsLoadingDetail(false);
      return undefined;
    }

    let cancelled = false;
    void loadSelectedSessionDetail({ cancelled: () => cancelled });
    return () => { cancelled = true; };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    return subscribeToExecutionEvents({
      sessionId: selectedSessionId,
      refetch: () => loadSelectedSessionDetail(),
      poll: () => loadSelectedSessionDetail(),
      onSnapshot: ({ execution }) => setDetail((current) => replaceHistoryExecution(current, execution))
    });
  }, [selectedSessionId]);

  const translationHistory = compactTranslationHistoryForDetail(detail);
  const retranslationProgress = retranslationProgressFor(translationHistory, trackedRetranslations);
  const selectedOutput = selectedOutputId
    ? selectedOutputFor({ translationHistory: { outputs: retranslationProgress.outputs } }, selectedOutputId)
    : null;
  const hasPendingProgress = hasPendingRetranslationItems(retranslationProgress);

  useEffect(() => {
    if (!selectedSessionId || !hasPendingProgress) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void loadSelectedSessionDetail();
    }, HISTORY_REFRESH_MS);

    return () => window.clearTimeout(timer);
  }, [selectedSessionId, hasPendingProgress, detail?.translationHistory]);

  async function loadSelectedSessionDetail({ cancelled = () => false } = {}) {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setIsLoadingDetail(true);

    try {
      const [nextDetail, nextTranslations] = await Promise.all([
        sessionReadApiClientRef.current.getSessionDetail(selectedSessionId),
        sessionReadApiClientRef.current.getSessionTranslations(selectedSessionId).catch(() => null)
      ]);
      if (cancelled() || detailRequestIdRef.current !== requestId) return false;
      setDetail(mergeRetranslationHistoryIntoDetail(nextDetail, nextTranslations));
      setDetailError(nextDetail ? '' : '找不到此工作階段。');
      return Boolean(nextDetail);
    } catch {
      if (cancelled() || detailRequestIdRef.current !== requestId) return false;
      setDetail(null);
      setDetailError('無法載入重新翻譯工作階段。');
      return false;
    } finally {
      if (!cancelled() && detailRequestIdRef.current === requestId) {
        setIsLoadingDetail(false);
      }
    }
  }

  async function submitRetranslation() {
    setIsSubmitting(true);
    setStatusMessage('');
    setOperationError('');

    try {
      const command = {
        targetLanguageCode,
        ...(providerKey ? { providerKey } : {})
      };
      const result = await sessionRetranslationApiClientRef.current.submit(selectedSessionId, command);
      setTrackedRetranslations((current) => upsertTrackedRetranslation(current, trackedRetranslationForSubmitResult(result, targetLanguageCode)));
      setStatusMessage(`已將${targetLanguageLabelFor(targetLanguageCode)}重新翻譯加入佇列。`);
      await loadSelectedSessionDetail();
    } catch {
      setOperationError('無法將重新翻譯加入佇列。請確認此 Session 有原始逐字稿後再試一次。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function retryExecution(execution) {
    const executionId = execution?.id;
    if (!executionId) return;
    setIsRetryingExecutionId(executionId);
    setStatusMessage('');
    setOperationError('');

    try {
      const result = await translationCommandApiClientRef.current.retryFailedTranslationExecution(executionId);
      setTrackedRetranslations((current) => upsertTrackedRetranslation(current, {
        requestId: result.requestId || result.translationRequestId || execution.requestId,
        executionId: result.id,
        targetLanguageCode: execution.targetLanguageCode
      }));
      setStatusMessage('已重新加入佇列。');
      await loadSelectedSessionDetail();
    } catch {
      setOperationError('無法重試此重新翻譯工作。');
    } finally {
      setIsRetryingExecutionId('');
    }
  }

  async function deleteRetranslationOutput(output) {
    const outputId = output?.id;
    if (!selectedSessionId || !outputId) return;
    if (!window.confirm('確定要刪除此重新翻譯結果？')) {
      return;
    }

    setStatusMessage('');
    setOperationError('');

    try {
      await sessionReadApiClientRef.current.deleteSessionTranslationOutput(selectedSessionId, outputId);
      const nextOutputs = retranslationProgress.outputs.filter((item) => item.id !== outputId);
      setDetail((current) => removeRetranslationOutputFromDetail(current, outputId));
      setStatusMessage('重新翻譯結果已刪除。');

      if (selectedOutputId === outputId) {
        setSelectedOutputId(nextOutputs[0]?.id || '');
      }
    } catch {
      setOperationError('無法刪除此重新翻譯結果。');
    }
  }

  function exportSelectedRetranslation() {
    setOperationError('');

    try {
      const content = exportApplicationService.exportTranscript({
        items: retranslationExportItems,
        options: {
          format: retranslationExportFormat,
          stream: retranslationExportStream,
          timeOrigin: detail?.session?.startedAt
        }
      });
      downloadTextFile(
        content,
        buildRetranslationOutputFileName(selectedSessionId, selectedOutput, {
          format: retranslationExportFormat,
          stream: retranslationExportStream
        }),
        contentTypeForFormat(retranslationExportFormat)
      );
    } catch {
      setOperationError('所選選項無法匯出重翻逐字稿。');
    }
  }

  async function copySelectedRetranslation() {
    const articleText = formattedSelectedRetranslationText(selectedOutput);
    if (!articleText) return;
    try {
      await navigator.clipboard.writeText(articleText);
      setCopiedOutputId(selectedOutput.id);
      window.setTimeout(() => setCopiedOutputId((current) => current === selectedOutput.id ? '' : current), 1500);
    } catch {
      setOperationError('無法複製重翻逐字稿。');
    }
  }

  async function copyRetranslationSource() {
    const articleText = sourceContent.text || sourceContent.paragraphs.join('\n\n');
    if (!articleText) return;
    try {
      await navigator.clipboard.writeText(articleText);
      setCopiedRetranslationSource(true);
      window.setTimeout(() => setCopiedRetranslationSource(false), 1500);
    } catch {
      setOperationError('無法複製原始逐字稿。');
    }
  }

  function exportRetranslationSourceTxt() {
    const articleText = sourceContent.text || sourceContent.paragraphs.join('\n\n');
    if (!articleText) return;
    downloadTextFile(
      `${articleText}\n`,
      buildRetranslationOutputFileName(selectedSessionId, selectedOutput, { format: 'txt', stream: 'source' }),
      'text/plain;charset=utf-8'
    );
  }

  function exportSelectedRetranslationTxt() {
    const articleText = formattedSelectedRetranslationText(selectedOutput);
    if (!articleText) return;
    downloadTextFile(
      `${articleText}\n`,
      buildRetranslationOutputFileName(selectedSessionId, selectedOutput, { format: 'txt', stream: 'translation' }),
      'text/plain;charset=utf-8'
    );
  }

  const selectableRecords = retranslationSourceRecords(records);
  const filteredRecords = selectableRecords.filter((record) => retranslationRecordMatches(record, query));
  const sourceContent = sourceContentForRetranslationDetail(detail);
  const sourceLanguage = sourceLanguageLabelForDetail(detail);
  const articleParagraphs = paragraphsForArticleText(selectedOutput?.translatedText || '');
  const retranslationExportItems = retranslationExportItemsForDetail(detail, selectedOutput);
  const canDownloadRetranslationExport = canExportTranscript(retranslationExportItems, {
    format: retranslationExportFormat,
    stream: retranslationExportStream,
    timeOrigin: detail?.session?.startedAt
  });
  const retranslationExportUnavailableReason = selectedOutput
    ? retranslationExportReason({
        canExport: canDownloadRetranslationExport,
        format: retranslationExportFormat,
        stream: retranslationExportStream
      })
    : '';
  const selectedProvider = providers.find((provider) => provider.key === providerKey) || providers[0] || null;
  const canSubmit = Boolean(selectedSessionId && detail && sourceContent.paragraphs.length > 0 && targetLanguageCode && providerKey && !isSubmitting);
  const hasCompletedOutputs = retranslationProgress.outputs.length > 0;
  const shouldShowRetranslationContent = !hasCompletedOutputs || Boolean(selectedOutput);

  return (
    <section className="retranslation-workflow" aria-labelledby={titleId}>
      <div className="history-header">
        <div>
          <h2 id={titleId}>重新翻譯</h2>
          <p className="history-description">從已保存 Session 的原始逐字稿產生新的文章式翻譯。</p>
        </div>
        {selectedSessionId ? <a className="button detail-button" href="#retranslate">返回 Session 清單</a> : null}
      </div>

      {!selectedSessionId ? (
        <section className="history-panel" aria-label="選擇歷史紀錄">
          <div className="controls retranslation-picker-controls">
            <label className="field">
              <span>搜尋翻譯紀錄</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋日期、語言或狀態" />
            </label>
          </div>
          {selectableRecords.length === 0 ? <div className="empty-state"><p className="history-empty">尚無可重新翻譯的原始逐字稿。先完成一次即時翻譯，再回到這裡選擇目標語言。</p><a className="button primary" href="#live">開始即時翻譯</a></div> : null}
          {selectableRecords.length > 0 && filteredRecords.length === 0 ? <p className="history-empty">找不到符合條件的 Session。</p> : null}
          {filteredRecords.length > 0 ? (
            <AgGridReact
              {...dataGridProps('retranslation-session-data-grid')}
              aria-label="重新翻譯 Session 列表"
              columnDefs={[
                { headerName: '名稱', valueGetter: ({ data }) => data.name || historyLanguageLabel(data), width: 220, cellRenderer: RetranslationSessionNameCell },
                { headerName: '狀態', field: 'status', width: 100, cellRenderer: RetranslationSessionStatusCell },
                { headerName: '開始時間', field: 'startedAt', width: 150, cellRenderer: ({ data }) => formatRecordTime(data.startedAt) },
                { headerName: '結束時間', field: 'endedAt', width: 150, cellRenderer: ({ data }) => formatRecordTime(data.endedAt) },
                { headerName: '逐字稿', valueGetter: ({ data }) => transcriptSummaryLabel(data.transcriptSummary), minWidth: 210, flex: 1 },
                { headerName: '操作', width: 300, sortable: false, cellRenderer: RetranslationSessionActionCell }
              ]}
              context={{ onSelectSession }}
              rowData={filteredRecords}
              getRowId={({ data }) => data.id}
            />
          ) : null}
        </section>
      ) : (
        <>
          <section className="control-panel retranslation-control-panel" aria-label="重新翻譯控制項">
            <div className="title-block">
              <div className="status-pill">
                <RefreshCw size={16} aria-hidden="true" />
                {hasPendingProgress ? '處理中' : selectedOutput ? '已完成' : '準備重新翻譯'}
              </div>
            </div>
            <div className="controls retranslation-controls">
              <label className="field">
                <span>目標語言</span>
                <select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)} disabled={isSubmitting}>
                  {SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
                </select>
              </label>
              <div className="field retranslation-provider-readonly" aria-label="使用模型">
                <span>使用模型</span>
                <strong>{selectedProvider ? translationProviderOptionLabel(selectedProvider) : '正在載入可用模型…'}</strong>
              </div>
              <button className="button primary" type="button" onClick={submitRetranslation} disabled={!canSubmit}>
                <RefreshCw size={18} aria-hidden="true" />
                {isSubmitting ? '正在送出…' : '開始重新翻譯'}
              </button>
            </div>
            {providerError ? <p className="error-message" role="alert">{providerError}</p> : null}
            {operationError ? <p className="error-message" role="alert">{operationError}</p> : null}
            {statusMessage ? <p className="success-message" role="status">{statusMessage}</p> : null}
          </section>

          {detail && selectedOutput ? (
            <section className="control-panel retranslation-export-panel" aria-label="重新翻譯匯出">
              <div className="controls export-controls retranslation-export-actions">
                <label className="field">
                  <span>匯出格式</span>
                  <select value={retranslationExportFormat} onChange={(event) => setRetranslationExportFormat(event.target.value)}>
                    <option value="txt">TXT</option>
                    <option value="srt">SRT</option>
                    <option value="vtt">VTT</option>
                  </select>
                </label>
                <label className="field">
                  <span>匯出內容</span>
                  <select value={retranslationExportStream} onChange={(event) => setRetranslationExportStream(event.target.value)}>
                    <option value="translation">翻譯</option>
                    <option value="source">原文</option>
                    <option value="both">兩者</option>
                  </select>
                </label>
                <button className="button detail-button" type="button" onClick={exportSelectedRetranslation} disabled={!canDownloadRetranslationExport}>
                  <Download size={16} aria-hidden="true" />
                  下載
                </button>
              </div>
              {retranslationExportUnavailableReason ? <p className="export-note">{retranslationExportUnavailableReason}</p> : null}
            </section>
          ) : null}

          {isLoadingDetail ? <p className="history-empty retranslation-loading">正在載入 Session 原始逐字稿…</p> : null}
          {detailError ? <p className="error-message" role="alert">{detailError}</p> : null}

          {detail ? (
            <>
              <RetranslationProgress progress={{ ...retranslationProgress, outputs: [] }} onRetry={retryExecution} retryingExecutionId={isRetryingExecutionId} />
              <section className="retranslation-result-workspace" aria-label="重新翻譯結果與內容">
                <RetranslationOutputList
                  outputs={retranslationProgress.outputs}
                  selectedOutputId={selectedOutput?.id || ''}
                  onSelect={setSelectedOutputId}
                  onDelete={deleteRetranslationOutput}
                />
                {!shouldShowRetranslationContent ? (
                  <section className="history-panel retranslation-selection-panel" aria-label="重新翻譯內容選取">
                    <p className="history-empty">選取一筆重新翻譯結果後查看原文與翻譯文。</p>
                  </section>
                ) : (
                  <section className="retranslation-reading-column" aria-label="重新翻譯閱讀區">
                    <article className="transcript-panel" aria-label="原始逐字稿">
                      <div className="article-panel-header">
                        <h2>原始逐字稿</h2>
                        <div className="article-actions">
                          <button className="button detail-button" type="button" onClick={copyRetranslationSource} disabled={!sourceContent.text}>
                            <Copy size={16} aria-hidden="true" />
                            {copiedRetranslationSource ? '已複製' : '複製'}
                          </button>
                          <button className="button detail-button" type="button" onClick={exportRetranslationSourceTxt} disabled={!sourceContent.text}>
                            <Download size={16} aria-hidden="true" />
                            匯出 TXT
                          </button>
                        </div>
                      </div>
                      <dl className="session-detail-metadata retranslation-source-metadata">
                        <div><dt>日期</dt><dd>{formatRecordTime(detail.session?.startedAt)}</dd></div>
                        <div><dt>來源語言</dt><dd>{sourceLanguage}</dd></div>
                        <div><dt>Session</dt><dd>{detail.session?.id || selectedSessionId}</dd></div>
                      </dl>
                      {sourceContent.paragraphs.length > 0 ? (
                        <div className="article-content">
                          {sourceContent.paragraphs.map((paragraph, index) => <p key={`source-${index}`}>{paragraph}</p>)}
                        </div>
                      ) : <p className="transcript-text empty">{readingContentEmptyText(sourceContent)}</p>}
                    </article>

                    <article className="transcript-panel" aria-label="重翻逐字稿">
                      <div className="article-panel-header">
                        <h2>重翻逐字稿</h2>
                        <div className="article-actions">
                          <button className="button detail-button" type="button" onClick={copySelectedRetranslation} disabled={!selectedOutput?.translatedText}>
                            <Copy size={16} aria-hidden="true" />
                            {copiedOutputId === selectedOutput?.id ? '已複製' : '複製'}
                          </button>
                          <button className="button detail-button" type="button" onClick={exportSelectedRetranslationTxt} disabled={!selectedOutput?.translatedText}>
                            <Download size={16} aria-hidden="true" />
                            匯出 TXT
                          </button>
                        </div>
                      </div>
                      {articleParagraphs.length > 0 ? (
                        <div className="article-content" aria-label="重翻逐字稿內容">
                          {articleParagraphs.map((paragraph, index) => <p key={`output-${selectedOutput.id}-${index}`}>{paragraph}</p>)}
                        </div>
                      ) : (
                        <p className="transcript-text empty">{hasPendingProgress ? '重新翻譯正在處理中，完成後會顯示重翻逐字稿。' : '尚無重翻逐字稿。'}</p>
                      )}
                    </article>
                  </section>
                )}
              </section>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function RetranslationOutputList({ outputs, selectedOutputId, onSelect, onDelete }) {
  return (
    <section className="history-panel retranslation-output-list-panel" aria-label="重新翻譯結果">
      <h3>{`重新翻譯結果（${outputs.length}）`}</h3>
      {outputs.length === 0 ? (
        <p className="history-empty retranslation-output-empty">尚無重新翻譯結果。</p>
      ) : (
        <AgGridReact
          {...dataGridProps('retranslation-output-data-grid')}
          aria-label="重新翻譯結果列表"
          columnDefs={[
            { headerName: '結果', valueGetter: ({ data }) => translationOutputTitle(data), width: 220, cellRenderer: RetranslationOutputTitleCell },
            { headerName: '狀態', valueGetter: () => '已完成', width: 100, cellRenderer: RetranslationOutputStatusCell },
            { headerName: '目標語言', valueGetter: ({ data }) => targetLanguageLabelFor(data.targetLanguageCode) || data.targetLanguageCode || '', width: 130 },
            { headerName: '完成時間', field: 'completedAt', width: 150, cellRenderer: ({ data }) => formatRecordTime(data.completedAt) },
            { headerName: '輸出', valueGetter: ({ data }) => data.translatedText ? '可閱讀' : '沒有內容', width: 120 },
            { headerName: '操作', width: 280, sortable: false, cellRenderer: RetranslationOutputActionsCell }
          ]}
          context={{ onSelect, onDelete, selectedOutputId }}
          rowData={outputs}
          getRowId={({ data }) => data.id}
        />
      )}
    </section>
  );
}

function LiveGlossaryDrawer({
  open,
  entries,
  targetLanguageCode,
  selectedEntryIds,
  disabled,
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
  const apiClientRef = useRef(createGlossaryApiClient());

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError('');
    void apiClientRef.current.listEntries()
      .then((loadedEntries) => {
        if (!cancelled) onEntriesChange(loadedEntries);
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
      onEntriesChange(mergeGlossaryEntry(entries, entry));
      onSelectionChange((current) => [...new Set([...current, entry.id])]);
      setStatus('詞條已新增並套用。');
      resetQuickAdd();
    } catch {
      setError('無法新增詞條。請確認原文與翻譯皆已填寫。');
    } finally {
      setIsSaving(false);
    }
  }

  const targetEntries = liveGlossaryEntriesForTarget(entries, targetLanguageCode);
  const canSave = source.trim().length > 0 && translation.trim().length > 0 && !isSaving && !disabled;

  return (
    <>
      <div className={`glossary-drawer-backdrop${open ? ' is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`glossary-drawer${open ? ' is-open' : ''}`} aria-label="本次翻譯字典" aria-hidden={!open}>
        <div className="glossary-drawer-header">
          <div>
            <p className="eyebrow">即時翻譯</p>
            <h2>本次使用字典</h2>
            <p>選取的詞條會套用到本次翻譯與後續分段。</p>
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
            <div className="glossary-drawer-list">
              {targetEntries.map((entry) => (
                <label className={`glossary-choice${selectedEntryIds.includes(entry.id) ? ' is-selected' : ''}`} key={entry.id}>
                  <input
                    type="checkbox"
                    checked={selectedEntryIds.includes(entry.id)}
                    onChange={(event) => onSelectionChange((current) => event.target.checked
                      ? [...new Set([...current, entry.id])]
                      : current.filter((id) => id !== entry.id))}
                    disabled={disabled}
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

          <div className="glossary-quick-add">
            <h3>快速新增詞條</h3>
            <label className="field">
              <span>原文</span>
              <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如：產品名稱" disabled={disabled || isSaving} tabIndex={open ? 0 : -1} />
            </label>
            <label className="field">
              <span>翻譯（{targetLanguageLabelFor(targetLanguageCode) || targetLanguageCode}）</span>
              <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="例如：正式翻譯" disabled={disabled || isSaving} tabIndex={open ? 0 : -1} />
            </label>
            <button className="button primary" type="button" onClick={saveQuickEntry} disabled={!canSave} tabIndex={open ? 0 : -1}>
              {isSaving ? '儲存中…' : '新增並套用'}
            </button>
            {status ? <p className="success-message" role="status">{status}</p> : null}
          </div>
        </div>

        <div className="glossary-drawer-footer">
          <button className="button secondary" type="button" onClick={onOpenManager} tabIndex={open ? 0 : -1}>前往完整字典管理</button>
        </div>
      </aside>
    </>
  );
}

function GlossaryPanel({ titleId, entries: sharedEntries = [], onEntriesChange }) {
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
    <section className="glossary-panel" aria-labelledby={titleId || undefined} aria-label={titleId ? undefined : '翻譯字典'}>
      <div className="glossary-header">
        <div>
          <h2 id={titleId}>翻譯字典</h2>
          <p className="history-description">管理即時翻譯與歷史重新翻譯字幕使用的全域替換規則。</p>
        </div>
      </div>
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
            <option value="live">即時翻譯</option>
            <option value="history">歷史重新翻譯</option>
            <option value="both">兩者</option>
          </select>
        </label>
        <button className="button detail-button" type="button" disabled={!canSave} onClick={saveEntry}>
          {isSaving ? '儲存中…' : editingEntry ? '更新詞條' : '新增詞條'}
        </button>
        {editingEntry ? <button className="button detail-button" type="button" onClick={resetForm}>取消編輯</button> : null}
      </div>
      {error ? <p className="error-message glossary-form-message" role="alert">{error}</p> : null}
      {!canSave && !isSaving && !editingEntry ? <p className="form-hint">請填寫詞條與替換內容後，才能新增。</p> : null}
      {status ? <p className="success-message" role="status">{status}</p> : null}
      {isLoading ? <p className="history-empty">正在載入字典…</p> : null}
      {!isLoading && entries.length === 0 ? <div className="empty-state"><p className="history-empty">尚無字典詞條。</p><p className="history-empty">新增常用名稱或專有名詞後，翻譯會更一致。</p></div> : null}
      {entries.length > 0 ? (
        <AgGridReact
          {...dataGridProps('glossary-data-grid')}
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
      ) : null}
    </section>
  );
}

function SessionDetail({ detail, historyRecord, onRetranslationSubmitted, onOpenRetranslationWorkflow, onPolishingRetry, onRetryExecution, retryingExecutionId = '', detailError = '', onRetryDetail }) {
  const [savedExportFormat, setSavedExportFormat] = useState('txt');
  const [savedExportStream, setSavedExportStream] = useState('translation');
  const [savedExportError, setSavedExportError] = useState('');
  const [readingTab, setReadingTab] = useState('translationArticle');
  const [trackedRetranslations, setTrackedRetranslations] = useState([]);
  const [executionEventsStatus, setExecutionEventsStatus] = useState('closed');
  const sessionRecordId = detail?.session?.id;
  const onRetranslationSubmittedRef = useRef(onRetranslationSubmitted);
  onRetranslationSubmittedRef.current = onRetranslationSubmitted;

  useEffect(() => {
    setSavedExportFormat('txt');
    setSavedExportStream('translation');
    setSavedExportError('');
    setReadingTab('translationArticle');
    setTrackedRetranslations([]);
  }, [sessionRecordId]);

  useEffect(() => {
    if (!sessionRecordId) return undefined;
    return subscribeToExecutionEvents({
      sessionId: sessionRecordId,
      refetch: () => onRetranslationSubmittedRef.current?.(sessionRecordId),
      poll: () => onRetranslationSubmittedRef.current?.(sessionRecordId),
      onStatus: setExecutionEventsStatus,
      onSnapshot: () => onRetranslationSubmittedRef.current?.(sessionRecordId)
    });
  }, [sessionRecordId]);


  const translationHistory = useMemo(() => compactTranslationHistoryForDetail(detail), [detail]);
  const retryLineages = useMemo(() => retryLineagesForExecutions(translationHistory.executions), [translationHistory.executions]);
  const retranslationProgress = retranslationProgressFor(translationHistory, trackedRetranslations);
  const hasPendingRetranslationProgress = hasPendingRetranslationItems(retranslationProgress);
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

  useEffect(() => {
    if (!sessionRecordId || !hasPendingRetranslationProgress) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void onRetranslationSubmitted?.(sessionRecordId);
    }, HISTORY_REFRESH_MS);

    return () => window.clearTimeout(timer);
  }, [sessionRecordId, hasPendingRetranslationProgress, onRetranslationSubmitted]);

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

  const retranslationSourceSessionId = sourceSessionIdForRetranslation(sessionRecord, sessionRecordId);
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
        {executionEventsStatus === 'reconnecting' || executionEventsStatus === 'polling' ? (
          <span className="history-status history-status-running">狀態同步恢復中</span>
        ) : null}
      </div>

      <dl className="session-detail-metadata">
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
        {sessionRecord.recordKind === 'retranslation' ? (
          <div>
            <dt>來源</dt>
            <dd>{retranslationSourceLabel(sessionRecord.retranslatedFrom)}</dd>
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
        />
      )}
      <section className="saved-export-panel" aria-label="重新翻譯">
        <button className="button primary detail-button" type="button" aria-label="以此原文重新翻譯" onClick={() => onOpenRetranslationWorkflow?.(retranslationSourceSessionId)} disabled={!retranslationSourceSessionId}>用這份原文重新翻譯</button>
        <RetranslationProgress
          progress={retranslationProgress}
          lineages={retryLineages}
          onRetry={onRetryExecution}
          retryingExecutionId={retryingExecutionId}
        />
      </section>

      <section className="saved-export-panel" aria-label="已儲存逐字稿匯出">
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

function SessionSharePanel({ sessionId }) {
  const clientRef = useRef(createSessionShareApiClient());
  const [shares, setShares] = useState([]);
  const [createdShare, setCreatedShare] = useState(null);
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    setCreatedShare(null);
    setQrDataUrl('');
    if (!sessionId) return undefined;
    clientRef.current.list(sessionId).then((result) => {
      if (!cancelled) setShares(result);
    }).catch(() => { if (!cancelled) setError('無法載入分享資訊。'); });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!createdShare?.url) return undefined;
    const shareUrl = createdShare.share?.role === 'recorder' ? createdShare.recorderUrl : createdShare.url;
    const absoluteUrl = new URL(shareUrl || createdShare.url, window.location.href).href;
    QRCode.toDataURL(absoluteUrl, { width: 180, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(''));
    return undefined;
  }, [createdShare]);

  async function createShare(role = 'viewer') {
    setError('');
    try {
      const expiresAt = expiry ? Date.now() + Number(expiry) : null;
      const result = await clientRef.current.create(sessionId, expiresAt, role);
      setCreatedShare(result);
      setShares((current) => [...current, result.share]);
    } catch {
      setError('無法建立分享連結。');
    }
  }

  async function revokeShare(shareId) {
    try {
      await clientRef.current.revoke(sessionId, shareId);
      setShares((current) => current.filter((share) => share.id !== shareId));
      if (createdShare?.share?.id === shareId) setCreatedShare(null);
    } catch {
      setError('無法撤銷分享連結。');
    }
  }

  function copy(value) {
    if (value && navigator.clipboard) void navigator.clipboard.writeText(new URL(value, window.location.href).href);
  }

  if (!sessionId) return null;
  return (
    <section className="saved-export-panel session-share-panel" aria-label="分享工作階段">
      <h4>分享唯讀觀看頁</h4>
      <div className="controls saved-export-controls">
        <label className="field"><span>有效期限</span><select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
          <option value="">永久</option><option value="3600000">1 小時</option><option value="86400000">24 小時</option><option value="604800000">7 天</option>
        </select></label>
        <button className="button detail-button" type="button" onClick={() => createShare('viewer')}>建立觀看連結</button>
        <button className="button detail-button" type="button" onClick={() => createShare('recorder')}>建立錄音連結</button>
      </div>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {createdShare ? (
        <div className="share-created">
          {qrDataUrl ? <img src={qrDataUrl} alt="分享連結 QR Code" width="180" height="180" /> : null}
          <p><strong>{createdShare.share.role === 'recorder' ? '錄音連結' : '觀看連結'}</strong> · <strong>短碼：</strong><code>{createdShare.share.shortCode}</code></p>
          <p className="share-url"><a href={createdShare.url}>{createdShare.url}</a> <button className="button detail-button" type="button" onClick={() => copy(createdShare.url)}><Copy size={15} aria-hidden="true" />複製</button></p>
          {createdShare.recorderUrl ? <p className="share-url"><a href={createdShare.recorderUrl}>{createdShare.recorderUrl}</a> <button className="button detail-button" type="button" onClick={() => copy(createdShare.recorderUrl)}><Copy size={15} aria-hidden="true" />複製錄音連結</button></p> : null}
          <p className="share-url"><a href={createdShare.share.role === 'recorder' ? createdShare.recorderCodeUrl : createdShare.codeUrl}>{createdShare.share.role === 'recorder' ? createdShare.recorderCodeUrl : createdShare.codeUrl}</a> <button className="button detail-button" type="button" onClick={() => copy(createdShare.share.role === 'recorder' ? createdShare.recorderCodeUrl : createdShare.codeUrl)}><Copy size={15} aria-hidden="true" />複製短碼連結</button></p>
        </div>
      ) : null}
      {shares.length > 0 ? <ul className="share-list">{shares.map((share) => <li key={share.id}><span>{share.expiresAt ? `到期：${formatRecordTime(share.expiresAt)}` : '永久有效'}</span><button className="button detail-button danger-button" type="button" onClick={() => revokeShare(share.id)}>撤銷</button></li>)}</ul> : <p className="export-note">重新整理後只顯示仍有效的分享 metadata；既有 plaintext token 不會再次顯示。</p>}
    </section>
  );
}

function AudioArtifactDownloads({
  title,
  audioArtifacts = {},
  inputLabel = '下載原始語音',
  translationLabel = '下載翻譯語音'
}) {
  const inputArtifact = audioArtifacts?.input;
  const translationArtifact = audioArtifacts?.translation;

  return (
    <section className="saved-export-panel" aria-label={title}>
      <h4>{title}</h4>
      <div className="recording-downloads">
        <a
          className={`button detail-button${inputArtifact?.downloadUrl ? '' : ' disabled-link'}`}
          href={inputArtifact?.downloadUrl || '#'}
          download={inputArtifact?.fileName || undefined}
          aria-disabled={!inputArtifact?.downloadUrl}
          onClick={(event) => {
            if (!inputArtifact?.downloadUrl) event.preventDefault();
          }}
        >
          <Download size={16} aria-hidden="true" />
          {inputLabel}
        </a>
        <a
          className={`button detail-button${translationArtifact?.downloadUrl ? '' : ' disabled-link'}`}
          href={translationArtifact?.downloadUrl || '#'}
          download={translationArtifact?.fileName || undefined}
          aria-disabled={!translationArtifact?.downloadUrl}
          onClick={(event) => {
            if (!translationArtifact?.downloadUrl) event.preventDefault();
          }}
        >
          <Download size={16} aria-hidden="true" />
          {translationLabel}
        </a>
      </div>
      {!inputArtifact?.downloadUrl || !translationArtifact?.downloadUrl ? (
        <p className="export-note">只有已成功儲存的語音紀錄可下載。</p>
      ) : null}
    </section>
  );
}

function RetranslationProgress({ progress, lineages = null, onRetry, retryingExecutionId = '' }) {
  const hasTimedProgress = progress.executions.some((execution) => ['queued', 'processing', 'running'].includes(execution.status));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasTimedProgress) {
      return undefined;
    }

    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasTimedProgress]);

  if (progress.outputs.length === 0 && progress.executions.length === 0) {
    return null;
  }

  return (
    <section className="translation-history-summary" aria-label="重新翻譯進度">
      <h4>重新翻譯進度</h4>
      {progress.executions.length > 0 ? (
        lineages ? (
          <div className="retry-lineage-list">
            {lineages.map((lineage, index) => (
              <section className="retry-lineage" key={lineage.requestId || `legacy-lineage-${index}`} aria-label={`重新翻譯 lineage ${lineage.requestId || 'legacy'}`}>
                <div className="retry-lineage-header">
                  <strong>{lineage.requestId ? `Request ${lineage.requestId}` : 'Legacy execution'}</strong>
                  <span>{lineage.executions.length} 次 execution</span>
                </div>
                <ol className="translation-history-list retry-lineage-timeline">
                  {lineage.executions.map((execution) => <RetranslationExecutionItem key={execution.id} execution={execution} nowMs={nowMs} onRetry={onRetry} retryingExecutionId={retryingExecutionId} />)}
                </ol>
              </section>
            ))}
          </div>
        ) : (
          <ol className="translation-history-list">
            {progress.executions.map((execution) => <RetranslationExecutionItem key={execution.id} execution={execution} nowMs={nowMs} onRetry={onRetry} retryingExecutionId={retryingExecutionId} />)}
          </ol>
        )
      ) : null}
      {progress.outputs.length > 0 ? (
        <ol className="translation-history-list">
          {progress.outputs.map((output) => (
            <li key={output.id}>
              <span>{translationOutputTitle(output)}</span>
              <span className="history-status history-status-completed">已完成</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function RetranslationExecutionItem({ execution, nowMs, onRetry, retryingExecutionId }) {
  return (
    <li>
      <span>{targetLanguageLabelFor(execution.targetLanguageCode) || execution.targetLanguageCode || '未知語言'}</span>
      <span className={`history-status history-status-${execution.status}`}>{translationExecutionStatusLabel(execution)}</span>
      <p className="retry-lineage-execution-id">Execution：{execution.id}</p>
      {translationExecutionTimingText(execution, nowMs) ? <p>{translationExecutionTimingText(execution, nowMs)}</p> : null}
      {execution.status === 'failed' ? <p>{translationFailureReasonText(execution.failureInfo)}</p> : null}
      {execution.status === 'failed' && onRetry ? (
        <button className="button detail-button" type="button" onClick={() => onRetry(execution)} disabled={retryingExecutionId === execution.id}>
          {retryingExecutionId === execution.id ? '正在重試…' : '重試'}
        </button>
      ) : null}
    </li>
  );
}

function ReadingContentTabs({ content, selectedTab, onSelectTab }) {
  const selectedContent = selectedTab === 'sourceTranscript'
    ? content.sourceTranscript
    : content.translationArticle;
  const selectedTitle = selectedTab === 'sourceTranscript' ? '原始逐字稿' : '翻譯內容';

  return (
    <section className="session-reading-panel" aria-label="歷史紀錄閱讀內容" data-testid="legacy-transcript-fallback">
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

function sourceContentForRetranslationDetail(detail) {
  const source = detail?.readingContent?.sourceTranscript;
  if (source) {
    return toTraditionalChineseSourceContent(source);
  }

  const sourceItems = finalTranscriptItemsForStream(detail?.sourceTranscript?.items || [], 'source');
  const paragraphs = buildTranscriptArticleParagraphs(sourceItems).map(toTraditionalChineseText);
  return toTraditionalChineseSourceContent({
    kind: 'sourceTranscript',
    status: paragraphs.length > 0 ? 'available' : 'empty',
    text: paragraphs.join('\n\n'),
    paragraphs,
    createdAt: detail?.sourceTranscript?.createdAt ?? detail?.session?.startedAt ?? null,
    finalizedAt: detail?.sourceTranscript?.finalizedAt ?? detail?.session?.endedAt ?? null,
    emptyReason: paragraphs.length > 0 ? null : 'no_content'
  });
}

function sourceLanguageLabelForDetail(detail) {
  const itemLanguageCodes = (detail?.sourceTranscript?.items || [])
    .flatMap((item) => [
      ...(Array.isArray(item?.sourceLanguageDetection?.detectedLanguageCodes) ? item.sourceLanguageDetection.detectedLanguageCodes : []),
      ...(typeof item?.languageCode === 'string' && item.languageCode.trim() ? [item.languageCode] : [])
    ]);
  const uniqueCodes = [...new Set(itemLanguageCodes)];
  if (uniqueCodes.length === 0) return '未標記';
  return uniqueCodes.map((code) => targetLanguageLabelFor(code) || code).join('、');
}

function paragraphsForArticleText(text) {
  return buildTranscriptArticleParagraphs([{
    id: 'article-text',
    stream: 'translation',
    status: 'final',
    text,
    sequence: 0
  }]);
}

function formattedSelectedRetranslationText(output) {
  return paragraphsForArticleText(output?.translatedText || '').join('\n\n');
}

function retranslationExportItemsForDetail(detail, output) {
  if (!detail || !output) {
    return [];
  }

  return [
    ...finalTranscriptItemsForStream(detail?.sourceTranscript?.items || [], 'source'),
    ...translationExportItemsForRetranslationOutput(detail, output)
  ];
}

function translationExportItemsForRetranslationOutput(detail, output) {
  if (Array.isArray(output?.items) && output.items.length > 0) {
    return finalTranscriptItemsForStream(output.items, 'translation');
  }

  const translatedText = formattedSelectedRetranslationText(output);
  if (!translatedText) {
    return [];
  }

  return [{
    id: `${output.id || 'retranslation-output'}:article`,
    stream: 'translation',
    status: 'final',
    text: translatedText,
    sequence: Number.MAX_SAFE_INTEGER,
    startedAt: detail?.session?.startedAt ?? null,
    finalizedAt: output.completedAt ?? detail?.session?.endedAt ?? null
  }];
}

function retranslationExportReason({ canExport, format, stream }) {
  if ((format === 'srt' || format === 'vtt') && stream === 'both') {
    return 'SRT 與 VTT 一次只能匯出一個內容。';
  }

  if (!canExport) {
    return '所選選項無法匯出重翻逐字稿。';
  }

  return '';
}

function retranslationSourceRecords(records = []) {
  return records.filter((record) => (record.recordKind || 'session') === 'session' && TERMINAL_HISTORY_STATUSES.has(record.status));
}

function retranslationRecordMatches(record, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    record.id,
    historyLanguageLabel(record),
    historyStatusLabel(record.status),
    formatRecordTime(record.startedAt),
    formatRecordTime(record.endedAt),
    transcriptSummaryLabel(record.transcriptSummary)
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function translationProviderOptionLabel(provider = {}) {
  if (provider.model) return provider.model;
  const label = provider.label || provider.key || '未知 provider';
  return label;
}

function buildRetranslationOutputFileName(sessionId, output = {}, options = {}) {
  const format = String(options.format || 'txt').replace(/[^a-zA-Z0-9]+/g, '') || 'txt';
  const stream = String(options.stream || 'translation').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const language = String(output.targetLanguageCode || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const version = Number.isFinite(output.version) ? `-v${output.version}` : '';
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return `live-translate-retranslation-${safeSessionId}-${stamp}-${language}-${stream}${version}.${format}`;
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

function mergeGlossaryEntry(entries = [], entry) {
  if (!entry?.id) return entries;
  const withoutEntry = entries.filter((item) => item.id !== entry.id);
  return [...withoutEntry, entry];
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

function selectedMeetingGlossaryEntries(entries, selectedIds, targetLanguageCode) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => selected.has(entry.id))
    .filter((entry) => typeof entry?.source === 'string' && entry.source.trim() !== '')
    .map((entry) => ({
      source: entry.source,
      translations: { ...(entry.translations || {}) },
      replacementAliases: Object.fromEntries(
        Object.entries(entry.replacementAliases || {}).map(([languageCode, aliases]) => [languageCode, [...aliases]])
      )
    }));
}

function glossaryScopeLabel(scope) {
  const labels = {
    live: '套用範圍：即時翻譯',
    history: '套用範圍：歷史重新翻譯',
    both: '套用範圍：兩者'
  };

  return labels[scope] || labels.history;
}

function trackedRetranslationForSubmitResult(result, fallbackTargetLanguageCode) {
  return {
    requestId: result?.request?.id || result?.execution?.requestId || null,
    executionId: result?.execution?.id || null,
    targetLanguageCode: result?.request?.targetLanguageCode || fallbackTargetLanguageCode
  };
}

function upsertTrackedRetranslation(current, next) {
  if (!next.requestId && !next.executionId) {
    return current;
  }

  const matches = (item) => (
    (next.requestId && item.requestId === next.requestId) ||
    (next.executionId && item.executionId === next.executionId)
  );

  return current.some(matches)
    ? current.map((item) => matches(item) ? { ...item, ...next } : item)
    : [...current, next];
}

function transcriptSummaryLabel(summary = {}) {
  const sourceFinalCount = summary.sourceFinalCount || 0;
  const translationFinalCount = summary.translationFinalCount || 0;

  if (!summary.hasTranscript && sourceFinalCount === 0 && translationFinalCount === 0) {
    return '沒有逐字稿';
  }

  return `原文完成：${sourceFinalCount} · 翻譯完成：${translationFinalCount}`;
}

function retranslationSourceLabel(provenance = {}) {
  return `由 ${formatRecordTime(provenance.startedAt)} 的語音紀錄重新翻譯`;
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

function sourceSessionIdForRetranslation(sessionRecord, fallbackSessionId) {
  if (sessionRecord?.recordKind === 'retranslation' && sessionRecord.retranslatedFrom?.sessionId) {
    return sessionRecord.retranslatedFrom.sessionId;
  }

  return fallbackSessionId || '';
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
  return `長會議 · ${formatRecordTime(record.startedAt)}`;
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

function historyRecordSortTime(record) {
  const endedAt = new Date(record.endedAt).getTime();

  if (Number.isFinite(endedAt)) {
    return endedAt;
  }

  const startedAt = new Date(record.startedAt).getTime();

  return Number.isFinite(startedAt) ? startedAt : 0;
}

function combinedHistoryEntries(records = [], meetingRecords = []) {
  return [
    ...records.map((record) => ({ kind: 'session', record, sortTime: historyRecordSortTime(record) })),
    ...meetingRecords.map((record) => ({ kind: 'meeting', record, sortTime: meetingRecordSortTime(record) }))
  ].sort((left, right) => right.sortTime - left.sortTime || historyEntryId(left).localeCompare(historyEntryId(right)));
}

function historyEntryId(entry) {
  return `${entry.kind}:${entry.record?.id || ''}`;
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
    recording: '正在保留即時翻譯輸出。',
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

createRoot(document.getElementById('root')).render(<App />);
