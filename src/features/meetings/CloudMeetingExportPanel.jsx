import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { createMeetingExportApiClient } from '../../lib/meetingExportApiClient.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;

export function CloudMeetingExportPanel({ meetingId }) {
  const [format, setFormat] = useState('txt');
  const [stream, setStream] = useState('translation');
  const [artifact, setArtifact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function startExport() {
    if (!meetingId || (stream === 'both' && format !== 'txt')) return;
    setBusy(true);
    setError('');
    try {
      const client = createMeetingExportApiClient();
      let next = await client.create(meetingId, { format, stream });
      setArtifact(next);
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && ['queued', 'processing'].includes(next?.status); attempt += 1) {
        await delay(POLL_INTERVAL_MS);
        next = await client.get(meetingId, next.id);
        setArtifact(next);
      }
      if (next?.status !== 'ready') {
        setError(next?.status === 'stale' ? '字幕來源已更新，請重新匯出。' : '匯出失敗，請重試。');
        return;
      }
      const download = await client.createDownloadUrl(meetingId, next.id);
      downloadFile(download.url, download.fileName);
    } catch (nextError) {
      setError(nextError?.code === 'export_not_ready' ? '匯出尚未完成，請稍後重試。' : '雲端匯出目前無法使用。');
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = {
    queued: '排隊中，背景工作者將處理匯出。',
    processing: '處理中，請稍候。',
    ready: '匯出完成。',
    failed: '匯出失敗，可重試。',
    stale: '字幕來源已更新，可重新匯出。'
  }[artifact?.status];

  return (
    <section className="meeting-export-block" aria-label="雲端字幕匯出">
      <h3>字幕匯出</h3>
      <div className="meeting-export-controls">
        <label className="field"><span>字幕匯出格式</span><select value={format} onChange={(event) => setFormat(event.target.value)} disabled={busy}>
          <option value="txt">TXT</option>
          <option value="srt">SRT</option>
          <option value="vtt">VTT</option>
        </select></label>
        <label className="field"><span>匯出內容</span><select value={stream} onChange={(event) => setStream(event.target.value)} disabled={busy}>
          <option value="translation">翻譯</option>
          <option value="source">原文</option>
          <option value="both" disabled={format !== 'txt'}>兩者</option>
        </select></label>
        <button className="button primary" type="button" onClick={() => void startExport()} disabled={busy || !meetingId || (stream === 'both' && format !== 'txt')}>
          {busy ? <RefreshCw size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          {busy ? '匯出中…' : '開始匯出'}
        </button>
      </div>
      {statusLabel ? <p className="export-note" role="status">{statusLabel}</p> : null}
      {artifact?.fileName ? <p className="export-note">檔案：{artifact.fileName}</p> : null}
      {error ? <p className="error-message" role="alert">{error}</p> : null}
    </section>
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function downloadFile(url, fileName) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || '';
  link.rel = 'noopener';
  link.click();
}
