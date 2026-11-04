import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createMeetingAudioDownload } from '../../lib/meetingAudioStorage.js';
import { resolveInputAudioDownloadState } from '../../lib/audioArtifactDownloadState.js';

export function audioArtifactDownloadUrl(artifact, localUrl = '') {
  return artifact?.downloadUrl || localUrl || '';
}

export function AudioArtifactDownloads({
  title,
  audioArtifacts = {},
  inputLabel = '下載原始語音',
  translationLabel = '下載翻譯語音',
  hideUnavailableLinks = false,
  cloudAudioArtifacts = [],
  onRefresh,
  onDownloadLocalAudio
}) {
  const [cloudDownloadId, setCloudDownloadId] = useState('');
  const [cloudDownloadError, setCloudDownloadError] = useState('');
  const [localDownloadUrls, setLocalDownloadUrls] = useState({});
  const [localDownloadKind, setLocalDownloadKind] = useState('');
  const [localDownloadError, setLocalDownloadError] = useState('');
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
  const inputDownload = resolveInputAudioDownloadState({ inputArtifact, localUrl: localDownloadUrls.input, cloudAudioArtifacts });
  const hasInputAudio = inputDownload.available;
  const inputAudioProcessing = inputDownload.processing;
  const inputAudioDisabled = inputDownload.disabled;
  const hasTranslationAudio = Boolean(translationDownloadUrl || translationArtifact?.status === 'sealed');
  const pendingMp3Artifacts = cloudAudioArtifacts.filter((artifact) => artifact?.kind === 'mp3' && ['queued', 'processing'].includes(artifact?.status));
  const failedMp3Artifacts = cloudAudioArtifacts.filter((artifact) => artifact?.kind === 'mp3' && artifact?.status === 'failed');

  useEffect(() => {
    if (!inputAudioProcessing || typeof onRefresh !== 'function') return undefined;
    const timer = window.setInterval(() => { void onRefresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [inputAudioProcessing, onRefresh]);

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

  async function downloadLocalArtifact(kind) {
    if (localDownloadKind) return;
    if (typeof onDownloadLocalAudio !== 'function') {
      setLocalDownloadError('此頁面無法讀取本機語音，請從會議匯出頁下載。');
      return;
    }
    setLocalDownloadError('');
    setLocalDownloadKind(kind);
    try {
      const artifact = await onDownloadLocalAudio(kind);
      if (!artifact?.blob?.size) throw new Error('Empty local audio export.');
      const url = URL.createObjectURL(artifact.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.fileName || `${kind}-audio.wav`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      setLocalDownloadError(error?.status === 410 ? '錄製資料已到期，無法下載。' : '本機語音匯出失敗，請重試。');
    } finally {
      setLocalDownloadKind('');
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
        {inputDownload.source === 'cloud' ? (
          <button className="button detail-button" type="button" disabled={cloudDownloadId === inputDownload.cloudArtifact.id} onClick={() => downloadCloudArtifact(inputDownload.cloudArtifact)}>
            <Download size={16} aria-hidden="true" />
            {cloudDownloadId === inputDownload.cloudArtifact.id ? '準備下載…' : inputLabel}
          </button>
        ) : inputArtifact?.status === 'sealed' ? (
          <button className="button detail-button" type="button" disabled={Boolean(localDownloadKind)} onClick={() => downloadLocalArtifact('input')}><Download size={16} aria-hidden="true" />{localDownloadKind === 'input' ? '準備下載…' : inputLabel}</button>
        ) : inputDownload.source === 'local' ? (
          <a className="button detail-button" href={inputDownloadUrl} download={inputArtifact?.fileName || undefined}><Download size={16} aria-hidden="true" />{inputLabel}</a>
        ) : inputAudioProcessing ? (
          <button className="button detail-button" type="button" disabled><Download size={16} aria-hidden="true" />{inputLabel}</button>
        ) : !hideUnavailableLinks ? (
          <a className="button detail-button disabled-link" href="#" aria-disabled="true" onClick={(event) => event.preventDefault()}><Download size={16} aria-hidden="true" />{inputLabel}</a>
        ) : null}
        {pendingMp3Artifacts.map((artifact) => <span className="button detail-button disabled-link" aria-disabled="true" key={`${artifact.id}-pending`}>MP3 產生中…</span>)}
        {failedMp3Artifacts.map((artifact) => <button className="button detail-button" type="button" key={`${artifact.id}-retry`} onClick={() => retryMp3(artifact)}>MP3 產生失敗，重試</button>)}
        {hideUnavailableLinks ? (
          translationArtifact?.status === 'sealed' ? <button className="button detail-button" type="button" disabled={Boolean(localDownloadKind)} onClick={() => downloadLocalArtifact('translation')}><Download size={16} aria-hidden="true" />{localDownloadKind === 'translation' ? '準備下載…' : translationLabel}</button> : hasTranslationAudio ? <a className="button detail-button" href={translationDownloadUrl} download={translationArtifact.fileName || undefined}><Download size={16} aria-hidden="true" />{translationLabel}</a> : null
        ) : (
          translationArtifact?.status === 'sealed' ? <button className="button detail-button" type="button" disabled={Boolean(localDownloadKind)} onClick={() => downloadLocalArtifact('translation')}><Download size={16} aria-hidden="true" />{localDownloadKind === 'translation' ? '準備下載…' : translationLabel}</button> : <a className={`button detail-button${hasTranslationAudio ? '' : ' disabled-link'}`} href={translationDownloadUrl || '#'} download={translationArtifact?.fileName || undefined} aria-disabled={!hasTranslationAudio} onClick={(event) => { if (!hasTranslationAudio) event.preventDefault(); }}><Download size={16} aria-hidden="true" />{translationLabel}</a>
        )}
      </div>
      {cloudDownloadError ? <p className="error-message" role="alert">{cloudDownloadError}</p> : null}
      {localDownloadError ? <p className="error-message" role="alert">{localDownloadError}</p> : null}
      {inputAudioProcessing ? <p className="export-note" role="status">錄音正在整理中，請稍候。</p> : inputAudioDisabled ? <p className="export-note" role="status">原始語音未啟用保存。</p> : hideUnavailableLinks && !hasInputAudio && !hasTranslationAudio ? <p className="export-note">目前沒有可下載的語音紀錄。</p> : !hideUnavailableLinks && (!hasInputAudio || !hasTranslationAudio) ? <p className="export-note">只有已成功儲存的語音紀錄可下載。</p> : null}
    </section>
  );
}
