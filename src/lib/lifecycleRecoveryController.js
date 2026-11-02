import { projectLifecycleOperationIntent } from './lifecycleOperationIntent.js';

function operationId() {
  return globalThis.crypto?.randomUUID?.() || `lifecycle-${Date.now()}-${Math.random()}`;
}

function outcomeMayBeUnknown(error) {
  const status = Number(error?.status);
  return error?.outcomeUnknown === true || error?.code === 'recorder_lease_invalid'
    || error?.code === 'supabase_unavailable' || error?.code === 'request_timeout'
    || !Number.isFinite(status) || status === 0
    || [408, 425, 429].includes(status) || status >= 500;
}

export function createLifecycleRecoveryController({ store, api, idFactory = operationId, now = () => Date.now() } = {}) {
  if (!store?.saveLifecycleIntent || !store?.listPendingLifecycleIntents
    || !api?.executeRecordingCommand || !api?.lookupRecordingOperation || !api?.recoverRecordingLease) {
    throw new TypeError('Lifecycle recovery requires local intent storage and lifecycle API.');
  }

  async function save(intent, changes) {
    return store.saveLifecycleIntent(projectLifecycleOperationIntent({
      ...intent, ...changes, updatedAt: new Date(now()).toISOString()
    }));
  }

  async function execute(intent) {
    const isAttempt = intent.currentOperationId !== intent.originalOperationId;
    const payload = isAttempt
      ? { ...intent.payload, originalOperationId: intent.originalOperationId,
        recoveryOperationId: intent.recoveryOperationId }
      : intent.payload;
    const submitted = await save(intent, { status: 'submitted' });
    try {
      const result = await api.executeRecordingCommand({
        meetingId: submitted.meetingId,
        command: submitted.command,
        operationId: submitted.currentOperationId,
        expectedLifecycleVersion: submitted.expectedLifecycleVersion,
        ...(submitted.leaseId ? { leaseId: submitted.leaseId, fenceToken: submitted.fenceToken } : {}),
        ...payload
      });
      await save(submitted, { status: 'committed' });
      return { status: 'committed', result };
    } catch (error) {
      await save(submitted, {
        status: outcomeMayBeUnknown(error) ? 'unknown' : 'rejected'
      });
      throw error;
    }
  }

  function assertCommittedResult(intent, found, operationId) {
    if (found.status !== 'committed'
      || found.targetIdentityRecorded !== true
      || !Object.hasOwn(found, 'targetSessionId')
      || !Object.hasOwn(found, 'targetSegmentId')
      || !Object.hasOwn(found, 'segmentId')) {
      const error = new Error('Lifecycle result lacks the original or resulting identity.');
      error.code = 'lifecycle_result_evidence_insufficient';
      throw error;
    }
    const createsSegment = ['start', 'resume', 'rollover', 'recover'].includes(intent.command);
    if (found.operationId !== operationId || found.command !== intent.command
      || found.resultingLifecycleVersion !== intent.expectedLifecycleVersion + 1
      || (found.meetingId && found.meetingId !== intent.meetingId)
      || (found.ownerUserId && found.ownerUserId !== intent.ownerUserId)
      || found.targetSessionId !== intent.sessionId
      || found.targetSegmentId !== intent.segmentId
      || !found.sessionId
      || (intent.sessionId && found.sessionId !== intent.sessionId)
      || (createsSegment && (!found.segmentId || found.segmentId === intent.segmentId))
      || (!createsSegment && found.segmentId !== null)) {
      const error = new Error('Lifecycle result does not match persisted intent.');
      error.code = 'meeting_lifecycle_conflict';
      throw error;
    }
  }

  async function verifyRecoveredCommit(intent, recovery) {
    const found = await api.lookupRecordingOperation({
      meetingId: intent.meetingId, operationId: recovery.operationId
    });
    assertCommittedResult(intent, found, recovery.operationId);
    await save(intent, { status: 'committed' });
    return { status: 'committed', result: { ...found, ...recovery } };
  }

  return Object.freeze({
    async submit(input) {
      const { operationId: requestedOperationId, ...metadata } = input;
      const intent = projectLifecycleOperationIntent({
        ...metadata,
        originalOperationId: requestedOperationId,
        currentOperationId: requestedOperationId,
        status: 'prepared'
      });
      const pending = await store.listPendingLifecycleIntents(intent.ownerUserId, intent.meetingId);
      if (pending.length > 0) {
        const error = new Error('Pending lifecycle operation must be recovered first.');
        error.code = 'meeting_lifecycle_conflict';
        throw error;
      }
      const prepared = await store.saveLifecycleIntent(intent);
      return execute(prepared);
    },

    async recover({ ownerUserId, meetingId, intent: suppliedIntent } = {}) {
      const intent = suppliedIntent || (await store.listPendingLifecycleIntents(ownerUserId, meetingId))[0];
      if (!intent) return null;
      if (intent.ownerUserId !== ownerUserId || intent.meetingId !== meetingId) {
        const error = new Error('Lifecycle intent does not match the requested owner and meeting.');
        error.code = 'meeting_lifecycle_conflict';
        throw error;
      }
      const operationIds = [intent.originalOperationId, ...intent.attemptOperationIds];
      for (const candidateId of operationIds) {
        const found = await api.lookupRecordingOperation({ meetingId: intent.meetingId, operationId: candidateId });
        if (found.status === 'expired') {
          await save(intent, { status: 'expired' });
          return { status: 'expired' };
        }
        if (found.status === 'committed') {
        assertCommittedResult(intent, found, candidateId);
        let result = found;
          if (intent.command !== 'stop' && found.sessionId && (!intent.leaseId || !intent.leaseExpiresAt
            || Date.parse(intent.leaseExpiresAt) <= now())) {
            const leaseResult = await api.recoverRecordingLease({
              meetingId: intent.meetingId,
              originalOperationId: intent.originalOperationId,
              recoveryOperationId: intent.recoveryOperationId || idFactory(),
              command: intent.command,
              expectedLifecycleVersion: found.resultingLifecycleVersion,
              sessionId: found.sessionId,
              segmentId: found.segmentId,
              priorLeaseId: intent.leaseId,
              priorFenceToken: intent.fenceToken
            });
            result = { ...found, ...leaseResult };
          }
          await save(intent, { status: 'committed' });
          return { status: 'committed', result };
        }
        if (found.status !== 'unknown') throw new Error('Unexpected lifecycle lookup result.');
      }

      // A same-ID retry is safe while the original fence is still valid.
      if (!intent.sessionId || !intent.leaseId || !intent.leaseExpiresAt
        || Date.parse(intent.leaseExpiresAt) > now()) {
        try {
          return await execute(intent);
        } catch (error) {
          if (error?.outcomeUnknown || error?.code !== 'recorder_lease_invalid') throw error;
        }
      }
      if (!intent.sessionId) {
        const error = new Error('Start outcome cannot be recovered without an authoritative session.');
        error.code = 'meeting_lifecycle_conflict';
        throw error;
      }

      const recoveryOperationId = intent.recoveryOperationId || idFactory();
      let recovering = await save(intent, { status: 'unknown', recoveryOperationId });
      let recovery = await api.recoverRecordingLease({
        meetingId: recovering.meetingId,
        originalOperationId: recovering.originalOperationId,
        recoveryOperationId,
        command: recovering.command,
        expectedLifecycleVersion: recovering.expectedLifecycleVersion,
        sessionId: recovering.sessionId,
        segmentId: recovering.segmentId,
        priorLeaseId: recovering.leaseId,
        priorFenceToken: recovering.fenceToken
      });
      if (recovery.status === 'committed') {
      return verifyRecoveredCommit(recovering, recovery);
      }
      if (recovery.status === 'ready' && Date.parse(recovery.expiresAt) <= now()) {
        const nextRecoveryOperationId = idFactory();
        recovering = await save(recovering, {
          status: 'unknown', recoveryOperationId: nextRecoveryOperationId,
          leaseId: recovery.leaseId, fenceToken: recovery.fenceToken,
          leaseExpiresAt: recovery.expiresAt
        });
        recovery = await api.recoverRecordingLease({
          meetingId: recovering.meetingId,
          originalOperationId: recovering.originalOperationId,
          recoveryOperationId: nextRecoveryOperationId,
          command: recovering.command,
          expectedLifecycleVersion: recovering.expectedLifecycleVersion,
          sessionId: recovering.sessionId,
          segmentId: recovering.segmentId,
          priorLeaseId: recovering.leaseId,
          priorFenceToken: recovering.fenceToken
        });
        if (recovery.status === 'committed') {
        return verifyRecoveredCommit(recovering, recovery);
        }
      }
      if (recovery.status !== 'ready') throw new Error('Unexpected lease recovery result.');
      if (Date.parse(recovery.expiresAt) <= now()) throw new Error('Recovered lease has already expired.');
      recovering = await save(recovering, {
        status: 'prepared',
        currentOperationId: recovery.attemptOperationId,
        attemptOperationIds: [...new Set([...recovering.attemptOperationIds, recovery.attemptOperationId])],
        leaseId: recovery.leaseId,
        fenceToken: recovery.fenceToken,
        leaseExpiresAt: recovery.expiresAt
      });
      return execute(recovering);
    }
  });
}
