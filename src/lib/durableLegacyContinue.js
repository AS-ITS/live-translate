import {
  createLegacyContinueOperation,
  createLegacyContinuePayload,
  createLegacyContinuePayloadHash
} from './legacyContinueOperation.js';

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
  now = () => new Date().toISOString()
} = {}) {
  if (!persistence?.saveContinueOperation || !persistence?.getPendingContinueOperation) {
    throw new TypeError('Durable continue operation persistence is required.');
  }
  if (!api?.resumeLegacySegment || !api?.getLegacyResumeOperation) {
    throw new TypeError('Legacy resume API is required.');
  }

  let operation = await persistence.getPendingContinueOperation(meetingId);
  if (operation && operation.sourceSegmentId !== sourceSegmentId && operation.state !== 'committed') {
    const error = new Error('Pending continue source segment changed.');
    error.code = 'meeting_segment_invalid_state';
    error.status = 409;
    throw error;
  }
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

  const reconcile = async () => {
    try {
      const result = await api.getLegacyResumeOperation(operation);
      assertCommittedResult(operation, result);
      return result;
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  };

  let result = await reconcile();
  if (!result) {
    operation = await persistence.saveContinueOperation({
      ...operation,
      attempt: operation.attempt + 1,
      state: 'executing',
      updatedAt: now()
    });
    try {
      result = await api.resumeLegacySegment(operation);
      assertCommittedResult(operation, result);
    } catch (error) {
      if (error?.status === 403 || error?.status === 410) throw error;
      if (error?.status === 409 || !error?.status || error.status >= 500) result = await reconcile();
      if (!result) throw error;
    }
  }

  operation = await persistence.saveContinueOperation({
    ...operation,
    state: 'committed',
    committedSuccessor: result,
    updatedAt: now()
  });
  return { operation, result, replayed: Boolean(result.replayed) };
}

function assertCommittedResult(operation, result) {
  if (!result) return;
  if (result.operation?.payloadHash !== operation.payloadHash
    || result.operation?.sourceSegmentId !== operation.sourceSegmentId) {
    const error = new Error('Committed legacy Continue result does not match the durable operation.');
    error.code = 'meeting_lifecycle_conflict';
    error.status = 409;
    throw error;
  }
}

export function completeDurableLegacyContinue(persistence, operation, now = () => new Date().toISOString()) {
  return persistence.saveContinueOperation({ ...operation, state: 'complete', updatedAt: now() });
}
