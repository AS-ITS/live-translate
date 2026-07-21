import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Download, Mic, MicOff, Radio, Square } from 'lucide-react';
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
import { HISTORY_REFRESH_MS, hasPendingExecutions, selectedOutputFor } from './lib/sessionHistoryState.js';
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
import {
  applyTranscriptEvent,
  createTranscriptState,
  resetTranscriptState,
  transcriptItemsForStream,
  transcriptTextForStream
} from './lib/transcript.js';
import './styles.css';

const RECONNECT_FAILED_MESSAGE = 'Unable to reconnect live translation. You can start a new session when ready.';
const RECONNECT_EXHAUSTED_MESSAGE = 'Live translation could not reconnect after repeated attempts. You can start a new session when ready.';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);

function App() {
  const [status, setStatus] = useState('idle');
  const [statusLabelOverride, setStatusLabelOverride] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('zh-Hant');
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  const [transcript, setTranscript] = useState(createTranscriptState);
  const [transcriptTimeOrigin, setTranscriptTimeOrigin] = useState(null);
  const [exportFormat, setExportFormat] = useState('txt');
  const [exportStream, setExportStream] = useState('translation');
  const [inputDevices, setInputDevices] = useState([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState('');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [error, setError] = useState('');
  const [historyRecords, setHistoryRecords] = useState([]);
  const [selectedHistoryRecordId, setSelectedHistoryRecordId] = useState(null);
  const [selectedHistoryDetail, setSelectedHistoryDetail] = useState(null);
  const [selectedTranslationHistory, setSelectedTranslationHistory] = useState(null);
  const sessionRef = useRef(null);
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

        setDeviceMessage('Selected microphone is unavailable. Using browser default microphone.');
        return '';
      });
    } catch {
      setDeviceMessage('Microphone list is unavailable. Using browser default microphone.');
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
      setError(nextError.message || 'Unable to start live translation');
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
      setTranscript(resetTranscriptState());
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
        setDeviceMessage('Selected microphone is unavailable. Using browser default microphone.');
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
    setTranscript((current) => {
      const next = applyTranscriptEvent(current, update);
      const activeSessionRecordId = activeSessionRecordIdRef.current;
      const appended = appendNewFinalTranscriptItems(sessionRepositoryRef.current, activeSessionRecordId, current, next);

      if (appended.length > 0) {
        const activeSessionRecord = sessionRepositoryRef.current.getSessionRecord(activeSessionRecordId)?.sessionRecord;
        if (activeSessionRecord) {
          void syncSessionSnapshot(activeSessionRecordId);
          void translationCommandLifecycle().recordFinalTranscriptItems(activeSessionRecord, appended);
        }
      }

      return next;
    });
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
      setError('Session history is unavailable.');
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
    setError('Translation persistence is unavailable. Live translation can continue.');
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
    setSelectedTranslationHistory(undefined);

    try {
      const detail = await sessionReadApiClientRef.current.getSessionDetail(id);

      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return;
      }

      setSelectedHistoryDetail(detail);

      const translationHistory = await sessionReadApiClientRef.current.getSessionTranslations(id).catch(() => null);

      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return;
      }

      setSelectedTranslationHistory(translationHistory);
    } catch {
      if (detailRequestIdRef.current !== requestId || selectedHistoryRecordIdRef.current !== id) {
        return;
      }

      setSelectedHistoryDetail(null);
      setSelectedTranslationHistory(null);
      setError('Session details are unavailable.');
    }
  }

  function closeHistoryRecordDetail() {
    detailRequestIdRef.current += 1;
    selectedHistoryRecordIdRef.current = null;
    setSelectedHistoryRecordId(null);
    setSelectedHistoryDetail(null);
    setSelectedTranslationHistory(null);
  }

  function selectedInputDeviceSnapshot() {
    const selectedDevice = inputDevices.find((device) => device.deviceId === selectedInputDeviceId);

    return {
      selectedInputDeviceId: selectedDevice?.deviceId || '',
      inputDeviceLabelSnapshot: selectedDevice?.label || null
    };
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
      const blob = new Blob([content], { type: contentTypeForFormat(exportFormat) });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Transcript export is unavailable for the selected options.');
    }
  }

  const sourceTranscriptItems = transcriptItemsForStream(transcript, 'source');
  const translationTranscriptItems = transcriptItemsForStream(transcript, 'translation');
  const transcriptItems = [...sourceTranscriptItems, ...translationTranscriptItems];
  const inputTranscriptText = transcriptTextForStream(transcript, 'source');
  const outputTranscriptText = transcriptTextForStream(transcript, 'translation');
  const canDownloadTranscript = canExportTranscript(transcriptItems, {
    format: exportFormat,
    stream: exportStream,
    timeOrigin: transcriptTimeOrigin
  });
  const exportUnavailableReason =
    exportFormat !== 'txt' && exportStream === 'both' ? 'SRT and VTT export one stream at a time.' : '';
  const selectedHistoryRecord = selectedHistoryRecordId
    ? historyRecords.find((historyRecord) => historyRecord.id === selectedHistoryRecordId) || null
    : null;

  return (
    <main className="app-shell">
      <section className="control-panel" aria-labelledby="app-title">
        <div className="title-block">
          <div className="status-pill">
            <Radio size={16} aria-hidden="true" />
            {statusLabel(status, statusLabelOverride)}
          </div>
          <h1 id="app-title">Live Translate</h1>
          <p>Real-time speech translation powered by Gemini Live API.</p>
        </div>

        <div className="controls" aria-label="Translation controls">
          <label className="field">
            <span>Target language</span>
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
            <span>Echo target language</span>
          </label>

          <label className="field">
            <span>Microphone</span>
            <select
              value={selectedInputDeviceId}
              onChange={(event) => {
                setSelectedInputDeviceId(event.target.value);
                setDeviceMessage('');
              }}
              disabled={isActive}
            >
              <option value="">Browser default microphone</option>
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
              Stop
            </button>
          ) : status === 'reconnecting' ? (
            <button className="button secondary" type="button" onClick={stopSession}>
              <Square size={18} aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button className="button primary" type="button" onClick={startSession} disabled={isActive}>
              {isActive ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
              {isActive ? 'Starting' : 'Start'}
            </button>
          )}
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {status === 'reconnecting' ? <p className="device-note">Reconnecting live translation...</p> : null}
        {deviceMessage ? <p className="device-note">{deviceMessage}</p> : null}
      </section>

      <section className="export-panel" aria-label="Transcript export">
        <div className="controls export-controls">
          <label className="field">
            <span>Export format</span>
            <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)}>
              <option value="txt">TXT</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
            </select>
          </label>

          <label className="field">
            <span>Export stream</span>
            <select value={exportStream} onChange={(event) => setExportStream(event.target.value)}>
              <option value="translation">Translation</option>
              <option value="source">Source</option>
              <option value="both">Both</option>
            </select>
          </label>

          <button className="button secondary" type="button" onClick={downloadTranscript} disabled={!canDownloadTranscript}>
            <Download size={18} aria-hidden="true" />
            Download
          </button>
        </div>
        {exportUnavailableReason ? <p className="export-note">{exportUnavailableReason}</p> : null}
      </section>

      <section className="transcript-grid" aria-label="Live transcripts">
        <TranscriptPanel title="Source speech" text={inputTranscriptText} emptyText="Waiting for source speech..." />
        <TranscriptPanel title="Translated speech" text={outputTranscriptText} emptyText="Waiting for translated speech..." />
      </section>

      <HistoryPanel
        records={historyRecords}
        selectedRecordId={selectedHistoryRecordId}
        selectedDetail={selectedHistoryDetail}
        selectedTranslationHistory={selectedTranslationHistory}
        selectedRecord={selectedHistoryRecord}
        onViewDetails={openHistoryRecordDetail}
        onCloseDetails={closeHistoryRecordDetail}
      />
    </main>
  );
}

function reconnectErrorMessage(result) {
  if (result?.decision?.stopReason === 'max_attempts_exceeded') {
    return RECONNECT_EXHAUSTED_MESSAGE;
  }

  return RECONNECT_FAILED_MESSAGE;
}

function TranscriptPanel({ title, text, emptyText }) {
  return (
    <article className="transcript-panel">
      <h2>{title}</h2>
      <p className={text ? 'transcript-text' : 'transcript-text empty'}>{text || emptyText}</p>
    </article>
  );
}

function HistoryPanel({ records, selectedRecordId, selectedDetail, selectedTranslationHistory, selectedRecord, onViewDetails, onCloseDetails }) {
  return (
    <section className="history-panel" aria-labelledby="history-title">
      <div className="history-header">
        <h2 id="history-title">Session history</h2>
      </div>

      {records.length === 0 ? (
        <p className="history-empty">No session history yet.</p>
      ) : (
        <ol className="history-list">
          {records.map((record) => (
            <li className="history-item" key={record.id}>
              <article aria-label={`${historyLanguageLabel(record)} ${historyStatusLabel(record.status)} session`}>
                <div className="history-item-header">
                  <div>
                    <h3>{historyLanguageLabel(record)}</h3>
                    <span className={`history-status history-status-${record.status}`}>{historyStatusLabel(record.status)}</span>
                  </div>
                  <button className="button detail-button" type="button" onClick={() => onViewDetails(record.id)}>
                    View details
                  </button>
                </div>

                <dl className="history-metadata">
                  <div>
                    <dt>Started</dt>
                    <dd>{formatRecordTime(record.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Ended</dt>
                    <dd>{formatRecordTime(record.endedAt)}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(record.durationMs)}</dd>
                  </div>
                </dl>

                <p className="history-summary">{transcriptSummaryLabel(record.transcriptSummary)}</p>
                {shouldShowFailureReason(record) ? <p className="history-reason">Reason: {record.failureReason}</p> : null}
              </article>
              {selectedRecordId === record.id ? (
                <SessionDetail detail={selectedDetail} translationHistory={selectedTranslationHistory} historyRecord={selectedRecord} onClose={onCloseDetails} />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionDetail({ detail, translationHistory, historyRecord, onClose }) {
  const [savedExportFormat, setSavedExportFormat] = useState('txt');
  const [savedExportStream, setSavedExportStream] = useState('translation');
  const [savedExportError, setSavedExportError] = useState('');
  const [translationLanguageFilter, setTranslationLanguageFilter] = useState('');
  const [selectedOutputId, setSelectedOutputId] = useState(null);
  const [showRetranslation, setShowRetranslation] = useState(false);
  const [retranslationLanguage, setRetranslationLanguage] = useState('en');
  const [isSubmittingRetranslation, setIsSubmittingRetranslation] = useState(false);
  const [retranslationError, setRetranslationError] = useState('');
  const [localExecutions, setLocalExecutions] = useState([]);
  const [historyData, setHistoryData] = useState(translationHistory);
  const [refreshError, setRefreshError] = useState('');
  const sessionRecordId = detail?.session?.id;

  useEffect(() => {
    setSavedExportFormat('txt');
    setSavedExportStream('translation');
    setSavedExportError('');
    setTranslationLanguageFilter('');
    setSelectedOutputId(null); setShowRetranslation(false); setRetranslationError(''); setLocalExecutions([]);
    setHistoryData(translationHistory); setRefreshError('');
  }, [sessionRecordId]);

  useEffect(() => { setHistoryData(translationHistory); }, [translationHistory]);
  useEffect(() => {
    if (!sessionRecordId || !hasPendingExecutions(historyData) && localExecutions.length === 0) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const next = await createSessionReadApiClient().getSessionTranslations(sessionRecordId);
        if (!active || !next) return;
        setHistoryData(next);
        const serverIds = new Set(next.translationHistory?.executions?.map((item) => item.id) || []);
        setLocalExecutions((items) => items.filter((item) => !serverIds.has(item.id)));
        setRefreshError('');
      } catch { if (active) setRefreshError('Translation history could not be refreshed.'); }
    };
    refresh(); const timer = setInterval(refresh, HISTORY_REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, [sessionRecordId, historyData, localExecutions.length]);

  if (detail === undefined) {
    return (
      <section className="session-detail" aria-label="Session details">
        <div className="session-detail-header">
          <h3>Loading session details</h3>
          <button className="button detail-button" type="button" onClick={onClose}>
            Close details
          </button>
        </div>
        <p className="history-empty">Loading saved session...</p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="session-detail" aria-label="Session details">
        <div className="session-detail-header">
          <h3>Session details unavailable</h3>
          <button className="button detail-button" type="button" onClick={onClose}>
            Close details
          </button>
        </div>
        <p className="history-empty">This session record is unavailable.</p>
      </section>
    );
  }

  const sessionRecord = sessionRecordForDetailDTO(detail, historyRecord);
  const sourceItems = finalTranscriptItemsForStream(detail.sourceTranscript?.items, 'source');
  const translationItems = finalTranscriptItemsForStream(detail.selectedTranslationOutput?.items, 'translation');
  const hasTranscript = sourceItems.length > 0 || translationItems.length > 0;
  const exportDetail = exportDetailForSessionDetailDTO(detail, historyRecord);
  const selectedFormalOutput = selectedOutputFor(historyData, selectedOutputId);
  const formalOutputItems = selectedFormalOutput?.source === 'formal' && selectedFormalOutput.translatedText
    ? [{ id: selectedFormalOutput.id, stream: 'translation', status: 'final', text: selectedFormalOutput.translatedText, sequence: 0, startedAt: sessionRecord.startedAt }]
    : null;
  const canDownloadSavedTranscript = formalOutputItems
    ? canExportTranscript(formalOutputItems, { format: savedExportFormat, stream: 'translation', timeOrigin: sessionRecord.startedAt })
    : canExportSavedSession(exportDetail, {
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
      const content = formalOutputItems ? formatTranscriptExport(formalOutputItems, {
        format: savedExportFormat,
        stream: 'translation',
        timeOrigin: sessionRecord.startedAt
      }) : formatSavedSessionExport(exportDetail, {
        format: savedExportFormat,
        stream: savedExportStream
      });
      const fileName = formalOutputItems
        ? `session-${sessionRecord.id}-${selectedFormalOutput.targetLanguageCode}-v${selectedFormalOutput.version}.${savedExportFormat}`
        : buildSavedSessionFileName(exportDetail.sessionRecord, {
        format: savedExportFormat,
        stream: savedExportStream
      });
      const blob = new Blob([content], { type: contentTypeForFormat(savedExportFormat) });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setSavedExportError('Saved transcript export is unavailable for the selected options.');
    }
  }

  return (
    <section className="session-detail" aria-label="Session details">
      <div className="session-detail-header">
        <h3>{historyLanguageLabel(sessionRecord)} details</h3>
        <button className="button detail-button" type="button" onClick={onClose}>
          Close details
        </button>
      </div>

      <dl className="session-detail-metadata">
        <div>
          <dt>Target language</dt>
          <dd>{historyLanguageLabel(sessionRecord)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{historyStatusLabel(sessionRecord.status)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatRecordTime(sessionRecord.startedAt)}</dd>
        </div>
        <div>
          <dt>Ended</dt>
          <dd>{formatRecordTime(sessionRecord.endedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(sessionRecord.durationMs)}</dd>
        </div>
        <div>
          <dt>Transcript</dt>
          <dd>{transcriptSummaryLabel(sessionRecord.transcriptSummary)}</dd>
        </div>
        {shouldShowFailureReason(sessionRecord) ? (
          <div>
            <dt>Failure reason</dt>
            <dd>{sessionRecord.failureReason}</dd>
          </div>
        ) : null}
        {sessionRecord.failureCategory ? (
          <div>
            <dt>Failure category</dt>
            <dd>{sessionRecord.failureCategory}</dd>
          </div>
        ) : null}
        {sessionRecord.inputDeviceLabelSnapshot ? (
          <div>
            <dt>Microphone</dt>
            <dd>{sessionRecord.inputDeviceLabelSnapshot}</dd>
          </div>
        ) : null}
      </dl>

      {hasTranscript ? (
        <div className="session-detail-transcripts">
          <TranscriptItemList title="Source transcript" items={sourceItems} />
          <TranscriptItemList title="Translation transcript" items={translationItems} />
        </div>
      ) : (
        <p className="history-empty">No saved transcript.</p>
      )}

      <TranslationHistoryPanel history={historyData ?? (detail.translationHistory === undefined ? undefined : { translationHistory: detail.translationHistory })} targetLanguageCode={translationLanguageFilter} onTargetLanguageCodeChange={setTranslationLanguageFilter} selectedOutputId={selectedOutputId} onSelectOutput={setSelectedOutputId} localExecutions={localExecutions} />
      {refreshError ? <p className="error-message" role="alert">{refreshError} <button className="detail-button" type="button" onClick={() => setHistoryData(null)}>Retry</button></p> : null}

      <section className="saved-export-panel" aria-label="Retranslation">
        <button className="button detail-button" type="button" onClick={() => setShowRetranslation((value) => !value)}>以此內容重新翻譯</button>
        {showRetranslation ? <div className="controls saved-export-controls">
          <label className="field"><span>目標語言</span><select value={retranslationLanguage} onChange={(event) => setRetranslationLanguage(event.target.value)}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <button className="button" type="button" disabled={isSubmittingRetranslation} onClick={async () => {
            setIsSubmittingRetranslation(true); setRetranslationError('');
            try {
              const result = await createSessionRetranslationApiClient().submit(sessionRecordId, { targetLanguageCode: retranslationLanguage });
              setLocalExecutions((items) => [...items, { ...result.execution, targetLanguageCode: retranslationLanguage }]); setShowRetranslation(false);
            } catch { setRetranslationError('Unable to queue re-translation. Please try again.'); }
            finally { setIsSubmittingRetranslation(false); }
          }}>{isSubmittingRetranslation ? 'Submitting…' : '開始翻譯'}</button>
          {retranslationError ? <p className="error-message" role="alert">{retranslationError}</p> : null}
        </div> : null}
      </section>

      <section className="saved-export-panel" aria-label="Saved transcript export">
        <div className="controls saved-export-controls">
          <label className="field">
            <span>Saved export format</span>
            <select value={savedExportFormat} onChange={(event) => setSavedExportFormat(event.target.value)}>
              <option value="txt">TXT</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
            </select>
          </label>

          <label className="field">
            <span>Saved export stream</span>
            <select value={savedExportStream} onChange={(event) => setSavedExportStream(event.target.value)}>
              <option value="translation">Translation</option>
              <option value="source">Source</option>
              <option value="both">Both</option>
            </select>
          </label>

          <button
            className="button detail-button"
            type="button"
            onClick={downloadSavedTranscript}
            disabled={!canDownloadSavedTranscript}
          >
            <Download size={16} aria-hidden="true" />
            Download saved
          </button>
        </div>
        <p className="export-note">Saved subtitle timing uses the original session observation timestamps.</p>
        {savedExportUnavailableReason ? <p className="export-note">{savedExportUnavailableReason}</p> : null}
        {savedExportError ? <p className="error-message">{savedExportError}</p> : null}
      </section>
    </section>
  );
}

function TranscriptItemList({ title, items }) {
  return (
    <section className="session-transcript-section" aria-label={title}>
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="history-empty">No saved transcript.</p>
      ) : (
        <ol className="session-transcript-list">
          {items.map((item) => (
            <li key={item.id}>
              <p>{item.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TranslationHistoryPanel({ history, targetLanguageCode, onTargetLanguageCodeChange, selectedOutputId, onSelectOutput, localExecutions = [] }) {
  if (history === undefined) return <section className="session-transcript-section" aria-label="Translation history"><h4>Translation history</h4><p className="history-empty">Loading translation history...</p></section>;
  if (!history) return <section className="session-transcript-section" aria-label="Translation history"><h4>Translation history</h4><p className="history-empty">Translation history is unavailable.</p></section>;
  const model = history.translationHistory;
  if (model) {
    const outputs = [...model.outputs].sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)) || String(a.id).localeCompare(String(b.id)));
    const selected = outputs.find((output) => output.id === selectedOutputId) || outputs[0];
    const executions = [...model.executions, ...localExecutions];
    return <section className="session-transcript-section" aria-label="Translation history"><h4>Translation history</h4>
      {outputs.map((output) => <button className="button detail-button" type="button" key={output.id} onClick={() => onSelectOutput(output.id)} aria-pressed={selected?.id === output.id}>{output.targetLanguageCode} · {output.version ? `v${output.version}` : 'legacy'} · {formatRecordTime(output.completedAt)}</button>)}
      {selected ? <div><p><strong>{selected.targetLanguageCode} {selected.version ? `v${selected.version}` : ''}</strong></p><p>{selected.translatedText}</p></div> : <p className="history-empty">No completed translations.</p>}
      {executions.length ? <ul>{executions.map((execution) => <li key={execution.id}>{execution.targetLanguageCode || 'Translation'} · {execution.status}{execution.failureInfo?.message ? ` · ${execution.failureInfo.message}` : ''}</li>)}</ul> : null}
    </section>;
  }
  const languageCodes = [...new Set(history.translations.map((item) => item.request.targetLanguageCode))];
  const translations = targetLanguageCode ? history.translations.filter((item) => item.request.targetLanguageCode === targetLanguageCode) : history.translations;
  return (
    <section className="session-transcript-section" aria-label="Translation history">
      <h4>Translation history</h4>
      <label className="field"><span>Filter output language</span><select value={targetLanguageCode} onChange={(event) => onTargetLanguageCodeChange(event.target.value)}><option value="">All languages</option>{languageCodes.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
      {translations.length === 0 ? <p className="history-empty">No historical translations match this language.</p> : <ol className="session-transcript-list">{translations.map((item) => (
        <li key={`${item.request.id}:${item.execution?.id || 'pending'}`}>
          <p><strong>{item.request.targetLanguageCode}</strong> · {item.execution?.status || 'queued'}</p>
          <p>{item.request.sourceText || 'Source text unavailable.'}</p>
          {item.output ? <p>{item.output.translatedText}</p> : null}
          {item.execution?.failureInfo?.reason ? <p className="history-reason">Reason: {item.execution.failureInfo.reason}</p> : null}
          {item.sourceLanguageDetections?.length ? <p>Detected source languages: {item.sourceLanguageDetections.flatMap((detection) => detection.detectedLanguageCodes || []).join(', ')}</p> : null}
        </li>
      ))}</ol>}
    </section>
  );
}

function historyLanguageLabel(record) {
  return record.targetLanguageLabel || record.targetLanguageCode || 'Unknown language';
}

function historyStatusLabel(status) {
  const labels = {
    stopped: 'Stopped',
    failed: 'Failed',
    expired: 'Expired',
    completed: 'Completed'
  };

  return labels[status] || status;
}

function transcriptSummaryLabel(summary = {}) {
  const sourceFinalCount = summary.sourceFinalCount || 0;
  const translationFinalCount = summary.translationFinalCount || 0;

  if (!summary.hasTranscript && sourceFinalCount === 0 && translationFinalCount === 0) {
    return 'No transcript';
  }

  return `Source final: ${sourceFinalCount} · Translation final: ${translationFinalCount}`;
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
    return 'SRT and VTT export one stream at a time.';
  }

  if (!canExportSavedSession(detail, options)) {
    return 'Saved transcript export is unavailable for the selected options.';
  }

  return '';
}

function formatRecordTime(value) {
  if (!value) {
    return 'Not available';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return 'Not available';
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
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
    idle: 'Ready',
    'requesting-permission': 'Requesting mic',
    connecting: 'Connecting',
    listening: 'Listening',
    reconnecting: 'Reconnecting',
    stopped: 'Stopped',
    expired: 'Session expired',
    error: 'Needs attention'
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

createRoot(document.getElementById('root')).render(<App />);
