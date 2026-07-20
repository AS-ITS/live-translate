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
    repository.createSessionRecord(session);
    existing = repository.getSessionRecord(session.id);
  }

  const apply = (detail) => {
    const knownItemIds = new Set((detail?.transcriptItems ?? []).map((item) => item.id));
    for (const item of transcriptItems) {
      if (!knownItemIds.has(item.id)) repository.appendTranscriptItem(session.id, item);
    }

    const current = repository.getSessionRecord(session.id)?.sessionRecord;
    if (isTerminalSessionStatus(session.status) && current?.status === 'active') {
      return repository.finalizeSessionRecord(session.id, {
        status: session.status,
        failureReason: session.failureReason ?? null,
        failureCategory: session.failureCategory ?? null,
        endedAt: session.endedAt,
        transcriptSummary: session.transcriptSummary
      });
    }

    if (current?.status === 'active') {
      return repository.updateSessionRecord(session.id, sessionMetadata(session));
    }

    return current;
  };

  return isPromiseLike(existing) ? existing.then(apply) : apply(existing);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) invalid();
  const { session, transcriptItems } = snapshot;
  if (!session || typeof session !== 'object' || Array.isArray(session) || !nonEmptyString(session.id)) invalid();
  if (!nonEmptyString(session.targetLanguageCode) || !['active', 'completed', 'stopped', 'failed', 'expired'].includes(session.status)) invalid();
  if (!Array.isArray(transcriptItems)) invalid();
  for (const item of transcriptItems) {
    if (!item || typeof item !== 'object' || !nonEmptyString(item.id) || !['source', 'translation'].includes(item.stream)
      || !['partial', 'final'].includes(item.status) || typeof item.text !== 'string' || !Number.isInteger(item.sequence)) invalid();
  }
  return { session, transcriptItems };
}

function sessionMetadata(session) {
  return {
    targetLanguageCode: session.targetLanguageCode,
    targetLanguageLabel: session.targetLanguageLabel ?? null,
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
function invalid() { const error = new TypeError('Session snapshot is invalid.'); error.code = 'invalid_request'; throw error; }
function isPromiseLike(value) { return value && typeof value.then === 'function'; }
