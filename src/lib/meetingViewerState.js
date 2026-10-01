export function mergeMeetingViewerSnapshot(current, snapshot) {
  const next = { ...(current || {}), ...(snapshot || {}) };
  const cues = mergeCues(current?.cues || [], snapshot?.cues || []);
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
  return [...cues].sort((left, right) => (
    (Number(left?.segmentSequence) || 0) - (Number(right?.segmentSequence) || 0) ||
    (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0) ||
    String(left?.cueId || '').localeCompare(String(right?.cueId || ''))
  ));
}

function mergeCues(existing, incoming) {
  const byId = new Map(existing.filter((cue) => cue?.cueId).map((cue) => [cue.cueId, cue]));
  for (const cue of incoming) {
    if (!cue?.cueId) continue;
    const previous = byId.get(cue.cueId);
    if (!previous || isNewerCue(cue, previous)) byId.set(cue.cueId, cue);
  }
  return sortMeetingCues([...byId.values()]);
}

function isNewerCue(incoming, existing) {
  const incomingSourceVersion = Number(incoming?.sourceVersion) || 0;
  const existingSourceVersion = Number(existing?.sourceVersion) || 0;
  const incomingTranslationVersion = Number(incoming?.translationVersion) || 0;
  const existingTranslationVersion = Number(existing?.translationVersion) || 0;
  if (incomingSourceVersion < existingSourceVersion || incomingTranslationVersion < existingTranslationVersion) return false;
  if (incomingSourceVersion > existingSourceVersion || incomingTranslationVersion > existingTranslationVersion) return true;
  const incomingVersion = Number(incoming?.refinement?.version) || 0;
  const existingVersion = Number(existing?.refinement?.version) || 0;
  return incomingVersion > existingVersion || (incomingVersion === existingVersion && JSON.stringify(incoming) !== JSON.stringify(existing));
}
