export const SESSION_STATUSES = Object.freeze(['created', 'active', 'paused', 'stopped', 'failed', 'expired']);

const TERMINAL_STATUSES = new Set(['stopped', 'failed', 'expired']);
const ALLOWED_TRANSITIONS = Object.freeze({
  created: Object.freeze(['active', 'failed']),
  active: Object.freeze(['paused', 'stopped', 'failed', 'expired']),
  paused: Object.freeze(['active', 'stopped', 'failed', 'expired']),
  stopped: Object.freeze([]),
  failed: Object.freeze([]),
  expired: Object.freeze([])
});

export function isSessionStatus(status) {
  return SESSION_STATUSES.includes(status);
}

export function isTerminalSessionStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function assertSessionTransition(from, to) {
  if (!isSessionStatus(from) || !isSessionStatus(to)) {
    throw new RangeError(`Unsupported session transition: ${from} -> ${to}`);
  }
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new RangeError(`Session status transition from ${from} to ${to} is not allowed`);
  }
}

export function transitionSessionStatus(session, status, patch = {}) {
  assertSessionTransition(session.status, status);
  return {
    ...session,
    ...patch,
    status,
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: patch.updatedAt ?? Date.now()
  };
}
