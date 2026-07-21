export const HISTORY_REFRESH_MS = 2000;

export function hasPendingExecutions(history) {
  return (history?.translationHistory?.executions || []).some((execution) => execution.status === 'queued' || execution.status === 'processing');
}

export function selectedOutputFor(history, selectedOutputId) {
  const outputs = history?.translationHistory?.outputs || [];
  return outputs.find((output) => output.id === selectedOutputId) || outputs[0] || null;
}
