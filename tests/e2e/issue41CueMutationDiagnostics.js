import { writeFileSync } from 'node:fs';

const classifications = new Set([
  'MUTATION_REJECTED', 'INDEXEDDB_TRANSACTION_FAILURE',
  'COMMIT_EXCEPTION', 'UNCLASSIFIED_ERROR'
]);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
  ? value : null;
const index = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
const stackFrame = (value) => typeof value === 'string'
  && /^src\/[A-Za-z0-9_./-]+\.(?:js|jsx|ts|tsx):\d+:\d+$/u.test(value)
  && !value.split('/').includes('..') ? value : null;

export function createCueMutationDiagnostics() { return []; }

export function captureCueMutationConsole(message, diagnostics) {
  const text = message.text();
  if (!text.startsWith('ISSUE41_CUE_MUTATION ')) return;
  try {
    const raw = JSON.parse(text.slice('ISSUE41_CUE_MUTATION '.length));
    if (!Array.isArray(raw.failures)) return;
    for (const item of raw.failures.slice(0, 100)) {
      if (item?.operation !== 'LOCAL_CUE_MUTATION_FLUSH') continue;
      diagnostics.push({
        operation: 'LOCAL_CUE_MUTATION_FLUSH',
        mutationOperation: identifier(item.mutationOperation),
        mutationCount: index(item.mutationCount),
        mutationIndex: index(item.mutationIndex),
        failureCount: index(item.failureCount),
        failureIndex: index(item.failureIndex),
        resultStatus: identifier(item.resultStatus),
        resultReason: identifier(item.resultReason),
        errorName: identifier(item.errorName),
        errorCode: Number.isSafeInteger(item.errorCode) && item.errorCode >= 0 && item.errorCode <= 255
          ? item.errorCode : identifier(item.errorCode),
        stackSummary: Array.isArray(item.stackSummary)
          ? item.stackSummary.map(stackFrame).filter(Boolean).slice(0, 5) : [],
        classification: classifications.has(item.classification) ? item.classification : 'UNCLASSIFIED_ERROR'
      });
    }
  } catch { /* Diagnostics must not affect the test workflow. */ }
}

export function attachCueMutationDiagnostics(page, diagnostics) {
  page.on('console', (message) => captureCueMutationConsole(message, diagnostics));
}

export function writeCueMutationArtifact(path, diagnostics, testStatus) {
  const artifact = {
    failures: diagnostics,
    testStatus: ['passed', 'failed', 'timedOut', 'interrupted'].includes(testStatus) ? testStatus : 'unknown'
  };
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
