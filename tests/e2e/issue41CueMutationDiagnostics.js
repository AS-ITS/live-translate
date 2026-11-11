import { writeFileSync } from 'node:fs';

const classifications = new Set([
  'MUTATION_REJECTED', 'INDEXEDDB_TRANSACTION_FAILURE',
  'COMMIT_EXCEPTION', 'UNCLASSIFIED_ERROR'
]);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
  ? value : null;
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/u.test(value)
  ? value : null;
const stages = new Set(['enqueue', 'commit', 'queue_reject', 'queue_drain', 'provider_drain']);
const transactionStates = new Set(['active', 'error', 'aborted', 'complete', 'operation_rejected']);
const index = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
const versionNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
function safeBatch(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 20).map((item) => ({
    mutationIndex: index(item?.mutationIndex),
    operationId: safeId(item?.operationId),
    mutationOperation: identifier(item?.mutationOperation),
    resultStatus: identifier(item?.resultStatus),
    resultReason: identifier(item?.resultReason),
    incomingTranslationVersion: versionNumber(item?.incomingTranslationVersion),
    committedTranslationVersion: versionNumber(item?.committedTranslationVersion),
    incomingSourceVersion: versionNumber(item?.incomingSourceVersion),
    committedSourceVersion: versionNumber(item?.committedSourceVersion),
    incomingProviderSequence: versionNumber(item?.incomingProviderSequence),
    committedProviderSequence: versionNumber(item?.committedProviderSequence),
    incomingInputHash: safeId(item?.incomingInputHash),
    committedInputHash: safeId(item?.committedInputHash),
    ...(item?.inputFieldsMatch && typeof item.inputFieldsMatch === 'object' ? { inputFieldsMatch:
      Object.fromEntries(['rawSource', 'rawTranslation', 'initialTranslation',
        'translationVersion', 'translationProvenance'].map((field) =>
        [field, item.inputFieldsMatch[field] === true])) } : {})
  }));
}
function safeVersionState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries([
    'expectedSideVersion', 'currentRevision', 'incomingRevision',
    'currentSourceVersion', 'incomingSourceVersion',
    'currentTranslationVersion', 'incomingTranslationVersion',
    'currentRefinementVersion', 'incomingRefinementVersion',
    'currentProviderSequence', 'incomingProviderSequence',
    'currentSideSequence', 'incomingSideSequence',
    'currentSideConnectionEpoch', 'incomingSideConnectionEpoch',
    'currentSideProviderEpoch', 'incomingSideProviderEpoch',
    'currentTurnId', 'incomingTurnId'
  ].map((field) => [field, field.endsWith('TurnId')
    ? safeId(value[field]) : versionNumber(value[field])]));
}
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
        ...(Array.isArray(raw.batch) ? { batch: safeBatch(raw.batch) } : {}),
        operation: 'LOCAL_CUE_MUTATION_FLUSH',
        failureStage: stages.has(item.failureStage) ? item.failureStage : null,
        cueId: safeId(item.cueId),
        segmentId: safeId(item.segmentId),
        operationId: safeId(item.operationId),
        mutationOperation: identifier(item.mutationOperation),
        mutationCount: index(item.mutationCount),
        mutationIndex: index(item.mutationIndex),
        failureCount: index(item.failureCount),
        failureIndex: index(item.failureIndex),
        resultStatus: identifier(item.resultStatus),
        resultReason: identifier(item.resultReason),
        versionState: safeVersionState(item.versionState),
        errorName: identifier(item.errorName),
        errorCode: Number.isSafeInteger(item.errorCode) && item.errorCode >= 0 && item.errorCode <= 255
          ? item.errorCode : identifier(item.errorCode),
        stackSummary: Array.isArray(item.stackSummary)
          ? item.stackSummary.map(stackFrame).filter(Boolean).slice(0, 5) : [],
        rootErrorName: identifier(item.rootErrorName),
        rootErrorCode: Number.isSafeInteger(item.rootErrorCode) && item.rootErrorCode >= 0 && item.rootErrorCode <= 255
          ? item.rootErrorCode : identifier(item.rootErrorCode),
        rootStackSummary: Array.isArray(item.rootStackSummary)
          ? item.rootStackSummary.map(stackFrame).filter(Boolean).slice(0, 5) : [],
        transactionState: transactionStates.has(item.transactionState) ? item.transactionState : null,
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
