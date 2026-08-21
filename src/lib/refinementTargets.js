export function refinementTargetsForItems(items = [], context = {}) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    targetCueId: item.cueId,
    targetSequence: item.sequence,
    version: item.version ?? item.refinement?.version ?? null,
    inputHash: item.inputHash ?? item.refinement?.inputHash ?? null,
    sessionId: context.sessionId ?? item.sessionId ?? null,
    segmentId: context.segmentId ?? item.segmentId ?? null,
    connectionEpoch: context.connectionEpoch ?? null,
    refinementJobId: context.refinementJobId ?? context.executionId ?? null,
    requestId: context.requestId ?? null,
    fields: context.fields || ['source', 'translation']
  }));
}

export function normalizeRefinementTargets(targets = [], { sessionId, segmentId, connectionEpoch, refinementJobId, requestId, fields } = {}) {
  if (!Array.isArray(targets)) return [];
  return targets.map((target) => ({
    targetCueId: target?.targetCueId ?? target?.cueId,
    targetSequence: target?.targetSequence ?? target?.sequence,
    version: target?.version ?? null,
    inputHash: target?.inputHash ?? null,
    sessionId: target?.sessionId ?? sessionId ?? null,
    segmentId: target?.segmentId ?? segmentId ?? null,
    connectionEpoch: target?.connectionEpoch ?? connectionEpoch ?? null,
    refinementJobId: target?.refinementJobId ?? refinementJobId ?? null,
    requestId: target?.requestId ?? requestId ?? null,
    fields: Array.isArray(target?.fields) && target.fields.length > 0 ? [...target.fields] : (fields || ['translation'])
  }));
}

export function targetForCue(targets, cueId) {
  return (Array.isArray(targets) ? targets : []).find((target) => target?.targetCueId === cueId) || null;
}

export function assertRefinementResultIdentity(item, target, { sessionId, segmentId, refinementJobId, requestId } = {}) {
  if (!target || item?.cueId !== target.targetCueId || item?.sequence !== target.targetSequence) return false;
  for (const [actual, expected] of [['sessionId', sessionId], ['segmentId', segmentId], ['refinementJobId', refinementJobId], ['requestId', requestId]]) {
    if (expected !== undefined && expected !== null && target[actual] !== null && target[actual] !== expected) return false;
  }
  return true;
}
