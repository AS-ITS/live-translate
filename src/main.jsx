import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Mic, MicOff, Radio, Square } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from './lib/languages.js';
import { LiveTranslateSession } from './lib/liveSession.js';
import './styles.css';

function App() {
  const [status, setStatus] = useState('idle');
  const [targetLanguageCode, setTargetLanguageCode] = useState('zh-Hant');
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  const [inputTranscript, setInputTranscript] = useState('');
  const [outputTranscript, setOutputTranscript] = useState('');
  const [error, setError] = useState('');
  const sessionRef = useRef(null);

  const isActive = status === 'requesting-permission' || status === 'connecting' || status === 'listening';

  async function startSession() {
    setError('');
    setInputTranscript('');
    setOutputTranscript('');
    setStatus('requesting-permission');

    const session = new LiveTranslateSession({
      targetLanguageCode,
      echoTargetLanguage,
      onInputTranscript: (text) => setInputTranscript((current) => appendTranscript(current, text)),
      onOutputTranscript: (text) => setOutputTranscript((current) => appendTranscript(current, text)),
      onError: (nextError) => {
        setError(nextError.message);
        setStatus('error');
      },
      onClose: () => {
        setStatus((current) => (current === 'listening' ? 'stopped' : current));
      }
    });

    sessionRef.current = session;

    try {
      setStatus('connecting');
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

      <section className="transcript-grid" aria-label="Live transcripts">
        <TranscriptPanel title="Source speech" text={inputTranscript} emptyText="Waiting for source speech..." />
        <TranscriptPanel title="Translated speech" text={outputTranscript} emptyText="Waiting for translated speech..." />
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

function appendTranscript(current, next) {
  if (!next.trim()) {
    return current;
  }

  return current ? `${current} ${next}` : next;
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

createRoot(document.getElementById('root')).render(<App />);

