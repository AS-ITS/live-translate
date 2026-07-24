export function createRetranslationSessionMaterializer({ sessionRepository, clock = () => Date.now() } = {}) {
  assertSessionRepository(sessionRepository);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  return Object.freeze({
    async materialize({ output } = {}) {
      if (!isRecord(output) || typeof output.executionId !== 'string' || typeof output.sessionId !== 'string') {
        return null;
      }

      const derivedSessionId = `retranslation-session:${output.executionId}`;
      const existing = await maybeAwait(sessionRepository.getSessionRecord(derivedSessionId));
      if (existing?.sessionRecord) {
        return existing.sessionRecord;
      }

      const sourceDetail = await maybeAwait(sessionRepository.getSessionRecord(output.sessionId));
      if (!sourceDetail?.sessionRecord) {
        return null;
      }

      const completedAt = output.completedAt ?? output.createdAt ?? clock();
      await maybeAwait(sessionRepository.createSessionRecord({
        id: derivedSessionId,
        startedAt: output.createdAt ?? completedAt,
        targetLanguageCode: output.targetLanguageCode,
        targetLanguageLabel: targetLanguageLabelFor(output.targetLanguageCode)
      }));

      for (const item of sourceItemsFor(output)) {
        await maybeAwait(sessionRepository.appendTranscriptItem(derivedSessionId, item));
      }

      await maybeAwait(sessionRepository.appendTranscriptItem(derivedSessionId, {
        id: `translation:${output.id}:article`,
        stream: 'translation',
        status: 'final',
        text: output.translatedText,
        sequence: 0,
        startedAt: output.createdAt ?? completedAt,
        finalizedAt: completedAt
      }));

      return maybeAwait(sessionRepository.finalizeSessionRecord(derivedSessionId, {
        status: 'completed',
        endedAt: completedAt,
        recordKind: 'retranslation',
        retranslatedFrom: {
          sessionId: output.sessionId,
          startedAt: sourceDetail.sessionRecord.startedAt ?? null,
          requestId: output.requestId ?? null,
          executionId: output.executionId,
          outputId: output.id
        }
      }));
    }
  });
}

function sourceItemsFor(output) {
  const snapshot = output.sourceTranscriptMetadata?.sourceTranscriptSnapshot
    ?? output.sourceTranscriptMetadata?.snapshot
    ?? null;

  if (Array.isArray(snapshot?.items)) {
    return snapshot.items
      .filter((item) => item?.stream === 'source' && item.status === 'final')
      .map((item, index) => ({
        ...item,
        sequence: Number.isFinite(item.sequence) ? item.sequence : index
      }));
  }

  if (typeof output.sourceText === 'string' && output.sourceText.trim().length > 0) {
    return [{
      id: `source:${output.executionId}:article`,
      stream: 'source',
      status: 'final',
      text: output.sourceText,
      sequence: 0,
      startedAt: output.createdAt ?? output.completedAt ?? null,
      finalizedAt: output.completedAt ?? output.createdAt ?? null
    }];
  }

  return [];
}

function targetLanguageLabelFor(code) {
  const labels = {
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    'zh-Hant': 'Traditional Chinese',
    'zh-Hans': 'Simplified Chinese',
    es: 'Spanish',
    fr: 'French',
    de: 'German'
  };

  return labels[code] ?? null;
}

function assertSessionRepository(sessionRepository) {
  if (!sessionRepository || typeof sessionRepository !== 'object') {
    throw new TypeError('sessionRepository is required.');
  }

  for (const method of ['createSessionRecord', 'appendTranscriptItem', 'finalizeSessionRecord', 'getSessionRecord']) {
    if (typeof sessionRepository[method] !== 'function') {
      throw new TypeError(`sessionRepository.${method} must be a function.`);
    }
  }
}

function maybeAwait(value) {
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
