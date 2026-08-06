const STREAMS = new Set(['source', 'translation']);
const DEFAULT_MINIMUM_GAP_MS = 1;
const DEFAULT_MINIMUM_CUE_DURATION_MS = 300;
const DEFAULT_MAX_CUE_CHARS = Object.freeze({
  'zh-Hant': 32, 'zh-Hans': 32, ja: 36, ko: 44,
  en: 80, es: 84, fr: 84, de: 76
});

export function createSubtitleCueState(input = {}) {
  const finalCues = Array.isArray(input.finalCues) ? input.finalCues.map(copyCue) : [];
  const pendingCues = Array.isArray(input.pendingCues) ? input.pendingCues.map(copyCue) : [];
  return {
    finalCues,
    currentCue: input.currentCue ? copyCue(input.currentCue) : null,
    pendingCues,
    pendingBoundary: {
      turnComplete: Boolean(input.pendingBoundary?.turnComplete),
      generationComplete: Boolean(input.pendingBoundary?.generationComplete)
    },
    nextSequence: Number.isInteger(input.nextSequence) && input.nextSequence > 0 ? input.nextSequence : 1,
    finalizedCueKeys: Array.isArray(input.finalizedCueKeys)
      ? [...input.finalizedCueKeys]
      : finalCues.map(stableCueKey),
    processedEventIds: Array.isArray(input.processedEventIds) ? [...input.processedEventIds] : []
  };
}

export function resetSubtitleCueState() {
  return createSubtitleCueState();
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
  const cumulativeFinalTarget = !eventState.currentCue && eventState.pendingCues.length === 0
    ? findCumulativeFinalCue(eventState, event)
    : null;
  if (cumulativeFinalTarget) return updateFinalCue(eventState, cumulativeFinalTarget, event);
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

  const complete = isCueSubmittable(cue);
  if (complete && exceedsLanguageCueLimit(cue, options)) {
    const split = splitCompleteCue(next, cue, event, options);
    if (split) return split;
  }
  const shouldFinalize = complete && (
    event.isFinal || cue.turnCompleteSeen || cue.generationCompleteSeen || cue.retranslationRequested
  );
  if (shouldFinalize) return finalizeCue(next, cue, {
    ...options,
    nowMs: event.sessionTimeMs,
    reason: finalizeReason(event, cue, options),
    minimumGapMs: options.minimumGapMs,
    minimumCueDurationMs: options.minimumCueDurationMs
  });

  if (complete && exceedsLanguageCueLimit(cue, options)) {
    // Keep the bilingual pair atomic when no safe, aligned split exists.
    return finalizeCue(next, cue, {
      ...options,
      nowMs: event.sessionTimeMs,
      reason: 'length',
      minimumGapMs: options.minimumGapMs,
      minimumCueDurationMs: options.minimumCueDurationMs
    });
  }
  return next;
}

export function finalizePendingSubtitleCue(stateInput, options = {}) {
  const state = createSubtitleCueState(stateInput);
  const nowMs = resolveSessionTimeMs(options);
  if (!Number.isFinite(nowMs)) return stateInput;
  const candidates = [state.currentCue, ...state.pendingCues].filter(isCueSubmittable);
  if (candidates.length === 0) return stateInput;
  let next = state;
  for (const cue of candidates) {
    next = finalizeCue(next, cueForState(next, cue.key || stablePendingKey(cue)), {
      ...options,
      nowMs,
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
    return {
      // Boundary is preferred, but some Live responses omit it after the
      // paired transcript arrives. The Cue is already aggregated by Turn,
      // so idle finalization is a safe fallback and will not split fragments.
      state: finalizeCue(state, cue, {
        ...options,
        nowMs: options.sessionTimeMs,
        reason: 'idle',
        minimumGapMs: options.minimumGapMs,
        minimumCueDurationMs: options.minimumCueDurationMs
      }),
      action: 'finalized'
    };
  }

  if (cue.sourceText && !cue.translatedText) {
    if (cue.retranslationRequested || options.retry) {
      return { state: stateInput, action: 'waiting-for-translation' };
    }
    const requested = updateCandidate(state, candidate, {
      retranslationRequested: true,
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
  return [
    ...state.finalCues,
    ...state.pendingCues,
    ...(state.currentCue ? [state.currentCue] : [])
  ];
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
  return { ...state, processedEventIds: [...state.processedEventIds, eventId] };
}

function applyBoundary(state, event, options) {
  const update = (cue) => cue ? {
    ...cue,
    turnCompleteSeen: cue.turnCompleteSeen || event.turnComplete,
    generationCompleteSeen: cue.generationCompleteSeen || event.generationComplete
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
      }
  };
  const nowMs = event.sessionTimeMs;
  const candidates = [next.currentCue, ...next.pendingCues].filter(isCueSubmittable)
    .filter((cue) => cue.turnCompleteSeen || cue.generationCompleteSeen);
  for (const cue of candidates) {
    next = finalizeCue(next, cueForState(next, cue.key || stablePendingKey(cue)), {
      ...options,
      nowMs,
      reason: event.turnComplete ? 'turnComplete' : 'generationComplete',
      minimumGapMs: options.minimumGapMs,
      minimumCueDurationMs: options.minimumCueDurationMs
    });
  }
  return next;
}

function moveClosedCurrentCue(state, event) {
  const current = state.currentCue;
  if (!current) return state;
  const sameSegment = !event.segmentId || !current.segmentId || event.segmentId === current.segmentId;
  const sameTurn = event.turnIndex !== null && current.turnIndex !== null && current.turnIndex === event.turnIndex;
  if (!sameSegment || (event.turnIndex !== null && current.turnIndex !== null && !sameTurn)) {
    return moveCueToNextState(state, current, event);
  }

  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const currentText = normalizeText(current[field]);
  if (!currentText || canContinueText(currentText, event.text)) return state;

  // An incomplete same-stream transcript can still be a non-cumulative
  // fragment of the current turn. Once that stream is already paired, or the
  // provider marks the incoming text final, an unrelated value starts a new
  // Cue instead of being appended to the previous one.
  if (!event.isFinal && (
    !isCueSubmittable(current) ||
    looksLikeContinuationFragment(event.text)
  )) return state;
  return moveCueToNextState(state, current, event);
}

function moveCueToNextState(state, current, event) {
  if (!isCueSubmittable(current)) {
    return { ...state, currentCue: null, pendingCues: [...state.pendingCues, current] };
  }
  return finalizeCue(state, current, {
    nowMs: event.sessionTimeMs,
    reason: 'next',
    minimumGapMs: DEFAULT_MINIMUM_GAP_MS,
    minimumCueDurationMs: DEFAULT_MINIMUM_CUE_DURATION_MS
  });
}

function findPairingCue(state, event) {
  if (state.currentCue && cueCanAcceptCurrentCue(state.currentCue, event)) {
    return { key: 'current', cue: state.currentCue };
  }
  const index = state.pendingCues.findIndex((cue) => cueCanAccept(cue, event));
  return index >= 0 ? { key: `pending:${index}`, cue: state.pendingCues[index] } : null;
}

function cueCanAcceptCurrentCue(cue, event) {
  if (event.segmentId && cue.segmentId && event.segmentId !== cue.segmentId) return false;
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  if (!cue[field]) return true;
  if (!event.isFinal && looksLikeContinuationFragment(event.text)) return true;
  if (!isCueSubmittable(cue) && !event.isFinal) return true;
  return canContinueText(cue[field], event.text);
}

function canContinueText(currentText, incomingText) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(incomingText);
  return Boolean(current && incoming) && (
    incoming.startsWith(current) ||
    current.startsWith(incoming) ||
    isRedundantTextUpdate(current, incoming)
  );
}

function looksLikeContinuationFragment(text) {
  return /[.!?。！？]$/u.test(normalizeText(text));
}

function findCumulativeFinalCue(state, event) {
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  for (let index = state.finalCues.length - 1; index >= 0; index -= 1) {
    const cue = state.finalCues[index];
    if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) continue;
    const previousText = normalizeText(cue[field]);
    if (previousText && event.text.length > previousText.length && event.text.startsWith(previousText)) {
      return { index, cue };
    }
  }
  return null;
}

function findLateSourceOnlyCue(state, event) {
  for (let index = state.finalCues.length - 1; index >= 0; index -= 1) {
    const cue = state.finalCues[index];
    if (cue.translatedText || !cue.sourceText || !cue.retranslationRequested) continue;
    if (event.segmentId && cue.segmentId && event.segmentId !== cue.segmentId) continue;
    if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) continue;
    return { index, cue };
  }
  return null;
}

function updateFinalCue(state, target, event) {
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const finalCues = [...state.finalCues];
  finalCues[target.index] = {
    ...target.cue,
    [field]: event.text,
    ...(event.sourceLanguageCode ? { sourceLanguageCode: event.sourceLanguageCode } : {}),
    ...(event.targetLanguageCode ? { targetLanguageCode: event.targetLanguageCode } : {}),
    endTimeMs: Math.max(target.cue.endTimeMs, event.sessionTimeMs),
    updatedTimeMs: event.sessionTimeMs
  };
  return { ...state, finalCues };
}

function cueCanAccept(cue, event) {
  if (event.segmentId && cue.segmentId && event.segmentId !== cue.segmentId) return false;
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  return !cue[field] || event.text.startsWith(cue[field]) || cue[field].startsWith(event.text) || isRedundantTextUpdate(cue[field], event.text);
}

function isRedundantTextUpdate(currentText, incomingText) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(incomingText);
  return incoming.length > 0 && incoming.length < current.length && current.endsWith(incoming);
}

function mergeCueText(currentText, incomingText) {
  const current = normalizeText(currentText);
  const incoming = normalizeText(incomingText);
  if (!current) return incoming;
  if (!incoming || current === incoming || current.startsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  if (isRedundantTextUpdate(current, incoming)) return current;
  return `${current}${needsTextSeparator(current, incoming) ? ' ' : ''}${incoming}`;
}

function needsTextSeparator(currentText, incomingText) {
  if (containsCjk(currentText)
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(incomingText)) {
    return false;
  }
  if (/^[\s\p{P}\p{S}]/u.test(incomingText)) return false;
  return /\S$/u.test(currentText);
}

function isCueSubmittable(cue) {
  return Boolean(cue && normalizeText(cue.sourceText) && normalizeText(cue.translatedText));
}

function addCue(state, event) {
  const cue = {
    cueId: cueIdFor({ sessionId: event.sessionId || event.liveSessionId, segmentId: event.segmentId, sequence: state.nextSequence }),
    sessionId: event.sessionId || null,
    liveSessionId: event.liveSessionId || null,
    segmentId: event.segmentId || null,
    turnIndex: event.turnIndex ?? null,
    sequence: state.nextSequence,
    startTimeMs: event.sessionTimeMs,
    endTimeMs: event.sessionTimeMs,
    sourceLanguageCode: event.sourceLanguageCode || null,
    targetLanguageCode: event.targetLanguageCode || null,
    sourceText: event.stream === 'source' ? event.text : '',
    translatedText: event.stream === 'translation' ? event.text : '',
    status: 'partial',
    updatedTimeMs: event.sessionTimeMs,
    turnCompleteSeen: event.turnComplete || state.pendingBoundary.turnComplete,
    generationCompleteSeen: event.generationComplete || state.pendingBoundary.generationComplete
  };
  return {
    ...state,
    currentCue: cue,
    pendingBoundary: { turnComplete: false, generationComplete: false }
  };
}

function updateCue(state, target, event) {
  const cue = target.cue;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const nextText = mergeCueText(cue[field], event.text);
  const updated = {
    ...cue,
    [field]: nextText,
    ...(event.sourceLanguageCode ? { sourceLanguageCode: event.sourceLanguageCode } : {}),
    ...(event.targetLanguageCode ? { targetLanguageCode: event.targetLanguageCode } : {}),
    endTimeMs: Math.max(cue.endTimeMs, event.sessionTimeMs),
    updatedTimeMs: event.sessionTimeMs,
    status: 'partial',
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
  const { nowMs, reason, minimumGapMs, minimumCueDurationMs } = options;
  const previousEnd = state.finalCues.at(-1)?.endTimeMs;
  const gapMs = Number.isFinite(minimumGapMs) ? Math.max(0, minimumGapMs) : DEFAULT_MINIMUM_GAP_MS;
  const minimumDurationMs = Number.isFinite(minimumCueDurationMs)
    ? Math.max(0, minimumCueDurationMs) : DEFAULT_MINIMUM_CUE_DURATION_MS;
  const startTimeMs = Math.max(cue.startTimeMs, Number.isFinite(previousEnd) ? previousEnd + gapMs : cue.startTimeMs);
  const endTimeMs = Math.max(cue.endTimeMs, Number.isFinite(nowMs) ? nowMs : cue.endTimeMs, startTimeMs + minimumDurationMs);
  const finalCue = {
    ...cue,
    sourceText: normalizeText(cue.sourceText),
    translatedText: normalizeText(cue.translatedText),
    status: 'final', startTimeMs, endTimeMs,
    finalizedReason: reason || 'final'
  };
  const previousCue = state.finalCues.at(-1);
  const mergedCue = mergeAdjacentFinalCues(previousCue, finalCue, options);
  if (mergedCue) {
    const previousKey = stableCueKey(previousCue);
    const mergedKey = stableCueKey(mergedCue);
    return {
      ...state,
      finalCues: [...state.finalCues.slice(0, -1), mergedCue],
      finalizedCueKeys: [...new Set([...state.finalizedCueKeys, previousKey, stableCueKey(finalCue), mergedKey])],
      nextSequence: Math.max(state.nextSequence, cue.sequence + 1),
      currentCue: state.currentCue?.cueId === cue.cueId ? null : state.currentCue,
      pendingCues: state.pendingCues.filter((item) => item.cueId !== cue.cueId)
    };
  }
  const cueKey = stableCueKey(finalCue);
  let next = state;
  if (!state.finalizedCueKeys.includes(cueKey)) {
    next = {
      ...next,
      finalCues: [...next.finalCues, finalCue],
      finalizedCueKeys: [...next.finalizedCueKeys, cueKey]
    };
  }
  next = { ...next, nextSequence: Math.max(next.nextSequence, cue.sequence + 1) };
  if (next.currentCue?.cueId === cue.cueId) return { ...next, currentCue: null };
  return { ...next, pendingCues: next.pendingCues.filter((item) => item.cueId !== cue.cueId) };
}

function mergeAdjacentFinalCues(previousCue, nextCue, options = {}) {
  if (!previousCue || !canMergeAdjacentFinalCues(previousCue, nextCue, options)) return null;
  return {
    ...previousCue,
    sourceText: mergeCueText(previousCue.sourceText, nextCue.sourceText),
    translatedText: mergeCueText(previousCue.translatedText, nextCue.translatedText),
    endTimeMs: Math.max(previousCue.endTimeMs, nextCue.endTimeMs),
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
  if (previousCue.sourceText === nextCue.sourceText && previousCue.translatedText === nextCue.translatedText) return false;
  if (endsSentence(previousCue.sourceText) || endsSentence(previousCue.translatedText)) return false;
  if (!isLikelyContinuation(previousCue, nextCue)) return false;

  const sourceText = mergeCueText(previousCue.sourceText, nextCue.sourceText);
  const translatedText = mergeCueText(previousCue.translatedText, nextCue.translatedText);
  return sourceText.length <= languageCueLimit(previousCue.sourceLanguageCode || nextCue.sourceLanguageCode, options)
    && translatedText.length <= languageCueLimit(previousCue.targetLanguageCode || nextCue.targetLanguageCode, options);
}

function isLikelyContinuation(previousCue, nextCue) {
  const previousTexts = [previousCue.sourceText, previousCue.translatedText].map(normalizeText);
  const nextTexts = [nextCue.sourceText, nextCue.translatedText].map(normalizeText);
  if (previousTexts.some((text) => /[,，、:：;；]$/u.test(text))) return true;
  if (nextTexts.some((text) => /[,，、:：;；]$/u.test(text))) return true;
  return nextTexts.some(endsSentence);
}

function containsCjk(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
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
  const finalCues = Array.isArray(options.finalCues) ? options.finalCues : [];
  const values = event.stream === 'source' ? finalCues.map((cue) => cue.sourceText) : finalCues.map((cue) => cue.translatedText);
  if (values.length < 2) return text;
  const prefixes = [values.join(' '), values.join('')].filter(Boolean);
  const prefix = prefixes.find((candidate) => text.length > candidate.length && text.startsWith(candidate));
  return prefix ? text.slice(prefix.length) : text;
}

function finalizeReason(event, cue, options) {
  if (event.isFinal) return 'final';
  if (event.turnComplete || cue.turnCompleteSeen) return 'turnComplete';
  if (event.generationComplete || cue.generationCompleteSeen) return 'generationComplete';
  if (exceedsLanguageCueLimit(cue, options)) return 'length';
  return 'final';
}

function exceedsLanguageCueLimit(cue, options) {
  const sourceLimit = languageCueLimit(cue?.sourceLanguageCode || options.sourceLanguageCode, options);
  const translationLimit = languageCueLimit(cue?.targetLanguageCode || options.targetLanguageCode, options);
  return normalizeText(cue?.sourceText).length > sourceLimit || normalizeText(cue?.translatedText).length > translationLimit;
}

function splitCompleteCue(state, cue, event, options) {
  const sourceLimit = languageCueLimit(cue.sourceLanguageCode || options.sourceLanguageCode, options);
  const translationLimit = languageCueLimit(cue.targetLanguageCode || options.targetLanguageCode, options);
  const sourceParts = splitCueText(cue.sourceText, sourceLimit);
  const translationParts = splitCueText(cue.translatedText, translationLimit);
  // Keep the bilingual Cue atomic when only one side has a safe split. This
  // prevents a source fragment from becoming a source-only export Cue, or a
  // short translation from being duplicated across multiple source Cues.
  if (sourceParts.length < 2 || translationParts.length < 2) return null;
  const partCount = Math.max(sourceParts.length, translationParts.length);
  if (partCount < 2) return null;

  const alignedSource = alignParts(sourceParts, partCount);
  const alignedTranslation = alignParts(translationParts, partCount);
  if (!alignedSource || !alignedTranslation || alignedSource.length !== alignedTranslation.length) return null;

  let next = state;
  for (let index = 0; index < alignedSource.length; index += 1) {
    const sequence = next.nextSequence;
    const partCue = {
      ...cue,
      cueId: cueIdFor({ sessionId: cue.sessionId || cue.liveSessionId, segmentId: cue.segmentId, sequence }),
      sequence,
      sourceText: alignedSource[index],
      translatedText: alignedTranslation[index],
      startTimeMs: cue.startTimeMs,
      endTimeMs: Math.max(cue.endTimeMs, event.sessionTimeMs),
      status: 'partial'
    };
    next = finalizeCue(next, partCue, {
      ...options,
      nowMs: event.sessionTimeMs,
      reason: 'length',
      minimumGapMs: options.minimumGapMs,
      minimumCueDurationMs: options.minimumCueDurationMs
    });
  }
  return next;
}

function languageCueLimit(languageCode, options) {
  if (Number.isInteger(options.maxCueChars)) return options.maxCueChars;
  return DEFAULT_MAX_CUE_CHARS[languageCode] || DEFAULT_MAX_CUE_CHARS.en;
}

function splitCueText(text, maxChars) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length <= maxChars) return [normalized];

  const parts = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const boundary = safeBoundaryBefore(remaining, maxChars);
    if (!boundary) return [normalized];
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

function safeBoundaryBefore(text, maxChars) {
  const protectedRanges = protectedTokenRanges(text);
  const isSafe = (position) => position > 0 && !protectedRanges.some(([start, end]) => position > start && position < end);
  const candidates = { sentence: [], clause: [], word: [], character: [] };
  const characters = Array.from(text);
  let offset = 0;
  for (const character of characters) {
    offset += character.length;
    if (offset > maxChars) break;
    if (!isSafe(offset)) continue;
    if (/[。！？.!?]/u.test(character)) candidates.sentence.push(offset);
    else if (/[，,、；;：:]/u.test(character)) candidates.clause.push(offset);
    else if (/\s/u.test(character)) candidates.word.push(offset);
    else if (isCjkCharacter(character)) candidates.character.push(offset);
  }
  for (const kind of ['sentence', 'clause', 'word', 'character']) {
    if (candidates[kind].length) return candidates[kind].at(-1);
  }

  const tokenEnd = protectedRanges.find(([, end]) => end > maxChars)?.[1];
  return tokenEnd && tokenEnd < text.length ? tokenEnd : null;
}

function protectedTokenRanges(text) {
  const ranges = [];
  const pattern = /https?:\/\/[^\s]+|www\.[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\d+(?:[.,]\d+)+(?:\s*[A-Za-z%°]+)?|\d{1,4}[./-]\d{1,4}(?:[./-]\d{1,4})?|\d+(?:\.\d+)?\s*[A-Za-z%°]+/giu;
  for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

function isCjkCharacter(character) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}

function alignParts(parts, count) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const aligned = [...parts];
  while (aligned.length < count) {
    const splitIndex = aligned.reduce((longest, part, index) => (
      part.length > aligned[longest].length ? index : longest
    ), 0);
    const part = aligned[splitIndex];
    const pieces = splitCueText(part, Math.max(1, Math.ceil(part.length / (count - aligned.length + 1))));
    if (pieces.length < 2) return null;
    const separator = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(pieces[0]) ? '' : ' ';
    aligned.splice(splitIndex, 1, pieces[0], pieces.slice(1).join(separator));
  }
  while (aligned.length > count) {
    let mergeIndex = 0;
    let shortest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < aligned.length - 1; index += 1) {
      const length = aligned[index].length + aligned[index + 1].length;
      if (length < shortest) {
        shortest = length;
        mergeIndex = index;
      }
    }
    aligned.splice(mergeIndex, 2, `${aligned[mergeIndex]}${aligned[mergeIndex + 1]}`.trim());
  }
  return aligned.length === count ? aligned : null;
}

function isPunctuationOnly(text) { return /^[\s。！？.!?，,、；;：:]+$/u.test(text); }
function normalizeText(text) { return String(text || '').replace(/\s+/gu, ' ').trim(); }
function stablePendingKey(cue) { return cue.cueId || stableCueKey(cue); }
function stableCueKey(cue) { return [cue.sessionId || cue.liveSessionId || '', cue.segmentId || '', cue.sequence, cue.startTimeMs, cue.sourceText, cue.translatedText].join('|'); }
function cueIdFor({ sessionId, segmentId, sequence }) { return ['cue', sessionId, segmentId, sequence].filter(Boolean).join(':'); }
function copyCue(cue) { return { ...cue }; }
