const TRANSCRIPT_FIELDS = [
  ['inputTranscription', 'source', 'input'],
  ['interimInputTranscription', 'source', 'input-interim'],
  ['outputTranscription', 'translation', 'output']
];

export function normalizeGeminiLiveCueEvents(message = {}, context = {}) {
  const content = message?.serverContent || {};
  const eventSequence = context.eventSequence ?? null;
  const providerEventId = providerIdentity(message, content);
  const turnIndex = firstDefined(
    content.turnIndex,
    content.turn?.index,
    content.turn?.turnIndex,
    message.turnIndex
  );
  const sessionTimeMs = resolveSessionTime(context);
  const events = [];

  for (const [field, stream, eventType] of TRANSCRIPT_FIELDS) {
    const payload = content[field];
    if (!payload?.text) continue;
    events.push(createEvent({
      payload,
      stream,
      eventType,
      text: payload.text,
      providerEventId,
      eventSequence,
      turnIndex,
      sessionTimeMs,
      context,
      isFinal: transcriptIsFinal({ content, context, stream, eventType })
    }));
  }

  if (content.turnComplete || content.generationComplete) {
    events.push(createEvent({
      stream: null,
      eventType: 'boundary',
      text: '',
      providerEventId,
      eventSequence,
      turnIndex,
      sessionTimeMs,
      context,
      isFinal: false,
      turnComplete: Boolean(content.turnComplete),
      generationComplete: Boolean(content.generationComplete)
    }));
  }

  return events;
}

function transcriptIsFinal({ content, context, stream, eventType }) {
  if (content.turnComplete || content.generationComplete) return true;
  if (stream === 'source' && eventType === 'input') return Boolean(context.inputTranscriptIsFinal);
  if (stream === 'translation' && eventType === 'output') return Boolean(context.outputTranscriptIsFinal);
  return false;
}

function createEvent({ payload = {}, stream, eventType, text, providerEventId, eventSequence, turnIndex, sessionTimeMs, context, isFinal, turnComplete = false, generationComplete = false }) {
  const identityBase = providerEventId || [
    context.liveSessionId || context.sessionId || 'session-unknown',
    turnIndex ?? 'turn-unknown',
    eventSequence ?? 'sequence-unknown'
  ].join('|');
  return {
    eventId: `${identityBase}:${stream || 'control'}:${eventType}:${normalizeText(text)}`,
    liveSessionId: context.liveSessionId || null,
    sessionId: context.sessionId || null,
    segmentId: context.segmentId || null,
    connectionEpoch: context.connectionEpoch ?? null,
    stream,
    eventType,
    text: normalizeText(text),
    isFinal,
    turnComplete,
    generationComplete,
    sourceLanguageCode: payload.sourceLanguageCode || context.sourceLanguageCode || null,
    targetLanguageCode: payload.targetLanguageCode || context.targetLanguageCode || null,
    turnIndex: turnIndex ?? null,
    eventSequence: eventSequence ?? null,
    sessionTimeMs,
    ...((stream === 'source' && context.inputTranscriptArrivedAfterBoundary)
      || (stream === 'translation' && context.outputTranscriptArrivedAfterBoundary)
      ? { isLateTranscript: true }
      : {}),
    ...(context.retranslationCueId ? { retranslationCueId: context.retranslationCueId } : {})
  };
}

function providerIdentity(message, content) {
  return firstDefined(
    message.eventId,
    message.event_id,
    message.id,
    content.eventId,
    content.event_id
  );
}

function resolveSessionTime(context) {
  if (Number.isFinite(context.sessionTimeMs) && context.sessionTimeMs >= 0) return context.sessionTimeMs;
  if (typeof context.sessionClock === 'function') {
    const value = context.sessionClock();
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}
