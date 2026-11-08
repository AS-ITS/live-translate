export const MAX_PENDING_CUES_PER_MEETING = 512;
export const MAX_PENDING_EVENTS_PER_CUE = 32;

export function pendingCueKey(meetingId, sessionId, cueId) {
  return JSON.stringify([meetingId, sessionId, cueId]);
}

export function projectPendingCue(input) {
  const cue = input?.cue;
  if (!cue || cue.segmentId != null || !['partial', 'final'].includes(cue.status)
    || !nonEmpty(input.meetingId) || !nonEmpty(input.eventKey)
    || !nonEmpty(cue.cueId) || !nonEmpty(cue.sessionId)
    || !Number.isSafeInteger(cue.sequence) || cue.sequence < 1
    || !Number.isFinite(cue.startTimeMs) || !Number.isFinite(cue.endTimeMs)) {
    return { status: 'rejected', reason: 'cue_pending_invalid' };
  }
  const fields = [
    'cueId', 'sessionId', 'liveSessionId', 'sequence', 'startTimeMs', 'endTimeMs',
    'status', 'sourceText', 'translatedText', 'rawSource', 'rawTranslation',
    'sourceStatus', 'translationStatus', 'audioTurnId', 'turnKey', 'turnIndex',
    'providerEpoch', 'connectionEpoch', 'providerEventSequence',
    'providerEventId', 'eventId', 'sourceProvenance', 'translationProvenance',
    'sourceLanguageCode', 'targetLanguageCode', 'finalizedReason'
  ];
  const snapshot = Object.fromEntries(fields.filter((field) => cue[field] !== undefined)
    .map((field) => [field, structuredClone(cue[field])]));
  return { status: 'valid', record: {
    key: pendingCueKey(input.meetingId, cue.sessionId, cue.cueId),
    meetingId: input.meetingId, sessionId: cue.sessionId, cueId: cue.cueId,
    sequence: cue.sequence, cue: snapshot
  } };
}

export function advancePendingCue(existing, projected, eventKey, fingerprint) {
  if (existing && (existing.sessionId !== projected.sessionId
    || existing.cueId !== projected.cueId || existing.sequence !== projected.sequence
    || existing.cue.startTimeMs !== projected.cue.startTimeMs)) {
    return { status: 'rejected', reason: 'cue_pending_identity_conflict' };
  }
  const events = existing?.events || [];
  const prior = events.find((event) => event.eventKey === eventKey);
  if (prior) return prior.fingerprint === fingerprint
    ? { status: 'duplicate', pending: existing }
    : { status: 'rejected', reason: 'cue_event_key_conflict' };
  if (events.length >= MAX_PENDING_EVENTS_PER_CUE) {
    return { status: 'rejected', reason: 'cue_pending_event_limit' };
  }
  return { status: 'pending', pending: {
    ...projected, events: [...events, { eventKey, fingerprint, cue: projected.cue }], updatedAt: Date.now()
  } };
}

export function pendingOwnershipIsProven(pending, cue, segment, candidateSegments) {
  return Boolean(pending && cue && segment
    && cue.segmentId === segment.segmentId
    && segment.recordingId === cue.sessionId
    && pending.sessionId === cue.sessionId
    && pending.cueId === cue.cueId
    && pending.sequence === cue.sequence
    && pending.cue.startTimeMs === cue.startTimeMs
    && (pending.cue.liveSessionId ?? null) === (cue.liveSessionId ?? null)
    && ['ACTIVE', 'ENDED'].includes(segment.status)
    && candidateSegments.length === 1);
}

export function classifyCueAuthority({ marker, cues = [], checkpoints = [], unassigned = [] }) {
  if (marker?.mode === 'b2') return 'b2';
  if (cues.length || unassigned.length || checkpoints.some((item) =>
    item.checkpoint?.finalCues?.length || item.checkpoint?.cueCheckpoint
    || item.checkpoint?.refinedSubtitleCues?.length)) return 'legacy_readonly';
  return 'new';
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
