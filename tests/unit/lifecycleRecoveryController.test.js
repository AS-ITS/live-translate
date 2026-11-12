import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createLifecycleRecoveryController } from '../../src/lib/lifecycleRecoveryController.js';

const base = {
  ownerUserId: 'owner-a',
  meetingId: 'meeting-a',
  command: 'rollover',
  operationId: 'original-a',
  expectedLifecycleVersion: 1,
  sessionId: 'session-a',
  segmentId: 'segment-a',
  leaseId: 'lease-a',
  fenceToken: 1,
  leaseExpiresAt: '2030-01-01T00:00:00.000Z',
  payload: { nextLiveSessionId: 'live-next' }
};
const { operationId: unusedOperationId, ...baseIntent } = base;

function success(input) {
  return {
    meeting: { id: input.meetingId, lifecycle_version: input.expectedLifecycleVersion + 1 },
    session: { id: 'session-a' },
    segment: { id: 'segment-next' },
    lease: { leaseId: input.leaseId, fenceToken: input.fenceToken }
  };
}

test('lifecycle intent rejects content fields and keeps owner/meeting scope', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  assert.throws(() => store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId, status: 'prepared',
    payload: { checkpoint: { durableChunks: [] } }
  }), /allowed metadata/u);
  await store.saveLifecycleIntent({ ...baseIntent, originalOperationId: base.operationId, status: 'prepared' });
  assert.equal((await store.listPendingLifecycleIntents('owner-a', 'meeting-a')).length, 1);
  assert.equal((await store.listPendingLifecycleIntents('owner-b', 'meeting-a')).length, 0);
  assert.equal((await store.listPendingLifecycleIntents('owner-a', 'meeting-b')).length, 0);
});

test('lost response is resolved after reload without resubmitting committed operation', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const calls = [];
  const api = {
    async executeRecordingCommand(input) {
      calls.push(input);
      const error = new Error('response lost');
      throw error;
    },
    async lookupRecordingOperation() {
      return { status: 'committed', command: 'rollover', operationId: 'original-a',
        resultingLifecycleVersion: 2, sessionId: 'session-a', segmentId: 'segment-next',
        targetIdentityRecorded: true, targetSessionId: 'session-a',
        targetSegmentId: 'segment-a' };
    },
    async recoverRecordingLease() { throw new Error('lease recovery must not run'); }
  };
  await assert.rejects(createLifecycleRecoveryController({ store, api }).submit(base), /response lost/u);
  assert.equal((await store.listPendingLifecycleIntents('owner-a', 'meeting-a'))[0].status, 'unknown');
  const reloaded = createLifecycleRecoveryController({ store, api });
  const recovered = await reloaded.recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' });
  assert.equal(recovered.status, 'committed');
  assert.equal(calls.length, 1);
  assert.equal((await store.getLifecycleIntent('owner-a', 'meeting-a', 'original-a')).status, 'committed');
});

test('unknown, uncommitted operation reuses the same ID while lease is valid', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId, currentOperationId: base.operationId,
    status: 'unknown'
  });
  const calls = [];
  const api = {
    async lookupRecordingOperation() { return { status: 'unknown' }; },
    async executeRecordingCommand(input) { calls.push(input); return success(input); },
    async recoverRecordingLease() { throw new Error('unexpected lease recovery'); }
  };
  await createLifecycleRecoveryController({ store, api, now: () => Date.parse('2029-01-01') })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' });
  assert.deepEqual(calls.map((input) => input.operationId), ['original-a']);
});

test('committed Stop after response loss is adopted without a lease or second Stop', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: 'stop-original', currentOperationId: 'stop-original',
    command: 'stop', payload: {}, leaseExpiresAt: '2020-01-01T00:00:00.000Z', status: 'unknown'
  });
  const api = {
    async lookupRecordingOperation() {
      return { status: 'committed', command: 'stop', operationId: 'stop-original',
        resultingLifecycleVersion: 2, sessionId: 'session-a', segmentId: null,
        targetIdentityRecorded: true, targetSessionId: 'session-a',
        targetSegmentId: 'segment-a' };
    },
    async executeRecordingCommand() { throw new Error('duplicate Stop'); },
    async recoverRecordingLease() { throw new Error('completed Stop needs no lease'); }
  };
  const recovered = await createLifecycleRecoveryController({ store, api })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' });
  assert.equal(recovered.status, 'committed');
  assert.equal((await store.getLifecycleIntent('owner-a', 'meeting-a', 'stop-original')).status, 'committed');
});

test('expired lease creates one persisted attempt after authoritative recovery', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId, currentOperationId: base.operationId,
    leaseExpiresAt: '2020-01-01T00:00:00.000Z', status: 'unknown'
  });
  const calls = [];
  const api = {
    async lookupRecordingOperation() { return { status: 'unknown' }; },
    async recoverRecordingLease(input) {
      calls.push(['recover', input]);
      return { status: 'ready', attemptOperationId: 'attempt-a', leaseId: 'lease-b',
        fenceToken: 2, expiresAt: '2030-01-01T00:00:00.000Z' };
    },
    async executeRecordingCommand(input) {
      calls.push(['execute', input]);
      const saved = await store.getLifecycleIntent('owner-a', 'meeting-a', 'original-a');
      assert.equal(saved.status, 'submitted');
      assert.deepEqual(saved.attemptOperationIds, ['attempt-a']);
      return success(input);
    }
  };
  const result = await createLifecycleRecoveryController({
    store, api, idFactory: () => 'recovery-a', now: () => Date.parse('2029-01-01')
  }).recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' });
  assert.equal(result.status, 'committed');
  assert.deepEqual(calls.map(([kind]) => kind), ['recover', 'execute']);
  assert.equal(calls[1][1].operationId, 'attempt-a');
  assert.equal(calls[1][1].originalOperationId, 'original-a');
});

test('expired retention and revoked authorization stop automatic recovery', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId, currentOperationId: base.operationId,
    status: 'unknown'
  });
  const expiredApi = {
    async lookupRecordingOperation() { return { status: 'expired' }; },
    async executeRecordingCommand() { throw new Error('must not submit'); },
    async recoverRecordingLease() { throw new Error('must not recover lease'); }
  };
  assert.equal((await createLifecycleRecoveryController({ store, api: expiredApi })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' })).status, 'expired');
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId, currentOperationId: base.operationId,
    status: 'unknown'
  });
  const revokedApi = {
    async lookupRecordingOperation() {
      const error = new Error('revoked');
      error.code = 'auth_forbidden';
      throw error;
    },
    async executeRecordingCommand() { throw new Error('must not submit'); },
    async recoverRecordingLease() { throw new Error('must not recover lease'); }
  };
  await assert.rejects(createLifecycleRecoveryController({ store, api: revokedApi })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' }), /revoked/u);
});

test('committed lookup rejects another target Segment and keeps the pending intent', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId,
    currentOperationId: base.operationId, status: 'unknown'
  });
  const api = {
    async lookupRecordingOperation() {
      return { status: 'committed', command: 'rollover', operationId: base.operationId,
        resultingLifecycleVersion: 2, sessionId: 'session-a', segmentId: 'segment-next',
        targetIdentityRecorded: true, targetSessionId: 'session-a',
        targetSegmentId: 'segment-other' };
    },
    async executeRecordingCommand() { throw new Error('must not submit'); },
    async recoverRecordingLease() { throw new Error('must not recover lease'); }
  };
  await assert.rejects(createLifecycleRecoveryController({ store, api })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' }),
  (error) => error.code === 'meeting_lifecycle_conflict');
  const pending = await store.getLifecycleIntent('owner-a', 'meeting-a', base.operationId);
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.segmentId, 'segment-a');
});

test('completed Stop without original Segment metadata reports insufficient evidence', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: 'stop-insufficient',
    currentOperationId: 'stop-insufficient', command: 'stop', payload: {}, status: 'unknown'
  });
  const api = {
    async lookupRecordingOperation() {
      return { status: 'committed', command: 'stop', operationId: 'stop-insufficient',
        resultingLifecycleVersion: 2, sessionId: 'session-a', segmentId: null };
    },
    async executeRecordingCommand() { throw new Error('must not submit'); },
    async recoverRecordingLease() { throw new Error('must not recover lease'); }
  };
  await assert.rejects(createLifecycleRecoveryController({ store, api })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' }),
  (error) => error.code === 'lifecycle_result_evidence_insufficient');
  assert.equal((await store.getLifecycleIntent('owner-a', 'meeting-a', 'stop-insufficient')).status, 'unknown');
});

test('committed lookup rejects a different target Session and preserves pending status', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveLifecycleIntent({
    ...baseIntent, originalOperationId: base.operationId,
    currentOperationId: base.operationId, status: 'unknown'
  });
  const api = {
    async lookupRecordingOperation() {
      return { status: 'committed', command: 'rollover', operationId: base.operationId,
        resultingLifecycleVersion: 2, sessionId: 'session-a', segmentId: 'segment-next',
        targetIdentityRecorded: true, targetSessionId: 'session-other',
        targetSegmentId: 'segment-a' };
    },
    async executeRecordingCommand() { throw new Error('must not submit'); },
    async recoverRecordingLease() { throw new Error('must not recover lease'); }
  };
  await assert.rejects(createLifecycleRecoveryController({ store, api })
    .recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' }),
  (error) => error.code === 'meeting_lifecycle_conflict');
  assert.equal((await store.getLifecycleIntent('owner-a', 'meeting-a', base.operationId)).status, 'unknown');
});

test('commit racing with expired-lease recovery is adopted only after target lookup', async () => {
  for (const targetSegmentId of ['segment-a', 'segment-other']) {
    const store = createInMemoryLocalMeetingManifestStore();
    await store.saveLifecycleIntent({
      ...baseIntent, originalOperationId: base.operationId,
      currentOperationId: base.operationId,
      leaseExpiresAt: '2020-01-01T00:00:00.000Z', status: 'unknown'
    });
    let lookups = 0;
    const api = {
      async lookupRecordingOperation() {
        lookups += 1;
        if (lookups === 1) return { status: 'unknown' };
        return { status: 'committed', operationId: base.operationId, command: 'rollover',
          resultingLifecycleVersion: 2, targetIdentityRecorded: true,
          targetSessionId: 'session-a', targetSegmentId,
          sessionId: 'session-a', segmentId: 'segment-next' };
      },
      async recoverRecordingLease() {
        return { status: 'committed', operationId: base.operationId,
          command: 'rollover', resultingLifecycleVersion: 2,
          sessionId: 'session-a', segmentId: 'segment-next' };
      },
      async executeRecordingCommand() { throw new Error('must not resubmit'); }
    };
    const controller = createLifecycleRecoveryController({ store, api });
    if (targetSegmentId === 'segment-a') {
      assert.equal((await controller.recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' })).status,
        'committed');
    } else {
      await assert.rejects(controller.recover({ ownerUserId: 'owner-a', meetingId: 'meeting-a' }),
        (error) => error.code === 'meeting_lifecycle_conflict');
    }
    assert.equal(lookups, 2);
    assert.equal((await store.getLifecycleIntent('owner-a', 'meeting-a', base.operationId)).status,
      targetSegmentId === 'segment-a' ? 'committed' : 'unknown');
  }
});
