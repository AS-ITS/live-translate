import { mergeFinalCue, validateFinalCue } from './index.js';

const SIDE_FIELDS = Object.freeze({
  source: ['sourceText', 'rawSource', 'sourceStatus'],
  translation: ['translatedText', 'rawTranslation', 'translationStatus', 'initialTranslation']
});

function reject(reason) { return { status: 'rejected', reason }; }

function equalFields(left, right, fields) {
  return fields.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}

/** The only Final Cue revision allocator. Input is a proposed full Cue plus the changed side. */
export function applyCueMutation(existing, { side, cue } = {}) {
  if (!cue || !['auto', 'initial', 'source', 'translation', 'refinement'].includes(side)) return reject('cue_mutation_invalid');
  let normalized;
  try { normalized = validateFinalCue(cue); } catch { return reject('cue_mutation_invalid'); }
  if (side === 'auto') {
    if (!existing) return applyCueMutation(null, { side: 'initial', cue });
    let current = existing;
    let changed = false;
    for (const candidateSide of ['source', 'translation', 'refinement']) {
      const result = applyCueMutation(current, { side: candidateSide, cue });
      if (result.status === 'rejected') return result;
      if (result.status === 'committed') { current = result.cue; changed = true; }
    }
    return { status: changed ? 'committed' : 'duplicate', cue: current };
  }
  if (!existing) {
 // The first committed Final may arrive as either side after a provisional Cue.
 // The complete proposed Cue supplies the initial immutable identity and both sides.
    return { status: 'committed', cue: { ...cue, ...normalized, revision: 1,
      ...(normalized.sourceText ? { sourceProvenance: normalized.sourceProvenance ?? provenanceFor(normalized) } : {}),
      ...(normalized.translatedText ? { translationProvenance: normalized.translationProvenance ?? provenanceFor(normalized) } : {}) } };
  }
  if (existing.cueId !== normalized.cueId || existing.sessionId !== normalized.sessionId
    || existing.segmentId !== normalized.segmentId || existing.sequence !== normalized.sequence
    || existing.startTimeMs !== normalized.startTimeMs) return reject('cue_identity_conflict');
  if (side === 'initial') {
    return equalFields(existing, normalized, [...SIDE_FIELDS.source, ...SIDE_FIELDS.translation])
      ? { status: 'duplicate', cue: existing } : reject('cue_initial_conflict');
  }
  const fields = SIDE_FIELDS[side];
  const changed = side === 'refinement'
    ? JSON.stringify([existing.refinement, existing.refinedSource, existing.refinedTranslation])
      !== JSON.stringify([normalized.refinement, normalized.refinedSource, normalized.refinedTranslation])
    : !equalFields(existing, normalized, fields);
  if (!changed) return { status: 'duplicate', cue: existing };
  const next = { ...existing, revision: (existing.revision || 0) + 1 };
  if (side === 'refinement') {
    next.refinement = normalized.refinement;
    next.refinedSource = normalized.refinedSource;
    next.refinedTranslation = normalized.refinedTranslation;
  } else {
    const version = side === 'source' ? 'sourceVersion' : 'translationVersion';
    if (normalized[version] <= (existing[version] || 0)) return reject('cue_stale_or_same_side_version');
    const textField = side === 'source' ? 'sourceText' : 'translatedText';
    const previousText = existing[textField] || '';
    const nextText = normalized[textField] || '';
    if (previousText && !nextText) return reject('cue_side_content_regression');
    if (previousText && !nextText.startsWith(previousText)
      && !provenNewerSameTurn(existing[`${side}Provenance`],
        normalized[`${side}Provenance`] ?? provenanceFor(normalized))) {
      return reject('cue_unproven_correction');
    }
    next[version] = (existing[version] || 0) + 1;
    for (const field of fields) next[field] = normalized[field];
    // A source-only Final update changes refinement input too. Its reset must
    // share the source version advance, before a separate refinement job runs.
    if (side === 'source' && existing.refinement && normalized.refinement
      && normalized.translationVersion === existing.translationVersion
      && normalized.translatedText === existing.translatedText
      && normalized.rawTranslation === existing.rawTranslation
      && normalized.initialTranslation === existing.initialTranslation
      && normalized.rawSource === normalized.sourceText
      && normalized.refinement.inputHash !== existing.refinement.inputHash
      && normalized.refinement.status === 'pending' && normalized.refinement.version === 1
      && normalized.refinedSource === null && normalized.refinedTranslation === null) {
      next.refinement = normalized.refinement;
      next.refinedSource = null;
      next.refinedTranslation = null;
    }
    // A late translation changes the refinement input along with initialTranslation.
    // Keep that reset in the same versioned Cue write so mergeFinalCue can verify it.
    if (side === 'translation' && existing.refinement && normalized.refinement
      && normalized.refinement.inputHash !== existing.refinement.inputHash
      && normalized.refinement.status === 'pending' && normalized.refinement.version === 1
      && normalized.refinedSource === null && normalized.refinedTranslation === null
      && normalized.sourceVersion === existing.sourceVersion
      && normalized.sourceText === existing.sourceText
      && normalized.rawSource === existing.rawSource) {
      next.refinement = normalized.refinement;
      next.refinedSource = null;
      next.refinedTranslation = null;
    }
    next[`${side}Provenance`] = normalized[`${side}Provenance`] ?? provenanceFor(normalized);
    for (const field of ['audioTurnId', 'turnKey', 'providerEventSequence', 'providerEpoch', 'connectionEpoch']) {
      if (normalized[field] !== undefined) next[field] = normalized[field];
    }
  }
  try {
    const result = mergeFinalCue([existing], next);
    return result.updated ? { status: 'committed', cue: result.cue } : reject('cue_transition_rejected');
  } catch (error) {
    return reject(error.rejectReason || error.code || 'cue_transition_rejected');
  }
}

function provenanceFor(cue) {
  return Object.fromEntries([
    ['audioTurnId', cue.audioTurnId], ['turnKey', cue.turnKey],
    ['providerEventId', cue.providerEventId], ['eventId', cue.eventId],
    ['connectionEpoch', cue.connectionEpoch], ['providerEpoch', cue.providerEpoch],
    ['eventSequence', cue.providerEventSequence]
  ].filter(([, value]) => value !== undefined && value !== null));
}

function provenNewerSameTurn(before, after) {
  if (!before || !after || !Number.isSafeInteger(before.connectionEpoch)
    || before.connectionEpoch !== after.connectionEpoch
    || !Number.isSafeInteger(before.providerEpoch)
    || before.providerEpoch !== after.providerEpoch
    || !Number.isSafeInteger(before.eventSequence)
    || !Number.isSafeInteger(after.eventSequence)
    || after.eventSequence <= before.eventSequence) return false;
  return Boolean((before.audioTurnId && before.audioTurnId === after.audioTurnId)
    || (before.turnKey && before.turnKey === after.turnKey));
}
