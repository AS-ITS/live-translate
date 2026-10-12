export function createLocalCueManifest(initial = []) {
  const cues = new Map();
  for (const cue of initial) append(cue);
  return Object.freeze({
    append,
    list(segmentId) {
      return Object.freeze([...cues.values()]
        .filter((cue) => segmentId === undefined || cue.segmentId === segmentId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((cue) => Object.freeze({ ...cue })));
    }
  });

  function append(input) {
    const cue = normalizeCue(input);
    const existing = cues.get(cue.cueId);
    if (existing) {
      if (!sameIdentity(existing, cue)) throw conflict();
      return Object.freeze({ ...existing });
    }
    if ([...cues.values()].some((value) => value.sessionId === cue.sessionId && value.segmentId === cue.segmentId && value.sequence === cue.sequence)) throw conflict();
    cues.set(cue.cueId, cue);
    return Object.freeze({ ...cue });
  }
}

function normalizeCue(input = {}) {
  const cue = {
    cueId: required(input.cueId, 'cueId'),
    sessionId: required(input.sessionId, 'sessionId'),
    segmentId: required(input.segmentId, 'segmentId'),
    sequence: positive(input.sequence, 'sequence'),
    startTimeMs: nonNegative(input.startTimeMs, 'startTimeMs'),
    endTimeMs: nonNegative(input.endTimeMs, 'endTimeMs'),
    sourceText: required(input.sourceText, 'sourceText')
  };
  if (cue.endTimeMs < cue.startTimeMs) throw new TypeError('endTimeMs must not precede startTimeMs.');
  return Object.freeze(cue);
}
function sameIdentity(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function required(value, field) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required.`); return value.trim(); }
function positive(value, field) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${field} must be positive integer.`); return number; }
function nonNegative(value, field) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${field} must be non-negative integer.`); return number; }
function conflict() { const error = new Error('local_cue_identity_conflict'); error.code = 'local_cue_identity_conflict'; error.status = 409; return error; }
