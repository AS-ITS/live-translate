const STREAMS = new Set(['source', 'translation']);
const DEFAULT_MINIMUM_GAP_MS = 1;
const DEFAULT_MINIMUM_CUE_DURATION_MS = 300;
const DEFAULT_ADJACENT_CUE_MAX_GAP_MS = 1200;
const DEFAULT_MAX_CUE_TEXT_LENGTH = 120;
export const DEFAULT_TURN_COMPLETE_DEBOUNCE_MS = 700;
export const DEFAULT_FINAL_CUE_REVISION_WINDOW_MS = 5000;
export const DEFAULT_MAX_RETRANSLATION_ATTEMPTS = 2;
export const MAX_PROCESSED_EVENT_IDS = 1024;
import { cueRefinementInputHash } from './cueContent.js';
import { isCumulativeSnapshot } from './cumulativeTranscript.js';

export function createSubtitleCueState(input = {}) {
  const finalCues = Array.isArray(input.finalCues) ? input.finalCues.map(copyCue) : [];
  const refinedSubtitleCues = Array.isArray(input.refinedSubtitleCues) ? input.refinedSubtitleCues.map(copyCue) : [];
  const pendingCues = Array.isArray(input.pendingCues) ? input.pendingCues.map(copyCue) : [];
  return {
    finalCues,
    refinedSubtitleCues,
    refinedSubtitleRevision: Number.isInteger(input.refinedSubtitleRevision) ? input.refinedSubtitleRevision : 0,
    refinedSubtitleInputHash: input.refinedSubtitleInputHash || null,
    refinedSubtitleStatus: input.refinedSubtitleStatus || 'pending',
    currentCue: input.currentCue ? copyCue(input.currentCue) : null,
    pendingCues,
    pendingBoundary: {
      turnComplete: Boolean(input.pendingBoundary?.turnComplete),
      generationComplete: Boolean(input.pendingBoundary?.generationComplete)
    },
    pendingBoundaryAtMs: Number.isFinite(input.pendingBoundaryAtMs) ? input.pendingBoundaryAtMs : null,
    lastFinalizedCueId: input.lastFinalizedCueId || null,
    lastFinalizedAtMs: Number.isFinite(input.lastFinalizedAtMs) ? input.lastFinalizedAtMs : null,
    lastFinalizedStream: input.lastFinalizedStream || null,
    lastFinalizedReason: input.lastFinalizedReason || null,
    nextSequence: Number.isInteger(input.nextSequence) && input.nextSequence > 0 ? input.nextSequence : 1,
    finalizedCueKeys: Array.isArray(input.finalizedCueKeys)
      ? [...input.finalizedCueKeys]
      : finalCues.map(stableCueKey),
    processedEventIds: Array.isArray(input.processedEventIds)
      ? input.processedEventIds.slice(-MAX_PROCESSED_EVENT_IDS)
      : []
  };
}

export function resetSubtitleCueState() {
  return createSubtitleCueState();
}

// Recovery checkpoints may contain an in-flight Cue from the previous
// Segment. Finalize only complete pairs, then discard all recovery-only
// partial/boundary state before the next Live session starts.
export function prepareSubtitleCueStateForNewSegment(stateInput, options = {}) {
  const state = createSubtitleCueState(stateInput);
  const flushed = finalizePendingSubtitleCue(state, options);
  return {
    ...flushed,
    currentCue: null,
    pendingCues: [],
    pendingBoundary: { turnComplete: false, generationComplete: false },
    pendingBoundaryAtMs: null,
    processedEventIds: [],
    lastFinalizedCueId: null,
    lastFinalizedAtMs: null,
    lastFinalizedStream: null,
    lastFinalizedReason: null
  };
}

export function applySubtitleCueEvent(stateInput, eventInput = {}, options = {}) {
  const state = createSubtitleCueState(stateInput);
  const event = normalizeEvent(eventInput, { ...options, finalCues: state.finalCues });
  if (!event) return stateInput;
  if (state.processedEventIds.includes(event.eventId)) return stateInput;

  const marked = markEventProcessed(state, event.eventId);
  if (!event.stream) {
    return applyBoundary(marked, event, options);
  }

  let eventState = marked;
  eventState = moveClosedCurrentCue(eventState, event);
  const sameTurnFinalTarget = !eventState.currentCue && eventState.pendingCues.length === 0
    ? findSameAudioTurnFinalCue(eventState, event)
    : null;
  const revisionFinalTarget = sameTurnFinalTarget || (!eventState.currentCue && eventState.pendingCues.length === 0
    ? findFinalRevisionCue(eventState, event, options)
    : null);
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV && typeof console !== 'undefined') {
    console.debug('[Cue decision]', JSON.stringify({
      eventId: event.eventId,
      audioTurnId: event.audioTurnId || null,
      eventSequence: event.eventSequence ?? null,
      match: sameTurnFinalTarget ? 'same-turn-final' : revisionFinalTarget ? 'revision-window' : 'none',
      matchedCueId: revisionFinalTarget?.cue?.cueId || null,
      action: revisionFinalTarget ? 'update' : 'create'
    }));
  }
  if (revisionFinalTarget) return updateFinalCue(eventState, revisionFinalTarget, event);
  const lateSourceOnlyTarget = !eventState.currentCue && eventState.pendingCues.length === 0 && event.stream === 'translation'
    ? findLateSourceOnlyCue(eventState, event)
    : null;
  if (lateSourceOnlyTarget) return updateFinalCue(eventState, lateSourceOnlyTarget, event);
  const target = findPairingCue(eventState, event);
  const next = target
    ? updateCue(eventState, target, event)
    : addCue(eventState, event);
  const cue = cueForState(next, target?.key || currentKey(next));
  if (!cue) return next;

  // Transcript events, including provider-final events and punctuation, only
  // update the pending bilingual pair. A boundary/idle/stop caller owns the
  // decision to commit a complete Cue.
  return next;
}

export function finalizePendingSubtitleCue(stateInput, options = {}) {
  const state = createSubtitleCueState(stateInput);
  const nowMs = resolveSessionTimeMs(options);
  if (!Number.isFinite(nowMs)) return stateInput;
  const candidates = [state.currentCue, ...state.pendingCues]
    .filter(isCueSubmittable)
    .sort((left, right) => left.startTimeMs - right.startTimeMs);
  if (candidates.length === 0) return stateInput;
  let next = state;
  for (const cue of candidates) {
    const candidate = cueForState(next, cue.key || stablePendingKey(cue));
    next = finalizeCue(next, candidate, {
      ...options,
      nowMs: cue.endTimeMs,
      reason: options.reason || 'flush',
      minimumGapMs: options.minimumGapMs,
      minimumCueDurationMs: options.minimumCueDurationMs
    });
  }
  return next;
}

// Resolves one candidate after transcript-idle debounce. This deliberately
// does not use microphone silence: the caller supplies the exact cue version
// observed when its timer was armed.
export function resolveIdleSubtitleCue(stateInput, options = {}) {
  const state = createSubtitleCueState(stateInput);
  const candidate = findIdleCandidate(state, options);
  if (!candidate) return { state: stateInput, action: 'stale' };

  const cue = candidate.cue;
  if (isCueSubmittable(cue)) {
    const boundaryAtMs = Number.isFinite(cue.boundaryAtMs)
      ? cue.boundaryAtMs
      : state.pendingBoundaryAtMs;
    const idleOriginMs = Number.isFinite(boundaryAtMs) ? boundaryAtMs : cue.updatedTimeMs;
    const debounceMs = Number.isFinite(options.debounceMs)
      ? options.debounceMs
      : DEFAULT_TURN_COMPLETE_DEBOUNCE_MS;
    const boundaryReady = Boolean(options.force) || (
      Number.isFinite(idleOriginMs) &&
      Number.isFinite(options.sessionTimeMs) &&
      options.sessionTimeMs >= idleOriginMs + debounceMs
    );
    if (!boundaryReady) {
      return { state: stateInput, action: 'waiting-for-more-text' };
    }
    return {
      state: finalizeCue(state, cue, {
        ...options,
        nowMs: options.sessionTimeMs,
        reason: cue.turnCompleteSeen ? 'turnComplete' : cue.generationCompleteSeen ? 'generationComplete' : 'idle',
        minimumGapMs: options.minimumGapMs,
        minimumCueDurationMs: options.minimumCueDurationMs
      }),
      action: 'finalized'
    };
  }

  if (!cue.targetLanguageCode && cue.sourceText) {
    return {
      state: finalizeCue(state, cue, {
        ...options,
        nowMs: options.sessionTimeMs,
        reason: cue.turnCompleteSeen ? 'turnComplete' : cue.generationCompleteSeen ? 'generationComplete' : 'idle'
      }),
      action: 'finalized'
    };
  }

  if (cue.sourceText && !cue.translatedText) {
    if (cue.retranslationFailed) return { state: stateInput, action: 'translation-failed', cue };
    const maxAttempts = Number.isInteger(options.maxRetranslationAttempts) && options.maxRetranslationAttempts > 0
      ? options.maxRetranslationAttempts
      : DEFAULT_MAX_RETRANSLATION_ATTEMPTS;
    const attempts = Number.isInteger(cue.retranslationAttempts) ? cue.retranslationAttempts : 0;
    if (attempts >= maxAttempts) {
      const failed = updateCandidate(state, candidate, {
        translationStatus: 'failed',
        retranslationFailed: true,
        updatedTimeMs: options.sessionTimeMs
      });
      return { state: failed, action: 'translation-failed', cue: cueForState(failed, candidate.key) };
    }
    const requested = updateCandidate(state, candidate, {
      retranslationRequested: true,
      retranslationAttempts: attempts + 1,
      updatedTimeMs: options.sessionTimeMs
    });
    return { state: requested, action: 'needs-retranslation', cue: cueForState(requested, candidate.key) };
  }

  // A model output without recognized source text is not durable transcript
  // content and must not enter final Cues or checkpoints.
  return { state: removeCandidate(state, candidate), action: 'discarded-translation-only' };
}

export function subtitleCuesForDisplay(stateInput) {
  const state = createSubtitleCueState(stateInput);
  const preview = pendingCuePreview(state);
  return preview ? [...state.finalCues, preview] : [...state.finalCues];
}

export function markNumericCorrectionRequested(stateInput, cueId) {
  const state = createSubtitleCueState(stateInput);
  const index = state.finalCues.findIndex((cue) => cue.cueId === cueId);
  if (index < 0 || state.finalCues[index].numericCorrectionRequested) return stateInput;
  const finalCues = [...state.finalCues];
  finalCues[index] = { ...finalCues[index], numericCorrectionRequested: true };
  return { ...state, finalCues };
}

function pendingCuePreview(state) {
  const candidates = [state.currentCue, ...state.pendingCues]
    .filter((cue) => cue && cue.status !== 'final')
    .filter((cue) => normalizeText(cue.sourceText) || normalizeText(cue.translatedText))
    .sort((left, right) => (right.updatedTimeMs || right.endTimeMs || 0) - (left.updatedTimeMs || left.endTimeMs || 0));
  if (candidates.length === 0) return null;
  return candidates.reduce((preview, cue) => ({
    ...preview,
    cueId: preview.cueId || cue.cueId,
    sequence: Math.min(preview.sequence || cue.sequence, cue.sequence || preview.sequence),
    startTimeMs: Math.min(preview.startTimeMs ?? cue.startTimeMs, cue.startTimeMs ?? preview.startTimeMs),
    endTimeMs: Math.max(preview.endTimeMs ?? cue.endTimeMs, cue.endTimeMs ?? preview.endTimeMs),
    sourceText: preview.sourceText || cue.sourceText || '',
    translatedText: preview.translatedText || cue.translatedText || '',
    status: 'partial'
  }), {});
}

function normalizeEvent(event, options) {
  const control = !event.stream && (event.turnComplete || event.generationComplete);
  if (!control && !STREAMS.has(event.stream)) return null;
  const sessionTimeMs = resolveSessionTimeMs({ ...options, ...event });
  if (!Number.isFinite(sessionTimeMs)) return null;
  const text = normalizeText(deltaAfterFinalCues(event, options));
  if (!control && (!text || isPunctuationOnly(text))) return null;
  return {
    ...event,
    eventId: event.eventId || deterministicEventId({ ...event, text, eventType: control ? 'boundary' : event.eventType || 'transcript' }),
    stream: control ? null : event.stream,
    text,
    sessionTimeMs,
    isFinal: Boolean(event.isFinal),
    turnComplete: Boolean(event.turnComplete),
    generationComplete: Boolean(event.generationComplete),
    sessionId: event.sessionId || options.sessionId || null,
    liveSessionId: event.liveSessionId || options.liveSessionId || null,
    segmentId: event.segmentId || options.segmentId || null,
    turnIndex: event.turnIndex ?? options.turnIndex ?? null
  };
}

function deterministicEventId({ eventId, liveSessionId, sessionId, segmentId, turnIndex, eventSequence, stream, eventType, text }) {
  if (eventId) return String(eventId);
  return [
    'cue-event', liveSessionId || sessionId || 'session-unknown', segmentId || 'segment-unknown',
    turnIndex ?? 'turn-unknown', eventSequence ?? 'sequence-unknown',
    stream || 'control', eventType || 'event', normalizeText(text)
  ].join('|');
}

function markEventProcessed(state, eventId) {
  return {
    ...state,
    processedEventIds: [...state.processedEventIds, eventId].slice(-MAX_PROCESSED_EVENT_IDS)
  };
}

export function dismissSubtitleCue(stateInput, cueId) {
  const state = createSubtitleCueState(stateInput);
  if (!cueId) return stateInput;
  if (state.currentCue?.cueId === cueId) {
    return { ...state, currentCue: null };
  }
  const pendingCues = state.pendingCues.filter((cue) => cue.cueId !== cueId);
  return pendingCues.length === state.pendingCues.length
    ? stateInput
    : { ...state, pendingCues };
}

function applyBoundary(state, event, options) {
  const nowMs = event.sessionTimeMs;
  const update = (cue) => cue ? {
    ...cue,
    turnCompleteSeen: cue.turnCompleteSeen || event.turnComplete,
    generationCompleteSeen: cue.generationCompleteSeen || event.generationComplete,
    boundaryAtMs: nowMs
  } : cue;
  const hasExistingCue = Boolean(state.currentCue || state.pendingCues.length > 0);
  let next = {
    ...state,
    currentCue: update(state.currentCue),
    pendingCues: state.pendingCues.map(update),
    pendingBoundary: hasExistingCue
      ? { turnComplete: false, generationComplete: false }
      : {
        turnComplete: state.pendingBoundary.turnComplete || event.turnComplete,
        generationComplete: state.pendingBoundary.generationComplete || event.generationComplete
      },
    pendingBoundaryAtMs: hasExistingCue ? state.pendingBoundaryAtMs : nowMs
  };
  return next;
}

function moveClosedCurrentCue(state, event) {
  const current = state.currentCue;
  if (!current) return state;
  if (isIdentityBoundSourceSnapshot(current, event)) return state;
  const sameScope = cueScopeMatchesEvent(current, event);
  const sameTurn = event.turnIndex !== null && current.turnIndex !== null && current.turnIndex === event.turnIndex;
  if (!sameScope || (!sameAudioTurnId(current, event) && !isCumulativeTurnContinuation(current, event)) || (event.turnIndex !== null && current.turnIndex !== null && !sameTurn)) {
    return moveCueToNextState(state, current, event);
  }

  if (Number.isFinite(current.boundaryAtMs) && event.sessionTimeMs > current.boundaryAtMs) {
    const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
    const existing = normalizeText(current[field]);
    const incoming = normalizeText(event.text);
    const isSameUpdate = !existing || existing === incoming || existing.startsWith(incoming) || incoming.startsWith(existing);
    // A late counterpart or cumulative revision remains paired with the
    // boundary-marked Cue. A genuinely new stream value starts a new pending
    // pair, without finalizing the old one.
    if (!isSameUpdate && existing && event.stream === (current.sourceText ? 'source' : 'translation')) {
      return moveCueToNextState(state, current, event);
    }
  }

  return state;
}

function moveCueToNextState(state, current, event) {
  return {
    ...state,
    currentCue: null,
    pendingCues: [...state.pendingCues, current]
  };
}

function findPairingCue(state, event) {
  if (state.currentCue && cueCanAcceptCurrentCue(state.currentCue, event)) {
    return { key: 'current', cue: state.currentCue };
  }
  const index = state.pendingCues.findIndex((cue) => cueCanAccept(cue, event));
  return index >= 0 ? { key: `pending:${index}`, cue: state.pendingCues[index] } : null;
}

function cueCanAcceptCurrentCue(cue, event) {
  if (!cueScopeMatchesEvent(cue, event)) return false;
  if (!sameAudioTurnId(cue, event) && !isCumulativeTurnContinuation(cue, event)) return false;
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  return true;
}

function findFinalRevisionCue(state, event, options = {}) {
  const correctionTarget = findNumericCorrectionCue(state, event);
  if (correctionTarget) return correctionTarget;
  const index = state.finalCues.length - 1;
  const cue = state.finalCues[index];
  const cumulativeContinuation = cue && isCumulativeTurnContinuation(cue, event);
  if ((event.isFinal && Number.isFinite(event.eventSequence) && !event.isLateTranscript && !cumulativeContinuation) || !cue
    || (!event.isLateTranscript && !['turnComplete', 'generationComplete', 'merged'].includes(state.lastFinalizedReason))
    || (!event.isLateTranscript && !isWithinFinalRevisionWindow(state, cue, event, options))) return null;
  if (event.audioTurnId && cue.audioTurnId && event.audioTurnId !== cue.audioTurnId && !cumulativeContinuation) return null;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const existingText = normalizeText(cue[field]);
  const incomingText = normalizeText(event.text);
  if (existingText === incomingText || !existingText) return null;
  const isCumulative = incomingText.startsWith(existingText) || existingText.startsWith(incomingText);
  if (!isCumulative && event.isFinal && !event.isLateTranscript && !endsFragment(existingText)) return null;
  if (endsSentence(cue[field])) return null;
  if (state.lastFinalizedStream === event.stream && endsSentence(event.text) && !cumulativeContinuation) return null;
  return { index, cue, ...(cumulativeContinuation ? { snapshot: true } : {}) };
}

function findSameAudioTurnFinalCue(state, event) {
  const eventIdentity = turnIdentityFor(event);
  if (!eventIdentity) return null;
  for (let index = state.finalCues.length - 1; index >= 0; index -= 1) {
    const cue = state.finalCues[index];
    if (turnIdentityFor(cue) !== eventIdentity
      || !cueScopeMatchesEvent(cue, event)) continue;
    const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
    if (!isCumulativeTextUpdate(cue[field], event)) continue;
    return { index, cue, snapshot: true };
  }
  return null;
}

function findNumericCorrectionCue(state, event) {
  if (!event.retranslationCueId || event.stream !== 'translation') return null;
  const index = state.finalCues.findIndex((cue) => cue.cueId === event.retranslationCueId);
  return index >= 0 ? { index, cue: state.finalCues[index], replace: true } : null;
}

function isWithinFinalRevisionWindow(state, cue, event, options = {}) {
  if (state.lastFinalizedCueId && state.lastFinalizedCueId !== cue.cueId) return false;
  if (state.lastFinalizedStream && state.lastFinalizedStream !== 'source' && state.lastFinalizedStream !== 'translation') return false;
  if (!cueScopeMatchesEvent(cue, event)) return false;
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  const windowMs = Number.isFinite(options.finalCueRevisionWindowMs)
    ? options.finalCueRevisionWindowMs
    : DEFAULT_FINAL_CUE_REVISION_WINDOW_MS;
  const finalizedAtMs = Number.isFinite(state.lastFinalizedAtMs) ? state.lastFinalizedAtMs : cue.endTimeMs;
  return Number.isFinite(event.sessionTimeMs) && event.sessionTimeMs >= finalizedAtMs && event.sessionTimeMs <= finalizedAtMs + windowMs;
}

function findLateSourceOnlyCue(state, event) {
  for (let index = state.finalCues.length - 1; index >= 0; index -= 1) {
    const cue = state.finalCues[index];
    if (cue.translatedText || !cue.sourceText || !cue.retranslationRequested) continue;
    if (!cueScopeMatchesEvent(cue, event)) continue;
    if (!sameAudioTurnId(cue, event)) continue;
    if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) continue;
    return { index, cue };
  }
  return null;
}

function cueScopeMatchesEvent(cue, event) {
  return ['sessionId', 'liveSessionId', 'segmentId'].every((field) => (
    !event[field] || !cue[field] || event[field] === cue[field]
  ));
}

function sameAudioTurnId(cue, event) {
  return !cue.audioTurnId || !event.audioTurnId || cue.audioTurnId === event.audioTurnId;
}

function isCumulativeTurnContinuation(cue, event) {
  if (!cue || !event?.stream || !cueScopeMatchesEvent(cue, event)) return false;
  const cueIdentity = turnIdentityFor(cue);
  const eventIdentity = turnIdentityFor(event);
  if (!cueIdentity || !eventIdentity || cueIdentity !== eventIdentity) return false;
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  if (Number.isFinite(cue.providerEventSequence) && Number.isFinite(event.eventSequence)
    && event.eventSequence <= cue.providerEventSequence) return false;
  if (Number.isFinite(cue.updatedTimeMs) && Number.isFinite(event.sessionTimeMs)
    && event.sessionTimeMs < cue.updatedTimeMs) return false;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  return isCumulativeSnapshot(cue[field], event.text)
    && normalizeText(cue[field]) !== normalizeText(event.text);
}

function isIdentityBoundSourceSnapshot(cue, event) {
  return Boolean(cue && event?.stream
    && turnIdentityFor(cue)
    && turnIdentityFor(cue) === turnIdentityFor(event)
    && cueScopeMatchesEvent(cue, event)
    && isCumulativeTextUpdate(cue[event.stream === 'source' ? 'sourceText' : 'translatedText'], event));
}

function isCumulativeTextUpdate(currentText, event) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(event?.text);
  if (!current || !incoming) return false;
  if (current === incoming) return false;
  if (incoming.startsWith(current) || current.startsWith(incoming)) return true;
  const commonPrefix = commonPrefixLength(current, incoming);
  return commonPrefix >= 2 && commonPrefix / Math.min(current.length, incoming.length) >= 0.3;
}

function isReliableTurnIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return !/^(?:unknown|current|fallback|null|undefined|audio-turn-unknown)$/iu.test(value.trim());
}

function turnIdentityFor(value) {
  if (isReliableTurnIdentity(value?.turnKey)) return `key:${value.turnKey}`;
  if (isReliableTurnIdentity(value?.audioTurnId)) return `audio:${value.audioTurnId}`;
  return null;
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function updateFinalCue(state, target, event) {
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const finalCues = [...state.finalCues];
  const nextText = target.snapshot
    ? replaceCumulativeText(target.cue[field], event.text)
    : target.replace
      ? normalizeText(event.text)
      : mergeCueText(target.cue[field], event.text, event);
  finalCues[target.index] = {
    ...target.cue,
    [field]: nextText,
    ...(event.sourceLanguageCode ? { sourceLanguageCode: event.sourceLanguageCode } : {}),
    ...(event.targetLanguageCode ? { targetLanguageCode: event.targetLanguageCode } : {}),
    endTimeMs: Math.max(target.cue.endTimeMs, event.sessionTimeMs),
    updatedTimeMs: event.sessionTimeMs,
    finalizedReason: target.replace ? 'numeric-correction' : 'merged',
    ...(target.replace ? { numericCorrectionRequested: false } : {})
  };
  return {
    ...state,
    finalCues,
    lastFinalizedCueId: target.cue.cueId,
    lastFinalizedAtMs: event.sessionTimeMs,
    lastFinalizedStream: event.stream,
    lastFinalizedReason: 'merged'
  };
}

function replaceCumulativeText(currentText, incomingText) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(incomingText);
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming) || (incoming && current.endsWith(incoming))) return current;
  return incoming;
}

function hasSameAudioTurnId(cue, event) {
  return Boolean(cue.audioTurnId && event.audioTurnId && cue.audioTurnId === event.audioTurnId);
}

function cueCanAccept(cue, event) {
  if (!cueScopeMatchesEvent(cue, event)) return false;
  const sameTurn = hasSameAudioTurnId(cue, event);
  const openUnidentifiedTurn = !cue.audioTurnId && !event.audioTurnId && !cue.boundaryAtMs && !event.turnComplete && !event.generationComplete;
  if (!sameTurn && !openUnidentifiedTurn && !isCumulativeTurnContinuation(cue, event)) return false;
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  if (sameTurn || !openUnidentifiedTurn) return true;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  return !cue[field] || event.text.startsWith(cue[field]) || cue[field].startsWith(event.text) || isRedundantTextUpdate(cue[field], event.text);
}

function isRedundantTextUpdate(currentText, incomingText) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(incomingText);
  return incoming.length > 0 && incoming.length < current.length && current.endsWith(incoming);
}

function mergeCueText(currentText, incomingText, context = {}) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(incomingText);
  if (!current) return incoming;
  if (!incoming || current === incoming || current.startsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  if (isRedundantTextUpdate(current, incoming)) return current;
  return `${current}${needsTextSeparator(current, incoming, context) ? ' ' : ''}${incoming}`;
}

function needsTextSeparator(currentText, incomingText, context = {}) {
  if (containsCjk(currentText)
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(incomingText)) {
    return false;
  }
  if (/^[\s\p{P}\p{S}]/u.test(incomingText)) return false;
  if (/(?:interim|fragment)/iu.test(String(context.eventType || ''))
    || (/^[A-Za-z]+$/u.test(currentText) && /^[a-z]+$/u.test(incomingText) && currentText.length <= 4)) {
    return false;
  }
  return /\S$/u.test(currentText);
}

function isCueSubmittable(cue) {
  return Boolean(cue && normalizeText(cue.sourceText)
    && (!cue.targetLanguageCode || normalizeText(cue.translatedText)));
}

function addCue(state, event) {
  const cue = {
    cueId: cueIdFor({ sessionId: event.sessionId || event.liveSessionId, segmentId: event.segmentId, sequence: state.nextSequence }),
    sessionId: event.sessionId || null,
    liveSessionId: event.liveSessionId || null,
    segmentId: event.segmentId || null,
    turnIndex: event.turnIndex ?? null,
    turnKey: event.turnKey || null,
    sequence: state.nextSequence,
    startTimeMs: event.sessionTimeMs,
    endTimeMs: event.sessionTimeMs,
    sourceLanguageCode: event.sourceLanguageCode || null,
    targetLanguageCode: event.targetLanguageCode || null,
    mode: event.targetLanguageCode ? 'translation' : 'transcription',
    sourceText: event.stream === 'source' ? event.text : '',
    translatedText: event.stream === 'translation' ? event.text : '',
    status: 'partial',
    ...(event.terminalStatus ? { terminalStatus: event.terminalStatus } : {}),
    ...(event.terminalReason ? { terminalReason: event.terminalReason } : {}),
    ...(event.audioTurnId ? { audioTurnId: event.audioTurnId } : {}),
    updatedTimeMs: event.sessionTimeMs,
    providerEventSequence: Number.isFinite(event.eventSequence) ? event.eventSequence : null,
    boundaryAtMs: event.turnComplete || event.generationComplete
      ? event.sessionTimeMs
      : state.pendingBoundaryAtMs,
    turnCompleteSeen: event.turnComplete || state.pendingBoundary.turnComplete,
    generationCompleteSeen: event.generationComplete || state.pendingBoundary.generationComplete
  };
  return {
    ...state,
    currentCue: cue,
    nextSequence: Math.max(state.nextSequence, cue.sequence + 1),
    pendingBoundary: { turnComplete: false, generationComplete: false },
    pendingBoundaryAtMs: null
  };
}

function updateCue(state, target, event) {
  const cue = target.cue;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const nextText = isIdentityBoundSourceSnapshot(cue, event)
    ? replaceCumulativeText(cue[field], event.text)
    : mergeCueText(cue[field], event.text, event);
  const updated = {
    ...cue,
    [field]: nextText,
    ...(event.sourceLanguageCode ? { sourceLanguageCode: event.sourceLanguageCode } : {}),
    ...(event.targetLanguageCode ? { targetLanguageCode: event.targetLanguageCode } : {}),
    endTimeMs: Math.max(cue.endTimeMs, event.sessionTimeMs),
    updatedTimeMs: event.sessionTimeMs,
    providerEventSequence: Number.isFinite(event.eventSequence)
      ? event.eventSequence
      : cue.providerEventSequence,
    status: 'partial',
    ...(event.terminalStatus ? { terminalStatus: event.terminalStatus } : {}),
    ...(event.terminalReason ? { terminalReason: event.terminalReason } : {}),
    ...(event.audioTurnId ? { audioTurnId: event.audioTurnId } : {}),
    ...(event.turnKey ? { turnKey: event.turnKey } : {}),
    boundaryAtMs: event.turnComplete || event.generationComplete
      ? event.sessionTimeMs
      : cue.boundaryAtMs,
    turnCompleteSeen: cue.turnCompleteSeen || event.turnComplete,
    generationCompleteSeen: cue.generationCompleteSeen || event.generationComplete
  };
  if (target.key === 'current') return { ...state, currentCue: updated };
  const index = Number(target.key.slice('pending:'.length));
  const pendingCues = [...state.pendingCues];
  pendingCues[index] = updated;
  return { ...state, pendingCues };
}

function cueForState(state, key) {
  if (!key) return null;
  if (key === 'current') return state.currentCue;
  if (key.startsWith('pending:')) return state.pendingCues[Number(key.slice('pending:'.length))] || null;
  return state.currentCue?.cueId === key ? state.currentCue : state.pendingCues.find((cue) => cue.cueId === key) || null;
}

function findIdleCandidate(state, options) {
  const cueId = options.cueId;
  const updatedTimeMs = options.updatedTimeMs;
  const candidates = [
    state.currentCue ? { key: 'current', cue: state.currentCue } : null,
    ...state.pendingCues.map((cue, index) => ({ key: `pending:${index}`, cue }))
  ].filter(Boolean);
  return candidates.find(({ cue }) => (
    (!cueId || cue.cueId === cueId) &&
    (!Number.isFinite(updatedTimeMs) || cue.updatedTimeMs === updatedTimeMs)
  )) || null;
}

function updateCandidate(state, candidate, patch) {
  const cue = { ...candidate.cue, ...patch };
  if (candidate.key === 'current') return { ...state, currentCue: cue };
  const index = Number(candidate.key.slice('pending:'.length));
  const pendingCues = [...state.pendingCues];
  pendingCues[index] = cue;
  return { ...state, pendingCues };
}

function removeCandidate(state, candidate) {
  if (candidate.key === 'current') return { ...state, currentCue: null };
  const index = Number(candidate.key.slice('pending:'.length));
  return { ...state, pendingCues: state.pendingCues.filter((_, itemIndex) => itemIndex !== index) };
}

function currentKey(state) { return state.currentCue ? 'current' : null; }

function finalizeCue(state, cue, options = {}) {
  if (!cue || !isCueSubmittable(cue)) return state;
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV && typeof console !== 'undefined') {
    console.debug('[Cue decision]', JSON.stringify({
      action: 'finalize',
      cueId: cue.cueId || null,
      sequence: cue.sequence || null,
      reason: options.reason || 'final'
    }));
  }
  const { nowMs, reason, minimumGapMs, minimumCueDurationMs } = options;
  const mode = cue.mode || (cue.targetLanguageCode ? 'translation' : 'transcription');
  const previousEnd = state.finalCues.at(-1)?.endTimeMs;
  const gapMs = Number.isFinite(minimumGapMs) ? Math.max(0, minimumGapMs) : DEFAULT_MINIMUM_GAP_MS;
  const minimumDurationMs = Number.isFinite(minimumCueDurationMs)
    ? Math.max(0, minimumCueDurationMs) : DEFAULT_MINIMUM_CUE_DURATION_MS;
  const observedEndTimeMs = Math.max(cue.endTimeMs, Number.isFinite(nowMs) ? nowMs : cue.endTimeMs);
  const startTimeMs = Math.max(cue.startTimeMs, Number.isFinite(previousEnd) ? previousEnd + gapMs : cue.startTimeMs);
  const endTimeMs = Math.max(observedEndTimeMs, startTimeMs + minimumDurationMs);
  const finalCue = {
    ...cue,
    mode,
    sourceText: normalizeText(cue.sourceText),
    translatedText: normalizeText(cue.translatedText),
    ...(mode === 'transcription' ? {} : {
      rawSource: normalizeText(cue.rawSource || cue.sourceText),
      rawTranslation: normalizeText(cue.rawTranslation || cue.translatedText),
      refinedSource: cue.refinedSource || null,
      refinedTranslation: cue.refinedTranslation || null,
      refinement: {
        status: 'pending',
        version: 1,
        inputHash: cueRefinementInputHash({
          ...cue,
          rawSource: normalizeText(cue.rawSource || cue.sourceText),
          rawTranslation: normalizeText(cue.rawTranslation || cue.translatedText)
        })
      }
    }),
    status: 'final', startTimeMs, endTimeMs,
    finalizedReason: reason || 'final'
  };
  const previousCue = state.finalCues.at(-1);
  const mergedCue = mergeAdjacentFinalCues(previousCue, finalCue, {
    ...options,
    observedEndTimeMs
  });
  if (mergedCue) {
    const previousKey = stableCueKey(previousCue);
    const mergedKey = stableCueKey(mergedCue);
    return {
      ...state,
      finalCues: [...state.finalCues.slice(0, -1), mergedCue],
      finalizedCueKeys: [...new Set([...state.finalizedCueKeys, previousKey, stableCueKey(finalCue), mergedKey])],
      nextSequence: Math.max(state.nextSequence, cue.sequence + 1),
      lastFinalizedCueId: mergedCue.cueId,
      lastFinalizedAtMs: Number.isFinite(nowMs) ? nowMs : mergedCue.endTimeMs,
      lastFinalizedStream: options.stream || null,
      lastFinalizedReason: mergedCue.finalizedReason,
      currentCue: state.currentCue?.cueId === cue.cueId ? null : state.currentCue,
      pendingCues: state.pendingCues.filter((item) => item.cueId !== cue.cueId)
    };
  }
  const cueKey = stableCueKey(finalCue);
  let next = {
    ...state,
    currentCue: state.currentCue?.cueId === cue.cueId ? null : state.currentCue,
    pendingCues: state.pendingCues.filter((item) => item.cueId !== cue.cueId),
    nextSequence: cue.sequence
  };
  if (!state.finalizedCueKeys.includes(cueKey)) {
    next = {
      ...next,
      finalCues: [...next.finalCues, finalCue],
      finalizedCueKeys: [...next.finalizedCueKeys, cueKey]
    };
  }
  next = { ...next, nextSequence: Math.max(next.nextSequence, cue.sequence + 1) };
  next = {
    ...next,
    lastFinalizedCueId: finalCue.cueId,
    lastFinalizedAtMs: Number.isFinite(nowMs) ? nowMs : finalCue.endTimeMs,
    lastFinalizedStream: options.stream || null,
    lastFinalizedReason: finalCue.finalizedReason
  };
  if (next.currentCue?.cueId === cue.cueId) return { ...next, currentCue: null };
  return { ...next, pendingCues: next.pendingCues.filter((item) => item.cueId !== cue.cueId) };
}

function mergeAdjacentFinalCues(previousCue, nextCue, options = {}) {
  if (!previousCue || !canMergeAdjacentFinalCues(previousCue, nextCue, options)) return null;
  return {
    ...previousCue,
    sourceText: mergeCueText(previousCue.sourceText, nextCue.sourceText),
    translatedText: mergeCueText(previousCue.translatedText, nextCue.translatedText),
    rawSource: mergeCueText(previousCue.rawSource || previousCue.sourceText, nextCue.rawSource || nextCue.sourceText),
    rawTranslation: mergeCueText(previousCue.rawTranslation || previousCue.translatedText, nextCue.rawTranslation || nextCue.translatedText),
    refinedSource: null,
    refinedTranslation: null,
    refinement: { status: 'pending', version: 1, inputHash: cueRefinementInputHash({
      cueId: previousCue.cueId,
      sequence: previousCue.sequence,
      rawSource: mergeCueText(previousCue.rawSource || previousCue.sourceText, nextCue.rawSource || nextCue.sourceText),
      rawTranslation: mergeCueText(previousCue.rawTranslation || previousCue.translatedText, nextCue.rawTranslation || nextCue.translatedText)
    }) },
    endTimeMs: Math.max(previousCue.endTimeMs, options.observedEndTimeMs || nextCue.endTimeMs),
    updatedTimeMs: Math.max(previousCue.updatedTimeMs || 0, nextCue.updatedTimeMs || 0),
    finalizedReason: nextCue.finalizedReason === 'length' ? 'length' : 'merged'
  };
}

function canMergeAdjacentFinalCues(previousCue, nextCue, options = {}) {
  if (previousCue.status !== 'final' || nextCue.status !== 'final') return false;
  if (previousCue.finalizedReason === 'length' || nextCue.finalizedReason === 'length') return false;
  if (previousCue.sessionId && nextCue.sessionId && previousCue.sessionId !== nextCue.sessionId) return false;
  if (previousCue.liveSessionId && nextCue.liveSessionId && previousCue.liveSessionId !== nextCue.liveSessionId) return false;
  if (previousCue.segmentId && nextCue.segmentId && previousCue.segmentId !== nextCue.segmentId) return false;
  if (previousCue.audioTurnId && nextCue.audioTurnId && previousCue.audioTurnId !== nextCue.audioTurnId) return false;
  if (previousCue.sourceText === nextCue.sourceText && previousCue.translatedText === nextCue.translatedText) return false;
  if (endsSentence(previousCue.sourceText) || endsSentence(previousCue.translatedText)) return false;
  const adjacentTexts = [previousCue.sourceText, previousCue.translatedText, nextCue.sourceText, nextCue.translatedText];
  if (!adjacentTexts.some(endsFragment) && !adjacentTexts.some(isNumericFragment)) return false;

  const gapMs = Math.max(0, nextCue.startTimeMs - previousCue.endTimeMs);
  if (gapMs > DEFAULT_ADJACENT_CUE_MAX_GAP_MS) return false;

  const sourceText = mergeCueText(previousCue.sourceText, nextCue.sourceText);
  const translatedText = mergeCueText(previousCue.translatedText, nextCue.translatedText);
  const maxLength = DEFAULT_MAX_CUE_TEXT_LENGTH;
  // Prefer a complete sentence over provider turn boundaries. The length cap
  // is only a safety valve so an absent punctuation event cannot grow one Cue
  // without limit.
  return Boolean(sourceText && translatedText)
    && sourceText.length <= maxLength
    && translatedText.length <= maxLength;
}

function containsCjk(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

function endsFragment(text) {
  return /[,，、:：;；]/u.test(normalizeText(text));
}

function isNumericFragment(text) {
  return /^\d[\d\s]*$/u.test(normalizeText(text));
}

function endsSentence(text) {
  return /[.!?。！？…]+["'”’」』）)]*$/u.test(normalizeText(text));
}

function resolveSessionTimeMs(input = {}) {
  if (Number.isFinite(input.sessionTimeMs) && input.sessionTimeMs >= 0) return input.sessionTimeMs;
  if (typeof input.sessionClock === 'function') {
    const value = input.sessionClock();
    if (Number.isFinite(value) && value >= 0) return value;
  }
  if (Number.isFinite(input.now) && Number.isFinite(input.sessionStartedAt)) return Math.max(0, input.now - input.sessionStartedAt);
  return null;
}

function deltaAfterFinalCues(event, options) {
  const text = String(event.text || '');
  if (event.stream === 'source' && event.audioTurnId) return text;
  // Final transcript events close a provider turn. A later turn may legally
  // repeat the same number or phrase as the completed history, so treating a
  // final event as a cumulative history update would discard real speech.
  // History-prefix removal is only safe for non-final cumulative updates.
  if (event.isFinal) return text;
  const finalCues = Array.isArray(options.finalCues) ? options.finalCues : [];
  const values = event.stream === 'source' ? finalCues.map((cue) => cue.sourceText) : finalCues.map((cue) => cue.translatedText);
  if (values.length < 2) return text;
  const prefixes = [values.join(' '), values.join('')].filter(Boolean);
  const prefix = prefixes.find((candidate) => text.length > candidate.length && text.startsWith(candidate));
  return prefix ? text.slice(prefix.length) : text;
}

function isPunctuationOnly(text) { return /^[\s。！？.!?，,、；;：:]+$/u.test(text); }
function normalizeText(text) { return String(text || '').replace(/\s+/gu, ' ').trim(); }
function stablePendingKey(cue) { return cue.cueId || stableCueKey(cue); }
function stableCueKey(cue) { return [cue.sessionId || cue.liveSessionId || '', cue.segmentId || '', cue.sequence, cue.startTimeMs, cue.sourceText, cue.translatedText].join('|'); }
function cueIdFor({ sessionId, segmentId, sequence }) { return ['cue', sessionId, segmentId, sequence].filter(Boolean).join(':'); }
function copyCue(cue) { return { ...cue }; }
