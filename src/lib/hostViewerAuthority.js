import { applyMeetingCueEvent, mergeMeetingViewerSnapshot } from './meetingViewerState.js';

// The signaling channel authorizes the Host; metadata constrains which of its
// locally stored segments may appear in this Viewer session.
export function mergeHostViewerEnvelope(current, envelope) {
  const meetingId = current?.meeting?.id;
  if (!meetingId || envelope?.meetingId !== meetingId || !envelope?.sourceId) return current;
  const cursor = current.hostCursor || { sourceId: null, sequence: 0 };
  if (envelope.type === 'replay.response') {
    if (cursor.sourceId && envelope.sourceId !== cursor.sourceId) return current;
    if (!Array.isArray(envelope.events) || envelope.fromSequence > cursor.sequence) return current;
    let next = current;
    for (const event of [...envelope.events].sort((left, right) => left.sequence - right.sequence)) {
      if (event.sourceId !== envelope.sourceId) return current;
      if (event.sequence <= cursor.sequence) continue;
      if (event.sequence !== (next.hostCursor?.sequence || 0) + 1) return current;
      const accepted = mergeHostViewerEnvelope(next, event);
      if (accepted === next) return current;
      next = accepted;
    }
    return envelope.toSequence === (next.hostCursor?.sequence || 0) ? next : current;
  }
  if (!['snapshot', 'cue.append', 'cue.update'].includes(envelope.type)) return current;
  if (envelope.sourceId === cursor.sourceId && envelope.sequence <= cursor.sequence) return current;
  if (envelope.type !== 'snapshot' && envelope.sequence !== (envelope.sourceId === cursor.sourceId ? cursor.sequence : 0) + 1) return current;
  const rawCues = envelope.type === 'snapshot' ? envelope.cues : [envelope.cue];
  if (!Array.isArray(rawCues) || !rawCues.every((cue) => validCue(current, cue, meetingId))) return current;
  const segments = new Map(current.segments.map((segment) => [segment.id, segment]));
  const cues = rawCues.map((cue) => ({ ...cue, meetingId, segmentSequence: segments.get(cue.segmentId).sequence }));
  const next = envelope.type === 'snapshot'
    ? mergeMeetingViewerSnapshot(current, { cues })
    : applyMeetingCueEvent(current, { type: envelope.type, cue: cues[0] });
  return { ...next, hostCursor: { sourceId: envelope.sourceId, sequence: envelope.sequence } };
}

function validCue(current, cue, meetingId) {
  const segment = current.segments?.find((item) => item.id === cue?.segmentId);
  if (!segment || !cue?.cueId || cue.meetingId !== meetingId || cue.sessionId !== segment.sessionId
    || !Number.isSafeInteger(cue.sequence) || cue.sequence < 1) return false;
  const previous = current.cues?.find((item) => item.cueId === cue.cueId);
  return !previous || (previous.meetingId === meetingId
    && previous.sessionId === cue.sessionId && previous.segmentId === cue.segmentId);
}
