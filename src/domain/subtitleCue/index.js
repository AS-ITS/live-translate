import { SUPPORTED_LANGUAGES } from '../../lib/languages.js';

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
  const cue = {
    cueId: requiredString(input.cueId, 'cueId'),
    sessionId: requiredString(input.sessionId, 'sessionId'),
    segmentId: requiredString(input.segmentId, 'segmentId'),
    sequence: positiveInteger(input.sequence, 'sequence'),
    startTimeMs: nonNegativeFinite(input.startTimeMs, 'startTimeMs'),
    endTimeMs: finite(input.endTimeMs, 'endTimeMs'),
    sourceLanguageCode: languageCode(input.sourceLanguageCode, 'sourceLanguageCode'),
    targetLanguageCode: languageCode(input.targetLanguageCode, 'targetLanguageCode'),
    sourceText: text(input.sourceText, 'sourceText'),
    translatedText: optionalText(input.translatedText, 'translatedText'),
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
    if (sameCue(existingById, incoming)) return { cue: clone(existingById), appended: false, cues: normalizedExisting };
    if (isMonotonicMergedCue(existingById, incoming)) {
      const cues = normalizedExisting.map((cue) => cue.cueId === incoming.cueId ? incoming : cue);
      return { cue: clone(incoming), appended: false, updated: true, cues };
    }
    return conflict(`Cue ${incoming.cueId} has conflicting payload.`);
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
    processedEventIds: Array.isArray(checkpoint.processedEventIds) ? checkpoint.processedEventIds : [],
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
  return ['cueId', 'sessionId', 'segmentId', 'sequence', 'startTimeMs', 'endTimeMs', 'sourceLanguageCode', 'targetLanguageCode', 'sourceText', 'translatedText', 'status', 'finalizedReason'].every((field) => left[field] === right[field]);
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
function finite(value, field) { if (!Number.isFinite(value)) return invalid(`${field} must be finite.`); return value; }
function nonNegativeFinite(value, field) { if (!Number.isFinite(value) || value < 0) return invalid(`${field} must be non-negative and finite.`); return value; }
function languageCode(value, field) { if (!LANGUAGE_CODES.has(value)) return invalid(`${field} is not supported.`); return value; }
function text(value, field) { if (typeof value !== 'string' || value.trim() === '' || PUNCTUATION_ONLY.test(value.trim())) return invalid(`${field} must contain non-punctuation text.`); return value.trim(); }
function optionalText(value, field) { if (value === '') return ''; return text(value, field); }
function invalid(message) { const error = new TypeError(message); error.code = CUE_ERROR_CODES.invalid; throw error; }
function conflict(message) { const error = new Error(message); error.code = CUE_ERROR_CODES.conflict; throw error; }
function sequenceConflict(message) { const error = new Error(message); error.code = CUE_ERROR_CODES.sequenceConflict; throw error; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
