export const BACKGROUND_JOB_QUEUES = Object.freeze({
  TRANSLATION: 'translation_jobs',
  MP3: 'mp3_jobs',
  EXPORT: 'export_jobs'
});

export const BACKGROUND_JOB_MAX_ATTEMPTS = 3;
export const BACKGROUND_JOB_VISIBILITY_TIMEOUT_SECONDS = 300;

export function createBackgroundJobMessage({ ownerUserId, executionId, requestId, artifactId, meetingId, segmentId, kind } = {}) {
  const message = { ownerUserId, executionId, requestId, artifactId, meetingId, segmentId, kind };
  for (const [name, value] of Object.entries(message)) {
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(`${name} must be a non-empty string when provided.`);
    }
  }
  if (!ownerUserId) throw new TypeError('ownerUserId is required.');
  if (!executionId && !artifactId) throw new TypeError('executionId or artifactId is required.');
  return Object.freeze(Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined)));
}

export function assertBackgroundJobMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Background job message must be an object.');
  }
  return createBackgroundJobMessage(message);
}
