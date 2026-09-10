export const MP3_ARTIFACT_KIND = 'mp3';
export const MP3_ARTIFACT_MIME_TYPE = 'audio/mpeg';
export const MP3_ARTIFACT_FILE_NAME = 'recording.mp3';

export function createMp3ArtifactService({ artifactRepository, converter } = {}) {
  if (!artifactRepository || typeof artifactRepository.getOrCreate !== 'function' || typeof artifactRepository.update !== 'function') {
    throw new TypeError('artifactRepository must implement getOrCreate and update.');
  }
  if (!converter || typeof converter.convert !== 'function') throw new TypeError('converter.convert is required.');

  return Object.freeze({
    async process({ ownerUserId, meetingId, segmentId, sourcePath, sourceBytes } = {}) {
      const artifact = await artifactRepository.getOrCreate({ ownerUserId, meetingId, segmentId, kind: MP3_ARTIFACT_KIND });
      if (artifact.status === 'ready') return artifact;
      const attempt = Number(artifact.attempt || 0) + 1;
      await artifactRepository.update(artifact.id, { status: 'processing', attempt });
      try {
        const result = await converter.convert({ sourcePath, sourceBytes, outputFileName: MP3_ARTIFACT_FILE_NAME });
        return artifactRepository.update(artifact.id, {
          status: 'ready', attempt, fileName: MP3_ARTIFACT_FILE_NAME,
          mimeType: MP3_ARTIFACT_MIME_TYPE, byteSize: result.byteSize, storagePath: result.storagePath
        });
      } catch (error) {
        const exhausted = attempt >= 3;
        return artifactRepository.update(artifact.id, {
          status: exhausted ? 'failed' : 'queued', attempt,
          errorCode: safeErrorCode(error)
        });
      }
    },
    async retry({ ownerUserId, artifactId } = {}) {
      const artifact = await artifactRepository.get(artifactId, ownerUserId);
      if (!artifact || artifact.kind !== MP3_ARTIFACT_KIND) throw mp3Error('audio_artifact_not_found', 404);
      if (artifact.status !== 'failed') throw mp3Error('audio_artifact_not_retryable', 409);
      return artifactRepository.update(artifactId, { status: 'queued', errorCode: null });
    }
  });
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_:-]+$/u.test(error.code) ? error.code : 'mp3_conversion_failed';
}

function mp3Error(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
