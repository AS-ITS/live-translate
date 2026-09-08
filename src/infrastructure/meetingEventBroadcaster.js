const DEFAULT_HISTORY_LIMIT = 256;

export function createMeetingEventBroadcaster({ clock = () => Date.now(), historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer.');

  const meetings = new Map();

  return Object.freeze({
    publish(meetingId, { segmentId, cue, producedAt = null } = {}) {
      const state = stateFor(meetingId);
      const existing = state.cues.get(cue?.cueId);
      if (existing && !isNewerCue(cue, existing.cue)) return existing.event;

      state.sequence += 1;
      const event = {
        eventId: state.sequence,
        type: 'cue.append',
        meetingId,
        segmentId: segmentId || cue?.segmentId || null,
        cue: clone(cue),
        timing: {
          producedAt: Number.isFinite(producedAt) ? producedAt : null,
          publishedAt: clock()
        }
      };
      state.cues.set(cue.cueId, { event, cue: clone(cue) });
      state.events.push(event);
      if (state.events.length > historyLimit) state.events.splice(0, state.events.length - historyLimit);
      for (const listener of [...state.listeners]) listener(event);
      return event;
    },

    cursor(meetingId) {
      const state = meetings.get(meetingId);
      return { eventId: state?.sequence || 0, cueSequence: latestCueSequence(state) };
    },

    eventsSince(meetingId, afterEventId = 0) {
      const state = meetings.get(meetingId);
      if (!state) return { events: [], gap: false, cursor: { eventId: 0, cueSequence: 0 } };
      const firstEventId = state.events[0]?.eventId || state.sequence + 1;
      return {
        events: state.events.filter((event) => event.eventId > afterEventId),
        gap: afterEventId > 0 && afterEventId < firstEventId - 1,
        cursor: { eventId: state.sequence, cueSequence: latestCueSequence(state) }
      };
    },

    subscribe(meetingId, listener) {
      const state = stateFor(meetingId);
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    }
  });

  function stateFor(meetingId) {
    let state = meetings.get(meetingId);
    if (!state) {
      state = { sequence: 0, events: [], cues: new Map(), listeners: new Set() };
      meetings.set(meetingId, state);
    }
    return state;
  }
}

function latestCueSequence(state) {
  return state ? Math.max(0, ...[...state.cues.values()].map(({ cue }) => Number(cue?.sequence) || 0)) : 0;
}

function isNewerCue(incoming, existing) {
  const incomingVersion = Number(incoming?.refinement?.version) || 0;
  const existingVersion = Number(existing?.refinement?.version) || 0;
  return incomingVersion > existingVersion || (incomingVersion === existingVersion && JSON.stringify(incoming) !== JSON.stringify(existing));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
