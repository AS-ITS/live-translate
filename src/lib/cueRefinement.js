const ACTIVE_EXECUTION_STATUSES = new Set(['queued', 'processing', 'running']);
const FAILED_EXECUTION_STATUSES = new Set(['failed', 'cancelled']);

const REFINEMENT_STATUS_PRIORITY = Object.freeze({
  pending: 0,
  queued: 1,
  running: 2,
  failed: 3,
  completed: 4
});

export function refinementVersion(cue = {}) {
  return Number.isInteger(cue?.refinement?.version) ? cue.refinement.version : 0;
}

export function shouldPreferRefinementCue(incoming, existing) {
  const incomingVersion = refinementVersion(incoming);
  const existingVersion = refinementVersion(existing);
  if (incomingVersion !== existingVersion) return incomingVersion > existingVersion;
  const incomingStatus = REFINEMENT_STATUS_PRIORITY[incoming?.refinement?.status] ?? 0;
  const existingStatus = REFINEMENT_STATUS_PRIORITY[existing?.refinement?.status] ?? 0;
  if (incomingStatus !== existingStatus) return incomingStatus > existingStatus;
  return Boolean(incoming?.refinedSource || incoming?.refinedTranslation)
    && !(existing?.refinedSource || existing?.refinedTranslation);
}

export function mergeCuesByIdPreferRefinement(existingCues = [], incomingCues = []) {
  const incomingById = new Map((Array.isArray(incomingCues) ? incomingCues : [])
    .filter((cue) => cue?.cueId)
    .map((cue) => [cue.cueId, cue]));
  return existingCues.map((cue) => {
    const incoming = incomingById.get(cue?.cueId);
    return incoming && shouldPreferRefinementCue(incoming, cue)
      ? { ...cue, ...incoming }
      : cue;
  });
}

export function applyRefinementResultToCues(cues = [], result = {}, {
  sessionId,
  segmentId,
  connectionEpoch,
  refinementJobId,
  logger = (event) => console.debug?.('[Cue refinement]', event)
} = {}) {
  const targetCueId = result?.targetCueId;
  const availableCueIds = cues.map((cue) => cue?.cueId).filter(Boolean);
  const target = cues.find((cue) => cue?.cueId === targetCueId);
  const diagnostic = (reason) => ({
    event: 'refinement_target_not_found',
    reason,
    targetCueId,
    availableCueIds,
    sessionId: sessionId ?? result?.sessionId ?? null,
    segmentId: segmentId ?? result?.segmentId ?? null,
    connectionEpoch: connectionEpoch ?? result?.connectionEpoch ?? null,
    refinementJobId: result?.refinementJobId ?? null
  });
  if (!targetCueId || !target) {
    const event = diagnostic('target_not_found');
    logger(event);
    return { cues, applied: false, diagnostic: event };
  }
  if ((sessionId && result.sessionId && sessionId !== result.sessionId)
    || (segmentId && result.segmentId && segmentId !== result.segmentId)
    || (result.sessionId && target.sessionId && result.sessionId !== target.sessionId)
    || (result.segmentId && target.segmentId && result.segmentId !== target.segmentId)
    || (connectionEpoch !== undefined && result.connectionEpoch !== undefined && connectionEpoch !== result.connectionEpoch)
    || (refinementJobId && result.refinementJobId && refinementJobId !== result.refinementJobId)
    || (result.version !== undefined && target.refinement?.version !== undefined && result.version < target.refinement.version)
    || (result.version !== undefined && target.refinement?.version !== undefined && result.version === target.refinement.version
      && result.inputHash && target.refinement?.inputHash && result.inputHash !== target.refinement.inputHash)) {
    const event = diagnostic('stale_or_mismatched_identity');
    logger(event);
    return { cues, applied: false, stale: true, diagnostic: event };
  }
  const fields = Array.isArray(result.fields) && result.fields.length > 0 ? result.fields : ['source', 'translation'];
  const nextRefinement = {
    ...(target.refinement || {}),
    status: 'completed',
    version: result.version ?? target.refinement?.version ?? 1,
    ...(result.inputHash ? { inputHash: result.inputHash } : {}),
    ...(result.refinementJobId ? { executionId: result.refinementJobId } : {}),
    ...(result.completedAt ? { completedAt: result.completedAt } : {})
  };
  const nextCue = {
    ...target,
    ...(fields.includes('source') && typeof result.refinedSource === 'string' ? { refinedSource: result.refinedSource } : {}),
    ...(fields.includes('translation') && typeof result.refinedTranslation === 'string' ? { refinedTranslation: result.refinedTranslation } : {}),
    ...(fields.includes('translation') && typeof result.polishedText === 'string' ? { refinedTranslation: result.polishedText.trim() } : {}),
    refinement: nextRefinement
  };
  return {
    cues: cues.map((cue) => cue.cueId === targetCueId ? nextCue : cue),
    applied: true,
    cue: nextCue
  };
}

export function completedCueRefinementOutputs(detail = {}) {
  return (detail.translationHistory?.outputs || []).filter((output) => (
    output?.operation === 'transcript_polishing' && (
      (Array.isArray(output.refinedItems) && output.refinedItems.length > 0)
      || (Array.isArray(output.refinedCues) && output.refinedCues.length > 0)
      || (Array.isArray(output.polishedItems) && output.polishedItems.length > 0)
      || (typeof output.translatedText === 'string' && output.translatedText.trim().length > 0)
    )
  ));
}

export function applyCueRefinementExecutionStates(cues = [], executions = []) {
  const byId = new Map((Array.isArray(executions) ? executions : []).map((execution) => [execution.id, execution]));
  return cues.map((cue) => {
    if (cue?.refinement?.status === 'completed') return cue;
    const executionId = cue?.refinement?.executionId;
    const execution = executionId ? byId.get(executionId) : null;
    if (!execution) return cue;

    if (FAILED_EXECUTION_STATUSES.has(execution.status)) {
      if (cue.refinement?.status === 'failed') return cue;
      return {
        ...cue,
        refinement: {
          ...(cue.refinement || {}),
          status: 'failed',
          failedAt: execution.completedAt || new Date().toISOString(),
          failure: execution.failureInfo || { reason: execution.status }
        }
      };
    }

    if (ACTIVE_EXECUTION_STATUSES.has(execution.status)) {
      if (cue.refinement?.status === execution.status) return cue;
      return {
        ...cue,
        refinement: {
          ...(cue.refinement || {}),
          status: execution.status
        }
      };
    }

    return cue;
  });
}

export function markCuesCompletedByRefinedSubtitleCues(cues = [], refinedSubtitleCues = []) {
  const completedCueIds = new Set((Array.isArray(refinedSubtitleCues) ? refinedSubtitleCues : [])
    .flatMap((cue) => Array.isArray(cue?.sourceCueIds) ? cue.sourceCueIds : []));
  if (completedCueIds.size === 0) return cues;

  return cues.map((cue) => {
    if (!completedCueIds.has(cue?.cueId) || cue?.refinement?.status === 'completed') return cue;
    return {
      ...cue,
      refinement: {
        ...(cue.refinement || {}),
        status: 'completed',
        completedAt: cue.refinement?.completedAt || new Date().toISOString()
      }
    };
  });
}

export function refinedSubtitleCuesForDisplay(cues = [], { inputHash = null } = {}) {
  return (Array.isArray(cues) ? cues : [])
    .filter((cue) => cue?.status === 'final'
      && typeof cue?.cueId === 'string'
      && cue.cueId.startsWith('refined-subtitle:')
      && (!inputHash || cue?.refinement?.inputHash === inputHash))
    .slice()
    .sort((left, right) => (
      (left.sequence ?? 0) - (right.sequence ?? 0)
      || (left.startTimeMs ?? 0) - (right.startTimeMs ?? 0)
      || left.cueId.localeCompare(right.cueId)
    ));
}

export function markCuesCompletedByRefinedOutputs(cues = [], outputs = []) {
  const completedCueIds = new Map();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (output?.operation !== 'transcript_polishing' || !Array.isArray(output.refinedCues)) continue;
    for (const refinedCue of output.refinedCues) {
      for (const sourceCueId of Array.isArray(refinedCue?.sourceCueIds) ? refinedCue.sourceCueIds : []) {
        completedCueIds.set(sourceCueId, output.completedAt || output.createdAt || null);
      }
    }
  }
  if (completedCueIds.size === 0) return cues;

  return cues.map((cue) => {
    const completedAt = completedCueIds.get(cue?.cueId);
    if (!completedAt || cue?.refinement?.status === 'completed') return cue;
    return {
      ...cue,
      refinement: {
        ...(cue.refinement || {}),
        status: 'completed',
        completedAt: cue.refinement?.completedAt || completedAt
      }
    };
  });
}

export function applyPolishedItemsToCues(cues = [], outputs = []) {
  const polishedItems = new Map();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (output?.operation !== 'transcript_polishing' || !Array.isArray(output.polishedItems)) continue;
    const completedAt = output.completedAt || output.createdAt || null;
    for (const item of output.polishedItems) {
      if (!item?.cueId || typeof item.polishedText !== 'string' || item.polishedText.trim() === '') continue;
      polishedItems.set(item.cueId, {
        refinedTranslation: item.polishedText.trim(),
        completedAt
      });
    }
  }
  if (polishedItems.size === 0) return cues;

  return cues.map((cue) => {
    const item = polishedItems.get(cue?.cueId);
    if (!item) return cue;
    const nextRefinement = {
      ...(cue.refinement || {}),
      status: 'completed',
      completedAt: cue.refinement?.completedAt || item.completedAt || new Date().toISOString()
    };
    if (cue.refinedTranslation === item.refinedTranslation
      && cue.refinement?.status === 'completed'
      && cue.refinement?.completedAt === nextRefinement.completedAt) return cue;
    return {
      ...cue,
      refinedTranslation: item.refinedTranslation,
      refinement: nextRefinement
    };
  });
}
