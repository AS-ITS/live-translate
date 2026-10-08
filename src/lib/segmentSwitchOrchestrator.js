const DEFAULT_SEGMENT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SEGMENT_INTERVAL_MS = 15 * 60 * 1000;

export function createSegmentSwitchOrchestrator({
  switchSegment,
  intervalMs = DEFAULT_SEGMENT_INTERVAL_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onStatusChange,
  onError
} = {}) {
  if (typeof switchSegment !== 'function') throw new TypeError('switchSegment is required.');
  if (typeof setTimeoutFn !== 'function') throw new TypeError('setTimeoutFn is required.');
  if (typeof clearTimeoutFn !== 'function') throw new TypeError('clearTimeoutFn is required.');

  const normalizedIntervalMs = normalizeIntervalMs(intervalMs);
  let timer = null;
  let active = false;
  let switching = false;
  let generation = 0;

  return Object.freeze({
    start() {
      active = true;
      generation += 1;
      schedule(generation);
    },

    cancel() {
      active = false;
      generation += 1;
      clearTimer();
    },

    async triggerNow() {
      return runSwitch(generation);
    }
  });

  function schedule(expectedGeneration) {
    clearTimer();
    if (!active) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void runSwitch(expectedGeneration);
    }, normalizedIntervalMs);
  }

  async function runSwitch(expectedGeneration) {
    if (!active || switching || expectedGeneration !== generation) return false;
    switching = true;
    onStatusChange?.('switching');

    try {
      await switchSegment({ generation: expectedGeneration });
      if (!active || expectedGeneration !== generation) return false;
      onStatusChange?.('switched');
      schedule(expectedGeneration);
      return true;
    } catch (error) {
      if (active && expectedGeneration === generation) {
        onStatusChange?.('error');
        onError?.(error);
        schedule(expectedGeneration);
      }
      return false;
    } finally {
      switching = false;
    }
  }

  function clearTimer() {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  }
}

export function normalizeSegmentIntervalMs(value) {
  return normalizeIntervalMs(value);
}

function normalizeIntervalMs(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SEGMENT_INTERVAL_MS;
  return Math.min(Math.floor(value), MAX_SEGMENT_INTERVAL_MS);
}
