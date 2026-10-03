import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createMeetingAudioDownload } from '../../lib/meetingAudioStorage.js';

export function audioArtifactDownloadUrl(artifact, localUrl = '') {
  return artifact?.downloadUrl || localUrl || '';
}

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
  const [localDownloadUrls, setLocalDownloadUrls] = useState({});
  const inputArtifact = audioArtifacts?.input;
  const translationArtifact = audioArtifacts?.translation;
  useEffect(() => {
    const urls = {};
    if (inputArtifact?.blob && typeof URL?.createObjectURL === 'function') urls.input = URL.createObjectURL(inputArtifact.blob);
    if (translationArtifact?.blob && typeof URL?.createObjectURL === 'function') urls.translation = URL.createObjectURL(translationArtifact.blob);
    setLocalDownloadUrls(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [inputArtifact, translationArtifact]);
  const inputDownloadUrl = audioArtifactDownloadUrl(inputArtifact, localDownloadUrls.input);
  const translationDownloadUrl = audioArtifactDownloadUrl(translationArtifact, localDownloadUrls.translation);
  const hasInputAudio = Boolean(inputDownloadUrl);
  const hasTranslationAudio = Boolean(translationDownloadUrl);
  const readyCloudArtifacts = cloudAudioArtifacts.filter((artifact) => artifact?.status === 'ready');
  const pendingMp3Artifacts = cloudAudioArtifacts.filter((artifact) => ['queued', 'processing'].includes(artifact?.status));
  const failedMp3Artifacts = cloudAudioArtifacts.filter((artifact) => artifact?.kind === 'mp3' && artifact?.status === 'failed');

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

  async function retryMp3(artifact) {
    setCloudDownloadError('');
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(artifact.meetingId)}/audio-artifacts/${encodeURIComponent(artifact.id)}/retry`, { method: 'POST' });
      if (!response.ok) throw new Error('retry failed');
      window.location.reload();
    } catch {
      setCloudDownloadError('無法重新產生 MP3，請稍後重試。');
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
        {pendingMp3Artifacts.map((artifact) => <span className="button detail-button disabled-link" aria-disabled="true" key={`${artifact.id}-pending`}>MP3 產生中…</span>)}
        {failedMp3Artifacts.map((artifact) => <button className="button detail-button" type="button" key={`${artifact.id}-retry`} onClick={() => retryMp3(artifact)}>MP3 產生失敗，重試</button>)}
        {hideUnavailableLinks ? (
          hasInputAudio ? <a className="button detail-button" href={inputDownloadUrl} download={inputArtifact.fileName || undefined}><Download size={16} aria-hidden="true" />{inputLabel}</a> : null
        ) : (
          <a className={`button detail-button${hasInputAudio ? '' : ' disabled-link'}`} href={inputDownloadUrl || '#'} download={inputArtifact?.fileName || undefined} aria-disabled={!hasInputAudio} onClick={(event) => { if (!hasInputAudio) event.preventDefault(); }}><Download size={16} aria-hidden="true" />{inputLabel}</a>
        )}
        {hideUnavailableLinks ? (
          hasTranslationAudio ? <a className="button detail-button" href={translationDownloadUrl} download={translationArtifact.fileName || undefined}><Download size={16} aria-hidden="true" />{translationLabel}</a> : null
        ) : (
          <a className={`button detail-button${hasTranslationAudio ? '' : ' disabled-link'}`} href={translationDownloadUrl || '#'} download={translationArtifact?.fileName || undefined} aria-disabled={!hasTranslationAudio} onClick={(event) => { if (!hasTranslationAudio) event.preventDefault(); }}><Download size={16} aria-hidden="true" />{translationLabel}</a>
        )}
      </div>
      {cloudDownloadError ? <p className="error-message" role="alert">{cloudDownloadError}</p> : null}
      {hideUnavailableLinks && readyCloudArtifacts.length === 0 && !hasInputAudio && !hasTranslationAudio ? <p className="export-note">目前沒有可下載的語音紀錄。</p> : !hideUnavailableLinks && readyCloudArtifacts.length === 0 && (!hasInputAudio || !hasTranslationAudio) ? <p className="export-note">只有已成功儲存的語音紀錄可下載。</p> : null}
    </section>
  );
}
