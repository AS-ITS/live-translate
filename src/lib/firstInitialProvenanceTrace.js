const STAGES = new Set(['provider', 'normalized', 'allocator', 'before_initial_commit']);

function safeLocalId(value) {
  return typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9:_-]+$/u.test(value)
    ? value : null;
}

/** Metadata only: normalized eventId contains transcript text and must never enter this trace. */
export function firstInitialProvenanceMetadata(stage, input = {}) {
  if (!STAGES.has(stage)) throw new TypeError('Unknown Initial provenance trace stage.');
  const connectionEpochValid = Number.isSafeInteger(input.connectionEpoch) && input.connectionEpoch >= 0;
  const providerEpochValid = Number.isSafeInteger(input.providerEpoch) && input.providerEpoch >= 0;
  const eventSequenceValid = Number.isSafeInteger(input.eventSequence) && input.eventSequence > 0;
  const turnId = safeLocalId(input.turnId);
  return {
    stage,
    cueId: safeLocalId(input.cueId),
    turnId,
    eventIdentity: connectionEpochValid && providerEpochValid && eventSequenceValid
      ? `${input.connectionEpoch}:${input.providerEpoch}:${input.eventSequence}` : null,
    connectionEpochPresent: input.connectionEpoch != null,
    connectionEpochValid,
    providerEpochPresent: input.providerEpoch != null,
    providerEpochValid,
    eventSequencePresent: input.eventSequence != null,
    eventSequenceValid,
    turnIdPresent: input.turnId != null,
    turnIdValid: turnId !== null,
    epochSequenceOrigin: 'local_session',
    providerEventIdPresent: Boolean(input.providerEventId),
    providerConnectionEpochPresent: Boolean(input.providerConnectionEpochPresent),
    providerEpochFieldPresent: Boolean(input.providerEpochFieldPresent),
    providerEventSequencePresent: Boolean(input.providerEventSequencePresent),
    providerTurnIdPresent: Boolean(input.providerTurnIdPresent),
    providerTurnIndexPresent: input.providerTurnIndex != null,
    translationVersion: Number.isSafeInteger(input.translationVersion) ? input.translationVersion : null,
    translationVersionIncreased: Number.isSafeInteger(input.translationVersion)
      && Number.isSafeInteger(input.previousTranslationVersion)
      ? input.translationVersion > input.previousTranslationVersion : null
  };
}

export function recordFirstInitialProvenance(stage, input) {
  if (!import.meta.env?.DEV && !globalThis.__LIVE_TRANSLATE_DIAGNOSTICS__) return;
  console.info('ISSUE41_FIRST_INITIAL_PROVENANCE', firstInitialProvenanceMetadata(stage, input));
}
