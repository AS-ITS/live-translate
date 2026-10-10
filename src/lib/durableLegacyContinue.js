import {
  createLegacyContinueOperation,
  createLegacyContinuePayload,
  createLegacyContinuePayloadHash
} from './legacyContinueOperation.js';

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

export async function establishDurableLegacyContinue({
  persistence,
  api,
  meetingId,
  sourceSegmentId,
  expectedSessionId,
  checkpoint,
  operationIdFactory = () => globalThis.crypto.randomUUID(),
  liveSessionIdFactory,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString(),
  wait = defaultWait,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  shouldContinue = () => true
} = {}) {
  if (!persistence?.saveContinueOperation || !persistence?.getPendingContinueOperation) {
    throw new TypeError('Durable continue operation persistence is required.');
  }
  if (!api?.resumeLegacySegment || !api?.getLegacyResumeOperation) {
    throw new TypeError('Legacy resume API is required.');
  }
  if (typeof wait !== 'function') throw new TypeError('wait is required.');

  const delays = normalizeRetryDelays(retryDelaysMs);
  let operation = await persistence.getPendingContinueOperation(meetingId);
  if (!operation) {
    const payload = createLegacyContinuePayload({
      meetingId,
      sourceSegmentId,
      nextLiveSessionId: liveSessionIdFactory(),
      expectedSessionId,
      checkpoint
    });
    operation = createLegacyContinueOperation({
      ...payload,
      operationId: operationIdFactory(),
      payloadHash: await createLegacyContinuePayloadHash(payload, cryptoImpl),
      timestamp: now()
    });
    operation = await persistence.saveContinueOperation(operation);
  }

  if (operation.state === 'committed' && operation.committedSuccessor) {
    return { operation, result: operation.committedSuccessor, replayed: true };
  }

  // A reload may discover the committed successor before IndexedDB records the ACK.
  // Reconcile the immutable operation before comparing it with the current open Segment.
  let result = await reconcileAfterRecoverableFailure(api, operation);
  if (result) return persistCommittedResult(persistence, operation, result, now);
  if (operation.sourceSegmentId !== sourceSegmentId) {
    throw continueError('meeting_segment_invalid_state', 409, 'Pending Continue source Segment changed without a committed result.');
  }

  let lastError = null;
  for (let attemptIndex = 0; attemptIndex <= delays.length; attemptIndex += 1) {
    assertContinueRequested(shouldContinue);
    if (attemptIndex > 0) {
      result = await reconcileAfterRecoverableFailure(api, operation);
      if (result) return persistCommittedResult(persistence, operation, result, now);
      let sourceActive;
      try {
        sourceActive = await confirmSourceStillActive(api, operation);
      } catch (error) {
        if (!isRecoverableLegacyContinueError(error) || attemptIndex === delays.length) throw error;
        await wait(delays[attemptIndex - 1]);
        continue;
      }
      if (!sourceActive) {
        throw continueError('meeting_lifecycle_conflict', 409, 'Authoritative source Segment cannot safely accept the Continue retry.');
      }
      await wait(delays[attemptIndex - 1]);
      assertContinueRequested(shouldContinue);
    }

    operation = await persistence.saveContinueOperation({
      ...operation,
      attempt: operation.attempt + 1,
      state: 'executing',
      updatedAt: now()
    });
    try {
      result = await api.resumeLegacySegment(operation);
      assertCommittedResult(operation, result);
      return persistCommittedResult(persistence, operation, result, now);
    } catch (error) {
      lastError = error;
      if (!isRecoverableLegacyContinueError(error)) throw error;

      result = await reconcileAfterRecoverableFailure(api, operation);
      if (result) return persistCommittedResult(persistence, operation, result, now);

      // A conflict without a stored result may belong to another lifecycle command.
      if (error?.status === 409) throw error;
      if (attemptIndex === delays.length) throw error;
    }
  }

  throw lastError;
}

export function isRecoverableLegacyContinueError(error) {
  if (error?.outcomeUnknown || error?.code === 'request_timeout') return true;
  if (!Number.isInteger(error?.status)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

async function reconcileCommittedOperation(api, operation) {
  try {
    const result = await api.getLegacyResumeOperation(operation);
    assertCommittedResult(operation, result);
    return result;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function reconcileAfterRecoverableFailure(api, operation) {
  try {
    return await reconcileCommittedOperation(api, operation);
  } catch (error) {
    if (isRecoverableLegacyContinueError(error)) return null;
    throw error;
  }
}

async function confirmSourceStillActive(api, operation) {
  if (typeof api.listSegments !== 'function') {
    throw continueError('meeting_lifecycle_conflict', 409, 'Authoritative Segment reconciliation is unavailable.');
  }
  const result = await api.listSegments({ meetingId: operation.meetingId });
  const source = result?.segments?.find((segment) => segment.id === operation.sourceSegmentId);
  if (!source || source.status !== 'active') return false;
  if (operation.expectedSessionId && source.sessionId && source.sessionId !== operation.expectedSessionId) return false;
  return true;
}

async function persistCommittedResult(persistence, operation, result, now) {
  const committed = await persistence.saveContinueOperation({
    ...operation,
    state: 'committed',
    committedSuccessor: result,
    updatedAt: now()
  });
  return { operation: committed, result, replayed: Boolean(result.replayed) };
}

function assertCommittedResult(operation, result) {
  if (!result) return;
  if (result.operation?.payloadHash !== operation.payloadHash
    || result.operation?.sourceSegmentId !== operation.sourceSegmentId) {
    throw continueError('meeting_lifecycle_conflict', 409, 'Committed legacy Continue result does not match the durable operation.');
  }
}

function assertContinueRequested(shouldContinue) {
  if (shouldContinue()) return;
  throw continueError('continue_cancelled', 409, 'Continue was cancelled.');
}

function normalizeRetryDelays(value) {
  if (!Array.isArray(value)) return DEFAULT_RETRY_DELAYS_MS;
  return Object.freeze(value.map((delay) => {
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('retry delays must be non-negative numbers.');
    return Math.floor(delay);
  }));
}

function continueError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function defaultWait(delayMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

export function completeDurableLegacyContinue(persistence, operation, now = () => new Date().toISOString()) {
  return persistence.saveContinueOperation({ ...operation, state: 'complete', updatedAt: now() });
}
