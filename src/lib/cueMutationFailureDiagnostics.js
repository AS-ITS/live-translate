import { localTransactionFailureState } from './localMeetingStorage.js';

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
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/u.test(value)
  ? value : null;
const STAGES = new Set(['enqueue', 'commit', 'queue_reject', 'queue_drain', 'provider_drain']);

export function describeCueMutationBatch(results = []) {
  return results.slice(0, 20).map(({ job, result, error }, mutationIndex) => ({
    mutationIndex,
    operationId: safeId(job?.eventKey),
    mutationOperation: OPERATIONS.has(job?.side) ? job.side : 'unknown',
    resultStatus: error ? 'error' : identifier(result?.status),
    resultReason: reason(result?.reason),
    incomingTranslationVersion: nonNegativeInteger(job?.cue?.translationVersion),
    committedTranslationVersion: nonNegativeInteger(result?.cue?.translationVersion),
    incomingSourceVersion: nonNegativeInteger(job?.cue?.sourceVersion),
    committedSourceVersion: nonNegativeInteger(result?.cue?.sourceVersion),
    incomingProviderSequence: nonNegativeInteger(job?.cue?.translationProvenance?.eventSequence),
    committedProviderSequence: nonNegativeInteger(result?.cue?.translationProvenance?.eventSequence),
    incomingInputHash: safeId(job?.cue?.refinement?.inputHash),
    committedInputHash: safeId(result?.cue?.refinement?.inputHash),
    ...(result?.cue ? { inputFieldsMatch: {
      rawSource: job?.cue?.rawSource === result.cue.rawSource,
      rawTranslation: job?.cue?.rawTranslation === result.cue.rawTranslation,
      initialTranslation: job?.cue?.initialTranslation === result.cue.initialTranslation,
      translationVersion: job?.cue?.translationVersion === result.cue.translationVersion,
      translationProvenance: JSON.stringify(job?.cue?.translationProvenance ?? null)
        === JSON.stringify(result.cue.translationProvenance ?? null)
    } } : {})
  }));
}

function applicationStackSummary(stack) {
  if (typeof stack !== 'string') return [];
  return stack.split('\n').filter((line) => /^\s*at\s+/u.test(line)).flatMap((line) => {
    const match = line.match(/\bsrc\/([A-Za-z0-9_./-]+\.(?:js|jsx|ts|tsx))(?:\?[^\s):]*)?:(\d+):(\d+)/u);
    return match && !match[1].split('/').includes('..')
      ? [`src/${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 5);
}

export function describeCueMutationFailures(failures) {
  return failures.map(({ job, result, error, mutationCount, mutationIndex, stage }, failureIndex) => {
    const errorName = ERROR_NAMES.has(error?.name) ? error.name : null;
    const stackSummary = applicationStackSummary(error?.stack);
    let rootError = error;
    for (let depth = 0; depth < 4 && rootError?.cause instanceof Error; depth += 1) rootError = rootError.cause;
    return {
      operation: 'LOCAL_CUE_MUTATION_FLUSH',
      failureStage: STAGES.has(stage) ? stage : null,
      cueId: safeId(job?.cue?.cueId),
      segmentId: safeId(job?.segmentId),
      operationId: safeId(job?.eventKey),
      mutationOperation: OPERATIONS.has(job?.side) ? job.side : 'unknown',
      mutationCount: nonNegativeInteger(mutationCount),
      mutationIndex: nonNegativeInteger(mutationIndex),
      failureCount: failures.length,
      failureIndex,
      resultStatus: identifier(result?.status),
      resultReason: reason(result?.reason),
      versionState: ['versioned_state_regression', 'cue_translation_event_unproven',
        'cue_source_event_unproven'].includes(result?.reason) ? {
        expectedSideVersion: nonNegativeInteger(result.versionState?.expectedSideVersion),
        currentRevision: nonNegativeInteger(result.versionState?.currentRevision),
        incomingRevision: nonNegativeInteger(result.versionState?.incomingRevision),
        currentSourceVersion: nonNegativeInteger(result.versionState?.currentSourceVersion),
        incomingSourceVersion: nonNegativeInteger(result.versionState?.incomingSourceVersion),
        currentTranslationVersion: nonNegativeInteger(result.versionState?.currentTranslationVersion),
        incomingTranslationVersion: nonNegativeInteger(result.versionState?.incomingTranslationVersion),
        currentRefinementVersion: nonNegativeInteger(result.versionState?.currentRefinementVersion),
        incomingRefinementVersion: nonNegativeInteger(result.versionState?.incomingRefinementVersion),
        currentProviderSequence: nonNegativeInteger(result.versionState?.currentProviderSequence),
        incomingProviderSequence: nonNegativeInteger(result.versionState?.incomingProviderSequence),
        currentSideSequence: nonNegativeInteger(result.versionState?.currentSideSequence),
        incomingSideSequence: nonNegativeInteger(result.versionState?.incomingSideSequence),
        currentSideConnectionEpoch: nonNegativeInteger(result.versionState?.currentSideConnectionEpoch),
        incomingSideConnectionEpoch: nonNegativeInteger(result.versionState?.incomingSideConnectionEpoch),
        currentSideProviderEpoch: nonNegativeInteger(result.versionState?.currentSideProviderEpoch),
        incomingSideProviderEpoch: nonNegativeInteger(result.versionState?.incomingSideProviderEpoch),
        currentTurnId: safeId(result.versionState?.currentTurnId),
        incomingTurnId: safeId(result.versionState?.incomingTurnId)
      } : null,
      errorName,
      errorCode: errorCode(error?.code),
      stackSummary,
      rootErrorName: ERROR_NAMES.has(rootError?.name) ? rootError.name : null,
      rootErrorCode: errorCode(rootError?.code),
      rootStackSummary: applicationStackSummary(rootError?.stack),
      transactionState: localTransactionFailureState(error) || localTransactionFailureState(rootError),
      classification: result?.status === 'rejected' ? 'MUTATION_REJECTED'
        : error && (INDEXED_DB_ERRORS.has(errorName)
          || /\brunNamedTransaction\b/u.test(error?.stack || '')
          || ['IndexedDB transaction failed.', 'IndexedDB transaction aborted.'].includes(error?.message))
          ? 'INDEXEDDB_TRANSACTION_FAILURE'
          : error && OPERATIONS.has(job?.side) ? 'COMMIT_EXCEPTION' : 'UNCLASSIFIED_ERROR'
    };
  });
}
