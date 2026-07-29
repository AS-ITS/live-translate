import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Download, Mic, MicOff, Radio, RefreshCw, Square, Trash2 } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from './lib/languages.js';
import { classifyConnectionFailure } from './lib/connectionFailures.js';
import { failureUiStateForClassification } from './lib/failureUiState.js';
import { audioInputDevices } from './lib/mediaDevices.js';
import { createReconnectController } from './lib/reconnectController.js';
import { createMemorySessionRepository } from './lib/sessionRepository.js';
import { createSessionReadApiClient } from './lib/sessionReadApiClient.js';
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
import './styles.css';

const RECONNECT_FAILED_MESSAGE = '無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時翻譯多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);
const FEATURE_PAGES = new Set(['live', 'history', 'retranslate', 'glossary']);
const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const PENDING_TRANSCRIPT_IDLE_FINALIZE_MS = 3000;
const SESSION_SNAPSHOT_SYNC_DELAY_MS = 1000;
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const SEGMENT_SWITCH_INTERVAL_MS = 10 * 60 * 1000;

function pageFromLocation() {
  return pageInfoFromLocation().page;
}

function pageInfoFromLocation() {
  const rawHash = window.location.hash.replace('#', '');
  const [pageName, queryString = ''] = rawHash.split('?');
  const page = FEATURE_PAGES.has(pageName) ? pageName : 'live';
  const params = new URLSearchParams(queryString);
  return { page, sessionId: params.get('sessionId') || '' };
}

function App() {
  const [page, setPage] = useState(pageFromLocation);
  const [status, setStatus] = useState('idle');
  const [statusLabelOverride, setStatusLabelOverride] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  const [transcript, setTranscript] = useState(createTranscriptState);
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
  const [retranslationSessionId, setRetranslationSessionId] = useState(() => pageInfoFromLocation().sessionId);
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [meetingCheckpointStatus, setMeetingCheckpointStatus] = useState('idle');
  const sessionRef = useRef(null);
  const transcriptRef = useRef(transcript);
  const reconnectControllerRef = useRef(null);
  const reconnectSessionRef = useRef(null);
  const sessionRepositoryRef = useRef(createMemorySessionRepository());
  const sessionSnapshotApiClientRef = useRef(createSessionSnapshotApiClient());
  const sessionSnapshotSyncCoordinatorRef = useRef(null);
  const meetingCheckpointApiClientRef = useRef(createMeetingCheckpointApiClient());
  const meetingCheckpointSyncCoordinatorRef = useRef(null);
  const segmentSwitchOrchestratorRef = useRef(null);
  const activeMeetingCheckpointRef = useRef(null);
  const liveSessionIdSequenceRef = useRef(0);
  const segmentSwitchCancelledRef = useRef(false);
  const sessionReadApiClientRef = useRef(createSessionReadApiClient());
  const translationCommandLifecycleRef = useRef(null);
  const activeSessionRecordIdRef = useRef(null);
  const suppressReconnectErrorRef = useRef(false);
  const detailRequestIdRef = useRef(0);
  const selectedHistoryRecordIdRef = useRef(null);

  const isActive =
    status === 'requesting-permission' ||
    status === 'connecting' ||
    status === 'listening' ||
    status === 'reconnecting' ||
    status === 'switching-segment';

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
    reconnectController().reset();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = false;
    suppressReconnectErrorRef.current = false;
    setStatusLabelOverride('');
    let session;

    try {
      const liveSessionId = generateLiveSessionId();
      const meetingCheckpoint = await createMeetingCheckpointForSession({ liveSessionId });
      session = await createSession({ preserveTranscript: false });
      sessionRef.current = session;

      await session.start();
      await createCurrentSessionRecord(meetingCheckpoint);
      setStatus('listening');
      segmentSwitchOrchestrator().start();
    } catch (nextError) {
      await session?.stop().catch(() => {});
      activeMeetingCheckpointRef.current = null;
      meetingCheckpointSyncCoordinatorRef.current?.cancel();
      segmentSwitchOrchestratorRef.current?.cancel();
      setError(nextError.message || '無法開始即時翻譯。');
      setStatus('error');
    }
  }

  async function stopSession() {
    reconnectController().cancel();
    segmentSwitchOrchestrator().cancel();
    segmentSwitchCancelledRef.current = true;
    suppressReconnectErrorRef.current = false;
    setStatusLabelOverride('');
    const reconnectingSession = reconnectSessionRef.current;
    reconnectSessionRef.current = null;
    await reconnectingSession?.stop().catch(() => {});
    await sessionRef.current?.stop();
    sessionRef.current = null;
    await finalizePendingTranscriptItemsForStop();
    await flushMeetingCheckpointSync();
    await finalizeCurrentSessionRecord({
      status: 'stopped',
      failureReason: 'user_stop',
      failureCategory: 'user_intent'
    });
    setStatus('stopped');
  }

  async function createSession({ preserveTranscript }) {
    if (!preserveTranscript) {
      setError('');
      setDeviceMessage('');
      setTranscriptTimeOrigin(Date.now());
      const resetTranscript = resetTranscriptState();
      transcriptRef.current = resetTranscript;
      setTranscript(() => resetTranscript);
      setCopiedArticleStream('');
      setStatus('requesting-permission');
    }

    const inputDeviceIdForSession = inputDevices.some((device) => device.deviceId === selectedInputDeviceId)
      ? selectedInputDeviceId
      : '';

    const { LiveTranslateSession } = await import('./lib/liveSession.js');

    return new LiveTranslateSession({
      targetLanguageCode,
      sourceLanguageCode,
      echoTargetLanguage,
      liveGlossaryEntries: liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode),
      inputDeviceId: inputDeviceIdForSession,
      onInputDeviceFallback: () => {
        setSelectedInputDeviceId('');
        setDeviceMessage('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
      },
      onMicrophoneReady: () => {
        void refreshInputDevices();
      },
      onConnecting: () => {
        setStatus((current) => (
          current === 'reconnecting' || current === 'switching-segment' ? current : 'connecting'
        ));
      },
      onInputTranscript: (update) => applyTranscriptUpdate({ ...update, stream: 'source' }),
      onOutputTranscript: (update) => applyTranscriptUpdate({ ...update, stream: 'translation' }),
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
    if (classification.reason !== 'unexpected_close' || generationId !== reconnectController().currentGeneration()) {
      return;
    }

    setError('');
    setStatusLabelOverride('');
    setStatus('reconnecting');

    const session = await createSession({ preserveTranscript: true });
    reconnectSessionRef.current = session;

    try {
      await session.start();
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

    if (generationId !== reconnectController().currentGeneration()) {
      await session.stop().catch(() => {});
      return;
    }

    reconnectSessionRef.current = null;
    sessionRef.current = session;
    setStatusLabelOverride('');
    setStatus('listening');
  }

  async function switchMeetingSegment() {
    const meetingCheckpoint = activeMeetingCheckpointRef.current;
    const previousSession = sessionRef.current;
    if (!meetingCheckpoint || !previousSession || segmentSwitchCancelledRef.current) return;

    setError('');
    setStatusLabelOverride('切換下一段中');
    setStatus('switching-segment');

    await finalizePendingTranscriptItemsForStop();
    if (segmentSwitchCancelledRef.current) return;

    const flushed = await flushMeetingCheckpointSync();
    if (!flushed) throw new Error('無法同步目前段落 checkpoint。');
    if (segmentSwitchCancelledRef.current) return;

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

    await previousSession.stop().catch(() => {});
    if (sessionRef.current === previousSession) {
      sessionRef.current = null;
    }

    const nextSession = await createSession({ preserveTranscript: true });
    try {
      await nextSession.start();
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

  async function createCurrentSessionRecord(meetingCheckpoint = activeMeetingCheckpointRef.current) {
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
    await flushSessionSnapshot(record.id);
    void translationCommandLifecycle().recordSessionStarted(record);
    return record;
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

  async function finalizeCurrentSessionRecord(options) {
    const sessionId = activeSessionRecordIdRef.current;
    activeSessionRecordIdRef.current = null;

    try {
      await flushMeetingCheckpointSync();
      const finalized = finalizeActiveSessionRecord(sessionRepositoryRef.current, sessionId, buildFinalizePatch(options));

      if (finalized) {
        await flushSessionSnapshot(sessionId);
        await translationCommandLifecycle().recordSessionFinalized(finalized);
        await refreshHistoryRecords();
      }

      return finalized;
    } catch {
      return null;
    } finally {
      activeMeetingCheckpointRef.current = null;
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
    return sessionSnapshotApiClientRef.current.sync({ session: detail.sessionRecord, transcriptItems: detail.transcriptItems });
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
    sessionSnapshotSyncCoordinator().schedule(sessionId);
  }

  function flushSessionSnapshot(sessionId) {
    return sessionSnapshotSyncCoordinator().flush(sessionId);
  }

  function reportSessionSnapshotSyncError(error) {
    console.error('Session snapshot persistence failed.', error);
    setError('無法儲存工作階段紀錄，但目前逐字稿仍保留在畫面上。');
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

  async function refreshHistoryRecords() {
    try {
      const history = await sessionReadApiClientRef.current.listSessionHistory();
      const finalizedRecords = history
        .filter((record) => TERMINAL_HISTORY_STATUSES.has(record.status))
        .sort((a, b) => historyRecordSortTime(b) - historyRecordSortTime(a));

      setHistoryRecords(finalizedRecords);
    } catch {
      setError('工作階段紀錄無法使用。');
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
    setSelectedHistoryDetail(undefined);

    try {
      const detail = await sessionReadApiClientRef.current.getSessionDetail(id);

      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return;
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

  async function deleteHistoryRecord(id) {
    if (!window.confirm('確定要刪除此翻譯紀錄？')) {
      return;
    }

    try {
      await sessionReadApiClientRef.current.deleteSessionRecord(id);
      setError('');
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
    const articleText = articleTextForStream(transcript, stream);
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
    const articleText = articleTextForStream(transcript, stream);
    if (!articleText) return;
    downloadTextFile(articleText, buildArticleFileName(stream), 'text/plain;charset=utf-8');
  }

  const sourceTranscriptItems = transcriptItemsForStream(transcript, 'source');
  const translationTranscriptItems = transcriptItemsForStream(transcript, 'translation');
  const transcriptItems = [...sourceTranscriptItems, ...translationTranscriptItems];
  const completedSourceSegments = transcript.source.finalItems;
  const completedTranslationSegments = transcript.translation.finalItems;
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
                disabled={isActive}
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
                disabled={isActive}
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
              disabled={isActive}
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
              disabled={isActive}
            />
            <span>朗讀翻譯語言</span>
          </label>

          {status === 'listening' ? (
            <button className="button secondary" type="button" onClick={stopSession}>
              <Square size={18} aria-hidden="true" />
              停止
            </button>
          ) : status === 'reconnecting' || status === 'switching-segment' ? (
            <button className="button secondary" type="button" onClick={stopSession}>
              <Square size={18} aria-hidden="true" />
              停止
            </button>
          ) : (
            <button className="button primary" type="button" onClick={startSession} disabled={isActive}>
              {isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
              {isActive ? '正在開始' : '開始'}
            </button>
          )}
        </div>

          {status === 'reconnecting' ? <p className="device-note">正在重新連線即時翻譯…</p> : null}
          {status === 'switching-segment' ? <p className="device-note">正在切換下一段即時翻譯…</p> : null}
          {deviceMessage ? <p className="device-note">{deviceMessage}</p> : null}
          <p className={`checkpoint-note checkpoint-note-${meetingCheckpointStatus}`}>
            {meetingCheckpointStatusLabel(meetingCheckpointStatus)}
          </p>
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

        <section className="transcript-grid" aria-label="文章版閱讀區">
          <ArticlePanel
            title="原文文章"
            stream="source"
            paragraphs={sourceArticleParagraphs}
            currentPartial={traditionalChineseTranscriptItem(transcript.source.currentPartial)}
            currentLabel="辨識中…"
            emptyText="尚無原文內容。"
            copied={copiedArticleStream === 'source'}
            onCopy={() => copyArticle('source')}
            onExport={() => downloadArticle('source')}
          />
          <ArticlePanel
            title="翻譯文章"
            stream="translation"
            paragraphs={translationArticleParagraphs}
            currentPartial={transcript.translation.currentPartial}
            currentLabel="翻譯中…"
            emptyText="尚無翻譯內容。"
            copied={copiedArticleStream === 'translation'}
            onCopy={() => copyArticle('translation')}
            onExport={() => downloadArticle('translation')}
          />
        </section>
      </section>

      <section className="feature-page history-page" aria-labelledby="history-page-title" hidden={page !== 'history'}>
        <HistoryPanel
          titleId="history-page-title"
          records={historyRecords}
          selectedRecordId={selectedHistoryRecordId}
          selectedDetail={selectedHistoryDetail}
          selectedRecord={selectedHistoryRecord}
          onViewDetails={openHistoryRecordDetail}
          onDeleteRecord={deleteHistoryRecord}
          onRetranslationSubmitted={refreshSelectedHistoryRecordDetail}
          onOpenRetranslationWorkflow={openRetranslationWorkflow}
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

function reconnectErrorMessage(result) {
  if (result?.decision?.stopReason === 'max_attempts_exceeded') {
    return RECONNECT_EXHAUSTED_MESSAGE;
  }

  return RECONNECT_FAILED_MESSAGE;
}

function articleTextForStream(transcript, stream) {
  const articleText = formatTranscriptArticleText(transcript?.[stream]?.finalItems || []);
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

function HistoryPanel({ titleId, records, selectedRecordId, selectedDetail, selectedRecord, onViewDetails, onDeleteRecord, onRetranslationSubmitted, onOpenRetranslationWorkflow }) {
  return (
    <section className="history-panel" aria-labelledby={titleId}>
      <div className="history-header">
        <div>
          <h2 id={titleId}>翻譯紀錄</h2>
          <p className="history-description">查看已儲存的工作階段、正式輸出與排隊中的翻譯工作。</p>
        </div>
      </div>

      {records.length === 0 ? (
        <p className="history-empty">尚無工作階段紀錄。</p>
      ) : (
        <ol className="history-list">
          {records.map((record) => (
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
          ))}
        </ol>
      )}
    </section>
  );
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

  const translationHistory = compactTranslationHistoryForDetail(detail);
  const retranslationProgress = retranslationProgressFor(translationHistory, trackedRetranslations);
  const hasPendingRetranslationProgress = hasPendingRetranslationItems(retranslationProgress);

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
        <p className="history-empty">此工作階段紀錄無法使用。</p>
      </section>
    );
  }

  const sessionRecord = sessionRecordForDetailDTO(detail, historyRecord);
  const retranslationSourceSessionId = sourceSessionIdForRetranslation(sessionRecord, sessionRecordId);
  const sourceItems = finalTranscriptItemsForStream(detail.sourceTranscript?.items, 'source');
  const translationItems = finalTranscriptItemsForStream(detail.selectedTranslationOutput?.items, 'translation');
  const readingContent = readingContentForDetail(detail, { sourceItems, translationItems, sessionRecord });
  const exportDetail = exportDetailForSessionDetailDTO(detail, historyRecord);
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

      <ReadingContentTabs
        content={readingContent}
        selectedTab={readingTab}
        onSelectTab={setReadingTab}
      />

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
    <section className="session-reading-panel" aria-label="歷史紀錄閱讀內容">
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
    stopped: '已停止',
    expired: '工作階段已過期',
    error: '需要處理'
  };

  return labels[status] || status;
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
