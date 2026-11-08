const OPERATIONS = new Set(['pending', 'initial', 'source', 'translation', 'refinement']);
const INDEXED_DB_ERRORS = new Set([
  'AbortError', 'ConstraintError', 'DataCloneError', 'DataError', 'InvalidAccessError',
  'InvalidStateError', 'NotFoundError', 'QuotaExceededError', 'ReadOnlyError',
  'TransactionInactiveError', 'UnknownError'
]);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'DOMException', ...INDEXED_DB_ERRORS]);
const CUE_CONFLICT_REASONS = new Set([
  'same_revision_payload_mismatch', 'incoming_revision_missing', 'versioned_state_regression',
  'legacy_reason_unverified', 'payload_conflict'
]);

const identifier = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
  ? value : null;
const reason = (value) => typeof value === 'string'
  && (CUE_CONFLICT_REASONS.has(value) || /^(?:cue|subtitle_cue)_[a-z0-9_]{1,55}$/u.test(value))
  ? value : null;
const errorCode = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 255
  ? value : typeof value === 'string'
    && /^(?:(?:cue|subtitle_cue|local)_[a-z0-9_]{1,55}|(?:IDB|INDEXEDDB|INTEGRITY|LOCAL)_[A-Z0-9_]{1,55})$/u.test(value)
    ? value : null;
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function applicationStackSummary(stack) {
  if (typeof stack !== 'string') return [];
  return stack.split('\n').filter((line) => /^\s*at\s+/u.test(line)).flatMap((line) => {
    const match = line.match(/\bsrc\/([A-Za-z0-9_./-]+\.(?:js|jsx|ts|tsx))(?:\?[^\s):]*)?:(\d+):(\d+)/u);
    return match && !match[1].split('/').includes('..')
      ? [`src/${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 5);
}

export function describeCueMutationFailures(failures) {
  return failures.map(({ job, result, error, mutationCount, mutationIndex }, failureIndex) => {
    const errorName = ERROR_NAMES.has(error?.name) ? error.name : null;
    const stackSummary = applicationStackSummary(error?.stack);
    return {
      operation: 'LOCAL_CUE_MUTATION_FLUSH',
      mutationOperation: OPERATIONS.has(job?.side) ? job.side : 'unknown',
      mutationCount: nonNegativeInteger(mutationCount),
      mutationIndex: nonNegativeInteger(mutationIndex),
      failureCount: failures.length,
      failureIndex,
      resultStatus: identifier(result?.status),
      resultReason: reason(result?.reason),
      errorName,
      errorCode: errorCode(error?.code),
      stackSummary,
      classification: result?.status === 'rejected' ? 'MUTATION_REJECTED'
        : error && (INDEXED_DB_ERRORS.has(errorName)
          || /\brunNamedTransaction\b/u.test(error?.stack || '')
          || ['IndexedDB transaction failed.', 'IndexedDB transaction aborted.'].includes(error?.message))
          ? 'INDEXEDDB_TRANSACTION_FAILURE'
          : error && OPERATIONS.has(job?.side) ? 'COMMIT_EXCEPTION' : 'UNCLASSIFIED_ERROR'
    };
  });
}
