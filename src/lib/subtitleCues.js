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
  const event = normalizeEvent(eventInput, options);
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
  const target = findPairingCue(eventState, event);
  const next = target
    ? updateCue(eventState, target, event)
    : addCue(eventState, event);
  const cue = cueForState(next, target?.key || currentKey(next));
  if (!cue) return next;

  const complete = isCueSubmittable(cue);
  const shouldFinalize = complete && (
    event.isFinal || cue.turnCompleteSeen || cue.generationCompleteSeen || endsWithSentenceBoundary(event.text)
  );
  if (shouldFinalize) return finalizeCue(next, cue, {
    nowMs: event.sessionTimeMs,
    reason: finalizeReason(event, cue, options),
    minimumGapMs: options.minimumGapMs,
    minimumCueDurationMs: options.minimumCueDurationMs
  });

  if (complete && exceedsLanguageCueLimit(cue, options)) {
    // Translation/source cannot be split independently without risking semantic
    // misalignment. Keep the bilingual pair atomic and finalize it instead.
    return finalizeCue(next, cue, {
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
      nowMs,
      reason: options.reason || 'flush',
      minimumGapMs: options.minimumGapMs,
      minimumCueDurationMs: options.minimumCueDurationMs
    });
  }
  return next;
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

function deterministicEventId({ eventId, liveSessionId, sessionId, turnIndex, eventSequence, stream, eventType, text }) {
  if (eventId) return String(eventId);
  return [
    'cue-event', liveSessionId || sessionId || 'session-unknown',
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
  const sameTurn = event.turnIndex !== null && current.turnIndex === event.turnIndex;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const sameStreamContinuation = event.stream === 'source'
    ? event.text.startsWith(current.sourceText)
    : event.text.startsWith(current.translatedText);
  if (sameTurn || sameStreamContinuation) return state;
  if (!isCueSubmittable(current) && !current[field]) return state;
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
  if (state.currentCue && cueCanAccept(state.currentCue, event)) return { key: 'current', cue: state.currentCue };
  const index = state.pendingCues.findIndex((cue) => cueCanAccept(cue, event));
  return index >= 0 ? { key: `pending:${index}`, cue: state.pendingCues[index] } : null;
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
  if (event.turnIndex !== null && cue.turnIndex !== null && event.turnIndex !== cue.turnIndex) return false;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  return !cue[field] || event.text.startsWith(cue[field]) || cue[field].startsWith(event.text);
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
  const nextText = event.text.length >= cue[field].length ? event.text : cue[field];
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

function currentKey(state) { return state.currentCue ? 'current' : null; }

function finalizeCue(state, cue, { nowMs, reason, minimumGapMs, minimumCueDurationMs }) {
  if (!cue || !isCueSubmittable(cue)) return state;
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
  const streamText = event.stream === 'source' ? finalCues.map((cue) => cue.sourceText).join(' ') : finalCues.map((cue) => cue.translatedText).join(' ');
  return streamText && text.startsWith(streamText) ? text.slice(streamText.length) : text;
}

function finalizeReason(event, cue, options) {
  if (event.isFinal) return 'final';
  if (event.turnComplete || cue.turnCompleteSeen) return 'turnComplete';
  if (event.generationComplete || cue.generationCompleteSeen) return 'generationComplete';
  if (endsWithSentenceBoundary(event.text)) return 'punctuation';
  if (exceedsLanguageCueLimit(cue, options)) return 'length';
  return 'final';
}

function exceedsLanguageCueLimit(cue, options) {
  const limit = cueLengthLimit(cue, options);
  return normalizeText(cue?.sourceText).length > limit || normalizeText(cue?.translatedText).length > limit;
}

function cueLengthLimit(cue, options) {
  return Number.isInteger(options.maxCueChars) ? options.maxCueChars : DEFAULT_MAX_CUE_CHARS[cue?.targetLanguageCode || options.targetLanguageCode] || DEFAULT_MAX_CUE_CHARS.en;
}

function endsWithSentenceBoundary(text) { return /[。！？.!?]$/u.test(normalizeText(text)); }
function isPunctuationOnly(text) { return /^[\s。！？.!?，,、；;：:]+$/u.test(text); }
function normalizeText(text) { return String(text || '').replace(/\s+/gu, ' ').trim(); }
function stablePendingKey(cue) { return cue.cueId || stableCueKey(cue); }
function stableCueKey(cue) { return [cue.sessionId || cue.liveSessionId || '', cue.segmentId || '', cue.sequence, cue.startTimeMs, cue.sourceText, cue.translatedText].join('|'); }
function cueIdFor({ sessionId, segmentId, sequence }) { return ['cue', sessionId, segmentId, sequence].filter(Boolean).join(':'); }
function copyCue(cue) { return { ...cue }; }
