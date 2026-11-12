export const SUBTITLE_DATA_CHANNEL_PROTOCOL = 'subtitle-webrtc/v1';
export const SUBTITLE_ENVELOPE_TYPES = Object.freeze({
  snapshot: 'snapshot',
  cueAppend: 'cue.append',
  cueUpdate: 'cue.update',
  segmentTransition: 'segment.transition',
  replayRequest: 'replay.request',
  replayResponse: 'replay.response',
  livenessPing: 'liveness.ping',
  livenessPong: 'liveness.pong',
  meetingStopped: 'meeting.stopped',
  recordingStopped: 'recording.stopped'
});

const CUE_TYPES = new Set([SUBTITLE_ENVELOPE_TYPES.cueAppend, SUBTITLE_ENVELOPE_TYPES.cueUpdate]);
const ENVELOPE_TYPES = new Set(Object.values(SUBTITLE_ENVELOPE_TYPES));
const SIDE_STATUSES = new Set(['empty', 'pending', 'partial', 'final', 'finalized', 'unavailable', 'failed']);

export function createEnvelope(type, fields = {}) {
  return buildSubtitleEnvelope(type, fields);
}

export function buildSubtitleEnvelope(type, fields = {}) {
  const envelope = { ...fields, protocol: SUBTITLE_DATA_CHANNEL_PROTOCOL, type };
  if (CUE_TYPES.has(type)) envelope.cue = normalizeSubtitleCue(fields.cue);
  if (type === SUBTITLE_ENVELOPE_TYPES.snapshot) {
    envelope.cues = (fields.cues || []).map(normalizeSubtitleCue);
  }
  if (type === SUBTITLE_ENVELOPE_TYPES.replayResponse) {
    envelope.events = (fields.events || []).map((event) => buildSubtitleEnvelope(event?.type, event));
  }
  return assertEnvelope(envelope);
}

export function assertEnvelope(envelope) {
  if (!envelope || envelope.protocol !== SUBTITLE_DATA_CHANNEL_PROTOCOL || typeof envelope.type !== 'string') {
    throw validationError('invalid_envelope', 'Invalid subtitle DataChannel envelope.');
  }
  if (!ENVELOPE_TYPES.has(envelope.type)) throw validationError('invalid_message_type', 'Unsupported subtitle DataChannel message type.');
  if (!nonEmpty(envelope.meetingId)) throw validationError('invalid_meeting_scope', 'Subtitle envelope requires meetingId.');
  if (CUE_TYPES.has(envelope.type) && (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1)) {
    throw validationError('invalid_sequence', 'Cue envelope requires a positive sequence.');
  }
  if (CUE_TYPES.has(envelope.type)) validateSubtitleCue(envelope.cue);
  if (envelope.type === SUBTITLE_ENVELOPE_TYPES.segmentTransition) {
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
      throw validationError('invalid_sequence', 'Segment transition requires a positive sequence.');
    }
    validateSegmentTransition(envelope.segment);
  }
  if (envelope.type === SUBTITLE_ENVELOPE_TYPES.snapshot) {
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0) {
      throw validationError('invalid_sequence', 'Snapshot envelope requires a non-negative sequence.');
    }
    if (!Array.isArray(envelope.cues)) throw validationError('invalid_snapshot_cues', 'Snapshot envelope requires cues.');
    envelope.cues.forEach(validateSubtitleCue);
    if (envelope.segment != null) validateSegmentTransition(envelope.segment);
  }
  if (envelope.type === SUBTITLE_ENVELOPE_TYPES.replayResponse) {
    if (!Array.isArray(envelope.events)) throw validationError('invalid_replay_events', 'Replay response requires events.');
    envelope.events.forEach(assertEnvelope);
  }
  if (envelope.type === SUBTITLE_ENVELOPE_TYPES.replayRequest && !nonEmpty(envelope.requestId)) {
    throw validationError('invalid_request_id', 'Replay request requires requestId.');
  }
  if ((envelope.type === SUBTITLE_ENVELOPE_TYPES.livenessPing
    || envelope.type === SUBTITLE_ENVELOPE_TYPES.livenessPong) && !nonEmpty(envelope.requestId)) {
    throw validationError('invalid_request_id', 'Liveness envelope requires requestId.');
  }
  return envelope;
}

export function createSubtitleSource({ meetingId, sourceId = createSourceId(), maxHistory = 100 } = {}) {
  if (!nonEmpty(meetingId)) throw new TypeError('Subtitle source requires meetingId.');
  if (!nonEmpty(sourceId)) throw new TypeError('Subtitle source requires sourceId.');
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer.');
  let sequence = 0;
  const history = [];
  const cues = new Map();
  let segment = null;

  function publish(type, cue) {
    if (!cue || !nonEmpty(cue.cueId)) throw new TypeError('Cue requires cueId.');
    if (cue.meetingId !== undefined && cue.meetingId !== meetingId) throw new TypeError('Cue meetingId mismatch.');
    const current = cues.get(cue.cueId);
    const revision = publicationRevision(cue);
    if (current && revision <= publicationRevision(current)) return null;
    const event = buildSubtitleEnvelope(type, { meetingId, sourceId, sequence: ++sequence, cue });
    cues.set(cue.cueId, event.cue);
    history.push(event);
    while (history.length > maxHistory) history.shift();
    return event;
  }

  return {
    append(cue) { return publish(SUBTITLE_ENVELOPE_TYPES.cueAppend, cue); },
    update(cue) { return publish(SUBTITLE_ENVELOPE_TYPES.cueUpdate, cue); },
    transition(nextSegment) {
      validateSegmentTransition(nextSegment);
      if (segment && segment.segmentId === nextSegment.segmentId
        && segment.segmentSequence === nextSegment.segmentSequence
        && segment.status === nextSegment.status) return null;
      const event = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.segmentTransition, {
        meetingId, sourceId, sequence: ++sequence, segment: { ...nextSegment }
      });
      segment = event.segment;
      history.push(event);
      while (history.length > maxHistory) history.shift();
      return event;
    },
    snapshot() {
      return createEnvelope(SUBTITLE_ENVELOPE_TYPES.snapshot, {
        meetingId,
        sourceId,
        sequence,
        segment: segment ? { ...segment } : null,
        cues: [...cues.values()].map((cue) => structuredClone(cue))
      });
    },
    replay(request = {}) {
      const requestEnvelope = typeof request === 'string'
        ? createReplayRequest({ meetingId, requestId: request, afterSequence: 0 })
        : createReplayRequest({ meetingId, ...request });
      const afterSequence = Number(requestEnvelope.afterSequence) || 0;
      if (requestEnvelope.sourceId && requestEnvelope.sourceId !== sourceId) return this.snapshot();
      if (history.length > 0 && afterSequence < history[0].sequence - 1) return this.snapshot();
      return createEnvelope(SUBTITLE_ENVELOPE_TYPES.replayResponse, {
        meetingId,
        sourceId,
        requestId: requestEnvelope.requestId,
        fromSequence: afterSequence,
        toSequence: sequence,
        events: history.filter((event) => event.sequence > afterSequence).map((event) => structuredClone(event))
      });
    },
    get sequence() { return sequence; },
    get history() { return history.map((event) => structuredClone(event)); }
  };
}

export function createReplayRequest({ meetingId, requestId, sourceId, afterSequence = 0 } = {}) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError('afterSequence must be a non-negative integer.');
  return createEnvelope(SUBTITLE_ENVELOPE_TYPES.replayRequest, {
    meetingId, requestId, ...(nonEmpty(sourceId) ? { sourceId } : {}), afterSequence
  });
}

export function createSubtitleState(meetingId) {
  if (!nonEmpty(meetingId)) throw new TypeError('Subtitle state requires meetingId.');
  return { meetingId, sequence: 0, cues: [] };
}

export function mergeSubtitleEnvelope(state, envelope) {
  if (!state || !nonEmpty(state.meetingId)) throw new TypeError('Subtitle state requires meetingId.');
  const packet = assertEnvelope(envelope);
  if (packet.meetingId !== state.meetingId) throw new TypeError('Subtitle envelope meetingId mismatch.');
  if (packet.type === SUBTITLE_ENVELOPE_TYPES.snapshot) {
    if (!Number.isSafeInteger(packet.sequence) || packet.sequence < state.sequence) throw new RangeError('Out-of-order subtitle snapshot.');
    const next = createSubtitleState(state.meetingId);
    next.sequence = packet.sequence;
    next.cues = mergeCues([], packet.cues || []);
    return next;
  }
  if (!CUE_TYPES.has(packet.type)) return state;
  if (packet.sequence <= state.sequence) {
    if (packet.sequence === state.sequence && state.cues.some((cue) => cue.cueId === packet.cue?.cueId)) return state;
    throw new RangeError('Out-of-order subtitle cue.');
  }
  const cues = mergeCues(state.cues, [packet.cue]);
  return { ...state, sequence: packet.sequence, cues };
}

function mergeCues(existing, incoming) {
  const byId = new Map(existing.filter((cue) => nonEmpty(cue?.cueId)).map((cue) => [cue.cueId, cue]));
  for (const cue of incoming) {
    if (!nonEmpty(cue?.cueId)) continue;
    const previous = byId.get(cue.cueId);
    if (!previous || cueRevision(cue) > cueRevision(previous)) byId.set(cue.cueId, structuredClone(cue));
  }
  return [...byId.values()];
}

function cueRevision(cue) {
  return Math.max(
    Number.isSafeInteger(cue?.revision) && cue.revision >= 0 ? cue.revision : 0,
    Number.isSafeInteger(cue?.sourceVersion) && cue.sourceVersion >= 0 ? cue.sourceVersion : 0,
    Number.isSafeInteger(cue?.translationVersion) && cue.translationVersion >= 0 ? cue.translationVersion : 0,
    Number.isSafeInteger(cue?.refinement?.version) && cue.refinement.version >= 0 ? cue.refinement.version : 0,
  );
}

function publicationRevision(cue) {
  return Number.isSafeInteger(cue?.revision) && cue.revision >= 0 ? cue.revision : cueRevision(cue);
}

function normalizeSubtitleCue(cue) {
  if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
    throw validationError('invalid_cue', 'Subtitle envelope requires a cue object.');
  }
  const normalized = structuredClone(cue);
  const rawSource = text(cue.rawSource) || text(cue.sourceText);
  const rawTranslation = text(cue.rawTranslation) || text(cue.translatedText);
  if (rawSource) {
    normalized.rawSource = rawSource;
    normalized.sourceText = rawSource;
  }
  if (rawTranslation) {
    normalized.rawTranslation = rawTranslation;
    normalized.translatedText = rawTranslation;
  }
  validateSubtitleCue(normalized);
  return normalized;
}

function validateSegmentTransition(segment) {
  if (!segment || !nonEmpty(segment.segmentId)
    || !Number.isSafeInteger(segment.segmentSequence) || segment.segmentSequence < 1
    || !['switching', 'ready'].includes(segment.status)) {
    throw validationError('invalid_segment_transition', 'Segment transition requires identity, sequence, and status.');
  }
}

function validateSubtitleCue(cue) {
  if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
    throw validationError('invalid_cue', 'Subtitle envelope requires a cue object.');
  }
  if (!nonEmpty(cue.cueId)) throw validationError('invalid_cue_id', 'Subtitle cue requires cueId.');
  if (!text(cue.rawSource) && !text(cue.sourceText) && !text(cue.rawTranslation) && !text(cue.translatedText)) {
    throw validationError('empty_cue_content', 'Subtitle cue requires source or translation content.');
  }
  for (const field of ['revision', 'sourceVersion', 'translationVersion']) {
    if (cue[field] !== undefined && (!Number.isSafeInteger(cue[field]) || cue[field] < 0)) {
      throw validationError(`invalid_${field}`, `Subtitle cue ${field} must be a non-negative integer.`);
    }
  }
  for (const field of ['sourceStatus', 'translationStatus']) {
    if (cue[field] !== undefined && cue[field] !== null && !SIDE_STATUSES.has(cue[field])) {
      throw validationError(`invalid_${field}`, `Subtitle cue ${field} is invalid.`);
    }
  }
  return cue;
}

function validationError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

function createSourceId() {
  return globalThis.crypto?.randomUUID?.() || `subtitle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createSubtitleDataChannelAdapter(channel, { onEnvelope, onError } = {}) {
  if (!channel || typeof channel.send !== 'function') throw new TypeError('RTCDataChannel-like object is required.');
  const listen = (event, handler) => channel.addEventListener?.(event, handler) || channel.on?.(event, handler);
  const open = () => {
    if (channel.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const handleOpen = () => resolve();
      const handleClose = () => reject(new Error('DataChannel closed before opening.'));
      const handleError = (error) => reject(error instanceof Error ? error : new Error('DataChannel error.'));
      listen('open', handleOpen);
      listen('close', handleClose);
      listen('error', handleError);
    });
  };
  const handleMessage = (event) => {
    try {
      const raw = typeof event?.data === 'string' ? event.data : event;
      const packet = assertEnvelope(JSON.parse(raw));
      onEnvelope?.(packet);
    } catch (error) {
      onError?.(error);
    }
  };
  listen('message', handleMessage);
  return {
    open,
    send(envelope) {
      if (channel.readyState !== 'open') return false;
      try {
        channel.send(JSON.stringify(assertEnvelope(envelope)));
        return true;
      } catch (error) {
        onError?.(error);
        return false;
      }
    },
    close() { channel.close?.(); }
  };
}
