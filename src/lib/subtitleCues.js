const STREAMS = new Set(['source', 'translation']);
const DEFAULT_PAUSE_THRESHOLD_MS = 900;
const DEFAULT_MAX_CUE_CHARS = Object.freeze({
  'zh-Hant': 32,
  'zh-Hans': 32,
  ja: 36,
  ko: 44,
  en: 80,
  es: 84,
  fr: 84,
  de: 76
});

export function createSubtitleCueState(input = {}) {
  const finalCues = Array.isArray(input.finalCues) ? input.finalCues.map(copyCue) : [];
  return {
    finalCues,
    currentCue: input.currentCue ? copyCue(input.currentCue) : null,
    nextSequence: Number.isInteger(input.nextSequence) && input.nextSequence > 0 ? input.nextSequence : 1,
    finalizedCueKeys: Array.isArray(input.finalizedCueKeys)
      ? [...input.finalizedCueKeys]
      : finalCues.map(stableCueKey)
  };
}

export function resetSubtitleCueState() {
  return createSubtitleCueState();
}

export function applySubtitleCueEvent(stateInput, eventInput = {}, options = {}) {
  const state = createSubtitleCueState(stateInput);
  const event = normalizeEvent(eventInput, options);
  if (!event) {
    if (eventInput.turnComplete || eventInput.generationComplete) {
      return finalizePendingSubtitleCue(state, {
        ...options,
        now: eventInput.now,
        nowMs: eventInput.nowMs,
        sessionTimeMs: eventInput.sessionTimeMs,
        reason: eventInput.turnComplete ? 'turnComplete' : 'generationComplete'
      });
    }
    return stateInput;
  }

  const afterPauseFlush = shouldFlushBeforeEvent(state.currentCue, event, options)
    ? finalizeCurrentCue(state, {
      nowMs: event.sessionTimeMs,
      reason: 'pause'
    })
    : state;

  const afterEvent = applyEventToCurrentCue(afterPauseFlush, event);
  if (isCueSubmittable(afterEvent.currentCue) && exceedsLanguageCueLimit(afterEvent.currentCue, options)) {
    return splitCurrentCueByLength(afterEvent, {
      nowMs: event.sessionTimeMs,
      options
    });
  }

  const shouldFinalize =
    isCueSubmittable(afterEvent.currentCue) &&
    (event.isFinal ||
      event.turnComplete ||
      event.generationComplete ||
      endsWithSentenceBoundary(event.text));

  return shouldFinalize
    ? finalizeCurrentCue(afterEvent, { nowMs: event.sessionTimeMs, reason: finalizeReason(event, afterEvent.currentCue, options) })
    : afterEvent;
}

export function finalizePendingSubtitleCue(stateInput, options = {}) {
  const state = createSubtitleCueState(stateInput);
  if (!isCueSubmittable(state.currentCue)) return stateInput;

  return finalizeCurrentCue(state, {
    nowMs: resolveSessionTimeMs(options),
    reason: options.reason || 'flush'
  });
}

export function subtitleCuesForDisplay(stateInput) {
  const state = createSubtitleCueState(stateInput);
  return state.currentCue ? [...state.finalCues, state.currentCue] : [...state.finalCues];
}

function applyEventToCurrentCue(state, event) {
  if (!state.currentCue && duplicatesLastFinalCueStream(state.finalCues.at(-1), event)) {
    return state;
  }

  const currentCue = state.currentCue || createPartialCue(state, event);
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  const languagePatch = languagePatchFor(event);

  if (currentCue[field] === event.text && sameLanguageFields(currentCue, languagePatch)) {
    return state.currentCue ? state : { ...state, currentCue };
  }

  return {
    ...state,
    currentCue: {
      ...currentCue,
      ...languagePatch,
      [field]: event.text,
      status: 'partial',
      endTimeMs: Math.max(currentCue.endTimeMs, event.sessionTimeMs),
      updatedTimeMs: event.sessionTimeMs
    }
  };
}

function createPartialCue(state, event) {
  const sequence = state.nextSequence;
  const sourceText = event.stream === 'source' ? event.text : '';
  const translatedText = event.stream === 'translation' ? event.text : '';

  return {
    cueId: cueIdFor({ sessionId: event.sessionId, segmentId: event.segmentId, sequence }),
    sessionId: event.sessionId,
    segmentId: event.segmentId,
    sequence,
    startTimeMs: event.sessionTimeMs,
    endTimeMs: event.sessionTimeMs,
    sourceLanguageCode: event.sourceLanguageCode || null,
    targetLanguageCode: event.targetLanguageCode || null,
    sourceText,
    translatedText,
    status: 'partial',
    updatedTimeMs: event.sessionTimeMs
  };
}

function finalizeCurrentCue(state, { nowMs, reason }) {
  const currentCue = state.currentCue;
  if (!isCueSubmittable(currentCue)) return state;

  const endTimeMs = Math.max(currentCue.endTimeMs, Number.isFinite(nowMs) ? nowMs : currentCue.endTimeMs);
  const finalCue = {
    ...currentCue,
    sourceText: normalizeText(currentCue.sourceText),
    translatedText: normalizeText(currentCue.translatedText),
    status: 'final',
    endTimeMs: endTimeMs > currentCue.startTimeMs ? endTimeMs : currentCue.startTimeMs + 1,
    finalizedReason: reason || 'final'
  };
  const cueKey = stableCueKey(finalCue);

  if (state.finalizedCueKeys.includes(cueKey)) {
    return {
      ...state,
      currentCue: null
    };
  }

  return {
    ...state,
    finalCues: [...state.finalCues, finalCue],
    currentCue: null,
    nextSequence: Math.max(state.nextSequence, finalCue.sequence + 1),
    finalizedCueKeys: [...state.finalizedCueKeys, cueKey]
  };
}

function splitCurrentCueByLength(state, { nowMs, options }) {
  const currentCue = state.currentCue;
  const limit = cueLengthLimit(currentCue, options);
  const sourceParts = splitTextAtNaturalBoundary(currentCue.sourceText, limit);
  const translationParts = splitTextAtNaturalBoundary(currentCue.translatedText, limit);

  if (!sourceParts.remainder || !translationParts.remainder) {
    return finalizeCurrentCue(state, { nowMs, reason: 'length' });
  }

  const splitTimeMs = Math.max(currentCue.startTimeMs + 1, Number.isFinite(nowMs) ? nowMs : currentCue.endTimeMs);
  const finalCue = {
    ...currentCue,
    sourceText: sourceParts.head,
    translatedText: translationParts.head,
    status: 'final',
    endTimeMs: splitTimeMs,
    updatedTimeMs: splitTimeMs,
    finalizedReason: 'length'
  };
  const cueKey = stableCueKey(finalCue);
  const nextSequence = finalCue.sequence + 1;
  const nextCue = {
    ...currentCue,
    cueId: cueIdFor({ sessionId: currentCue.sessionId, segmentId: currentCue.segmentId, sequence: nextSequence }),
    sequence: nextSequence,
    sourceText: sourceParts.remainder,
    translatedText: translationParts.remainder,
    status: 'partial',
    startTimeMs: splitTimeMs,
    endTimeMs: splitTimeMs,
    updatedTimeMs: splitTimeMs
  };

  return {
    ...state,
    finalCues: state.finalizedCueKeys.includes(cueKey) ? state.finalCues : [...state.finalCues, finalCue],
    currentCue: nextCue,
    nextSequence,
    finalizedCueKeys: state.finalizedCueKeys.includes(cueKey)
      ? state.finalizedCueKeys
      : [...state.finalizedCueKeys, cueKey]
  };
}

function shouldFlushBeforeEvent(currentCue, event, options) {
  if (!isCueSubmittable(currentCue)) return false;
  if (event.stream === 'source' && currentCue.sourceText && event.text.startsWith(currentCue.sourceText)) return false;
  if (event.stream === 'translation' && currentCue.translatedText && event.text.startsWith(currentCue.translatedText)) return false;

  const threshold = Number.isFinite(options.pauseThresholdMs)
    ? Math.max(0, options.pauseThresholdMs)
    : DEFAULT_PAUSE_THRESHOLD_MS;
  return event.sessionTimeMs - currentCue.updatedTimeMs >= threshold;
}

function isCueSubmittable(cue) {
  return Boolean(cue && normalizeText(cue.sourceText) && normalizeText(cue.translatedText));
}

function normalizeEvent(event, options) {
  const stream = event.stream;
  if (!STREAMS.has(stream)) return null;

  const text = normalizeText(deltaAfterFinalCues(event, options));
  if (!text || isPunctuationOnly(text)) return null;

  return {
    stream,
    text,
    isFinal: Boolean(event.isFinal),
    turnComplete: Boolean(event.turnComplete),
    generationComplete: Boolean(event.generationComplete),
    sessionId: event.sessionId || options.sessionId || null,
    segmentId: event.segmentId || options.segmentId || null,
    sourceLanguageCode: event.sourceLanguageCode || options.sourceLanguageCode || null,
    targetLanguageCode: event.targetLanguageCode || options.targetLanguageCode || null,
    sessionTimeMs: resolveSessionTimeMs({ ...options, ...event })
  };
}

function deltaAfterFinalCues(event, options) {
  const text = String(event.text || '');
  const finalCues = Array.isArray(options.finalCues) ? options.finalCues : [];
  const streamText = event.stream === 'source'
    ? finalCues.map((cue) => cue.sourceText).join(' ')
    : finalCues.map((cue) => cue.translatedText).join(' ');

  if (streamText && text.startsWith(streamText)) {
    return text.slice(streamText.length);
  }

  return text;
}

function resolveSessionTimeMs(input = {}) {
  if (Number.isFinite(input.sessionTimeMs)) return input.sessionTimeMs;
  if (Number.isFinite(input.now) && Number.isFinite(input.sessionStartedAt)) {
    return Math.max(0, input.now - input.sessionStartedAt);
  }
  if (Number.isFinite(input.nowMs)) return input.nowMs;
  if (Number.isFinite(input.now)) return input.now;
  return Date.now();
}

function finalizeReason(event, cue, options) {
  if (event.isFinal) return 'final';
  if (event.turnComplete) return 'turnComplete';
  if (event.generationComplete) return 'generationComplete';
  if (endsWithSentenceBoundary(event.text)) return 'punctuation';
  if (exceedsLanguageCueLimit(cue, options)) return 'length';
  return 'final';
}

function exceedsLanguageCueLimit(cue, options) {
  const limit = cueLengthLimit(cue, options);
  return normalizeText(cue?.sourceText).length > limit || normalizeText(cue?.translatedText).length > limit;
}

function cueLengthLimit(cue, options) {
  const targetLanguageCode = cue?.targetLanguageCode || options.targetLanguageCode;
  return Number.isInteger(options.maxCueChars)
    ? options.maxCueChars
    : DEFAULT_MAX_CUE_CHARS[targetLanguageCode] || DEFAULT_MAX_CUE_CHARS.en;
}

function endsWithSentenceBoundary(text) {
  return /[。！？.!?]$/u.test(normalizeText(text));
}

function isPunctuationOnly(text) {
  return /^[\s。！？.!?，,、；;：:]+$/u.test(text);
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}

function splitTextAtNaturalBoundary(text, limit) {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return { head: normalized, remainder: '' };
  }

  const boundaryIndex = nearestBoundaryIndex(normalized, limit);
  const splitIndex = boundaryIndex > 0 ? boundaryIndex : limit;
  return {
    head: normalized.slice(0, splitIndex).trim(),
    remainder: normalized.slice(splitIndex).trim()
  };
}

function nearestBoundaryIndex(text, limit) {
  const searchStart = Math.max(0, limit - 20);
  const window = text.slice(searchStart, limit + 1);
  const matches = [...window.matchAll(/[。！？.!?，,、；;：:\s]/gu)];
  const last = matches.at(-1);
  return last ? searchStart + last.index + last[0].length : -1;
}

function languagePatchFor(event) {
  return {
    ...(event.sourceLanguageCode ? { sourceLanguageCode: event.sourceLanguageCode } : {}),
    ...(event.targetLanguageCode ? { targetLanguageCode: event.targetLanguageCode } : {})
  };
}

function sameLanguageFields(cue, patch) {
  return (patch.sourceLanguageCode === undefined || cue.sourceLanguageCode === patch.sourceLanguageCode) &&
    (patch.targetLanguageCode === undefined || cue.targetLanguageCode === patch.targetLanguageCode);
}

function duplicatesLastFinalCueStream(lastFinalCue, event) {
  if (!lastFinalCue) return false;
  const field = event.stream === 'source' ? 'sourceText' : 'translatedText';
  return lastFinalCue[field] === event.text;
}

function stableCueKey(cue) {
  return [
    cue.sessionId || '',
    cue.segmentId || '',
    cue.sequence,
    cue.startTimeMs,
    cue.sourceText,
    cue.translatedText
  ].join('|');
}

function cueIdFor({ sessionId, segmentId, sequence }) {
  return ['cue', sessionId, segmentId, sequence].filter(Boolean).join(':');
}

function copyCue(cue) {
  return { ...cue };
}
