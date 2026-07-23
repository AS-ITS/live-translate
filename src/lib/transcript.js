const STREAMS = ['source', 'translation'];
const CUMULATIVE_EXTENSION_COMMIT_MS = 750;
const ARTICLE_PARAGRAPH_PAUSE_GAP_MS = 8000;
const ARTICLE_MAX_CHARS_PER_PARAGRAPH = 900;

export function createTranscriptState() {
  return {
    source: createStreamState(),
    translation: createStreamState(),
    nextSequence: 1
  };
}

export function resetTranscriptState() {
  return createTranscriptState();
}

export function applyTranscriptEvent(state, event = {}) {
  const stream = event.stream;
  if (!STREAMS.includes(stream)) {
    return state;
  }

  const text = event.text?.trim() || '';
  if (!text) {
    return state;
  }

  const decision = decideTranscriptEvent(state, { ...event, stream, text });
  if (decision.action === 'duplicate') {
    return state;
  }

  const segmentedEvent = {
    ...event,
    stream,
    text: decision.text,
    commitCurrentBeforeEvent: decision.commitCurrentBeforeEvent
  };

  return event.isFinal
    ? applyFinalEvent(state, segmentedEvent)
    : applyPartialEvent(state, segmentedEvent);
}

export function describeTranscriptSegmentDecision(state, event = {}) {
  const stream = event.stream;
  if (!STREAMS.includes(stream)) {
    return { action: 'ignored', reason: 'unknown-stream', stream };
  }

  const text = event.text?.trim() || '';
  if (!text) {
    return { action: 'ignored', reason: 'empty-text', stream };
  }

  const decision = decideTranscriptEvent(state, { ...event, stream, text });
  return {
    action: decision.action,
    reason: decision.reason,
    stream,
    incomingText: text,
    segmentText: decision.text || '',
    isFinal: Boolean(event.isFinal),
    commitCurrentBeforeEvent: Boolean(decision.commitCurrentBeforeEvent)
  };
}

export function transcriptTextForStream(state, stream) {
  return transcriptItemsForStream(state, stream).map((item) => item.text).join(' ');
}

export function transcriptItemsForStream(state, stream) {
  if (!STREAMS.includes(stream)) {
    return [];
  }

  const streamState = state[stream];
  return streamState.currentPartial
    ? [...streamState.finalItems, streamState.currentPartial]
    : [...streamState.finalItems];
}

export function buildTranscriptArticleParagraphs(items = []) {
  const paragraphs = [];
  let currentParagraph = [];
  let previousItem = null;

  const finalItems = items
    .filter((item) => item?.status === 'final')
    .map((item) => ({ ...item, text: item.text?.trim() || '' }))
    .filter((item) => item.text)
    .sort(compareTranscriptItemsBySequence);

  for (const item of finalItems) {
    const hardParts = item.text
      .split(/\n\s*\n/g)
      .map((part) => part.trim())
      .filter(Boolean);

    hardParts.forEach((part, index) => {
      const followsHardBreak = index > 0;
      const shouldBreakBefore =
        currentParagraph.length > 0 &&
        (followsHardBreak ||
          hasArticlePauseGap(previousItem, item) ||
          paragraphLengthWith(currentParagraph, part) > ARTICLE_MAX_CHARS_PER_PARAGRAPH);

      if (shouldBreakBefore) {
        paragraphs.push(currentParagraph.join(' '));
        currentParagraph = [];
      }

      currentParagraph.push(part);
    });

    previousItem = item;
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(' '));
  }

  return paragraphs;
}

export function formatTranscriptArticleText(items = []) {
  return buildTranscriptArticleParagraphs(items).join('\n\n');
}

export function finalizePendingTranscriptItems(state, options = {}) {
  const finalizedAt = Number.isFinite(options.now) ? options.now : Date.now();
  const streams = Array.isArray(options.streams)
    ? STREAMS.filter((stream) => options.streams.includes(stream))
    : STREAMS;
  let hasPendingItems = false;
  const nextState = { ...state };

  for (const stream of streams) {
    const streamState = state[stream];

    if (!streamState.currentPartial) {
      continue;
    }

    hasPendingItems = true;
    nextState[stream] = {
      ...streamState,
      finalItems: [...streamState.finalItems, {
        ...streamState.currentPartial,
        status: 'final',
        finalizedAt
      }],
      currentPartial: null
    };
  }

  return hasPendingItems ? nextState : state;
}

function createStreamState() {
  return {
    finalItems: [],
    currentPartial: null
  };
}

function applyPartialEvent(state, event) {
  const streamState = state[event.stream];
  const currentPartial = streamState.currentPartial;

  if (currentPartial) {
    if (event.commitCurrentBeforeEvent) {
      return appendAfterCommittingCurrentPartial(state, event, 'partial');
    }

    if (currentPartial.text === event.text && currentPartial.languageCode === event.languageCode) {
      return state;
    }

    return replaceStreamState(state, event.stream, {
      ...streamState,
      currentPartial: {
        ...currentPartial,
        text: event.text,
        ...(event.languageCode ? { languageCode: event.languageCode } : {}),
        ...(event.sourceLanguageDetection ? { sourceLanguageDetection: event.sourceLanguageDetection } : {})
      }
    });
  }

  const item = createTranscriptItem(state, event, 'partial', eventTime(event));
  return {
    ...state,
    [event.stream]: {
      ...streamState,
      currentPartial: item
    },
    nextSequence: state.nextSequence + 1
  };
}

function applyFinalEvent(state, event) {
  const streamState = state[event.stream];
  const lastFinal = streamState.finalItems.at(-1);
  const isDuplicateFinal = lastFinal?.text === event.text && lastFinal?.languageCode === event.languageCode;

  if (isDuplicateFinal) {
    if (!streamState.currentPartial || streamState.currentPartial.text !== event.text) {
      return state;
    }

    return replaceStreamState(state, event.stream, {
      ...streamState,
      currentPartial: null
    });
  }

  if (event.commitCurrentBeforeEvent) {
    return appendAfterCommittingCurrentPartial(state, event, 'final');
  }

  const now = eventTime(event);
  const finalItem = streamState.currentPartial
    ? finalizeTranscriptItem(streamState.currentPartial, event, now)
    : createTranscriptItem(state, event, 'final', now);

  return {
    ...state,
    [event.stream]: {
      finalItems: [...streamState.finalItems, finalItem],
      currentPartial: null
    },
    nextSequence: streamState.currentPartial ? state.nextSequence : state.nextSequence + 1
  };
}

function appendAfterCommittingCurrentPartial(state, event, status) {
  const streamState = state[event.stream];
  const now = eventTime(event);
  const finalizedCurrent = {
    ...streamState.currentPartial,
    status: 'final',
    finalizedAt: now
  };
  const item = createTranscriptItem(state, event, status, now);

  return {
    ...state,
    [event.stream]: {
      finalItems: status === 'final'
        ? [...streamState.finalItems, finalizedCurrent, item]
        : [...streamState.finalItems, finalizedCurrent],
      currentPartial: status === 'partial' ? item : null
    },
    nextSequence: state.nextSequence + 1
  };
}

function decideTranscriptEvent(state, event) {
  const streamState = state[event.stream];
  const currentPartial = streamState.currentPartial;
  const lastFinal = streamState.finalItems.at(-1);

  if (currentPartial?.text === event.text && currentPartial.languageCode === event.languageCode) {
    if (event.isFinal) {
      return {
        action: 'append',
        reason: 'finalizes-current-partial',
        text: event.text,
        commitCurrentBeforeEvent: false
      };
    }

    return { action: 'duplicate', reason: 'matches-current-partial', text: event.text };
  }

  if (lastFinal?.text === event.text && lastFinal.languageCode === event.languageCode) {
    return { action: 'duplicate', reason: 'matches-last-final', text: event.text };
  }

  const cumulativeDelta = deltaFromFinalTranscript(streamState, event.text);
  if (cumulativeDelta) {
    if (!cumulativeDelta.text) {
      return { action: 'duplicate', reason: 'matches-completed-transcript', text: event.text };
    }

    if (currentPartial?.text === cumulativeDelta.text && currentPartial.languageCode === event.languageCode) {
      if (event.isFinal) {
        return {
          action: 'append',
          reason: 'cumulative-text-finalizes-current-partial',
          text: cumulativeDelta.text,
          commitCurrentBeforeEvent: false
        };
      }

      return { action: 'duplicate', reason: 'cumulative-text-matches-current-partial', text: cumulativeDelta.text };
    }

    if (currentPartial && cumulativeDelta.text.startsWith(currentPartial.text)) {
      const currentDelta = cumulativeDelta.text.slice(currentPartial.text.length).trim();
      if (currentDelta && shouldCommitCumulativeExtension(currentPartial, event, currentDelta)) {
        return {
          action: 'delta',
          reason: 'cumulative-delta-extends-current-pending',
          text: currentDelta,
          commitCurrentBeforeEvent: true
        };
      }
    }

    return {
      action: 'delta',
      reason: 'incoming-text-extends-completed-transcript',
      text: cumulativeDelta.text,
      commitCurrentBeforeEvent: false
    };
  }

  if (currentPartial) {
    const currentExtensionDelta = currentPartialExtensionDelta(currentPartial.text, event.text);
    if (currentExtensionDelta && shouldCommitCumulativeExtension(currentPartial, event, currentExtensionDelta)) {
      return {
        action: 'delta',
        reason: 'incoming-text-extends-current-pending-as-cumulative-transcript',
        text: currentExtensionDelta,
        commitCurrentBeforeEvent: true
      };
    }

    if (isTextRevisionForCurrentPartial(currentPartial.text, event.text)) {
      return {
        action: event.isFinal ? 'append' : 'partial',
        reason: 'updates-current-partial',
        text: event.text,
        commitCurrentBeforeEvent: false
      };
    }

    return {
      action: 'append',
      reason: 'new-text-starts-next-segment',
      text: event.text,
      commitCurrentBeforeEvent: true
    };
  }

  return {
    action: event.isFinal ? 'append' : 'partial',
    reason: event.isFinal ? 'new-final-segment' : 'new-partial-segment',
    text: event.text,
    commitCurrentBeforeEvent: false
  };
}

function deltaFromFinalTranscript(streamState, incomingText) {
  const candidates = finalTranscriptTextCandidates(streamState);
  for (const candidate of candidates) {
    if (!incomingText.startsWith(candidate)) {
      continue;
    }

    return { text: incomingText.slice(candidate.length).trim() };
  }

  return null;
}

function finalTranscriptTextCandidates(streamState) {
  if (streamState.finalItems.length === 0) {
    return [];
  }

  const texts = streamState.finalItems.map((item) => item.text);
  return [...new Set([texts.join(' '), texts.join('')])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function isTextRevisionForCurrentPartial(currentText, incomingText) {
  return incomingText.startsWith(currentText) || currentText.startsWith(incomingText);
}

function currentPartialExtensionDelta(currentText, incomingText) {
  if (!incomingText.startsWith(currentText) || incomingText === currentText) {
    return '';
  }

  return incomingText.slice(currentText.length).trim();
}

function shouldCommitCumulativeExtension(currentPartial, event, deltaText) {
  if (!deltaText) {
    return false;
  }

  if (endsWithSegmentBoundary(currentPartial.text)) {
    return true;
  }

  const now = eventTime(event);
  return now - currentPartial.startedAt >= CUMULATIVE_EXTENSION_COMMIT_MS && deltaText.length >= 2;
}

function endsWithSegmentBoundary(text) {
  return /[.!?。！？；;，,、]$/.test(text);
}

function compareTranscriptItemsBySequence(first, second) {
  return sequenceValue(first) - sequenceValue(second);
}

function sequenceValue(item) {
  return Number.isFinite(item?.sequence) ? item.sequence : 0;
}

function hasArticlePauseGap(previousItem, nextItem) {
  if (!previousItem) {
    return false;
  }

  const previousTime = itemEndTime(previousItem);
  const nextTime = itemStartTime(nextItem);
  return Number.isFinite(previousTime) &&
    Number.isFinite(nextTime) &&
    nextTime - previousTime >= ARTICLE_PARAGRAPH_PAUSE_GAP_MS;
}

function itemEndTime(item) {
  return Number.isFinite(item?.finalizedAt) ? item.finalizedAt : item?.startedAt;
}

function itemStartTime(item) {
  return Number.isFinite(item?.startedAt) ? item.startedAt : item?.finalizedAt;
}

function paragraphLengthWith(parts, nextPart) {
  return parts.length === 0 ? nextPart.length : `${parts.join(' ')} ${nextPart}`.length;
}

function createTranscriptItem(state, event, status, now) {
  return {
    id: `${event.stream}-${state.nextSequence}`,
    stream: event.stream,
    status,
    text: event.text,
    sequence: state.nextSequence,
    startedAt: now,
    finalizedAt: status === 'final' ? now : undefined,
    ...(event.languageCode ? { languageCode: event.languageCode } : {}),
    ...(event.sourceLanguageDetection ? { sourceLanguageDetection: event.sourceLanguageDetection } : {})
  };
}

function finalizeTranscriptItem(item, event, now) {
  return {
    ...item,
    status: 'final',
    text: event.text,
    finalizedAt: now,
    ...(event.languageCode ? { languageCode: event.languageCode } : {}),
    ...(event.sourceLanguageDetection ? { sourceLanguageDetection: event.sourceLanguageDetection } : {})
  };
}

function replaceStreamState(state, stream, streamState) {
  return {
    ...state,
    [stream]: streamState
  };
}

function eventTime(event) {
  return Number.isFinite(event.now) ? event.now : Date.now();
}
