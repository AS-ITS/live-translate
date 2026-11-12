import { useEffect, useState } from 'react';
import { getAudioDiagnosticSnapshot, subscribeAudioDiagnostics } from '../lib/audioFailureDiagnostic.js';

const MIME_CHECKS = [
  ['WebM / Opus', 'audio/webm;codecs=opus'],
  ['MP4 / AAC', 'audio/mp4;codecs=mp4a.40.2']
];

function mimeSupport(mimeType) {
  try {
    return typeof globalThis.MediaRecorder?.isTypeSupported === 'function'
      ? (globalThis.MediaRecorder.isTypeSupported(mimeType) ? '支援' : '不支援') : '無法檢查';
  } catch {
    return '無法檢查';
  }
}

function summary(snapshot, support) {
  return [
    '音訊診斷（僅目前頁面記憶體）',
    ...support.map(([label, result]) => `${label} 瀏覽器宣告：${result}`),
    `實際選用 MIME：${snapshot.recorderMimeType || '尚未錄製'}`,
    `實際錄製成功：${snapshot.recordedChunk ? '已收到非空音訊區塊' : '尚未確認'}`,
    `最近錯誤事件：${snapshot.events.length} 筆`,
    ...snapshot.events.map((event) => `${event.at} ${event.audioPath || 'UNKNOWN'} ${event.stage} ${event.code}${event.storageOperation ? ` ${event.storageOperation}` : ''} ${event.errorOrigin || 'OTHER'}`)
  ].join('\n');
}

export function AudioDiagnosticPanel({ onClose }) {
  const [snapshot, setSnapshot] = useState(getAudioDiagnosticSnapshot);
  const [copyStatus, setCopyStatus] = useState('');
  const support = MIME_CHECKS.map(([label, mimeType]) => [label, mimeSupport(mimeType)]);
  const diagnosticSummary = summary(snapshot, support);

  useEffect(() => subscribeAudioDiagnostics(() => setSnapshot(getAudioDiagnosticSnapshot())), []);
  useEffect(() => {
    const onEscape = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(diagnosticSummary);
      setCopyStatus('已複製診斷摘要');
    } catch {
      setCopyStatus('無法複製，可直接截圖回報。');
    }
  }

  return <div className="audio-diagnostic-backdrop">
    <section className="audio-diagnostic-panel" role="dialog" aria-modal="true" aria-labelledby="audio-diagnostic-title">
      <div className="audio-diagnostic-heading">
        <h2 id="audio-diagnostic-title">音訊診斷</h2>
        <button type="button" className="button secondary" onClick={onClose}>關閉</button>
      </div>
      <p>僅顯示目前頁面的安全分類資訊。可直接截圖回報；重新載入後紀錄會消失。</p>
      <h3>錄製格式</h3>
      <dl className="audio-diagnostic-grid">
        {support.map(([label, result]) => <div key={label}><dt>{label} 瀏覽器宣告</dt><dd>{result}</dd></div>)}
        <div><dt>實際選用 MIME</dt><dd>{snapshot.recorderMimeType || '尚未錄製'}</dd></div>
        <div><dt>實際錄製成功</dt><dd>{snapshot.recordedChunk ? '已收到非空音訊區塊' : '尚未確認'}</dd></div>
      </dl>
      <h3>最近錯誤事件（{snapshot.events.length}/10）</h3>
      {snapshot.events.length ? <ol className="audio-diagnostic-events">
        {[...snapshot.events].reverse().map((event, index) => <li key={`${event.at}-${index}`}>
          <time>{event.at}</time><span>{event.audioPath || 'UNKNOWN'}</span><span>{event.stage}</span><strong>{event.code}</strong>
          {event.storageOperation ? <span>{event.storageOperation}</span> : null}<span>{event.errorOrigin || 'OTHER'}</span>
        </li>)}
      </ol> : <p>目前沒有音訊錯誤事件。</p>}
      <button type="button" className="button secondary" onClick={copySummary}>複製診斷摘要</button>
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
    </section>
  </div>;
}
