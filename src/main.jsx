import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Download, Mic, MicOff, Pause, Play, Radio, RefreshCw, Square, Trash2 } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from './lib/languages.js';
import { classifyConnectionFailure } from './lib/connectionFailures.js';
import { failureUiStateForClassification } from './lib/failureUiState.js';
import { audioInputDevices } from './lib/mediaDevices.js';
import { createReconnectController } from './lib/reconnectController.js';
import { createMemorySessionRepository } from './lib/sessionRepository.js';
import { createSessionReadApiClient } from './lib/sessionReadApiClient.js';
import { createMeetingReadApiClient } from './lib/meetingReadApiClient.js';
import { createSessionSnapshotApiClient } from './lib/sessionSnapshotApiClient.js';
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
import { applyGlossaryReplacements } from './lib/glossaryReplacement.js';
import { createTranslationCommandLifecycle } from './lib/translationCommandLifecycle.js';
import {
  appendNewFinalTranscriptItems,
  buildFinalizePatch,
  buildSessionRecordInput,
  createActiveSessionRecord,
  finalizeActiveSessionRecord
} from './lib/sessionRecordLifecycle.js';
import {
  buildSavedSessionFileName,
  canExportSavedSession,
  formatSavedSessionExport
} from './lib/sessionRecordExport.js';
import { buildTranscriptFileName, canExportTranscript, formatTranscriptExport } from './lib/transcriptExport.js';
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
import { hasPendingRetranslationItems, retranslationProgressFor } from './lib/retranslationProgress.js';
import { createMicrophoneRecordingController } from './lib/microphoneRecording.js';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  finalizePendingSubtitleCue,
  resetSubtitleCueState
} from './lib/subtitleCues.js';
import { cueListForDisplay, formatCueTimecode, shouldFollowLatest } from './lib/cueUi.js';
import {
  INPUT_SAMPLE_RATE,
  buildInputAudioFileName,
  buildTranslatedAudioFileName,
  pcm16ChunksToWavBlob
} from './lib/audio.js';
import './styles.css';

const RECONNECT_FAILED_MESSAGE = '無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時翻譯多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);
const FEATURE_PAGES = new Set(['live', 'history', 'meetings', 'retranslate', 'glossary']);
const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const PENDING_TRANSCRIPT_IDLE_FINALIZE_MS = 3000;
const SESSION_SNAPSHOT_SYNC_DELAY_MS = 1000;
const SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE = 20;
const AUDIO_SEGMENT_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const SEGMENT_SWITCH_INTERVAL_MS = 10 * 60 * 1000;
const ARCHIVED_TRANSCRIPT_SEGMENT_CACHE_LIMIT = 3;
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
    meetingId: params.get('meetingId') || ''
  };
}

function App() {
  const [page, setPage] = useState(pageFromLocation);
  const [status, setStatus] = useState('idle');
  const [statusLabelOverride, setStatusLabelOverride] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  // Legacy transcript state remains in the data flow for persistence, summary,
  // export, and backward-compatible Session detail fallback. Live rendering is
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
  const [selectedHistoryRecordId, setSelectedHistoryRecordId] = useState(null);
  const [selectedHistoryDetail, setSelectedHistoryDetail] = useState(null);
  const [meetingRecords, setMeetingRecords] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [selectedMeetingDetail, setSelectedMeetingDetail] = useState(null);
  const [retranslationSessionId, setRetranslationSessionId] = useState(() => pageInfoFromLocation().sessionId);
  const [glossaryEntries, setGlossaryEntries] = useState([]);
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
  const [resumeDraft, setResumeDraft] = useState(null);
  const sessionRef = useRef(null);
  const pendingMicrophoneStreamRef = useRef(null);
  const recordingControllerRef = useRef(null);
  const inputAudioChunksRef = useRef([]);
  const inputAudioUploadChunksRef = useRef([]);
  const inputAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const translatedAudioChunksRef = useRef([]);
  const translatedAudioUploadChunksRef = useRef([]);
  const translatedAudioMetadataRef = useRef({ sessionId: '', startedAt: null });
  const audioUploadSegmentsRef = useRef(createAudioUploadSegmentState());
  const transcriptRef = useRef(transcript);
  const subtitleCueStateRef = useRef(subtitleCueState);
  const transcriptTimeOriginRef = useRef(null);
  const archivedTranscriptRef = useRef(archivedTranscript);
  const archivedTranscriptSegmentsRef = useRef([]);
  const reconnectControllerRef = useRef(null);
  const reconnectSessionRef = useRef(null);
  const sessionRepositoryRef = useRef(createMemorySessionRepository());
  const sessionSnapshotApiClientRef = useRef(createSessionSnapshotApiClient());
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
  const meetingReadApiClientRef = useRef(createMeetingReadApiClient());
  const sessionDetailCacheRef = useRef(new Map());
  const meetingDetailCacheRef = useRef(new Map());
  const translationCommandLifecycleRef = useRef(null);
  const activeSessionRecordIdRef = useRef(null);
  const suppressReconnectErrorRef = useRef(false);
  const detailRequestIdRef = useRef(0);
  const selectedHistoryRecordIdRef = useRef(null);
  const meetingDetailRequestIdRef = useRef(0);
  const selectedMeetingIdRef = useRef(null);
  const meetingResumeDraftRequestIdRef = useRef(0);
  const liveCueUpdatesAllowedRef = useRef(false);

  const isActive =
    status === 'requesting-permission' ||
    status === 'connecting' ||
    status === 'listening' ||
    status === 'reconnecting' ||
    status === 'switching-segment';
  const controlsLocked = isActive || status === 'paused';

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
    const { page: currentPage, meetingId } = pageInfoFromLocation();
    if (currentPage !== 'live' || !meetingId || status !== 'idle') {
      return;
    }

    void loadMeetingResumeDraft(meetingId);
  }, [page, status]);

  useEffect(() => () => {
    reconnectControllerRef.current?.cancel();
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);
    sessionRef.current = null;
    reconnectSessionRef.current = null;
    sessionSnapshotSyncCoordinatorRef.current?.cancel();
    meetingCheckpointSyncCoordinatorRef.current?.cancel();
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
        return '';
      });
    } catch {
      setDeviceMessage('無法取得麥克風清單，已改用瀏覽器預設麥克風。');
    }
  }

  async function startSession() {
    meetingResumeDraftRequestIdRef.current += 1;
    reconnectController().reset();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = true;
    setStatusLabelOverride('');
    let session;

    try {
      await recordingController().cleanup({ discard: true });
      resetInputAudioDownload();
      resetTranslatedAudioDownload();
      pendingMicrophoneStreamRef.current = null;
      const liveSessionId = generateLiveSessionId();
      const meetingCheckpoint = await createMeetingCheckpointForSession({ liveSessionId });
      session = await createSession({ preserveTranscript: false, liveSessionId });
      sessionRef.current = session;

      await session.start();
      const record = await createCurrentSessionRecord(meetingCheckpoint);
      await startRecordingForSession(record);
      setStatus('listening');
      updateLiveMeetingUrl(meetingCheckpoint.meetingId);
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
      activeMeetingCheckpointRef.current = null;
      meetingCheckpointSyncCoordinatorRef.current?.cancel();
      segmentSwitchOrchestratorRef.current?.cancel();
      applyStartFailure(nextError, '無法開始即時翻譯。');
    }
  }

  async function pauseSession() {
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
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
    pendingMicrophoneStreamRef.current = null;
    setStatus('paused');
  }

  async function continuePausedSession() {
    if (status !== 'paused') return;

    reconnectController().reset();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = true;
    setStatusLabelOverride('');
    setError('');
    pendingMicrophoneStreamRef.current = null;

    let session;
    try {
      session = await createSession({ preserveTranscript: true, liveSessionId: generateLiveSessionId() });
      sessionRef.current = session;
      await session.start();
      await resumeRawAudioRecording();
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
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    liveCueUpdatesAllowedRef.current = false;
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

    const inputDeviceIdForSession = inputDevices.some((device) => device.deviceId === selectedInputDeviceId)
      ? selectedInputDeviceId
      : '';

    const { LiveTranslateSession } = await import('./lib/liveSession.js');

    return new LiveTranslateSession({
      liveSessionId,
      sessionId: activeSessionRecordIdRef.current,
      segmentId: activeMeetingCheckpointRef.current?.segmentId || null,
      sessionClock: () => sessionTimeForSubtitleCues(),
      targetLanguageCode,
      sourceLanguageCode,
      echoTargetLanguage,
      liveGlossaryEntries: liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode),
      inputDeviceId: inputDeviceIdForSession,
      onInputDeviceFallback: () => {
        setSelectedInputDeviceId('');
        setDeviceMessage('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
      },
      onMicrophoneReady: ({ mediaStream } = {}) => {
        pendingMicrophoneStreamRef.current = mediaStream || null;
        void refreshInputDevices();
      },
      onConnecting: () => {
        setStatus((current) => (
          current === 'reconnecting' || current === 'switching-segment' ? current : 'connecting'
        ));
      },
      onInputAudioChunk: handleInputAudioChunk,
      onInputTranscript: (update) => applyTranscriptUpdate({ ...update, stream: 'source' }),
      onOutputTranscript: (update) => applyTranscriptUpdate({ ...update, stream: 'translation' }),
      onCueEvent: (event) => {
        if (!liveCueUpdatesAllowedRef.current) return;
        const activeGlossaryEntries = sessionRef.current?.liveGlossaryEntries
          || liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode);
        const cueEvent = event?.stream === 'translation'
          ? { ...event, text: applyGlossaryReplacements(event.text, activeGlossaryEntries) }
          : event;
        applyLiveSubtitleCueEvent(cueEvent);
      },
      onOutputAudioChunk: handleTranslatedAudioChunk,
      onError: (nextError) => {
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
        setStatus((current) => (current === 'listening' ? 'stopped' : current));
        sessionRef.current = null;
      },
      onConnectionFailure: (failure) => {
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
            if (!result.scheduled && !result.ignored) {
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
  }

  function recordingController() {
    if (!recordingControllerRef.current) {
      recordingControllerRef.current = createMicrophoneRecordingController({
        onStateChange: setRecordingState
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
    inputAudioChunksRef.current = [];
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

    inputAudioChunksRef.current.push(new Uint8Array(bytes));
    inputAudioUploadChunksRef.current.push(new Uint8Array(bytes));
    void flushAudioSegmentIfDue('input');
  }

  async function pauseRawAudioRecording() {
    if (!shouldRecordInputAudio) {
      inputAudioChunksRef.current = [];
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
      inputAudioChunksRef.current = [];
      setRecordingState(INPUT_AUDIO_RECORDING_SKIPPED_STATE);
      return INPUT_AUDIO_RECORDING_SKIPPED_STATE;
    }

    const state = await recordingController().finalize().catch((nextError) => ({
      status: 'error',
      blob: null,
      mimeType: '',
      extension: '',
      fileName: '',
      errorMessage: nextError?.message || '原始語音音檔無法建立。'
    }));

    if (inputAudioChunksRef.current.length === 0) {
      setRecordingState(state);
      return state;
    }

    try {
      const metadata = inputAudioMetadataRef.current;
      const wavState = {
        status: 'ready',
        blob: pcm16ChunksToWavBlob(inputAudioChunksRef.current, {
          sampleRate: INPUT_SAMPLE_RATE,
          normalizePeak: true
        }),
        mimeType: 'audio/wav',
        extension: 'wav',
        fileName: buildInputAudioFileName(metadata),
        errorMessage: ''
      };
      setRecordingState(wavState);
      return wavState;
    } catch (nextError) {
      const errorState = {
        status: 'error',
        blob: null,
        mimeType: '',
        extension: '',
        fileName: '',
        errorMessage: nextError?.message || '原始語音音檔無法建立。'
      };
      setRecordingState(errorState);
      return errorState;
    }
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
    translatedAudioChunksRef.current = [];
    translatedAudioUploadChunksRef.current = [];
    translatedAudioMetadataRef.current = { sessionId: '', startedAt: null };
    resetAudioUploadSegment('translation');
    setTranslatedAudioState(TRANSLATED_AUDIO_IDLE_STATE);
  }

  function handleTranslatedAudioChunk(bytes) {
    if (!bytes || !Number.isFinite(bytes.byteLength) || bytes.byteLength === 0) {
      return;
    }

    translatedAudioChunksRef.current.push(new Uint8Array(bytes));
    translatedAudioUploadChunksRef.current.push(new Uint8Array(bytes));
    void flushAudioSegmentIfDue('translation');
    setTranslatedAudioState((current) => (
      current.status === 'ready'
        ? current
        : { status: 'recording', blob: null, fileName: '', errorMessage: '' }
    ));
  }

  function finalizeTranslatedAudioDownload(sessionId) {
    const chunks = translatedAudioChunksRef.current;
    if (chunks.length === 0) {
      let nextState = null;
      setTranslatedAudioState((current) => (
        current.status === 'recording' ? (nextState = TRANSLATED_AUDIO_IDLE_STATE) : (nextState = current)
      ));
      return nextState || TRANSLATED_AUDIO_IDLE_STATE;
    }

    try {
      const metadata = translatedAudioMetadataRef.current;
      const blob = pcm16ChunksToWavBlob(chunks, { normalizePeak: true });
      const nextState = {
        status: 'ready',
        blob,
        fileName: buildTranslatedAudioFileName({
          sessionId: metadata.sessionId || sessionId,
          startedAt: metadata.startedAt
        }),
        errorMessage: ''
      };
      setTranslatedAudioState(nextState);
      return nextState;
    } catch (nextError) {
      const errorState = {
        status: 'error',
        blob: null,
        fileName: '',
        errorMessage: nextError?.message || '翻譯語音音檔無法建立。'
      };
      setTranslatedAudioState(errorState);
      return errorState;
    }
  }

  function downloadRawAudio() {
    const blob = recordingState.blob;
    if (!blob || recordingState.status !== 'ready') return;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = recordingState.fileName || 'live-translate-input-audio.webm';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadTranslatedAudio() {
    const blob = translatedAudioState.blob;
    if (!blob || translatedAudioState.status !== 'ready') return;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = translatedAudioState.fileName || 'live-translate-translated-audio.wav';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function updateActiveSessionGlossaryEntries(entries) {
    const liveGlossaryEntries = liveGlossaryEntriesForTarget(entries, targetLanguageCode);
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);

    for (const session of sessions) {
      if (session) {
        session.liveGlossaryEntries = liveGlossaryEntries;
      }
    }
  }

  async function startReconnectSession({ generationId, classification }) {
    if (generationId !== reconnectController().currentGeneration()) {
      return;
    }

    setError('');
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

    reconnectController().reset();
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
        meetingId: resumeDraft.meetingId,
        segmentId: resumeDraft.segmentId,
        idempotencyKey: `recover:${resumeDraft.segmentId}:${nextLiveSessionId}`,
        checkpoint: {
          idempotencyKey: `checkpoint:${resumeDraft.segmentId}:resume:${nextLiveSessionId}`,
          durableChunks: [],
          pendingPartial: null
        },
        nextLiveSessionId,
        failureReason: 'manual_resume',
        failureCategory: 'user_intent',
        outcome: 'interrupted'
      });
      const nextMeetingCheckpoint = {
        meetingId: resumeDraft.meetingId,
        segmentId: recovery.segment.id
      };
      activeMeetingCheckpointRef.current = nextMeetingCheckpoint;
      meetingCheckpointSyncCoordinator().start(nextMeetingCheckpoint);
      await createCurrentSessionRecord(nextMeetingCheckpoint, resumeDraft.transcriptState);
      resetActiveTranscriptForNextSegment(resumeDraft.transcriptState.nextSequence);
      session = await createSession({ preserveTranscript: true, liveSessionId: nextLiveSessionId });
      sessionRef.current = session;
      await session.start();
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

  async function createMeetingCheckpointForSession({ liveSessionId } = {}) {
    try {
      setMeetingCheckpointStatus('syncing');
      const result = await meetingCheckpointApiClientRef.current.createMeeting({ liveSessionId });
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

  async function createCurrentSessionRecord(meetingCheckpoint = activeMeetingCheckpointRef.current, initialTranscript = null) {
    const record = createActiveSessionRecord(
      sessionRepositoryRef.current,
      buildSessionRecordInput({
        startedAt: Date.now(),
        targetLanguageCode,
        targetLanguageLabel: targetLanguageLabelFor(targetLanguageCode),
        sourceLanguageCode,
        meetingId: meetingCheckpoint?.meetingId,
        segmentId: meetingCheckpoint?.segmentId,
        ...selectedInputDeviceSnapshot()
      })
    );
    activeSessionRecordIdRef.current = record.id;
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
  }

  function enqueueCuePersistence(previous, next) {
    const previousIds = new Set((previous?.finalCues || []).map((cue) => cue.cueId));
    const newCues = (next?.finalCues || []).filter((cue) => !previousIds.has(cue.cueId));
    const checkpoint = cueCheckpointForState(next);
    meetingCheckpointSyncCoordinator().enqueueCues(newCues, checkpoint);
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
    activeSessionRecordIdRef.current = null;
    const meetingId = activeMeetingCheckpointRef.current?.meetingId || null;

    try {
      await flushMeetingCheckpointSync();
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
      activeMeetingCheckpointRef.current = null;
    }
  }

  async function uploadFinalizedSessionAudioArtifacts(sessionId, states = {}, options = {}) {
    try {
      await Promise.all([
        states.input?.status === 'ready' ? flushAudioSegment('input', { force: true, sessionId }) : null,
        states.translation?.status === 'ready' ? flushAudioSegment('translation', { force: true, sessionId }) : null
      ].filter(Boolean));
      await refreshAudioArtifactDetails(sessionId, options);
    } catch (nextError) {
      console.error('Session audio artifact persistence failed.', nextError);
      if (nextError?.status === 413) {
        setError('語音紀錄分段超過伺服器保存上限，但逐字稿保存不受影響，目前音檔仍可在本頁下載。請調高 SESSION_AUDIO_MAX_BYTES 或縮短分段時間。');
        return;
      }
      setError('語音紀錄無法儲存到翻譯紀錄，但逐字稿保存不受影響，目前音檔仍可在本頁下載。');
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
    await flushAudioSegment(kind);
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
      return true;
    })();
    segment.currentPromise = uploadPromise;
    try {
      return await uploadPromise;
    } catch (nextError) {
      chunksRef.current = uploadChunks.concat(chunksRef.current);
      throw nextError;
    } finally {
      segment.inFlight = false;
      if (segment.currentPromise === uploadPromise) {
        segment.currentPromise = null;
      }
    }
  }

  function resetAudioUploadSegment(kind) {
    audioUploadSegmentsRef.current[kind] = {
      nextIndex: 0,
      lastFlushedAt: Date.now(),
      inFlight: false,
      currentPromise: null
    };
  }

  async function uploadSessionAudioSegment(sessionId, kind, { blob, segmentIndex, fileName }) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/audio/${kind}/segments/${segmentIndex}`, {
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
        onStatusChange: setMeetingCheckpointStatus,
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
    setError('長會議同步暫時失敗，已保留未同步片段並會在下一次同步時重試。');
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
    try {
      const history = await sessionReadApiClientRef.current.listSessionHistory();
      const finalizedRecords = history
        .filter((record) => TERMINAL_HISTORY_STATUSES.has(record.status))
        .sort((a, b) => historyRecordSortTime(b) - historyRecordSortTime(a));

      setHistoryRecords(finalizedRecords);
    } catch {
      setError('翻譯紀錄無法使用。');
    }
  }

  async function refreshMeetingRecords() {
    try {
      const meetings = await meetingReadApiClientRef.current.listMeetingHistory();
      setMeetingRecords([...meetings].sort((a, b) => meetingRecordSortTime(b) - meetingRecordSortTime(a)));
    } catch {
      setError('翻譯紀錄無法使用。');
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

  function reportTranslationCommandError(error) {
    console.error('Translation command persistence failed.', error);
    setError('無法儲存翻譯紀錄，但即時翻譯仍可繼續。');
  }

  async function openHistoryRecordDetail(id) {
    if (selectedHistoryRecordIdRef.current === id) {
      closeHistoryRecordDetail();
      return;
    }

    const record = historyRecords.find((historyRecord) => historyRecord.id === id);

    if (!record || !TERMINAL_HISTORY_STATUSES.has(record.status)) {
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    selectedHistoryRecordIdRef.current = id;
    setSelectedHistoryRecordId(id);
    const cachedDetail = sessionDetailCacheRef.current.get(id);
    setSelectedHistoryDetail(cachedDetail || undefined);

    if (cachedDetail) {
      return;
    }

    try {
      const detail = await sessionReadApiClientRef.current.getSessionDetail(id);

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
      setError('工作階段詳細資料無法使用。');
    }
  }

  async function refreshSelectedHistoryRecordDetail(id) {
    if (!id || selectedHistoryRecordIdRef.current !== id) {
      return false;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;

    try {
      const detail = await sessionReadApiClientRef.current.getSessionDetail(id);

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
      setError('會議詳細資料無法使用。');
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
      const content = formatTranscriptExport(transcriptItems, {
        format: exportFormat,
        stream: exportStream,
        timeOrigin: transcriptTimeOrigin
      });
      const fileName = buildTranscriptFileName({ format: exportFormat });
      downloadTextFile(content, fileName, contentTypeForFormat(exportFormat));
    } catch {
      setError('所選選項無法匯出逐字稿。');
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
  const canDownloadTranscript = canExportTranscript(transcriptItems, {
    format: exportFormat,
    stream: exportStream,
    timeOrigin: transcriptTimeOrigin
  });
  const exportUnavailableReason =
    exportFormat !== 'txt' && exportStream === 'both' ? 'SRT 與 VTT 一次只能匯出一個內容。' : '';
  const selectedHistoryRecord = selectedHistoryRecordId
    ? historyRecords.find((historyRecord) => historyRecord.id === selectedHistoryRecordId) || null
    : null;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <h1>即時翻譯</h1>
          <p>由 Gemini Live API 驅動的即時語音翻譯。</p>
        </div>
        <nav className="feature-navigation" aria-label="主要導覽">
          <a href="#live" aria-current={page === 'live' ? 'page' : undefined} onClick={(event) => navigateTo('live', event)}>即時翻譯</a>
          <a href="#history" aria-current={page === 'history' ? 'page' : undefined} onClick={(event) => navigateTo('history', event)}>翻譯紀錄</a>
          <a href="#retranslate" aria-current={page === 'retranslate' ? 'page' : undefined} onClick={(event) => navigateTo('retranslate', event)}>重新翻譯</a>
          <a href="#glossary" aria-current={page === 'glossary' ? 'page' : undefined} onClick={(event) => navigateTo('glossary', event)}>翻譯字典</a>
        </nav>
      </header>

      {error ? <p className="error-message" role="alert">{error}</p> : null}

      <section className="feature-page live-page" aria-label="即時翻譯工作區" hidden={page !== 'live'}>
        <section className="control-panel">
          <div className="title-block">
            <div className="status-pill">
              <Radio size={16} aria-hidden="true" />
              {statusLabel(status, statusLabelOverride)}
            </div>
            <p>選擇目標語言、啟用麥克風，並查看即時逐字稿。</p>
          </div>

          <div className="controls" aria-label="翻譯控制項">
            <div className="language-controls">
              <label className="field">
                <span>主要輸入語言</span>
                <select
                  value={sourceLanguageCode}
                  onChange={(event) => setSourceLanguageCode(event.target.value)}
                  disabled={controlsLocked}
                >
                  {SUPPORTED_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>目標語言</span>
                <select
                  value={targetLanguageCode}
                  onChange={(event) => setTargetLanguageCode(event.target.value)}
                  disabled={controlsLocked}
                >
                  {SUPPORTED_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

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
                {inputDevices.map((device) => (
                  <option key={device.deviceId || device.label} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={echoTargetLanguage}
                onChange={(event) => setEchoTargetLanguage(event.target.checked)}
                disabled={controlsLocked}
              />
              <span>朗讀翻譯語言</span>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={shouldRecordInputAudio}
                onChange={(event) => setShouldRecordInputAudio(event.target.checked)}
                disabled={controlsLocked}
              />
              <span>錄製講者原音</span>
            </label>
          </div>

          <div className="control-status-row">
            <div className="control-status-messages">
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
              <p className={`checkpoint-note checkpoint-note-${meetingCheckpointStatus}`}>
                {meetingCheckpointStatusLabel(meetingCheckpointStatus)}
              </p>
              {meetingViewStats.archivedSegmentCount > 0 ? (
                <p className="checkpoint-note">
                  長會議段落：已封存 {meetingViewStats.archivedSegmentCount} 段 · 已載入 {meetingViewStats.loadedSegmentCount} 段 · 目前段落 {activeSegmentTranscriptCount(transcript)} 筆
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
                  <button className="button primary" type="button" onClick={startSession} disabled={isActive}>
                    {isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                    {isActive ? '正在開始' : '開始'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="recording-panel" aria-label="音檔下載">
          <div>
            <h2>音檔下載</h2>
            <p className="recording-note">原始語音：{recordingStatusLabel(recordingState.status)}</p>
            <p className="recording-note">翻譯語音：{translatedAudioStatusLabel(translatedAudioState.status)}</p>
            {recordingState.errorMessage ? <p className="recording-error" role="alert">{recordingState.errorMessage}</p> : null}
            {translatedAudioState.errorMessage ? <p className="recording-error" role="alert">{translatedAudioState.errorMessage}</p> : null}
          </div>
          <div className="recording-downloads">
            <button
              className="button secondary"
              type="button"
              onClick={downloadRawAudio}
              disabled={recordingState.status !== 'ready' || !recordingState.blob}
            >
              <Download size={18} aria-hidden="true" />
              下載原始語音
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={downloadTranslatedAudio}
              disabled={translatedAudioState.status !== 'ready' || !translatedAudioState.blob}
            >
              <Download size={18} aria-hidden="true" />
              下載翻譯語音
            </button>
          </div>
        </section>

        <section className="export-panel" aria-label="逐字稿匯出">
          <div className="controls export-controls">
          <label className="field">
            <span>匯出格式</span>
            <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)}>
              <option value="txt">TXT</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
            </select>
          </label>

          <label className="field">
            <span>匯出內容</span>
            <select value={exportStream} onChange={(event) => setExportStream(event.target.value)}>
              <option value="translation">翻譯</option>
              <option value="source">原文</option>
              <option value="both">兩者</option>
            </select>
          </label>

          <button className="button secondary" type="button" onClick={downloadTranscript} disabled={!canDownloadTranscript}>
            <Download size={18} aria-hidden="true" />
            下載
          </button>
          </div>
          {exportUnavailableReason ? <p className="export-note">{exportUnavailableReason}</p> : null}
        </section>

        <LiveCuePanel
          cueState={subtitleCueState}
          isPaused={status === 'paused'}
          isStopped={status === 'stopped'}
        />
      </section>

      <section className="feature-page history-page" aria-labelledby="history-page-title" hidden={page !== 'history'}>
        <div className="history-header">
          <div>
            <h2 id="history-page-title">翻譯紀錄</h2>
            <p className="history-description">查看已儲存的翻譯內容、正式輸出與匯出資料。</p>
          </div>
        </div>
        <HistoryPanel
          titleId="session-history-title"
          records={historyRecords}
          meetingRecords={meetingRecords}
          selectedRecordId={selectedHistoryRecordId}
          selectedDetail={selectedHistoryDetail}
          selectedRecord={selectedHistoryRecord}
          onViewDetails={openHistoryRecordDetail}
          onDeleteRecord={deleteHistoryRecord}
          onRetranslationSubmitted={refreshSelectedHistoryRecordDetail}
          onOpenRetranslationWorkflow={openRetranslationWorkflow}
          selectedMeetingId={selectedMeetingId}
          selectedMeetingDetail={selectedMeetingDetail}
          onViewMeetingDetails={openMeetingDetail}
        />
      </section>

      <section className="feature-page meetings-page" aria-labelledby="meetings-page-title" hidden={page !== 'meetings'}>
        <MeetingPanel
          titleId="meetings-page-title"
          records={meetingRecords}
          selectedMeetingId={selectedMeetingId}
          selectedDetail={selectedMeetingDetail}
          onViewDetails={openMeetingDetail}
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
        <GlossaryPanel titleId="glossary-page-title" onEntriesChange={setGlossaryEntries} />
      </section>
    </main>
  );
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

function LiveCuePanel({ cueState, isPaused, isStopped }) {
  const listRef = useRef(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const cues = useMemo(() => cueListForDisplay(cueState), [cueState]);

  useEffect(() => {
    const element = listRef.current;
    if (!element || !isFollowingLatest) return;
    element.scrollTo({ top: element.scrollHeight, behavior: cues.at(-1)?.status === 'final' ? 'smooth' : 'auto' });
  }, [cues.length, cues.at(-1)?.cueId, cues.at(-1)?.updatedTimeMs, isFollowingLatest]);

  function handleScroll() {
    const element = listRef.current;
    if (!element) return;
    setIsFollowingLatest(shouldFollowLatest(element));
  }

  function returnToLatest() {
    const element = listRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setIsFollowingLatest(true);
  }

  return (
    <section className="cue-panel" aria-label="即時字幕" data-testid="live-cue-panel">
      <div className="cue-panel-header">
        <div>
          <h2>即時字幕</h2>
          <p>{isPaused ? '已暫停，字幕內容會保留。' : isStopped ? '本次工作階段已結束。' : '原文與譯文會依句子同步顯示。'}</p>
        </div>
        {!isFollowingLatest ? (
          <button className="button detail-button" type="button" data-testid="follow-latest-button" onClick={returnToLatest}>回到最新字幕</button>
        ) : null}
      </div>
      <div className="cue-list" data-testid="cue-list" ref={listRef} onScroll={handleScroll} role="log" aria-live="polite" aria-label="字幕列表">
        {cues.length === 0 ? <p className="cue-empty" data-testid="cue-empty-state">開始說話後，字幕會顯示在這裡</p> : null}
        {cues.map((cue) => cue.status === 'final'
          ? <FinalCueRow key={cue.cueId} cue={cue} />
          : <PartialCueRow key={`partial-${cue.cueId || 'current'}`} cue={cue} />)}
      </div>
    </section>
  );
}

function FinalCueRow({ cue }) {
  return <CueRow cue={cue} />;
}

function PartialCueRow({ cue }) {
  return <CueRow cue={cue} partial />;
}

function CueRow({ cue, partial = false }) {
  const [expanded, setExpanded] = useState(false);
  const label = partial ? '辨識中／翻譯中' : `字幕 ${cue.sequence || ''}`;
  return (
    <article
      className={`cue-row${partial ? ' cue-row-partial' : ''}${expanded ? ' cue-row-expanded' : ''}`}
      data-testid={partial ? 'cue-partial-row' : 'cue-final-row'}
      data-cue-id={cue.cueId || undefined}
      aria-label={label}
    >
      <div className="cue-row-meta">
        <span className="cue-timecode">
          <span data-testid="cue-timecode">{formatCueTimecode(cue.startTimeMs)} → {formatCueTimecode(cue.endTimeMs)}</span>
        </span>
        {partial ? <span className="cue-partial-status">{label}</span> : null}
      </div>
      <button className="cue-text-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="cue-source" data-testid="cue-source-text">{cue.sourceText || '—'}</span>
        <span className="cue-translation" data-testid="cue-translated-text">{cue.translatedText || '—'}</span>
        <span className="sr-only">{expanded ? '收合字幕' : '展開查看完整字幕'}</span>
      </button>
    </article>
  );
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
  selectedMeetingId,
  selectedMeetingDetail,
  onViewMeetingDetails
}) {
  const entries = combinedHistoryEntries(records, meetingRecords);

  return (
    <section className="history-panel" aria-labelledby={titleId}>
      <h3 id={titleId} className="sr-only">紀錄清單</h3>

      {entries.length === 0 ? (
        <p className="history-empty">尚無翻譯紀錄。</p>
      ) : (
        <ol className="history-list">
          {entries.map((entry) => entry.kind === 'meeting' ? (
            <MeetingHistoryItem
              key={`meeting-${entry.record.id}`}
              record={entry.record}
              selectedMeetingId={selectedMeetingId}
              selectedDetail={selectedMeetingDetail}
              onViewDetails={onViewMeetingDetails}
            />
          ) : (
            <SessionHistoryItem
              key={`session-${entry.record.id}`}
              record={entry.record}
              selectedRecordId={selectedRecordId}
              selectedDetail={selectedDetail}
              selectedRecord={selectedRecord}
              onViewDetails={onViewDetails}
              onDeleteRecord={onDeleteRecord}
              onRetranslationSubmitted={onRetranslationSubmitted}
              onOpenRetranslationWorkflow={onOpenRetranslationWorkflow}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionHistoryItem({
  record,
  selectedRecordId,
  selectedDetail,
  selectedRecord,
  onViewDetails,
  onDeleteRecord,
  onRetranslationSubmitted,
  onOpenRetranslationWorkflow
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
            <button
              className="button detail-button"
              type="button"
              aria-expanded={selectedRecordId === record.id}
              onClick={() => onViewDetails(record.id)}
            >
              {selectedRecordId === record.id ? '關閉詳細資料' : '查看詳細資料'}
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
        />
      ) : null}
    </li>
  );
}

function MeetingHistoryItem({ record, selectedMeetingId, selectedDetail, onViewDetails }) {
  return (
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
              {selectedMeetingId === record.id ? '關閉詳細資料' : '查看詳細資料'}
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
      {selectedMeetingId === record.id ? <MeetingDetail detail={selectedDetail} /> : null}
    </li>
  );
}

function MeetingPanel({ titleId, records, selectedMeetingId, selectedDetail, onViewDetails }) {
  return (
    <section className="history-panel meeting-panel" aria-labelledby={titleId}>
      <div className="history-header">
        <div>
          <h3 id={titleId}>翻譯紀錄</h3>
          <p className="history-description">查看已儲存翻譯的分段時間軸、整場原文與文章版翻譯。</p>
        </div>
      </div>

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
              {selectedMeetingId === record.id ? <MeetingDetail detail={selectedDetail} /> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MeetingDetail({ detail }) {
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
        <p className="history-empty">此翻譯紀錄無法使用。</p>
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
      const content = formatTranscriptExport(transcriptItems, {
        format: meetingExportFormat,
        stream: meetingExportStream,
        timeOrigin
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
      const content = formatTranscriptExport(retranslationExportItems, {
        format: retranslationExportFormat,
        stream: retranslationExportStream,
        timeOrigin: detail?.session?.startedAt
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
              <span>搜尋 Session</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="日期、語言或摘要" />
            </label>
          </div>
          {selectableRecords.length === 0 ? <p className="history-empty">尚無可重新翻譯的原始 Session。</p> : null}
          {selectableRecords.length > 0 && filteredRecords.length === 0 ? <p className="history-empty">找不到符合條件的 Session。</p> : null}
          {filteredRecords.length > 0 ? (
            <ol className="history-list retranslation-session-list">
              {filteredRecords.map((record) => (
                <li className="history-item" key={record.id}>
                  <div className="history-item-header">
                    <div>
                      <h3>{historyLanguageLabel(record)}</h3>
                      <span className={`history-status history-status-${record.status}`}>{historyStatusLabel(record.status)}</span>
                    </div>
                    <button className="button detail-button" type="button" onClick={() => onSelectSession(record.id)}>選擇</button>
                  </div>
                  <dl className="history-metadata">
                    <div><dt>開始時間</dt><dd>{formatRecordTime(record.startedAt)}</dd></div>
                    <div><dt>結束時間</dt><dd>{formatRecordTime(record.endedAt)}</dd></div>
                    <div><dt>逐字稿</dt><dd>{transcriptSummaryLabel(record.transcriptSummary)}</dd></div>
                  </dl>
                </li>
              ))}
            </ol>
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
        <ol className="history-list retranslation-output-list">
          {outputs.map((output) => (
            <li className="history-item" key={output.id}>
              <div className="history-item-header">
                <div>
                  <h4>{translationOutputTitle(output)}</h4>
                  <span className="history-status history-status-completed">已完成</span>
                </div>
                <div className="history-actions">
                  <button
                    className="button detail-button"
                    type="button"
                    aria-pressed={selectedOutputId === output.id}
                    onClick={() => onSelect(output.id)}
                  >
                    {selectedOutputId === output.id ? '已選取' : '查看內容'}
                  </button>
                  <button className="button detail-button danger-button" type="button" onClick={() => onDelete(output)}>
                    <Trash2 size={16} aria-hidden="true" />
                    刪除
                  </button>
                </div>
              </div>
              <dl className="history-metadata">
                <div><dt>目標語言</dt><dd>{targetLanguageLabelFor(output.targetLanguageCode) || output.targetLanguageCode || '未知語言'}</dd></div>
                <div><dt>完成時間</dt><dd>{formatRecordTime(output.completedAt)}</dd></div>
                <div><dt>輸出</dt><dd>{output.translatedText ? '可閱讀' : '沒有內容'}</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function GlossaryPanel({ titleId, onEntriesChange }) {
  const [entries, setEntries] = useState([]);
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
        : [...entriesRef.current, entry]);
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
          <input value={source} onChange={(event) => setSource(event.target.value)} />
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
          <input value={translation} onChange={(event) => setTranslation(event.target.value)} />
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
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {status ? <p className="success-message" role="status">{status}</p> : null}
      {isLoading ? <p className="history-empty">正在載入字典…</p> : null}
      {!isLoading && entries.length === 0 ? <p className="history-empty">尚無字典詞條。</p> : null}
      {entries.length > 0 ? (
        <ol className="glossary-list">
          {entries.map((entry) => (
            <li key={entry.id || entry.source}>
              <div>
                <strong>{glossaryReplacementLabel(entry)}</strong>
                <p>{glossaryLanguagesLabel(entry.translations)}</p>
                <p>{glossaryScopeLabel(entry.scope)}</p>
              </div>
              <div className="glossary-actions">
                <button className="button detail-button" type="button" onClick={() => startEditing(entry)}>編輯</button>
                <button className="button detail-button" type="button" onClick={() => deleteEntry(entry)}>刪除</button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function SessionDetail({ detail, historyRecord, onRetranslationSubmitted, onOpenRetranslationWorkflow }) {
  const [savedExportFormat, setSavedExportFormat] = useState('txt');
  const [savedExportStream, setSavedExportStream] = useState('translation');
  const [savedExportError, setSavedExportError] = useState('');
  const [readingTab, setReadingTab] = useState('translationArticle');
  const [trackedRetranslations, setTrackedRetranslations] = useState([]);
  const sessionRecordId = detail?.session?.id;

  useEffect(() => {
    setSavedExportFormat('txt');
    setSavedExportStream('translation');
    setSavedExportError('');
    setReadingTab('translationArticle');
    setTrackedRetranslations([]);
  }, [sessionRecordId]);

  const translationHistory = useMemo(() => compactTranslationHistoryForDetail(detail), [detail]);
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
        <p className="history-empty">此翻譯紀錄無法使用。</p>
      </section>
    );
  }

  const retranslationSourceSessionId = sourceSessionIdForRetranslation(sessionRecord, sessionRecordId);
  const canDownloadSavedTranscript = canExportSavedSession(exportDetail, {
    format: savedExportFormat,
    stream: savedExportStream
  });
  const savedExportUnavailableReason = savedSessionExportUnavailableReason(exportDetail, {
    format: savedExportFormat,
    stream: savedExportStream
  });

  function downloadSavedTranscript() {
    setSavedExportError('');

    try {
      const content = formatSavedSessionExport(exportDetail, {
        format: savedExportFormat,
        stream: savedExportStream
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

      <dl className="session-detail-metadata">
        <div>
          <dt>目標語言</dt>
          <dd>{historyLanguageLabel(sessionRecord)}</dd>
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
            <dd>{sessionRecord.failureCategory}</dd>
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
        <button className="button detail-button" type="button" onClick={() => onOpenRetranslationWorkflow?.(retranslationSourceSessionId)} disabled={!retranslationSourceSessionId}>以此原文重新翻譯</button>
        <RetranslationProgress progress={retranslationProgress} />
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

function RetranslationProgress({ progress, onRetry, retryingExecutionId = '' }) {
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
        <ol className="translation-history-list">
          {progress.executions.map((execution) => (
            <li key={execution.id}>
              <span>{targetLanguageLabelFor(execution.targetLanguageCode) || execution.targetLanguageCode || '未知語言'}</span>
              <span className={`history-status history-status-${execution.status}`}>{translationExecutionStatusLabel(execution)}</span>
              {translationExecutionTimingText(execution, nowMs) ? <p>{translationExecutionTimingText(execution, nowMs)}</p> : null}
              {execution.status === 'failed' ? <p>{translationFailureReasonText(execution.failureInfo)}</p> : null}
              {execution.status === 'failed' && onRetry ? (
                <button className="button detail-button" type="button" onClick={() => onRetry(execution)} disabled={retryingExecutionId === execution.id}>
                  {retryingExecutionId === execution.id ? '正在重試…' : '重試'}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
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

function ReadingContentTabs({ content, selectedTab, onSelectTab }) {
  const selectedContent = selectedTab === 'sourceTranscript'
    ? content.sourceTranscript
    : content.translationArticle;
  const selectedTitle = selectedTab === 'sourceTranscript' ? '原始逐字稿' : '文章版翻譯';

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
          文章版翻譯
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
    ? '尚無文章版翻譯。'
    : '尚無原始逐字稿。';
}

function historyLanguageLabel(record) {
  return targetLanguageLabelFor(record.targetLanguageCode) || record.targetLanguageLabel || record.targetLanguageCode || '未知語言';
}

function historyStatusLabel(status) {
  const labels = {
    stopped: '已停止',
    failed: '失敗',
    expired: '已過期',
    completed: '已完成'
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
    return 'Gemini 拒絕此翻譯請求，請確認模型與翻譯內容格式。';
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

  return '翻譯提供者執行失敗，請稍後重試。';
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

function glossaryLanguagesLabel(translations = {}) {
  const label = Object.entries(translations)
    .map(([languageCode]) => targetLanguageLabelFor(languageCode) || languageCode)
    .join('、');
  return label ? `目標語言：${label}` : '目標語言：未設定';
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
    live: '套用範圍：即時翻譯',
    history: '套用範圍：歷史重新翻譯',
    both: '套用範圍：兩者'
  };

  return labels[scope] || labels.history;
}

function compactTranslationHistoryForDetail(detail) {
  const history = detail?.translationHistory || {};
  return {
    outputs: Array.isArray(history.outputs) ? history.outputs : [],
    executions: Array.isArray(history.executions) ? history.executions : []
  };
}

function mergeRetranslationHistoryIntoDetail(detail, translations) {
  if (!detail) {
    return detail;
  }

  const detailHistory = compactTranslationHistoryForDetail(detail);
  const translationsHistory = compactTranslationHistoryForDetail(translations);
  if (translationsHistory.outputs.length === 0 && translationsHistory.executions.length === 0) {
    return detail;
  }

  return {
    ...detail,
    translationHistory: {
      outputs: mergeHistoryItemsById(detailHistory.outputs, translationsHistory.outputs),
      executions: mergeHistoryItemsById(detailHistory.executions, translationsHistory.executions)
    }
  };
}

function removeRetranslationOutputFromDetail(detail, outputId) {
  if (!detail) {
    return detail;
  }

  const history = compactTranslationHistoryForDetail(detail);
  return {
    ...detail,
    translationHistory: {
      outputs: history.outputs.filter((output) => output.id !== outputId),
      executions: history.executions
    }
  };
}

function mergeHistoryItemsById(firstItems, secondItems) {
  const merged = new Map();
  for (const item of [...firstItems, ...secondItems]) {
    const key = item?.id || item?.executionId || item?.requestId;
    if (!key) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
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
  return `會議 ${record.id || ''}`.trim();
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
    error: '原始語音錄音無法使用。'
  };

  return labels[status] || labels.idle;
}

function translatedAudioStatusLabel(status) {
  const labels = {
    idle: '尚無可下載的翻譯語音。',
    recording: '正在保留即時翻譯輸出。',
    ready: '翻譯語音已可下載。',
    error: '翻譯語音音檔無法使用。'
  };

  return labels[status] || labels.idle;
}

function createAudioUploadSegmentState() {
  return {
    input: { nextIndex: 0, lastFlushedAt: Date.now(), inFlight: false, currentPromise: null },
    translation: { nextIndex: 0, lastFlushedAt: Date.now(), inFlight: false, currentPromise: null }
  };
}

function meetingCheckpointStatusLabel(status) {
  const labels = {
    idle: '長會議同步：尚未開始',
    ready: '長會議同步：準備同步',
    syncing: '長會議同步：同步中',
    synced: '長會議同步：已同步',
    switching: '長會議同步：切換下一段中',
    switched: '長會議同步：下一段已開始',
    error: '長會議同步：同步失敗，等待重試'
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

createRoot(document.getElementById('root')).render(<App />);
