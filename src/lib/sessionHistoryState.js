export const HISTORY_REFRESH_MS = 2000;

export function hasPendingExecutions(history) {
  return (history?.translationHistory?.executions || []).some(
    (execution) => execution.status === 'queued' || execution.status === 'running' || execution.status === 'processing'
  );
}

export function selectedOutputFor(history, selectedOutputId) {
  const outputs = history?.translationHistory?.outputs || [];
  return outputs.find((output) => output.id === selectedOutputId) || outputs[0] || null;
}

export function replaceHistoryExecution(history, execution) {
  const currentExecutions = history?.translationHistory?.executions || [];
  const existing = currentExecutions.find((item) => item.id === execution.id);
  const nextExecution = {
    ...existing,
    ...execution,
    requestId: execution.requestId || execution.translationRequestId || existing?.requestId
  };

  return {
    ...history,
    translationHistory: {
      ...(history?.translationHistory || {}),
      outputs: history?.translationHistory?.outputs || [],
      executions: existing
        ? currentExecutions.map((item) => (item.id === execution.id ? nextExecution : item))
        : [...currentExecutions, nextExecution]
    }
  };
}
