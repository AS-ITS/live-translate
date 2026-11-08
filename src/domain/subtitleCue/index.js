import { SUPPORTED_LANGUAGES } from '../../lib/languages.js';
import { cueRefinementInputHash } from '../../lib/cueContent.js';
import { MAX_PROCESSED_EVENT_IDS } from '../../lib/subtitleCues.js';

const LANGUAGE_CODES = new Set(SUPPORTED_LANGUAGES.map(({ code }) => code));
const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;

export const CUE_ERROR_CODES = Object.freeze({
  invalid: 'subtitle_cue_invalid',
  conflict: 'subtitle_cue_conflict',
  sequenceConflict: 'subtitle_cue_sequence_conflict',
  sessionNotFound: 'subtitle_cue_session_not_found',
  segmentNotFound: 'subtitle_cue_segment_not_found',
  segmentSessionMismatch: 'subtitle_cue_segment_session_mismatch'
});

export function validateFinalCue(input, { previousCue = null } = {}) {
  if (!isRecord(input)) return invalid('Cue must be an object.');
  const rawSource = optionalText(input.rawSource ?? input.sourceText, 'rawSource');
  const rawTranslation = optionalText(input.rawTranslation ?? input.translatedText, 'rawTranslation');
  if (!rawSource && !rawTranslation) return invalid('Cue must contain source or translation text.');
  const mode = input.mode === 'transcription' || input.targetLanguageCode === null ? 'transcription' : 'translation';
  const hasRefinementContract = Object.hasOwn(input, 'rawSource') || Object.hasOwn(input, 'rawTranslation') || Object.hasOwn(input, 'initialTranslation') || Object.hasOwn(input, 'refinement');
  const cue = {
    cueId: requiredString(input.cueId, 'cueId'),
    sessionId: requiredString(input.sessionId, 'sessionId'),
    segmentId: requiredString(input.segmentId, 'segmentId'),
    sequence: positiveInteger(input.sequence, 'sequence'),
    startTimeMs: nonNegativeFinite(input.startTimeMs, 'startTimeMs'),
    endTimeMs: finite(input.endTimeMs, 'endTimeMs'),
    sourceLanguageCode: languageCode(input.sourceLanguageCode, 'sourceLanguageCode'),
    targetLanguageCode: mode === 'transcription' ? null : languageCode(input.targetLanguageCode, 'targetLanguageCode'),
    ...(mode === 'transcription' ? { mode } : {}),
    sourceText: rawSource,
    translatedText: rawTranslation,
    sourceStatus: normalizeSideStatus(input.sourceStatus, rawSource),
    translationStatus: normalizeSideStatus(input.translationStatus, rawTranslation),
    sourceVersion: normalizeSideVersion(input.sourceVersion, rawSource),
    translationVersion: normalizeSideVersion(input.translationVersion, rawTranslation),
    ...(input.revision == null ? {} : { revision: cueRevision(input.revision) }),
    ...(typeof input.audioTurnId === 'string' && input.audioTurnId
      ? { audioTurnId: input.audioTurnId } : {}),
    ...(typeof input.turnKey === 'string' && input.turnKey
      ? { turnKey: input.turnKey } : {}),
    ...(Number.isSafeInteger(input.providerEventSequence) && input.providerEventSequence >= 0
      ? { providerEventSequence: input.providerEventSequence } : {}),
    ...(Number.isSafeInteger(input.providerEpoch) && input.providerEpoch >= 0
      ? { providerEpoch: input.providerEpoch } : {}),
    ...(Number.isSafeInteger(input.connectionEpoch) && input.connectionEpoch >= 0
      ? { connectionEpoch: input.connectionEpoch } : {}),
    ...(typeof input.providerEventId === 'string' && input.providerEventId
      ? { providerEventId: input.providerEventId } : {}),
    ...(typeof input.eventId === 'string' && input.eventId
      ? { eventId: input.eventId } : {}),
    ...(isRecord(input.sourceProvenance)
      ? { sourceProvenance: normalizeCueProvenance(input.sourceProvenance) } : {}),
    ...(isRecord(input.translationProvenance)
      ? { translationProvenance: normalizeCueProvenance(input.translationProvenance) } : {}),
    ...(hasRefinementContract ? {
      rawSource,
      rawTranslation,
      initialTranslation: optionalNullableText(input.initialTranslation, 'initialTranslation'),
      refinedSource: optionalNullableText(input.refinedSource, 'refinedSource'),
      refinedTranslation: optionalNullableText(input.refinedTranslation, 'refinedTranslation'),
      refinement: normalizeRefinement(input, { rawSource, rawTranslation })
    } : {}),
    status: input.status,
    finalizedReason: requiredString(input.finalizedReason || 'final', 'finalizedReason')
  };

  if (cue.endTimeMs <= cue.startTimeMs) return invalid('endTimeMs must be greater than startTimeMs.');
  if (cue.status !== 'final') return invalid('Only final cues may be persisted.');
  if (previousCue && cue.startTimeMs < previousCue.endTimeMs) {
    return invalid('Cue timeline overlaps the previous cue.');
  }
  return clone(cue);
}

export function mergeFinalCue(existingCues = [], input, options = {}) {
  const normalizedExisting = existingCues.map((cue) => validateFinalCue(cue));
  const existingById = normalizedExisting.find((cue) => cue.cueId === input?.cueId);
  if (existingById) {
    const incoming = validateFinalCue(input);
    const storedRevision = existingById.revision;
    const nextRevision = incoming.revision;
    if (storedRevision !== undefined && nextRevision !== undefined) {
      if (nextRevision < storedRevision) return { cue: clone(existingById), appended: false, cues: normalizedExisting };
      if (nextRevision === storedRevision) {
        if (sameNormalizedCue(existingById, incoming)) {
          return { cue: clone(existingById), appended: false, cues: normalizedExisting };
        }
        return cueConflict(`Cue ${incoming.cueId} has conflicting revision.`,
          'same_revision_payload_mismatch', existingById, incoming, options);
      }
    } else if (storedRevision !== undefined) {
      if (sameNormalizedCue(existingById, incoming, ['revision'])) {
        return { cue: clone(existingById), appended: false, cues: normalizedExisting };
      }
      return cueConflict(`Cue ${incoming.cueId} has no comparable revision.`,
        'incoming_revision_missing', existingById, incoming, options);
    }
    if (nextRevision !== undefined && !versionedCueProgresses(existingById, incoming)) {
      return cueConflict(`Cue ${incoming.cueId} regresses a finalized side or refinement.`,
        'versioned_state_regression', existingById, incoming, options);
    }
    if (existingById.finalizedReason !== incoming.finalizedReason &&
        (nextRevision === undefined ||
          (storedRevision === undefined && options.verifiedLegacyReasonUpdate !== true)) &&
        !isMonotonicMergedCue(existingById, incoming)) {
      return cueConflict(`Cue ${incoming.cueId} has no proven finalized reason update.`,
        'legacy_reason_unverified', existingById, incoming, options);
    }
    if ((storedRevision !== undefined && nextRevision !== undefined && nextRevision > storedRevision &&
        (incoming.endTimeMs === existingById.endTimeMs ||
          incoming.sourceVersion > existingById.sourceVersion ||
          incoming.translationVersion > existingById.translationVersion))
      || isPreferredRefinementUpdate(existingById, incoming)
      || isInitialTranslationUpdate(existingById, incoming)
      || isSideCompletionUpdate(existingById, incoming)
      || (nextRevision !== undefined &&
        sameNormalizedCue(existingById, incoming, ['revision', 'finalizedReason']))) {
      const cues = normalizedExisting.map((cue) => cue.cueId === incoming.cueId ? incoming : cue);
      return { cue: clone(incoming), appended: false, updated: true, cues };
    }
    if (sameCue(existingById, incoming)) return { cue: clone(existingById), appended: false, cues: normalizedExisting };
    if (isMonotonicMergedCue(existingById, incoming)) {
      const cues = normalizedExisting.map((cue) => cue.cueId === incoming.cueId ? incoming : cue);
      return { cue: clone(incoming), appended: false, updated: true, cues };
    }
    return cueConflict(`Cue ${incoming.cueId} has conflicting payload.`,
      'payload_conflict', existingById, incoming, options);
  }

  const incoming = validateFinalCue(input, { previousCue: previousCueFor(normalizedExisting, input?.sequence) });
  const sequenceOwner = normalizedExisting.find((cue) => cue.sequence === incoming.sequence);
  if (sequenceOwner && sequenceOwner.cueId !== incoming.cueId) {
    return sequenceConflict(`Cue sequence ${incoming.sequence} is already used by ${sequenceOwner.cueId}.`);
  }
  const cues = [...normalizedExisting, incoming].sort((left, right) => left.sequence - right.sequence || left.cueId.localeCompare(right.cueId));
  const index = cues.findIndex((cue) => cue.cueId === incoming.cueId);
  const prior = cues[index - 1];
  const next = cues[index + 1];
  if (prior && incoming.startTimeMs < prior.endTimeMs) return invalid('Cue timeline overlaps the previous cue.');
  if (next && next.startTimeMs < incoming.endTimeMs) return invalid('Cue timeline overlaps the next cue.');
  return { cue: clone(incoming), appended: true, cues };
}

export function normalizeCueCheckpoint(checkpoint = null) {
  if (!isRecord(checkpoint)) return null;
  return clone({
    currentCue: checkpoint.currentCue || null,
    pendingCues: Array.isArray(checkpoint.pendingCues) ? checkpoint.pendingCues : [],
    nextSequence: Number.isInteger(checkpoint.nextSequence) && checkpoint.nextSequence > 0 ? checkpoint.nextSequence : 1,
    finalizedCueKeys: Array.isArray(checkpoint.finalizedCueKeys) ? checkpoint.finalizedCueKeys : [],
    processedEventIds: Array.isArray(checkpoint.processedEventIds)
      ? checkpoint.processedEventIds.slice(-MAX_PROCESSED_EVENT_IDS)
      : [],
    pendingBoundary: {
      turnComplete: Boolean(checkpoint.pendingBoundary?.turnComplete),
      generationComplete: Boolean(checkpoint.pendingBoundary?.generationComplete)
    },
    pendingBoundaryAtMs: Number.isFinite(checkpoint.pendingBoundaryAtMs) ? checkpoint.pendingBoundaryAtMs : null,
    lastFinalizedCueId: typeof checkpoint.lastFinalizedCueId === 'string' ? checkpoint.lastFinalizedCueId : null,
    lastFinalizedAtMs: Number.isFinite(checkpoint.lastFinalizedAtMs) ? checkpoint.lastFinalizedAtMs : null,
    lastFinalizedStream: checkpoint.lastFinalizedStream === 'source' || checkpoint.lastFinalizedStream === 'translation'
      ? checkpoint.lastFinalizedStream
      : null,
    lastFinalizedReason: typeof checkpoint.lastFinalizedReason === 'string' ? checkpoint.lastFinalizedReason : null,
    lastCommittedCueSequence: Number.isInteger(checkpoint.lastCommittedCueSequence) ? checkpoint.lastCommittedCueSequence : 0,
    lastCommittedEndTimeMs: Number.isFinite(checkpoint.lastCommittedEndTimeMs) ? checkpoint.lastCommittedEndTimeMs : null
  });
}

function previousCueFor(cues, sequence) {
  return cues.filter((cue) => cue.sequence < sequence).sort((a, b) => b.sequence - a.sequence)[0] || null;
}

function sameCue(left, right) {
  return ['cueId', 'sessionId', 'segmentId', 'sequence', 'startTimeMs', 'endTimeMs', 'sourceLanguageCode', 'targetLanguageCode', 'sourceText', 'translatedText', 'sourceStatus', 'translationStatus', 'sourceVersion', 'translationVersion', 'status', 'finalizedReason'].every((field) => left[field] === right[field]);
}

function sameNormalizedCue(left, right, omitted = []) {
  const projection = (cue) => Object.fromEntries(
    Object.entries(cue).filter(([field]) => !omitted.includes(field))
  );
  return JSON.stringify(projection(left)) === JSON.stringify(projection(right));
}

function versionedCueProgresses(existing, incoming) {
  if (existing.cueId !== incoming.cueId || existing.sessionId !== incoming.sessionId ||
      existing.segmentId !== incoming.segmentId ||
      existing.sequence !== incoming.sequence || existing.startTimeMs !== incoming.startTimeMs ||
      existing.endTimeMs > incoming.endTimeMs || existing.status !== incoming.status ||
      existing.sourceLanguageCode !== incoming.sourceLanguageCode ||
      existing.targetLanguageCode !== incoming.targetLanguageCode || existing.mode !== incoming.mode) return false;
  for (const [version, content, status] of [
    ['sourceVersion', 'sourceText', 'sourceStatus'],
    ['translationVersion', 'translatedText', 'translationStatus']
  ]) {
    if (incoming[version] < existing[version]) return false;
    if (incoming[version] === existing[version] &&
        (incoming[content] !== existing[content] || incoming[status] !== existing[status])) return false;
    if (incoming[version] > existing[version] &&
        ((existing[content] && !incoming[content]) ||
          (incoming[status] !== existing[status] &&
            !(existing[status] === 'pending' && ['finalized', 'unavailable'].includes(incoming[status]))))) return false;
    if (incoming[version] > existing[version] && existing[content] &&
      !incoming[content].startsWith(existing[content]) &&
      !sameNewerProviderTurn(existing, incoming)) return false;
  }
  if (existing.refinement && !incoming.refinement) return false;
  const lateSource = incoming.sourceVersion > existing.sourceVersion;
  const lateTranslation = incoming.translationVersion > existing.translationVersion;
  const lateInputReset = existing.refinement && incoming.refinement &&
    (lateSource || lateTranslation) &&
    (lateSource
      ? incoming.rawSource === incoming.sourceText && (!existing.rawSource || Boolean(incoming.rawSource))
      : incoming.rawSource === existing.rawSource) &&
    (lateTranslation
      ? (!existing.rawTranslation || Boolean(incoming.rawTranslation))
      : incoming.rawTranslation === existing.rawTranslation) &&
    incoming.refinement.inputHash !== existing.refinement.inputHash &&
    incoming.refinement.inputHash === cueRefinementInputHash(incoming) &&
    incoming.refinement.version === 1 && incoming.refinement.status === 'pending' &&
    incoming.refinedSource === null && incoming.refinedTranslation === null;
  if (existing.initialTranslation !== null && existing.initialTranslation !== undefined &&
      incoming.initialTranslation !== existing.initialTranslation &&
      !(lateTranslation && lateInputReset &&
        incoming.initialTranslation === incoming.translatedText)) return false;
  if (existing.refinement && incoming.refinement) {
    if (incoming.refinement.inputHash !== existing.refinement.inputHash && !lateInputReset) return false;
    if (incoming.refinement.version < existing.refinement.version && !lateInputReset) return false;
    if (incoming.refinement.version === existing.refinement.version && !lateInputReset) {
      const rank = { pending: 0, queued: 1, running: 2, failed: 3, completed: 4 };
      if ((rank[incoming.refinement.status] ?? -1) < (rank[existing.refinement.status] ?? -1)) return false;
      if (incoming.refinement.inputHash !== existing.refinement.inputHash ||
          (existing.refinedSource !== null && incoming.refinedSource === null) ||
          (existing.refinedTranslation !== null && incoming.refinedTranslation === null)) return false;
      if (existing.refinement.status === 'completed' && incoming.refinement.status === 'completed' &&
          (existing.refinedSource !== incoming.refinedSource ||
            existing.refinedTranslation !== incoming.refinedTranslation)) return false;
    }
  }
  return true;
}

function sameNewerProviderTurn(existing, incoming) {
  const sameTurn = (existing.audioTurnId && existing.audioTurnId === incoming.audioTurnId)
    || (existing.turnKey && existing.turnKey === incoming.turnKey);
  return Boolean(sameTurn && Number.isSafeInteger(existing.providerEventSequence)
    && Number.isSafeInteger(incoming.providerEventSequence)
    && incoming.providerEventSequence > existing.providerEventSequence);
}

function normalizeCueProvenance(value) {
  const result = {};
  for (const field of ['audioTurnId', 'turnKey', 'providerEventId', 'eventId']) {
    if (typeof value[field] === 'string' && value[field]) result[field] = value[field];
  }
  for (const field of ['connectionEpoch', 'providerEpoch', 'eventSequence']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) result[field] = value[field];
  }
  return result;
}

function isPreferredRefinementUpdate(existing, incoming) {
  const existingRefinement = existing.refinement;
  const incomingRefinement = incoming.refinement;
  if (!existingRefinement || !incomingRefinement) return false;
  const sameIdentity = existing.sessionId === incoming.sessionId
    && existing.segmentId === incoming.segmentId
    && existing.sequence === incoming.sequence
    && existing.startTimeMs === incoming.startTimeMs
    && existing.endTimeMs === incoming.endTimeMs
    && existing.rawSource === incoming.rawSource
    && existing.rawTranslation === incoming.rawTranslation;
  if (!sameIdentity) return false;
  const existingVersion = Number.isInteger(existingRefinement.version) ? existingRefinement.version : 0;
  const incomingVersion = Number.isInteger(incomingRefinement.version) ? incomingRefinement.version : 0;
  const statusRank = { pending: 0, queued: 1, running: 2, failed: 3, completed: 4 };
  return incomingVersion > existingVersion
    || (incomingVersion === existingVersion
      && ((statusRank[incomingRefinement.status] || 0) > (statusRank[existingRefinement.status] || 0)
        || (incomingRefinement.status === 'completed'
          && (incoming.refinedSource !== existing.refinedSource || incoming.refinedTranslation !== existing.refinedTranslation))));
}

function isInitialTranslationUpdate(existing, incoming) {
  return existing.cueId === incoming.cueId
    && existing.sessionId === incoming.sessionId
    && existing.segmentId === incoming.segmentId
    && existing.sequence === incoming.sequence
    && existing.startTimeMs === incoming.startTimeMs
    && existing.endTimeMs === incoming.endTimeMs
    && existing.sourceText === incoming.sourceText
    && existing.translatedText === ''
    && incoming.translatedText !== ''
    && incoming.initialTranslation === incoming.translatedText;
}

function isSideCompletionUpdate(existing, incoming) {
  if (existing.cueId !== incoming.cueId
    || existing.sessionId !== incoming.sessionId
    || existing.segmentId !== incoming.segmentId
    || existing.sequence !== incoming.sequence
    || existing.startTimeMs !== incoming.startTimeMs) return false;
  const sourceAdvanced = incoming.sourceVersion > existing.sourceVersion
    && isTextExtension(existing.sourceText, incoming.sourceText);
  const translationAdvanced = incoming.translationVersion > existing.translationVersion
    && isTextExtension(existing.translatedText, incoming.translatedText);
  const sourcePreserved = incoming.sourceVersion === existing.sourceVersion
    && incoming.sourceText === existing.sourceText;
  const translationPreserved = incoming.translationVersion === existing.translationVersion
    && incoming.translatedText === existing.translatedText;
  return incoming.endTimeMs >= existing.endTimeMs
    && (sourceAdvanced || sourcePreserved)
    && (translationAdvanced || translationPreserved)
    && (sourceAdvanced || translationAdvanced);
}

function isMonotonicMergedCue(existing, incoming) {
  return incoming.finalizedReason === 'merged' &&
    incoming.sessionId === existing.sessionId &&
    incoming.segmentId === existing.segmentId &&
    incoming.sequence === existing.sequence &&
    incoming.startTimeMs === existing.startTimeMs &&
    incoming.endTimeMs >= existing.endTimeMs &&
    isTextExtension(existing.sourceText, incoming.sourceText) &&
    isTextExtension(existing.translatedText, incoming.translatedText) &&
    (incoming.sourceText !== existing.sourceText ||
      incoming.translatedText !== existing.translatedText ||
      incoming.endTimeMs > existing.endTimeMs);
}

function isTextExtension(existingText, incomingText) {
  return existingText === incomingText || existingText === '' || incomingText.startsWith(existingText);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') return invalid(`${field} must be a non-empty string.`);
  return value;
}
function positiveInteger(value, field) { if (!Number.isInteger(value) || value < 1) return invalid(`${field} must be a positive integer.`); return value; }
function cueRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) return invalid('revision must be a positive safe integer.');
  return value;
}
function finite(value, field) { if (!Number.isFinite(value)) return invalid(`${field} must be finite.`); return value; }
function nonNegativeFinite(value, field) { if (!Number.isFinite(value) || value < 0) return invalid(`${field} must be non-negative and finite.`); return value; }
function languageCode(value, field) { if (!LANGUAGE_CODES.has(value)) return invalid(`${field} is not supported.`); return value; }
function text(value, field) { if (typeof value !== 'string' || value.trim() === '' || PUNCTUATION_ONLY.test(value.trim())) return invalid(`${field} must contain non-punctuation text.`); return value.trim(); }
function optionalText(value, field) { if (value === undefined || value === null || value === '') return ''; return text(value, field); }
function normalizeSideStatus(value, sideText) {
  if (value === 'completed') return 'finalized';
  if (value === 'failed') return 'unavailable';
  if (['pending', 'finalized', 'unavailable'].includes(value)) return value;
  return sideText ? 'finalized' : 'pending';
}
function normalizeSideVersion(value, sideText) {
  if (Number.isInteger(value) && value >= 0) return value;
  return sideText ? 1 : 0;
}
function optionalNullableText(value, field) { if (value === undefined || value === null || value === '') return null; return text(value, field); }
function normalizeRefinement(input, { rawSource, rawTranslation }) {
  const expectedHash = cueRefinementInputHash({ cueId: input.cueId, sequence: input.sequence, rawSource, rawTranslation });
  const current = isRecord(input.refinement) ? input.refinement : {};
  const version = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;
  const status = ['pending', 'queued', 'running', 'completed', 'failed'].includes(current.status) ? current.status : 'pending';
  return {
    status,
    version,
    inputHash: current.inputHash || expectedHash,
    ...(current.executionId ? { executionId: current.executionId } : {}),
    ...(current.requestedAt ? { requestedAt: current.requestedAt } : {}),
    ...(current.startedAt ? { startedAt: current.startedAt } : {}),
    ...(current.completedAt ? { completedAt: current.completedAt } : {}),
    ...(current.failedAt ? { failedAt: current.failedAt } : {}),
    ...(current.failure ? { failure: clone(current.failure) } : {})
  };
}
function invalid(message) { const error = new TypeError(message); error.code = CUE_ERROR_CODES.invalid; throw error; }
function cueConflict(message, rejectReason, existing, incoming, options) {
  const error = new Error(message);
  error.code = CUE_ERROR_CODES.conflict;
  error.rejectReason = rejectReason;
  error.cueConflict = {
    cueId: incoming.cueId,
    sessionId: incoming.sessionId,
    segmentId: incoming.segmentId,
    identitySame: existing.cueId === incoming.cueId && existing.sessionId === incoming.sessionId &&
      existing.segmentId === incoming.segmentId && existing.sequence === incoming.sequence &&
      existing.startTimeMs === incoming.startTimeMs,
    existingRevision: existing.revision ?? null,
    incomingRevision: incoming.revision ?? null,
    finalizedReasonSame: existing.finalizedReason === incoming.finalizedReason,
    source: cueSideComparison(existing, incoming, 'sourceVersion', 'sourceStatus'),
    translation: cueSideComparison(existing, incoming, 'translationVersion', 'translationStatus'),
    refinement: {
      versionOrder: compareCueVersion(existing.refinement?.version, incoming.refinement?.version),
      statusSame: (existing.refinement?.status ?? null) === (incoming.refinement?.status ?? null),
      inputSame: (existing.refinement?.inputHash ?? null) === (incoming.refinement?.inputHash ?? null)
    },
    legacyDurableProof: options.verifiedLegacyReasonUpdate === true
  };
  throw error;
}
function cueSideComparison(existing, incoming, versionField, statusField) {
  return {
    versionOrder: compareCueVersion(existing[versionField], incoming[versionField]),
    statusSame: existing[statusField] === incoming[statusField]
  };
}
function compareCueVersion(existing, incoming) {
  if (existing === undefined || incoming === undefined) return 'uncomparable';
  return incoming < existing ? 'older' : incoming > existing ? 'newer' : 'same';
}
function sequenceConflict(message) { const error = new Error(message); error.code = CUE_ERROR_CODES.sequenceConflict; throw error; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
