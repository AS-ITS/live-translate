import { Download } from 'lucide-react';

export function AudioArtifactDownloads({
  title,
  audioArtifacts = {},
  inputLabel = '下載原始語音',
  translationLabel = '下載翻譯語音',
  hideUnavailableLinks = false
}) {
  const inputArtifact = audioArtifacts?.input;
  const translationArtifact = audioArtifacts?.translation;
  const hasInputAudio = Boolean(inputArtifact?.downloadUrl);
  const hasTranslationAudio = Boolean(translationArtifact?.downloadUrl);

  return (
    <section className="saved-export-panel audio-artifact-downloads" aria-label={title}>
      {title ? <h4>{title}</h4> : null}
      <div className="recording-downloads">
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
      {hideUnavailableLinks && !hasInputAudio && !hasTranslationAudio ? <p className="export-note">目前沒有可下載的語音紀錄。</p> : !hideUnavailableLinks && (!hasInputAudio || !hasTranslationAudio) ? <p className="export-note">只有已成功儲存的語音紀錄可下載。</p> : null}
    </section>
  );
}
