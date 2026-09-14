const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running', 'processing']);

export function backgroundTranslationSummary(cues = []) {
  const executions = cues
    .map((cue) => cue?.refinement)
    .filter((refinement) => refinement && ACTIVE_STATUSES.has(refinement.status));
  if (executions.length === 0) return { pending: false };

  const latest = executions
    .map((execution) => ({
      ...execution,
      updatedAt: execution.completedAt || execution.startedAt || execution.requestedAt || null
    }))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];

  return {
    pending: true,
    status: executions.some((execution) => ['running', 'processing'].includes(execution.status)) ? 'processing' : latest.status,
    updatedAt: latest.updatedAt,
    startedAtMs: Date.parse(latest.requestedAt || latest.startedAt || latest.updatedAt || '')
  };
}
