const DEFAULT_TRACE_LIMIT = 20_000;
const CONSOLE_STAGES = new Set(['PROVIDER_EVENT', 'NORMALIZED', 'CUE_STATE', 'REACT_RENDER']);

export function createLivePipelineTrace({
  enabled = false,
  limit = DEFAULT_TRACE_LIMIT,
  now = () => new Date().toISOString(),
  logger = (...args) => console.debug(...args)
} = {}) {
  let isEnabled = enabled === true;
  let entries = isEnabled ? [] : null;

  function record(input = {}) {
    if (!isEnabled || !entries) return null;
    const cueAction = input.cueAction || null;
    const entry = Object.freeze({
      timestamp: input.timestamp || now(),
      stage: input.stage || 'UNKNOWN',
      recordingId: input.recordingId || null,
      segmentId: input.segmentId || null,
      connectionEpoch: input.connectionEpoch ?? null,
      captureEpoch: input.captureEpoch ?? null,
      providerEpoch: input.providerEpoch ?? null,
      audioTurnId: input.audioTurnId || null,
      eventId: input.eventId || null,
      eventType: input.eventType || null,
      isFinal: Boolean(input.isFinal),
      isLateTranscript: Boolean(input.isLateTranscript),
      turnComplete: Boolean(input.turnComplete),
      generationComplete: Boolean(input.generationComplete),
      providerTurnIndex: input.providerTurnIndex ?? null,
      providerTurnId: input.providerTurnId || null,
      turnKey: input.turnKey || null,
      turnIdentitySource: input.turnIdentitySource || null,
      sourceText: input.sourceText || '',
      translationText: input.translationText || '',
      cueId: input.cueId || null,
      cueAction,
      dropReason: cueAction === 'drop' ? (input.dropReason || 'unspecified_drop') : (input.dropReason || null),
      pcmSequence: input.pcmSequence ?? null,
      pcmBytes: input.pcmBytes ?? null,
      transportResult: input.transportResult || null
    });
    entries.push(entry);
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    if (CONSOLE_STAGES.has(entry.stage) || entry.cueAction === 'drop') logger('[TURN TRACE]', entry);
    return entry;
  }

  function get(filter = {}) {
    if (!isEnabled || !entries) return [];
    return entries.filter((entry) => Object.entries(filter).every(([key, value]) => (
      value === undefined || value === null || entry[key] === value
    ))).map((entry) => ({ ...entry }));
  }

  function getTurn(audioTurnId) {
    return audioTurnId ? get({ audioTurnId }) : [];
  }

  function clear() {
    if (entries) entries.length = 0;
  }

  function setEnabled(nextEnabled) {
    const shouldEnable = nextEnabled === true;
    if (shouldEnable === isEnabled) return isEnabled;
    isEnabled = shouldEnable;
    entries = isEnabled ? [] : null;
    return isEnabled;
  }

  return Object.freeze({ record, get, getTurn, clear, setEnabled, isEnabled: () => isEnabled });
}

export const livePipelineTrace = createLivePipelineTrace();

export function configureLivePipelineTrace(enabled) {
  return livePipelineTrace.setEnabled(enabled === true);
}

export function recordLivePipelineTrace(entry) {
  return livePipelineTrace.record(entry);
}
