export const CUE_REFINEMENT_STATUSES = Object.freeze([
  'pending',
  'queued',
  'running',
  'completed',
  'failed'
]);

export function rawSourceForCue(cue = {}) {
  return textOrEmpty(cue.rawSource ?? cue.sourceText);
}

export function rawTranslationForCue(cue = {}) {
  return textOrEmpty(cue.rawTranslation ?? cue.translatedText);
}

export function refinedSourceForCue(cue = {}) {
  return textOrEmpty(cue.refinedSource);
}

export function refinedTranslationForCue(cue = {}) {
  return textOrEmpty(cue.refinedTranslation);
}

export function effectiveSourceForCue(cue = {}, variant = 'refined') {
  if (variant === 'raw') return rawSourceForCue(cue);
  return refinedSourceForCue(cue) || rawSourceForCue(cue);
}

export function effectiveTranslationForCue(cue = {}, variant = 'refined') {
  if (variant === 'raw') return rawTranslationForCue(cue);
  return refinedTranslationForCue(cue) || rawTranslationForCue(cue);
}

export function cueRefinementInputHash(cue = {}) {
  const value = JSON.stringify({
    cueId: cue.cueId,
    sequence: cue.sequence,
    rawSource: rawSourceForCue(cue),
    rawTranslation: rawTranslationForCue(cue)
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeCueRefinement(cue = {}, now = null) {
  const inputHash = cueRefinementInputHash(cue);
  const current = cue.refinement && typeof cue.refinement === 'object' ? cue.refinement : {};
  const sameInput = current.inputHash === inputHash;
  return {
    status: CUE_REFINEMENT_STATUSES.includes(current.status) && sameInput ? current.status : 'pending',
    version: sameInput && Number.isInteger(current.version) && current.version > 0 ? current.version : 1,
    inputHash,
    ...(current.executionId ? { executionId: current.executionId } : {}),
    ...(current.requestedAt ? { requestedAt: current.requestedAt } : now ? { requestedAt: now } : {}),
    ...(current.startedAt ? { startedAt: current.startedAt } : {}),
    ...(current.completedAt ? { completedAt: current.completedAt } : {}),
    ...(current.failedAt ? { failedAt: current.failedAt } : {}),
    ...(current.failure ? { failure: current.failure } : {})
  };
}

export function cueRefinementItem(cue = {}) {
  const refinement = normalizeCueRefinement(cue);
  return {
    cueId: cue.cueId,
    sequence: cue.sequence,
    version: refinement.version,
    inputHash: refinement.inputHash,
    rawSource: rawSourceForCue(cue),
    rawTranslation: rawTranslationForCue(cue)
  };
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}
