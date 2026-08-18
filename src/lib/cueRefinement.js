const ACTIVE_EXECUTION_STATUSES = new Set(['queued', 'processing', 'running']);
const FAILED_EXECUTION_STATUSES = new Set(['failed', 'cancelled']);

export function completedCueRefinementOutputs(detail = {}) {
  return (detail.translationHistory?.outputs || []).filter((output) => (
    output?.operation === 'transcript_polishing' && (
      (Array.isArray(output.refinedItems) && output.refinedItems.length > 0)
      || (typeof output.translatedText === 'string' && output.translatedText.trim().length > 0)
    )
  ));
}

export function applyCueRefinementExecutionStates(cues = [], executions = []) {
  const byId = new Map((Array.isArray(executions) ? executions : []).map((execution) => [execution.id, execution]));
  return cues.map((cue) => {
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
