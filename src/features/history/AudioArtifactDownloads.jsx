import { Download } from 'lucide-react';
import { useState } from 'react';
import { createMeetingAudioDownload } from '../../lib/meetingAudioStorage.js';

export function AudioArtifactDownloads({
  title,
  audioArtifacts = {},
  inputLabel = '下載原始語音',
  translationLabel = '下載翻譯語音',
  hideUnavailableLinks = false,
  cloudAudioArtifacts = []
}) {
  const [cloudDownloadId, setCloudDownloadId] = useState('');
  const [cloudDownloadError, setCloudDownloadError] = useState('');
  const inputArtifact = audioArtifacts?.input;
  const translationArtifact = audioArtifacts?.translation;
  const hasInputAudio = Boolean(inputArtifact?.downloadUrl);
  const hasTranslationAudio = Boolean(translationArtifact?.downloadUrl);
  const readyCloudArtifacts = cloudAudioArtifacts.filter((artifact) => artifact?.status === 'ready');

  async function downloadCloudArtifact(artifact) {
    setCloudDownloadError('');
    setCloudDownloadId(artifact.id);
    try {
      const download = await createMeetingAudioDownload({ meetingId: artifact.meetingId, artifactId: artifact.id });
      const anchor = document.createElement('a');
      anchor.href = download.url;
      anchor.download = download.fileName || artifact.fileName || 'recording.webm';
      anchor.rel = 'noopener';
      anchor.click();
    } catch {
      setCloudDownloadError('無法建立語音下載連結，請稍後重試。');
    } finally {
      setCloudDownloadId('');
    }
  }

  return (
    <section className="saved-export-panel audio-artifact-downloads" aria-label={title}>
      {title ? <h4>{title}</h4> : null}
      <div className="recording-downloads">
        {readyCloudArtifacts.map((artifact) => (
          <button className="button detail-button" type="button" key={artifact.id} disabled={cloudDownloadId === artifact.id} onClick={() => downloadCloudArtifact(artifact)}>
            <Download size={16} aria-hidden="true" />
            {cloudDownloadId === artifact.id ? '準備下載…' : `下載第 ${artifact.segmentSequence ?? '?'} 段原始語音`}
          </button>
        ))}
        {hideUnavailableLinks ? (
          hasInputAudio ? <a className="button detail-button" href={inputArtifact.downloadUrl} download={inputArtifact.fileName || undefined}><Download size={16} aria-hidden="true" />{inputLabel}</a> : null
        ) : (
          <a className={`button detail-button${hasInputAudio ? '' : ' disabled-link'}`} href={inputArtifact?.downloadUrl || '#'} download={inputArtifact?.fileName || undefined} aria-disabled={!hasInputAudio} onClick={(event) => { if (!hasInputAudio) event.preventDefault(); }}><Download size={16} aria-hidden="true" />{inputLabel}</a>
        )}
        {hideUnavailableLinks ? (
          hasTranslationAudio ? <a className="button detail-button" href={translationArtifact.downloadUrl} download={translationArtifact.fileName || undefined}><Download size={16} aria-hidden="true" />{translationLabel}</a> : null
        ) : (
          <a className={`button detail-button${hasTranslationAudio ? '' : ' disabled-link'}`} href={translationArtifact?.downloadUrl || '#'} download={translationArtifact?.fileName || undefined} aria-disabled={!hasTranslationAudio} onClick={(event) => { if (!hasTranslationAudio) event.preventDefault(); }}><Download size={16} aria-hidden="true" />{translationLabel}</a>
        )}
      </div>
      {cloudDownloadError ? <p className="error-message" role="alert">{cloudDownloadError}</p> : null}
      {hideUnavailableLinks && readyCloudArtifacts.length === 0 && !hasInputAudio && !hasTranslationAudio ? <p className="export-note">目前沒有可下載的語音紀錄。</p> : !hideUnavailableLinks && readyCloudArtifacts.length === 0 && (!hasInputAudio || !hasTranslationAudio) ? <p className="export-note">只有已成功儲存的語音紀錄可下載。</p> : null}
    </section>
  );
}
