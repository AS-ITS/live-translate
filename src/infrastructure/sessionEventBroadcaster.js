export function createSessionEventBroadcaster() {
  const sessions = new Map();

  return Object.freeze({
    publish(sessionId, payload) {
      const state = stateFor(sessionId);
      state.sequence += 1;
      state.snapshot = payload;
      const event = { id: state.sequence, type: 'session.snapshot', data: payload };
      for (const listener of [...state.listeners]) listener(event);
      return event;
    },

    snapshot(sessionId) {
      const state = sessions.get(sessionId);
      return state?.snapshot ? { sequence: state.sequence, payload: state.snapshot } : null;
    },

    subscribe(sessionId, listener) {
      const state = stateFor(sessionId);
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    }
  });

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { sequence: 0, snapshot: null, listeners: new Set() };
      sessions.set(sessionId, state);
    }
    return state;
  }
}
