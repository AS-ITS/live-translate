import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Download, Mic, MicOff, Radio, Square } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from './lib/languages.js';
import { classifyConnectionFailure } from './lib/connectionFailures.js';
import { failureUiStateForClassification } from './lib/failureUiState.js';
import { LiveTranslateSession } from './lib/liveSession.js';
import { audioInputDevices } from './lib/mediaDevices.js';
import { createReconnectController } from './lib/reconnectController.js';
import { createMemorySessionRepository } from './lib/sessionRepository.js';
import { createSessionReadApiClient } from './lib/sessionReadApiClient.js';
import { createSessionSnapshotApiClient } from './lib/sessionSnapshotApiClient.js';
import { createTranslationCommandApiClient } from './lib/translationCommandApiClient.js';
import { createSessionRetranslationApiClient } from './lib/sessionRetranslationApiClient.js';
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
import { toTraditionalChineseText } from './lib/chineseText.js';
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
import { HISTORY_REFRESH_MS } from './lib/sessionHistoryState.js';
import './styles.css';

const RECONNECT_FAILED_MESSAGE = '無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時翻譯多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);
const FEATURE_PAGES = new Set(['live', 'history']);
const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const PENDING_TRANSCRIPT_IDLE_FINALIZE_MS = 3000;

function pageFromLocation() {
  const page = window.location.hash.replace('#', '');
  return FEATURE_PAGES.has(page) ? page : 'live';
}

function App() {
  const [page, setPage] = useState(pageFromLocation);
  const [status, setStatus] = useState('idle');
  const [statusLabelOverride, setStatusLabelOverride] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
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
  const sessionRef = useRef(null);
  const transcriptRef = useRef(transcript);
  const reconnectControllerRef = useRef(null);
  const reconnectSessionRef = useRef(null);
  const sessionRepositoryRef = useRef(createMemorySessionRepository());
  const sessionSnapshotApiClientRef = useRef(createSessionSnapshotApiClient());
  const sessionReadApiClientRef = useRef(createSessionReadApiClient());
  const translationCommandLifecycleRef = useRef(null);
  const activeSessionRecordIdRef = useRef(null);
  const suppressReconnectErrorRef = useRef(false);
  const detailRequestIdRef = useRef(0);
  const selectedHistoryRecordIdRef = useRef(null);

  const isActive =
    status === 'requesting-permission' || status === 'connecting' || status === 'listening' || status === 'reconnecting';

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
    const handleHashChange = () => setPage(pageFromLocation());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => () => {
    reconnectControllerRef.current?.cancel();
    const sessions = new Set([sessionRef.current, reconnectSessionRef.current]);
    sessionRef.current = null;
    reconnectSessionRef.current = null;
    for (const session of sessions) {
      void session?.stop().catch(() => {});
    }
  }, []);

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
    suppressReconnectErrorRef.current = false;
    setStatusLabelOverride('');
    const session = createSession({ preserveTranscript: false });

    sessionRef.current = session;

    try {
      await session.start();
      await createCurrentSessionRecord();
      setStatus('listening');
    } catch (nextError) {
      await session.stop().catch(() => {});
      setError(nextError.message || '無法開始即時翻譯。');
      setStatus('error');
    }
  }

  async function stopSession() {
    reconnectController().cancel();
    suppressReconnectErrorRef.current = false;
    setStatusLabelOverride('');
    const reconnectingSession = reconnectSessionRef.current;
    reconnectSessionRef.current = null;
    await reconnectingSession?.stop().catch(() => {});
    await sessionRef.current?.stop();
    sessionRef.current = null;
    await finalizePendingTranscriptItemsForStop();
    await finalizeCurrentSessionRecord({
      status: 'stopped',
      failureReason: 'user_stop',
      failureCategory: 'user_intent'
    });
    setStatus('stopped');
  }

  function createSession({ preserveTranscript }) {
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

    return new LiveTranslateSession({
      targetLanguageCode,
      echoTargetLanguage,
      inputDeviceId: inputDeviceIdForSession,
      onInputDeviceFallback: () => {
        setSelectedInputDeviceId('');
        setDeviceMessage('所選麥克風無法使用，已改用瀏覽器預設麥克風。');
      },
      onMicrophoneReady: () => {
        void refreshInputDevices();
      },
      onConnecting: () => {
        setStatus((current) => (current === 'reconnecting' ? 'reconnecting' : 'connecting'));
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

  async function startReconnectSession({ generationId, classification }) {
    if (classification.reason !== 'unexpected_close' || generationId !== reconnectController().currentGeneration()) {
      return;
    }

    setError('');
    setStatusLabelOverride('');
    setStatus('reconnecting');

    const session = createSession({ preserveTranscript: true });
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

  function reconnectController() {
    if (!reconnectControllerRef.current) {
      reconnectControllerRef.current = createReconnectController({
        executeReconnect: startReconnectSession
      });
    }

    return reconnectControllerRef.current;
  }

  async function createCurrentSessionRecord() {
    const record = createActiveSessionRecord(
      sessionRepositoryRef.current,
      buildSessionRecordInput({
        startedAt: Date.now(),
        targetLanguageCode,
        targetLanguageLabel: targetLanguageLabelFor(targetLanguageCode),
        ...selectedInputDeviceSnapshot()
      })
    );
    activeSessionRecordIdRef.current = record.id;
    await syncSessionSnapshot(record.id);
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
        void syncSessionSnapshot(activeSessionRecordId);
        void translationCommandLifecycle().recordFinalTranscriptItems(activeSessionRecord, appended);
      }
    }
  }

  async function finalizeCurrentSessionRecord(options) {
    const sessionId = activeSessionRecordIdRef.current;
    activeSessionRecordIdRef.current = null;

    try {
      const finalized = finalizeActiveSessionRecord(sessionRepositoryRef.current, sessionId, buildFinalizePatch(options));

      if (finalized) {
        await syncSessionSnapshot(sessionId);
        await translationCommandLifecycle().recordSessionFinalized(finalized);
        await refreshHistoryRecords();
      }

      return finalized;
    } catch {
      return null;
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
      await syncSessionSnapshot(activeSessionRecordId);
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

  function selectedInputDeviceSnapshot() {
    const selectedDevice = inputDevices.find((device) => device.deviceId === selectedInputDeviceId);

    return {
      selectedInputDeviceId: selectedDevice?.deviceId || '',
      inputDeviceLabelSnapshot: selectedDevice?.label || null
    };
  }

  function navigateTo(nextPage) {
    if (nextPage === page) {
      return;
    }

    window.location.hash = nextPage;
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
          <a href="#live" aria-current={page === 'live' ? 'page' : undefined} onClick={() => navigateTo('live')}>即時翻譯</a>
          <a href="#history" aria-current={page === 'history' ? 'page' : undefined} onClick={() => navigateTo('history')}>翻譯紀錄</a>
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

          <label className="toggle">
            <input
              type="checkbox"
              checked={echoTargetLanguage}
              onChange={(event) => setEchoTargetLanguage(event.target.checked)}
              disabled={isActive}
            />
            <span>朗讀翻譯語言</span>
          </label>

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

          {status === 'listening' ? (
            <button className="button secondary" type="button" onClick={stopSession}>
              <Square size={18} aria-hidden="true" />
              停止
            </button>
          ) : status === 'reconnecting' ? (
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
          {deviceMessage ? <p className="device-note">{deviceMessage}</p> : null}
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
          onCloseDetails={closeHistoryRecordDetail}
          onRetranslationSubmitted={refreshSelectedHistoryRecordDetail}
        />
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

function HistoryPanel({ titleId, records, selectedRecordId, selectedDetail, selectedRecord, onViewDetails, onCloseDetails, onRetranslationSubmitted }) {
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
                  <button className="button detail-button" type="button" onClick={() => onViewDetails(record.id)}>
                    查看詳細資料
                  </button>
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
                {shouldShowFailureReason(record) ? <p className="history-reason">原因：{record.failureReason}</p> : null}
              </article>
              {selectedRecordId === record.id ? (
                <SessionDetail
                  detail={selectedDetail}
                  historyRecord={selectedRecord}
                  onClose={onCloseDetails}
                  onRetranslationSubmitted={onRetranslationSubmitted}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionDetail({ detail, historyRecord, onClose, onRetranslationSubmitted }) {
  const [savedExportFormat, setSavedExportFormat] = useState('txt');
  const [savedExportStream, setSavedExportStream] = useState('translation');
  const [savedExportError, setSavedExportError] = useState('');
  const [showRetranslation, setShowRetranslation] = useState(false);
  const [retranslationLanguage, setRetranslationLanguage] = useState('en');
  const [isSubmittingRetranslation, setIsSubmittingRetranslation] = useState(false);
  const [retranslationError, setRetranslationError] = useState('');
  const [retranslationStatus, setRetranslationStatus] = useState('');
  const [trackedRetranslations, setTrackedRetranslations] = useState([]);
  const sessionRecordId = detail?.session?.id;

  useEffect(() => {
    setSavedExportFormat('txt');
    setSavedExportStream('translation');
    setSavedExportError('');
    setShowRetranslation(false);
    setRetranslationError('');
    setRetranslationStatus('');
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
          <button className="button detail-button" type="button" onClick={onClose}>
            關閉詳細資料
          </button>
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
          <button className="button detail-button" type="button" onClick={onClose}>
            關閉詳細資料
          </button>
        </div>
        <p className="history-empty">此工作階段紀錄無法使用。</p>
      </section>
    );
  }

  const sessionRecord = sessionRecordForDetailDTO(detail, historyRecord);
  const sourceItems = finalTranscriptItemsForStream(detail.sourceTranscript?.items, 'source');
  const translationItems = finalTranscriptItemsForStream(detail.selectedTranslationOutput?.items, 'translation');
  const hasTranscript = sourceItems.length > 0 || translationItems.length > 0;
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
        <button className="button detail-button" type="button" onClick={onClose}>
          關閉詳細資料
        </button>
      </div>

      <dl className="session-detail-metadata">
        <div>
          <dt>目標語言</dt>
          <dd>{historyLanguageLabel(sessionRecord)}</dd>
        </div>
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
      </dl>

      {hasTranscript ? (
        <div className="session-detail-transcripts">
          <TranscriptItemList title="原文逐字稿" items={sourceItems} />
          <TranscriptItemList title="翻譯逐字稿" items={translationItems} />
        </div>
      ) : (
        <p className="history-empty">沒有已儲存的逐字稿。</p>
      )}

      <section className="saved-export-panel" aria-label="重新翻譯">
        <button className="button detail-button" type="button" onClick={() => setShowRetranslation((value) => !value)}>以此內容重新翻譯</button>
        {showRetranslation ? <div className="controls saved-export-controls">
          <label className="field"><span>目標語言</span><select value={retranslationLanguage} onChange={(event) => { setRetranslationLanguage(event.target.value); setRetranslationStatus(''); }}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <button className="button" type="button" disabled={isSubmittingRetranslation} onClick={async () => {
            setIsSubmittingRetranslation(true); setRetranslationError(''); setRetranslationStatus('');
            try {
              const result = await createSessionRetranslationApiClient().submit(sessionRecordId, { targetLanguageCode: retranslationLanguage });
              setTrackedRetranslations((current) => upsertTrackedRetranslation(current, trackedRetranslationForSubmitResult(result, retranslationLanguage)));
              setRetranslationStatus(`已將${targetLanguageLabelFor(retranslationLanguage)}重新翻譯加入佇列。`);
              setShowRetranslation(false);
              await onRetranslationSubmitted?.(sessionRecordId);
            } catch { setRetranslationError('無法將重新翻譯加入佇列。請再試一次。'); }
            finally { setIsSubmittingRetranslation(false); }
          }}>{isSubmittingRetranslation ? '正在送出…' : '開始翻譯'}</button>
          {retranslationError ? <p className="error-message" role="alert">{retranslationError}</p> : null}
        </div> : null}
        {retranslationStatus ? <p className="success-message" role="status">{retranslationStatus}</p> : null}
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

function RetranslationProgress({ progress }) {
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
              <span className={`history-status history-status-${execution.status}`}>{translationExecutionStatusLabel(execution.status)}</span>
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
              {output.translatedText ? <p>{output.translatedText}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function TranscriptItemList({ title, items }) {
  const paragraphs = buildTranscriptArticleParagraphs(
    title === '原文逐字稿' ? items.map(traditionalChineseTranscriptItem) : items
  );

  return (
    <section className="session-transcript-section" aria-label={title}>
      <h4>{title}</h4>
      {paragraphs.length === 0 ? (
        <p className="history-empty">沒有已儲存的逐字稿。</p>
      ) : (
        <div className="session-transcript-article article-content">
          {paragraphs.map((paragraph, index) => (
            <p key={`${title}-article-${index}`}>{paragraph}</p>
          ))}
        </div>
      )}
    </section>
  );
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

function translationExecutionStatusLabel(status) {
  const labels = {
    queued: '已排隊',
    processing: '處理中',
    running: '處理中',
    failed: '失敗',
    cancelled: '已取消'
  };

  return labels[status] || status || '未知狀態';
}

function translationOutputTitle(output) {
  const languageLabel = targetLanguageLabelFor(output.targetLanguageCode) || output.targetLanguageCode || '未知語言';
  const versionLabel = Number.isFinite(output.version) ? ` v${output.version}` : '';
  return `${languageLabel}${versionLabel}`;
}

function compactTranslationHistoryForDetail(detail) {
  const history = detail?.translationHistory || {};
  return {
    outputs: Array.isArray(history.outputs) ? history.outputs : [],
    executions: Array.isArray(history.executions) ? history.executions : []
  };
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

function retranslationProgressFor(history, trackedRetranslations) {
  const outputs = history.outputs.filter(isFormalRetranslationOutput);
  const executions = history.executions.filter(isRetranslationExecution);
  const knownKeys = new Set();

  for (const output of outputs) {
    addProgressKeys(knownKeys, output);
  }

  for (const execution of executions) {
    addProgressKeys(knownKeys, execution);
  }

  for (const tracked of trackedRetranslations) {
    if (hasProgressKey(knownKeys, tracked)) {
      continue;
    }

    const optimisticExecution = {
      id: tracked.executionId || tracked.requestId,
      requestId: tracked.requestId,
      targetLanguageCode: tracked.targetLanguageCode,
      status: 'queued'
    };

    executions.push(optimisticExecution);
    addProgressKeys(knownKeys, optimisticExecution);
  }

  return { outputs, executions };
}

function isFormalRetranslationOutput(output) {
  return output?.source !== 'legacy' && (
    output?.source === 'formal' ||
    Boolean(output?.requestId) ||
    Boolean(output?.executionId)
  );
}

function isRetranslationExecution(execution) {
  return Boolean(execution?.id || execution?.requestId);
}

function addProgressKeys(keys, item) {
  if (item?.requestId) {
    keys.add(`request:${item.requestId}`);
  }

  const executionId = item?.executionId || item?.id;
  if (executionId) {
    keys.add(`execution:${executionId}`);
  }
}

function hasProgressKey(keys, item) {
  return Boolean(
    (item?.requestId && keys.has(`request:${item.requestId}`)) ||
    (item?.executionId && keys.has(`execution:${item.executionId}`))
  );
}

function hasPendingRetranslationItems(progress) {
  return progress.executions.some((execution) => ['queued', 'processing', 'running'].includes(execution.status));
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
    targetLanguageLabel: historyRecord?.targetLanguageLabel || selectedTranslationOutput.targetLanguageLabel || null
  };
}

function exportDetailForSessionDetailDTO(detail, historyRecord) {
  return {
    sessionRecord: sessionRecordForDetailDTO(detail, historyRecord),
    transcriptItems: [...(detail?.sourceTranscript?.items || []), ...(detail?.selectedTranslationOutput?.items || [])]
  };
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
    stopped: '已停止',
    expired: '工作階段已過期',
    error: '需要處理'
  };

  return labels[status] || status;
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
