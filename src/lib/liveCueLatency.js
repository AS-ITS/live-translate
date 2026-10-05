const SIDE_FIELDS = Object.freeze({
  source: { first: 'firstSourcePartialAt', final: 'sourceFinalAt' },
  translation: { first: 'firstTranslationPartialAt', final: 'translationFinalAt' }
});

export function createLiveCueLatencyTracker({
  enabled = false,
  now = () => Date.now(),
  logger = (...args) => console.debug(...args)
} = {}) {
  const turns = new Map();
  const publications = new Map();

  function turn(audioTurnId) {
    if (!audioTurnId) return null;
    if (!turns.has(audioTurnId)) turns.set(audioTurnId, { audioTurnId });
    return turns.get(audioTurnId);
  }

  function recordAudioTurnStarted({ audioTurnId, at = now() } = {}) {
    if (!enabled) return null;
    const current = turn(audioTurnId);
    if (current && current.audioTurnStartedAt === undefined) current.audioTurnStartedAt = at;
    return current ? { ...current } : null;
  }

  function recordCueEvent(event, { at = now() } = {}) {
    if (!enabled || !event?.audioTurnId) return null;
    const current = turn(event.audioTurnId);
    const fields = SIDE_FIELDS[event.stream];
    const hasText = typeof event.text === 'string' && event.text.trim() !== '';
    if (fields && hasText && current[fields.first] === undefined) current[fields.first] = at;
    if (fields && hasText && (event.isFinal || event.turnComplete || event.generationComplete)) {
      current[fields.final] ??= at;
    }
    if (event.turnComplete || event.generationComplete) {
      for (const side of Object.values(SIDE_FIELDS)) {
        if (current[side.first] !== undefined) current[side.final] ??= at;
      }
    }
    return { ...current };
  }

  function linkAudioTurn({ fromAudioTurnId, toAudioTurnId } = {}) {
    if (!enabled || !fromAudioTurnId || !toAudioTurnId || fromAudioTurnId === toAudioTurnId) return null;
    const source = turns.get(fromAudioTurnId);
    const target = turn(toAudioTurnId);
    if (source?.audioTurnStartedAt !== undefined) target.audioTurnStartedAt ??= source.audioTurnStartedAt;
    return { ...target };
  }

  function recordViewerPublished({ cue, at = now() } = {}) {
    if (!enabled || !cue?.cueId || !cue?.audioTurnId) return null;
    const current = turn(cue.audioTurnId);
    const publication = publications.get(cue.cueId) || { cueId: cue.cueId };
    publication.viewerFirstPublishedAt ??= at;
    if (cue.translationStatus === 'finalized' && publication.viewerTranslationUpdatedAt === undefined) {
      publication.viewerTranslationUpdatedAt = at;
    }
    publications.set(cue.cueId, publication);
    Object.assign(current, publication);
    const measurement = latencyMeasurement(current);
    logger('[live-cue-latency]', measurement);
    return measurement;
  }

  function snapshot(audioTurnId) {
    const current = turns.get(audioTurnId);
    return current ? latencyMeasurement(current) : null;
  }

  return { recordAudioTurnStarted, linkAudioTurn, recordCueEvent, recordViewerPublished, snapshot };
}

function latencyMeasurement(timestamps) {
  return {
    ...timestamps,
    audioToFirstSourceMs: elapsed(timestamps.audioTurnStartedAt, timestamps.firstSourcePartialAt),
    audioToFirstTranslationMs: elapsed(timestamps.audioTurnStartedAt, timestamps.firstTranslationPartialAt),
    sourceFinalToViewerMs: elapsed(timestamps.sourceFinalAt, timestamps.viewerFirstPublishedAt),
    translationFinalToViewerMs: elapsed(timestamps.translationFinalAt, timestamps.viewerTranslationUpdatedAt)
  };
}

function elapsed(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export const liveCueLatencyTracker = createLiveCueLatencyTracker({
  enabled: Boolean(import.meta.env?.DEV)
});
