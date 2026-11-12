import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { createLocalMeetingOwnerAccess } from '../../lib/localMeetingOwnerAccess.js';
import { createIndexedDbLocalMeetingManifestStore } from '../../lib/localMeetingStorage.js';
import { createLocalMeetingObjectUrl, revokeLocalMeetingObjectUrl } from '../../lib/localMeetingObjectUrls.js';
import {
  canExportCues,
  exportCuesToSrt,
  exportCuesToTxt,
  exportCuesToVtt
} from '../../lib/subtitleCueExport.js';

export function LocalMeetingExportPanel({ meetingId, cues = [] }) {
  const [format, setFormat] = useState('txt');
  const [stream, setStream] = useState('translation');
  const [error, setError] = useState('');
  const canExport = useMemo(
    () => canExportCues(cues, { format, stream }),
    [cues, format, stream]
  );

  async function startExport() {
    setError('');
    try {
      const content = await createLocalMeetingOwnerAccess().withOwner(
        meetingId, createIndexedDbLocalMeetingManifestStore(),
        () => exportMeetingCues(cues, { format, stream })
      );
      if (!content.trim()) throw Object.assign(new Error('Empty transcript export.'), { code: 'subtitle_cue_empty' });
      downloadText(content, fileNameFor(meetingId, format));
    } catch {
      setError('選擇的內容沒有可匯出字幕，未產生空白檔案。');
    }
  }

  return (
    <section className="meeting-export-block" aria-label="本機字幕匯出">
      <h3>字幕匯出</h3>
      <p className="export-note">匯出結束時保存在這個瀏覽器的字幕。</p>
      <div className="meeting-export-controls">
        <label className="field"><span>字幕匯出格式</span><select value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="txt">TXT</option>
          <option value="srt">SRT</option>
          <option value="vtt">VTT</option>
        </select></label>
        <label className="field"><span>匯出內容</span><select value={stream} onChange={(event) => setStream(event.target.value)}>
          <option value="translation">翻譯</option>
          <option value="source">原文</option>
          <option value="both" disabled={format !== 'txt'}>兩者</option>
        </select></label>
        <button className="button primary" type="button" onClick={startExport} disabled={!canExport}>
          <Download size={16} aria-hidden="true" />
          開始匯出
        </button>
      </div>
      {!canExport ? <p className="export-note">選擇的字幕內容尚無可匯出文字。</p> : null}
      {error ? <p className="error-message" role="alert">{error}</p> : null}
    </section>
  );
}

function exportMeetingCues(cues, { format, stream }) {
  if (format === 'srt') return exportCuesToSrt(cues, { stream });
  if (format === 'vtt') return exportCuesToVtt(cues, { stream });
  return exportCuesToTxt(cues, { stream });
}

function fileNameFor(meetingId, format) {
  const safeMeetingId = String(meetingId || 'meeting').replace(/[^a-z0-9_-]+/giu, '-');
  return `live-translate-${safeMeetingId}.${format}`;
}

function downloadText(content, fileName) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = createLocalMeetingObjectUrl(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => revokeLocalMeetingObjectUrl(url), 0);
}
