const PENDING_EXECUTION_STATUSES = new Set(['queued', 'processing', 'running']);

export function retranslationProgressFor(history = {}, trackedRetranslations = []) {
  const outputs = (history.outputs || []).filter(isFormalRetranslationOutput);
  const completedKeys = new Set();

  for (const output of outputs) {
    addProgressKeys(completedKeys, output);
  }

  const executions = (history.executions || [])
    .filter(isRetranslationExecution)
    .filter((execution) => !hasProgressKey(completedKeys, execution));
  const knownKeys = new Set(completedKeys);

  for (const execution of executions) {
    addProgressKeys(knownKeys, execution);
  }

  for (const tracked of trackedRetranslations) {
    if (hasProgressKey(knownKeys, tracked)) {
      continue;
    }

    const optimisticExecution = {
      id: tracked.executionId || tracked.requestId,
      requestId: tracked.requestId,
      targetLanguageCode: tracked.targetLanguageCode,
      status: 'queued'
    };

    executions.push(optimisticExecution);
    addProgressKeys(knownKeys, optimisticExecution);
  }

  return { outputs, executions };
}

export function hasPendingRetranslationItems(progress = {}) {
  return (progress.executions || []).some((execution) => PENDING_EXECUTION_STATUSES.has(execution.status));
}

function isFormalRetranslationOutput(output) {
  if (output?.operation === 'transcript_polishing') {
    return false;
  }
  if (typeof output?.id === 'string' && output.id.startsWith('live-output:')) {
    return false;
  }

  return output?.source !== 'legacy' && (
    output?.source === 'formal' ||
    Boolean(output?.requestId) ||
    Boolean(output?.executionId)
  );
}

function isRetranslationExecution(execution) {
  if (execution?.operation === 'transcript_polishing') {
    return false;
  }
  const executionId = execution?.id || execution?.executionId || '';
  const requestId = execution?.requestId || execution?.translationRequestId || '';
  if (typeof executionId === 'string' && executionId.startsWith('legacy-execution:')) return false;
  if (typeof requestId === 'string' && requestId.startsWith('legacy-request:')) return false;
  return Boolean(executionId || execution?.requestId);
}

function addProgressKeys(keys, item) {
  if (item?.requestId) {
    keys.add(`request:${item.requestId}`);
  }

  const executionId = item?.executionId || item?.id;
  if (executionId) {
    keys.add(`execution:${executionId}`);
  }
}

function hasProgressKey(keys, item) {
  return Boolean(
    (item?.requestId && keys.has(`request:${item.requestId}`)) ||
    (item?.translationRequestId && keys.has(`request:${item.translationRequestId}`)) ||
    (item?.executionId && keys.has(`execution:${item.executionId}`)) ||
    (item?.id && keys.has(`execution:${item.id}`))
  );
}
