import { isTerminalSessionStatus } from '../lib/sessionRecords.js';

export function createSessionSnapshotSyncService({ sessionRepository } = {}) {
  assertSessionRepository(sessionRepository);

  return Object.freeze({
    sync(snapshot) {
      const { session, transcriptItems } = validateSnapshot(snapshot);
      const existing = sessionRepository.getSessionRecord(session.id);
      const sync = (detail) => syncSnapshot(sessionRepository, detail, session, transcriptItems);

      return isPromiseLike(existing) ? existing.then(sync) : sync(existing);
    }
  });
}

function syncSnapshot(repository, existing, session, transcriptItems) {
  if (!existing) {
    const created = repository.createSessionRecord({
      ...session,
      // Create through the mutable state first so terminal snapshots retain
      // endedAt and failure metadata via finalizeSessionRecord.
      ...(isTerminalSessionStatus(session.status) ? { status: 'active' } : {})
    });
    return isPromiseLike(created)
      ? created.then(() => repository.getSessionRecord(session.id)).then((detail) => syncSnapshot(repository, detail, session, transcriptItems))
      : syncSnapshot(repository, repository.getSessionRecord(session.id), session, transcriptItems);
  }

  const apply = (detail) => {
    const knownItemIds = new Set((detail?.transcriptItems ?? []).map((item) => item.id));
    const appendResult = transcriptItems.reduce((previous, item) => {
      if (knownItemIds.has(item.id)) {
        if (typeof repository.updateTranscriptItem !== 'function') return previous;
        return mapMaybePromise(previous, () => repository.updateTranscriptItem(session.id, item.id, item));
      }
      return mapMaybePromise(previous, () => repository.appendTranscriptItem(session.id, item));
    }, undefined);

    return mapMaybePromise(appendResult, () => applySessionPatch(repository, session));
  };

  return isPromiseLike(existing) ? existing.then(apply) : apply(existing);
}

function applySessionPatch(repository, session) {
  const detail = repository.getSessionRecord(session.id);
  return mapMaybePromise(detail, (currentDetail) => {
    const current = currentDetail?.sessionRecord;
    if (isTerminalSessionStatus(session.status) && current?.status === 'active') {
      const finalized = repository.finalizeSessionRecord(session.id, {
        status: session.status,
        failureReason: session.failureReason ?? null,
        failureCategory: session.failureCategory ?? null,
        endedAt: session.endedAt,
        transcriptSummary: session.transcriptSummary
      });
      return finalized;
    }

    if (['created', 'active', 'paused'].includes(current?.status)) {
      return repository.updateSessionRecord(session.id, sessionMetadata(session));
    }

    return current;
  });
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) invalid();
  const { session, transcriptItems } = snapshot;
  if (!session || typeof session !== 'object' || Array.isArray(session) || !nonEmptyString(session.id)) invalid();
  if (!nonEmptyString(session.targetLanguageCode) || !['created', 'active', 'paused', 'completed', 'stopped', 'failed', 'expired'].includes(session.status)) invalid();
  if (!Array.isArray(transcriptItems)) invalid();
  for (const item of transcriptItems) {
    if (!item || typeof item !== 'object' || !nonEmptyString(item.id) || !['source', 'translation'].includes(item.stream)
      || !['partial', 'final'].includes(item.status) || typeof item.text !== 'string' || !Number.isInteger(item.sequence)) invalid();
    if (item.sourceLanguageDetection !== undefined
      && (item.stream !== 'source' || !validSourceLanguageDetection(item.sourceLanguageDetection))) invalid();
  }
  return { session, transcriptItems };
}

function sessionMetadata(session) {
  return {
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    durationMs: session.durationMs ?? null,
    ...(session.name !== undefined ? { name: session.name } : {}),
    ...(session.status !== undefined ? { status: session.status } : {}),
    targetLanguageCode: session.targetLanguageCode,
    targetLanguageLabel: session.targetLanguageLabel ?? null,
    sourceLanguageCode: session.sourceLanguageCode ?? null,
    meetingId: session.meetingId ?? null,
    segmentId: session.segmentId ?? null,
    selectedInputDeviceId: session.selectedInputDeviceId ?? null,
    inputDeviceLabelSnapshot: session.inputDeviceLabelSnapshot ?? null
  };
}

function assertSessionRepository(repository) {
  for (const method of ['createSessionRecord', 'updateSessionRecord', 'appendTranscriptItem', 'finalizeSessionRecord', 'getSessionRecord']) {
    if (!repository || typeof repository[method] !== 'function') throw new TypeError(`sessionRepository.${method} is required.`);
  }
}

function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function validSourceLanguageDetection(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.detectedLanguageCodes)
    && value.detectedLanguageCodes.length > 0
    && value.detectedLanguageCodes.every(nonEmptyString)
    && ['complete', 'partial'].includes(value.coverage);
}
function invalid() { const error = new TypeError('Session snapshot is invalid.'); error.code = 'invalid_request'; throw error; }
function mapMaybePromise(value, mapper) { return isPromiseLike(value) ? value.then(mapper) : mapper(value); }
function isPromiseLike(value) { return value && typeof value.then === 'function'; }
