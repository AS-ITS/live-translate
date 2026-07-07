import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Download, Mic, MicOff, Radio, Square } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from './lib/languages.js';
import { LiveTranslateSession } from './lib/liveSession.js';
import { buildTranscriptFileName, canExportTranscript, formatTranscriptExport } from './lib/transcriptExport.js';
import {
  applyTranscriptEvent,
  createTranscriptState,
  resetTranscriptState,
  transcriptItemsForStream,
  transcriptTextForStream
} from './lib/transcript.js';
import './styles.css';

function App() {
  const [status, setStatus] = useState('idle');
  const [targetLanguageCode, setTargetLanguageCode] = useState('zh-Hant');
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  const [transcript, setTranscript] = useState(createTranscriptState);
  const [transcriptTimeOrigin, setTranscriptTimeOrigin] = useState(null);
  const [exportFormat, setExportFormat] = useState('txt');
  const [exportStream, setExportStream] = useState('translation');
  const [error, setError] = useState('');
  const sessionRef = useRef(null);

  const isActive = status === 'requesting-permission' || status === 'connecting' || status === 'listening';

  async function startSession() {
    setError('');
    setTranscriptTimeOrigin(Date.now());
    setTranscript(resetTranscriptState());
    setStatus('requesting-permission');

    const session = new LiveTranslateSession({
      targetLanguageCode,
      echoTargetLanguage,
      onConnecting: () => setStatus('connecting'),
      onInputTranscript: (update) => setTranscript((current) => applyTranscriptEvent(current, { ...update, stream: 'source' })),
      onOutputTranscript: (update) => setTranscript((current) => applyTranscriptEvent(current, { ...update, stream: 'translation' })),
      onError: (nextError) => {
        setError(nextError.message);
        setStatus('error');
        sessionRef.current = null;
      },
      onClose: () => {
        setStatus((current) => (current === 'listening' ? 'stopped' : current));
        sessionRef.current = null;
      }
    });

    sessionRef.current = session;

    try {
      await session.start();
      setStatus('listening');
    } catch (nextError) {
      await session.stop().catch(() => {});
      setError(nextError.message || 'Unable to start live translation');
      setStatus('error');
    }
  }

  async function stopSession() {
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus('stopped');
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

  return (
    <main className="app-shell">
      <section className="control-panel" aria-labelledby="app-title">
        <div className="title-block">
          <div className="status-pill">
            <Radio size={16} aria-hidden="true" />
            {statusLabel(status)}
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

          {status === 'listening' ? (
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
    </main>
  );
}

function TranscriptPanel({ title, text, emptyText }) {
  return (
    <article className="transcript-panel">
      <h2>{title}</h2>
      <p className={text ? 'transcript-text' : 'transcript-text empty'}>{text || emptyText}</p>
    </article>
  );
}

function statusLabel(status) {
  const labels = {
    idle: 'Ready',
    'requesting-permission': 'Requesting mic',
    connecting: 'Connecting',
    listening: 'Listening',
    stopped: 'Stopped',
    error: 'Needs attention'
  };

  return labels[status] || status;
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
