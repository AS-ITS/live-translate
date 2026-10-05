export function mergeMeetingViewerSnapshot(current, snapshot) {
  const next = { ...(current || {}), ...(snapshot || {}) };
  const cues = mergeMeetingCues(current?.cues || [], snapshot?.cues || []);
  return { ...next, cues, cursor: mergeCursor(current?.cursor, snapshot?.cursor, cues) };
}

function mergeCursor(current, incoming, cues) {
  return {
    eventId: Math.max(Number(current?.eventId) || 0, Number(incoming?.eventId) || 0),
    cueSequence: Math.max(Number(current?.cueSequence) || 0, Number(incoming?.cueSequence) || 0, ...cues.map((cue) => Number(cue.sequence) || 0))
  };
}

export function applyMeetingCueEvent(current, event) {
  if (!event || !['cue.append', 'cue.update'].includes(event.type) || !event.cue?.cueId) return current;
  const next = mergeMeetingViewerSnapshot(current, {
    cues: [event.cue],
    cursor: { eventId: event.eventId || current?.cursor?.eventId || 0, cueSequence: event.cue.sequence || current?.cursor?.cueSequence || 0 }
  });
  return next;
}

export function meetingEventGapDetected(cursor, eventId) {
  const previous = Number(cursor?.eventId) || 0;
  return previous > 0 && Number.isInteger(eventId) && eventId > previous + 1;
}

export function meetingEventDuplicateDetected(detail, event) {
  const cueId = event?.cue?.cueId || event?.cueId;
  if (!cueId) return false;
  return Array.isArray(detail?.cues) && detail.cues.some((cue) => cue?.cueId === cueId &&
    (Number(cue?.sourceVersion) || 0) >= (Number(event?.cue?.sourceVersion) || 0) &&
    (Number(cue?.translationVersion) || 0) >= (Number(event?.cue?.translationVersion) || 0));
}

export function sortMeetingCues(cues = []) {
  return [...cues].sort((left, right) => {
    const leftSegment = positiveSequence(left?.segmentSequence);
    const rightSegment = positiveSequence(right?.segmentSequence);
    if (leftSegment !== rightSegment) return (leftSegment ?? Infinity) - (rightSegment ?? Infinity);
    if (leftSegment === null) return 0;
    return (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0)
      || String(left?.cueId || '').localeCompare(String(right?.cueId || ''));
  });
}

export function mergeMeetingCues(existing = [], incoming = []) {
  const byId = new Map(existing.filter((cue) => cue?.cueId).map((cue) => [cue.cueId, canonicalSourceCue(cue)]));
  for (const cue of incoming) {
    if (!cue?.cueId) continue;
    const canonicalCue = canonicalSourceCue(cue);
    const previous = byId.get(canonicalCue.cueId);
    byId.set(canonicalCue.cueId, previous ? mergeCue(previous, canonicalCue) : canonicalCue);
  }
  return sortMeetingCues([...byId.values()]);
}

function canonicalSourceCue(cue) {
  const sourceText = cue.rawSource ?? cue.sourceText;
  return sourceText === undefined ? cue : { ...cue, sourceText };
}

function positiveSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function mergeCue(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const order = positiveSequence(existing.segmentSequence) ?? positiveSequence(incoming.segmentSequence);
  if (order !== null) merged.segmentSequence = order;
  else delete merged.segmentSequence;
  merged.sequence = positiveSequence(existing.sequence) ?? positiveSequence(incoming.sequence) ?? merged.sequence;
  merged.segmentId = existing.segmentId || incoming.segmentId;

  for (const [version, fields] of [
    ['sourceVersion', ['sourceText', 'sourceStatus', 'rawSource']],
    ['translationVersion', ['translatedText', 'translationStatus', 'rawTranslation']],
  ]) {
    const previousVersion = Number(existing[version]) || 0;
    const incomingVersion = Number(incoming[version]) || 0;
    merged[version] = Math.max(previousVersion, incomingVersion);
    if (incomingVersion < previousVersion || (incomingVersion === previousVersion && fields.every((field) => incoming[field] === undefined))) {
      for (const field of fields) if (existing[field] !== undefined) merged[field] = existing[field];
    } else {
      for (const field of fields) if (incoming[field] === undefined && existing[field] !== undefined) merged[field] = existing[field];
    }
  }

  const previousRefinement = Number(existing.refinement?.version) || 0;
  const incomingRefinement = Number(incoming.refinement?.version) || 0;
  if (previousRefinement > incomingRefinement || !incoming.refinement) merged.refinement = existing.refinement;
  if (existing.status === 'final' && incoming.status !== 'final') merged.status = 'final';
  merged.updatedTimeMs = Math.max(Number(existing.updatedTimeMs) || 0, Number(incoming.updatedTimeMs) || 0) || merged.updatedTimeMs;
  return merged;
}
