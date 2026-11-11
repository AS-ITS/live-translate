import { mergeFinalCue, validateFinalCue } from './index.js';
import { cueRefinementInputHash } from '../../lib/cueContent.js';

const SIDE_FIELDS = Object.freeze({
  source: ['sourceText', 'rawSource', 'sourceStatus'],
  translation: ['translatedText', 'rawTranslation', 'translationStatus', 'initialTranslation']
});

function reject(reason) { return { status: 'rejected', reason }; }

function equalFields(left, right, fields) {
  return fields.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}
function versionState(existing, incoming, side) {
  const currentSide = existing?.[`${side}Provenance`];
  const incomingSide = incoming?.[`${side}Provenance`];
  const sideVersion = side === 'source' ? 'sourceVersion'
    : side === 'translation' ? 'translationVersion' : null;
  return {
    expectedSideVersion: sideVersion ? (existing?.[sideVersion] ?? 0) + 1 : null,
    currentRevision: existing?.revision ?? null, incomingRevision: incoming?.revision ?? null,
    currentSourceVersion: existing?.sourceVersion ?? null, incomingSourceVersion: incoming?.sourceVersion ?? null,
    currentTranslationVersion: existing?.translationVersion ?? null,
    incomingTranslationVersion: incoming?.translationVersion ?? null,
    currentRefinementVersion: existing?.refinement?.version ?? null,
    incomingRefinementVersion: incoming?.refinement?.version ?? null,
    currentProviderSequence: existing?.providerEventSequence ?? null,
    incomingProviderSequence: incoming?.providerEventSequence ?? null,
    currentSideSequence: currentSide?.eventSequence ?? null,
    incomingSideSequence: incomingSide?.eventSequence ?? null,
    currentSideConnectionEpoch: currentSide?.connectionEpoch ?? null,
    incomingSideConnectionEpoch: incomingSide?.connectionEpoch ?? null,
    currentSideProviderEpoch: currentSide?.providerEpoch ?? null,
    incomingSideProviderEpoch: incomingSide?.providerEpoch ?? null,
    currentTurnId: currentSide?.audioTurnId ?? existing?.audioTurnId ?? null,
    incomingTurnId: incomingSide?.audioTurnId ?? incoming?.audioTurnId ?? null,
    provenanceChecks: {
      currentSidePresent: Boolean(currentSide),
      incomingSidePresent: Boolean(incomingSide),
      connectionEpochsValid: Number.isSafeInteger(currentSide?.connectionEpoch)
        && Number.isSafeInteger(incomingSide?.connectionEpoch),
      sameConnectionEpoch: currentSide?.connectionEpoch === incomingSide?.connectionEpoch,
      providerEpochsValid: Number.isSafeInteger(currentSide?.providerEpoch)
        && Number.isSafeInteger(incomingSide?.providerEpoch),
      sameProviderEpoch: currentSide?.providerEpoch === incomingSide?.providerEpoch,
      eventSequencesValid: Number.isSafeInteger(currentSide?.eventSequence)
        && Number.isSafeInteger(incomingSide?.eventSequence),
      newerSideSequence: Number.isSafeInteger(currentSide?.eventSequence)
        && Number.isSafeInteger(incomingSide?.eventSequence)
        && incomingSide.eventSequence > currentSide.eventSequence,
      sameAudioTurn: Boolean(currentSide?.audioTurnId
        && currentSide.audioTurnId === incomingSide?.audioTurnId),
      sameTurnKey: Boolean(currentSide?.turnKey
        && currentSide.turnKey === incomingSide?.turnKey),
      incomingTurnMatchesCue: !incoming?.audioTurnId
        || incomingSide?.audioTurnId === incoming.audioTurnId,
      incomingTurnKeyMatchesCue: !incoming?.turnKey
        || incomingSide?.turnKey === incoming.turnKey,
      currentSideHasProviderEventId: Boolean(currentSide?.providerEventId),
      incomingSideHasProviderEventId: Boolean(incomingSide?.providerEventId),
      currentSideHasEventId: Boolean(currentSide?.eventId),
      incomingSideHasEventId: Boolean(incomingSide?.eventId)
    }
  };
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
  if (side === 'refinement' && (
    normalized.initialTranslation !== existing.initialTranslation
    || normalized.translationVersion !== existing.translationVersion
    || JSON.stringify(normalized.translationProvenance ?? null) !== JSON.stringify(existing.translationProvenance ?? null)
    || normalized.refinement?.inputHash !== cueRefinementInputHash(existing)
  )) return reject('cue_refinement_input_conflict');
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
    const provenance = normalized[`${side}Provenance`];
    if (!provenNewerSameTurn(existing[`${side}Provenance`] ?? provenanceFor(existing), provenance)
      || (normalized.audioTurnId && provenance.audioTurnId !== normalized.audioTurnId)
      || (normalized.turnKey && provenance.turnKey !== normalized.turnKey)) {
      return { ...reject(`cue_${side}_event_unproven`),
        versionState: versionState(existing, normalized, side) };
    }
    const textField = side === 'source' ? 'sourceText' : 'translatedText';
    const previousText = existing[textField] || '';
    const nextText = normalized[textField] || '';
    if (previousText && !nextText) return reject('cue_side_content_regression');
    if (previousText && !nextText.startsWith(previousText)
      && !provenNewerSameTurn(existing[`${side}Provenance`],
        normalized[`${side}Provenance`])) {
      return reject('cue_unproven_correction');
    }
    next[version] = (existing[version] || 0) + 1;
    for (const field of fields) next[field] = normalized[field];
    // Reset refinement with the authority side whose raw input changed.
    if (side === 'translation' && next.initialTranslation !== existing.initialTranslation) {
      next.initialTranslation = next.translatedText;
    }
    if (provenance) {
      next[`${side}Provenance`] = provenance;
      if (Number.isSafeInteger(provenance.eventSequence)
        && provenance.eventSequence > (existing.providerEventSequence ?? -1)) {
        next.providerEventSequence = provenance.eventSequence;
        for (const field of ['audioTurnId', 'turnKey', 'providerEpoch', 'connectionEpoch']) {
          if (provenance[field] != null) next[field] = provenance[field];
        }
      }
    }
    const inputHash = cueRefinementInputHash(next);
    if (existing.refinement && inputHash !== existing.refinement.inputHash) {
      next.refinement = { status: 'pending', version: 1, inputHash };
      next.refinedSource = null;
      next.refinedTranslation = null;
    }
  }
  try {
    const result = mergeFinalCue([existing], next);
    if (!result.updated) return reject('cue_transition_rejected');
    const committed = { ...result.cue };
    // The authority validator canonicalizes both sides from raw content.
    // Preserve the unrelated display side from the latest stored Cue.
    const preserved = side === 'source' ? SIDE_FIELDS.translation : side === 'translation'
      ? SIDE_FIELDS.source : [...SIDE_FIELDS.source, ...SIDE_FIELDS.translation];
    for (const field of preserved) committed[field] = existing[field];
    if (side === 'source') committed.sourceText = cue.sourceText;
    if (side === 'translation') {
      committed.translatedText = cue.translatedText;
      committed.initialTranslation = cue.initialTranslation;
    }
    if (side !== 'source') committed.sourceProvenance = existing.sourceProvenance;
    if (side !== 'translation') committed.translationProvenance = existing.translationProvenance;
    // The merge may carry the prior side's pending hash. Bind the reset to the fully merged Live input.
    if (side !== 'refinement' && committed.refinement
      && committed.refinement.inputHash !== cueRefinementInputHash(committed)) {
      committed.refinement = { status: 'pending', version: 1,
        inputHash: cueRefinementInputHash(committed) };
      committed.refinedSource = null;
      committed.refinedTranslation = null;
    }
    return { status: 'committed', cue: committed };
  } catch (error) {
    const result = reject(error.rejectReason || error.code || 'cue_transition_rejected');
    if (result.reason !== 'versioned_state_regression') return result;
    return { ...result, versionState: versionState(existing, normalized, side) };
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
