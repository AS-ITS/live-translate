const STREAMS = ['source', 'translation'];

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

  return event.isFinal
    ? applyFinalEvent(state, { ...event, stream, text })
    : applyPartialEvent(state, { ...event, stream, text });
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
    if (currentPartial.text === event.text && currentPartial.languageCode === event.languageCode) {
      return state;
    }

    return replaceStreamState(state, event.stream, {
      ...streamState,
      currentPartial: {
        ...currentPartial,
        text: event.text,
        ...(event.languageCode ? { languageCode: event.languageCode } : {})
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
    if (!streamState.currentPartial) {
      return state;
    }

    return replaceStreamState(state, event.stream, {
      ...streamState,
      currentPartial: null
    });
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

function createTranscriptItem(state, event, status, now) {
  return {
    id: `${event.stream}-${state.nextSequence}`,
    stream: event.stream,
    status,
    text: event.text,
    sequence: state.nextSequence,
    startedAt: now,
    finalizedAt: status === 'final' ? now : undefined,
    ...(event.languageCode ? { languageCode: event.languageCode } : {})
  };
}

function finalizeTranscriptItem(item, event, now) {
  return {
    ...item,
    status: 'final',
    text: event.text,
    finalizedAt: now,
    ...(event.languageCode ? { languageCode: event.languageCode } : {})
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
