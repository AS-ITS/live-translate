const SNAPSHOT_MODE = 'snapshot';

/**
 * Keep transcript fragments lossless while allowing cumulative snapshots to
 * collapse before the next UI flush.
 */
export function enqueueLiveCueEvent(eventsInput, event) {
  const events = Array.isArray(eventsInput) ? eventsInput : [];
  if (!event) return events;

  if (event.textMergeMode === SNAPSHOT_MODE) {
    const key = snapshotKey(event);
    const existingIndex = events.findIndex((candidate) => (
      candidate?.textMergeMode === SNAPSHOT_MODE && snapshotKey(candidate) === key
    ));
    if (existingIndex >= 0) {
      const next = events.slice();
      next[existingIndex] = event;
      return next;
    }
  }

  return [...events, event];
}

function snapshotKey(event) {
  return [
    event?.connectionEpoch ?? 'epoch-unknown',
    event?.segmentId || 'segment-unknown',
    event?.stream || 'unknown',
    event?.turnKey || event?.audioTurnId || event?.eventId || `sequence:${event?.eventSequence ?? 'unknown'}`
  ].join(':');
}
