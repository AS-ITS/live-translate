export function resolveInputAudioDownloadState({
  inputArtifact = null,
  localUrl = '',
  cloudAudioArtifacts = []
} = {}) {
  const downloadUrl = inputArtifact?.downloadUrl || localUrl || '';
  const sourceArtifacts = Array.isArray(cloudAudioArtifacts) ? cloudAudioArtifacts : [];
  const cloudArtifact = sourceArtifacts
    .filter((artifact) => artifact.status === 'ready')
    .sort(compareNewestArtifact)[0] || null;
  const source = downloadUrl || inputArtifact?.status === 'sealed' ? 'local' : cloudArtifact ? 'cloud' : 'none';
  const available = source !== 'none';
  const processing = !available && (
    ['processing', 'finalizing', 'uploading'].includes(inputArtifact?.status)
    || sourceArtifacts.some((artifact) => ['uploading', 'queued', 'processing'].includes(artifact?.status))
  );

  return Object.freeze({
    source,
    available,
    processing,
    disabled: !available && !processing && inputArtifact?.status === 'disabled',
    downloadUrl,
    cloudArtifact: source === 'cloud' ? cloudArtifact : null
  });
}

function compareNewestArtifact(left, right) {
  return (right.segmentSequence ?? -1) - (left.segmentSequence ?? -1)
    || timestamp(right.createdAt) - timestamp(left.createdAt)
    || String(right.id || '').localeCompare(String(left.id || ''));
}

function timestamp(value) {
  const result = new Date(value ?? 0).getTime();
  return Number.isFinite(result) ? result : 0;
}
