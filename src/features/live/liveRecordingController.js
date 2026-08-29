import {
  applyRefinementResultToCues,
  markCuesCompletedByRefinedOutputs,
  mergeCuesByIdPreferRefinement
} from '../../lib/cueRefinement.js';
import { effectiveTranslationForCue } from '../../lib/cueContent.js';

// Keeps the polling merge atomic: completed output and its execution state are
// reduced to the same Cue snapshot before the React page renders it.
export function applyCompletedRefinementOutputs(previousCues = [], outputs = [], { sessionId, logger } = {}) {
  let nextCues = previousCues;
  for (const output of Array.isArray(outputs) ? outputs : []) {
    const targets = Array.isArray(output?.refinementTargets) ? output.refinementTargets : [];
    const targetByCueId = new Map(targets.filter((target) => target?.targetCueId).map((target) => [target.targetCueId, target]));
    const items = [
      ...(Array.isArray(output?.refinedItems) ? output.refinedItems : []),
      ...(Array.isArray(output?.polishedItems) ? output.polishedItems : [])
    ];
    for (const item of items) {
      const target = targetByCueId.get(item.targetCueId || item.cueId);
      const targetCueId = item.targetCueId || target?.targetCueId || item.cueId;
      if (!targetCueId) continue;
      const result = applyRefinementResultToCues(nextCues, {
        ...item,
        targetCueId,
        fields: item.fields || target?.fields || (typeof item.polishedText === 'string' ? ['translation'] : ['source', 'translation']),
        sessionId: item.sessionId || target?.sessionId || output.sessionId,
        segmentId: item.segmentId || target?.segmentId,
        connectionEpoch: item.connectionEpoch ?? target?.connectionEpoch,
        refinementJobId: item.refinementJobId || target?.refinementJobId || output.executionId,
        completedAt: output.completedAt || output.createdAt,
        version: item.version ?? target?.version,
        inputHash: item.inputHash ?? target?.inputHash
      }, { sessionId: output.sessionId || sessionId, logger });
      if (result.applied) nextCues = result.cues;
    }
  }
  nextCues = markCuesCompletedByRefinedOutputs(nextCues, outputs);
  nextCues = mergeCuesByIdPreferRefinement(previousCues, nextCues);
  return {
    cues: nextCues,
    changed: nextCues.some((cue, index) => cue !== previousCues[index]),
    articleText: nextCues.map((cue) => effectiveTranslationForCue(cue)).filter(Boolean).join('\n')
  };
}
