import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createLocalMeetingRecorder } from '../../src/lib/localMeetingRecorder.js';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';

const receipt = (operationId, captureEpoch = 2) => ({
  recordingId: 'recording-1', transitionOperationId: operationId, captureEpoch,
  endSample: 1600, offset: 42, sha256: 'a'.repeat(64)
});

function recorder(store) {
  return createLocalMeetingRecorder({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() } });
}

async function started(store = createInMemoryLocalMeetingManifestStore()) {
  const local = recorder(store);
  await local.start('meeting-1', { operationId: 'start-1', recordingId: 'recording-1',
    segmentId: 'segment-1', pcmEnabled: true });
  return { store, local };
}

test('one Segment owns multiple Journal epochs and rollover atomically ends its predecessor', async () => {
  const { store, local } = await started();
  const prepared = await local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  assert.equal(prepared.phase, 'PREPARED');
  assert.equal((await store.getRecording('meeting-1')).segmentId, 'segment-1');
  const result = await local.rolloverLocalSegment({ operationId: 'rollover-1',
    nextSegmentId: 'segment-2', boundaryReceipt: receipt('rollover-1') });
  const segments = store.listSegments('meeting-1');
  assert.deepEqual(segments.map(({ segmentId, status, firstJournalEpoch, lastJournalEpoch }) =>
    ({ segmentId, status, firstJournalEpoch, lastJournalEpoch })), [
    { segmentId: 'segment-1', status: 'ENDED', firstJournalEpoch: 1, lastJournalEpoch: 2 },
    { segmentId: 'segment-2', status: 'ACTIVE', firstJournalEpoch: 3, lastJournalEpoch: null }
  ]);
  assert.equal(result.segmentId, 'segment-2');
  assert.equal((await store.getRecording('meeting-1')).segmentId, 'segment-2');
  assert.equal(store.getSegmentTransition('meeting-1', 'rollover-1').phase, 'COMMITTED');
  const afterReload = recorder(store);
  assert.equal((await afterReload.restore('meeting-1')).segmentId, 'segment-2');
  assert.deepEqual(await afterReload.rolloverLocalSegment({ operationId: 'rollover-1',
    nextSegmentId: 'segment-2', boundaryReceipt: receipt('rollover-1') }), result);
  assert.equal(store.listSegments('meeting-1').filter((segment) => segment.status === 'ACTIVE').length, 1);
});

test('Continue then rollover keeps the committed Journal epoch for final Pause', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: 'pause-1', boundaryReceipt: receipt('pause-1', 1) });
  await local.preparePausedContinue({ operationId: 'continue-1', nextSegmentId: 'segment-2',
    boundaryOperationId: 'pause-1' });
  const continued = await local.rolloverLocalSegment({ operationId: 'continue-1',
    nextSegmentId: 'segment-2', boundaryReceipt: receipt('pause-1', 1) });
  assert.equal(continued.captureEpoch, 2);

  await local.prepareSegmentRollover({ operationId: 'rollover-2', nextSegmentId: 'segment-3' });
  const rolled = await local.rolloverLocalSegment({ operationId: 'rollover-2',
    nextSegmentId: 'segment-3', boundaryReceipt: receipt('rollover-2', 2) });
  assert.equal(rolled.captureEpoch, 3);
  assert.equal(local.snapshot().captureEpoch, 3);
  assert.equal((await store.getRecording('meeting-1')).captureEpoch, 3);

  const paused = await local.pause({ operationId: 'pause-3', boundaryReceipt: receipt('pause-3', 3) });
  assert.equal(paused.state, 'paused');
  assert.equal((await store.getRecording('meeting-1')).pauseBoundary.captureEpoch, 3);
  assert.equal((await store.getRecording('meeting-1')).captureEpoch, 4);
  assert.deepEqual(store.listSegments('meeting-1').map(({ segmentId, status, firstJournalEpoch, lastJournalEpoch }) =>
    ({ segmentId, status, firstJournalEpoch, lastJournalEpoch })), [
    { segmentId: 'segment-1', status: 'ENDED', firstJournalEpoch: 1, lastJournalEpoch: 1 },
    { segmentId: 'segment-2', status: 'ENDED', firstJournalEpoch: 2, lastJournalEpoch: 2 },
    { segmentId: 'segment-3', status: 'ACTIVE', firstJournalEpoch: 3, lastJournalEpoch: null }
  ]);
});

test('failed manifest commit cannot advance recorder epoch or report rollover success', async () => {
  const base = createInMemoryLocalMeetingManifestStore();
  const store = { ...base, commitSegmentTransition(input) {
    if (input.operationId === 'rollover-2') throw new Error('IDB_TRANSACTION_ABORTED');
    return base.commitSegmentTransition(input);
  } };
  const events = [];
  const local = createLocalMeetingRecorder({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() },
    onTrace: (event) => events.push(event) });
  await local.start('meeting-1', { operationId: 'start-1', recordingId: 'recording-1',
    segmentId: 'segment-1', pcmEnabled: true });
  await local.pause({ operationId: 'pause-1', boundaryReceipt: receipt('pause-1', 1) });
  await local.preparePausedContinue({ operationId: 'continue-1', nextSegmentId: 'segment-2',
    boundaryOperationId: 'pause-1' });
  await local.rolloverLocalSegment({ operationId: 'continue-1',
    nextSegmentId: 'segment-2', boundaryReceipt: receipt('pause-1', 1) });
  await local.prepareSegmentRollover({ operationId: 'rollover-2', nextSegmentId: 'segment-3' });

  await assert.rejects(local.rolloverLocalSegment({ operationId: 'rollover-2',
    nextSegmentId: 'segment-3', boundaryReceipt: receipt('rollover-2', 2) }), /IDB_TRANSACTION_ABORTED/u);
  assert.equal(local.snapshot().segmentId, 'segment-2');
  assert.equal(local.snapshot().captureEpoch, 2);
  assert.equal((await store.getRecording('meeting-1')).segmentId, 'segment-2');
  assert.equal((await store.getRecording('meeting-1')).captureEpoch, 2);
  assert.equal(store.getSegmentTransition('meeting-1', 'rollover-2').phase, 'PREPARED');
  assert.equal(store.listSegments('meeting-1').length, 2);
  assert.equal(events.some((event) => event.stage === 'LOCAL_SEGMENT_SCOPE_SWITCHED'
    && event.operationId === 'rollover-2'), false);
});

test('Reload proof checks every epoch and rejects an uncovered range', async () => {
  const { store, local } = await started();
  await local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  await local.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2',
    boundaryReceipt: receipt('rollover-1') });
  await local.stop({ finalSequence: 0, operationId: 'end-1' });
  let incomplete = false;
  const persistence = createLocalMeetingPersistence({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() },
    journalClientFactory: () => ({
      open: async () => ({ tailState: 'CLEAN', highestEpoch: 3, unclaimedTailBytes: 0 }),
      readPersistedGaps: async () => [],
      verifiedTransitionReceipt: async () => receipt('rollover-1'),
      coverage: async (_epoch, _start, end) => ({ epochBegun: true, epochClosed: true,
        endSample: 1600, complete: !incomplete || end === 0, gaps: incomplete && end > 0 ? [[800, 1600]] : [] }),
      close: async () => {}
    }) });
  assert.equal((await persistence.verifySegmentPcmOwnership('meeting-1')).status, 'PASS');
  incomplete = true;
  assert.deepEqual(await persistence.verifySegmentPcmOwnership('meeting-1'),
    { status: 'INTEGRITY_UNRESOLVED', reason: 'pcm_coverage_incomplete' });
});

test('different payload and concurrent successor cannot reuse a committed operation', async () => {
  const { store, local } = await started();
  await local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  await assert.rejects(local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-other' }),
    { code: 'local_segment_transition_conflict' });
  await assert.rejects(local.prepareSegmentRollover({ operationId: 'rollover-2', nextSegmentId: 'segment-3' }),
    { code: 'local_segment_transition_pending' });
  await local.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2',
    boundaryReceipt: receipt('rollover-1') });
  assert.equal(store.listSegments('meeting-1').length, 2);
});

test('lost IDB commit ACK adopts committed successor after Reload', async () => {
  const { store, local } = await started();
  const prepared = await local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  store.commitSegmentTransition({ ...prepared, boundary: receipt('rollover-1') });
  const afterReload = recorder(store);
  await afterReload.restore('meeting-1');
  const result = await afterReload.rolloverLocalSegment({ operationId: 'rollover-1',
    nextSegmentId: 'segment-2', boundaryReceipt: receipt('rollover-1') });
  assert.equal(result.segmentId, 'segment-2');
  assert.equal(store.listSegments('meeting-1').filter((segment) => segment.status === 'ACTIVE').length, 1);
});

test('END receipt survives a failed IDB commit and recovery commits the same transition', async () => {
  const base = createInMemoryLocalMeetingManifestStore();
  let fail = true;
  const store = { ...base, commitSegmentTransition(input) {
    if (fail) { fail = false; throw new Error('IDB_COMMIT_UNKNOWN'); }
    return base.commitSegmentTransition(input);
  } };
  const local = recorder(store);
  await local.start('meeting-1', { operationId: 'start-1', recordingId: 'recording-1',
    segmentId: 'segment-1', pcmEnabled: true });
  await local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  await assert.rejects(local.rolloverLocalSegment({ operationId: 'rollover-1',
    nextSegmentId: 'segment-2', boundaryReceipt: receipt('rollover-1') }), /IDB_COMMIT_UNKNOWN/u);
  assert.equal(base.getSegmentTransition('meeting-1', 'rollover-1').phase, 'PREPARED');
  const persistence = createLocalMeetingPersistence({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() },
    journalClientFactory: () => ({ open: async () => ({ tailState: 'CLEAN', unclaimedTailBytes: 0 }),
      verifiedTransitionReceipt: async () => receipt('rollover-1'), close: async () => {} }) });
  await persistence.recoverSegmentTransitions('meeting-1');
  assert.equal(base.getSegmentTransition('meeting-1', 'rollover-1').phase, 'COMMITTED');
  assert.equal((await base.getRecording('meeting-1')).segmentId, 'segment-2');
});

test('missing END with no unresolved write aborts durably; unreadable Journal leaves PREPARED', async () => {
  const { store, local } = await started();
  await local.prepareSegmentRollover({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  const persistence = createLocalMeetingPersistence({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() },
    journalClientFactory: () => ({ open: async () => ({ tailState: 'CLEAN', unclaimedTailBytes: 0 }),
      verifiedTransitionReceipt: async () => null, close: async () => {} }) });
  await persistence.recoverSegmentTransitions('meeting-1');
  assert.equal(store.getSegmentTransition('meeting-1', 'rollover-1').phase, 'ABORTED');
  assert.equal(store.getSegmentTransition('meeting-1', 'rollover-1').resolutionSegmentId, 'segment-1');
  assert.equal((await store.getRecording('meeting-1')).segmentId, 'segment-1');
  await local.prepareSegmentRollover({ operationId: 'rollover-2', nextSegmentId: 'segment-2' });
  const unreadable = createLocalMeetingPersistence({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() },
    journalClientFactory: () => ({ open: async () => { throw new Error('OPFS_UNAVAILABLE'); },
      close: async () => {} }) });
  await assert.rejects(unreadable.recoverSegmentTransitions('meeting-1'), /OPFS_UNAVAILABLE/u);
  assert.equal(store.getSegmentTransition('meeting-1', 'rollover-2').phase, 'PREPARED');
});

test('old recording remains legacy-unverified and does not receive invented Segment rows', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  store.saveRecording({ meetingId: 'old-meeting', recordingId: 'old-recording', segmentId: 'old-segment',
    segmentNumber: 1, captureEpoch: 1, providerEpoch: 0, state: 'stopped_local' });
  const old = store.getRecording('old-meeting');
  assert.equal(old.integrityVersion, null);
  assert.deepEqual(store.listSegments('old-meeting'), []);
});

const pauseId = 'pause:recording-1:segment-1';
const pauseReceipt = receipt(pauseId, 1);

function pausedPersistence(store, { damaged = false, missing = false, incomplete = false,
  unsealed = false, highestEpoch = 1, openError = null } = {}) {
  return createLocalMeetingPersistence({ manifestStore: store,
    chunkStore: { write: async () => {}, read: async () => new Uint8Array() },
    journalClientFactory: () => ({
      open: async () => {
        if (openError) throw openError;
        return { tailState: 'CLEAN', unclaimedTailBytes: 0, highestEpoch };
      },
      verifiedTransitionReceipt: async (id) => missing ? null : id === pauseId
        ? (damaged ? { ...pauseReceipt, sha256: 'b'.repeat(64) } : pauseReceipt) : null,
      readPersistedGaps: async () => [],
      coverage: async (_epoch, _start, end) => ({ epochBegun: true, epochClosed: !unsealed,
        endSample: 1600, complete: !incomplete, gaps: incomplete && end ? [[0, end]] : [] }),
      close: async () => {}
    }) });
}

test('Pause then End preserves one Segment and verifies its independent END receipt', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  await local.stop({ operationId: 'end-1', finalSequence: 0 });
  assert.equal(store.listSegments('meeting-1').length, 1);
  assert.equal((await pausedPersistence(store).verifySegmentPcmOwnership('meeting-1')).status, 'PASS');
});

test('Pause then Reload Continue commits one successor and replays lost ACK', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  const reloaded = pausedPersistence(store);
  await reloaded.startLifecycle({ meetingId: 'meeting-1', recordingId: 'recording-1',
    segmentId: 'segment-1', operationId: 'start-1', pcmEnabled: true });
  const first = await reloaded.continueLifecycle({ operationId: 'continue-1', nextSegmentId: 'segment-2' });
  assert.equal(first.state, 'capturing');
  assert.equal(first.recordingId, 'recording-1');
  assert.equal(first.segmentNumber, 2);
  assert.deepEqual(await reloaded.continueLifecycle({ operationId: 'continue-1', nextSegmentId: 'segment-2' }), first);
  const afterAckLoss = pausedPersistence(store);
  await afterAckLoss.startLifecycle({ meetingId: 'meeting-1', recordingId: 'recording-1',
    segmentId: 'segment-2', operationId: 'start-1', pcmEnabled: true });
  assert.deepEqual(await afterAckLoss.continueLifecycle({ operationId: 'continue-1', nextSegmentId: 'segment-2' }), first);
  assert.equal(store.listSegments('meeting-1').filter((segment) => segment.status === 'ACTIVE').length, 1);
  await assert.rejects(afterAckLoss.continueLifecycle({ operationId: 'continue-2', nextSegmentId: 'segment-3' }),
    { code: 'INTEGRITY_UNRESOLVED' });
  await afterAckLoss.endLifecycle({ operationId: 'end-1' });
  assert.equal((await pausedPersistence(store, { highestEpoch: 2 }).verifySegmentPcmOwnership('meeting-1')).status, 'PASS');
});

test('missing or damaged Pause END, incomplete coverage, and unsealed epoch never create a successor', async () => {
  for (const variant of [{ missing: true }, { damaged: true }, { incomplete: true }, { unsealed: true }]) {
    const { store, local } = await started();
    await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
    const reloaded = pausedPersistence(store, variant);
    await reloaded.startLifecycle({ meetingId: 'meeting-1', recordingId: 'recording-1',
      segmentId: 'segment-1', operationId: 'start-1', pcmEnabled: true });
    await assert.rejects(reloaded.continueLifecycle({ operationId: 'continue-1', nextSegmentId: 'segment-2' }),
      { code: 'INTEGRITY_UNRESOLVED' });
    assert.equal(store.listSegments('meeting-1').length, 1);
  }
});

test('Continue preserves a safe ownership reason without exposing recording identity', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  const reloaded = pausedPersistence(store, { missing: true });
  await reloaded.startLifecycle({ meetingId: 'meeting-1', recordingId: 'recording-1',
    segmentId: 'segment-1', operationId: 'start-1', pcmEnabled: true });
  const originalInfo = console.info;
  const diagnostics = [];
  console.info = (...args) => {
    if (args[0] === 'ISSUE41_PCM_OWNERSHIP') diagnostics.push(args[1]);
  };
  try {
    await assert.rejects(reloaded.continueLifecycle({ operationId: 'continue-1', nextSegmentId: 'segment-2' }),
      { code: 'INTEGRITY_UNRESOLVED', ownershipStatus: 'INTEGRITY_UNRESOLVED',
        ownershipReason: 'pause_boundary_conflict' });
  } finally {
    console.info = originalInfo;
  }
  assert.deepEqual(diagnostics.map((entry) => JSON.parse(entry)),
    [{ status: 'INTEGRITY_UNRESOLVED', reason: 'pause_boundary_conflict' }]);
  assert.equal(store.listSegments('meeting-1').length, 1);
});

test('Continue preserves numeric Journal OPEN error diagnostics', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  const openError = Object.assign(new Error('sensitive details'),
    { name: 'NoModificationAllowedError', code: 7 });
  const reloaded = pausedPersistence(store, { openError });
  await reloaded.startLifecycle({ meetingId: 'meeting-1', recordingId: 'recording-1',
    segmentId: 'segment-1', operationId: 'start-1', pcmEnabled: true });
  const originalInfo = console.info;
  const diagnostics = [];
  console.info = (...args) => {
    if (args[0] === 'ISSUE41_PCM_OWNERSHIP') diagnostics.push(args[1]);
  };
  try {
    await assert.rejects(reloaded.continueLifecycle({ operationId: 'continue-1', nextSegmentId: 'segment-2' }),
      { code: 'INTEGRITY_UNRESOLVED', ownershipStatus: 'INTEGRITY_UNRESOLVED',
        ownershipReason: 7, openErrorName: 'NoModificationAllowedError', openErrorCode: 7 });
  } finally {
    console.info = originalInfo;
  }
  assert.deepEqual(diagnostics.map((entry) => JSON.parse(entry)), [{
    status: 'INTEGRITY_UNRESOLVED', reason: 7,
    openErrorName: 'NoModificationAllowedError', openErrorCode: 7
  }]);
  assert.equal(store.listSegments('meeting-1').length, 1);
});

test('crash after Pause END but before pause operation leaves ownership unresolved', async () => {
  const { store } = await started();
  assert.deepEqual(await pausedPersistence(store).verifySegmentPcmOwnership('meeting-1'),
    { status: 'INTEGRITY_UNRESOLVED', reason: 'pause_end_without_operation' });
});

test('pending Continue recovery commits the Pause receipt only once', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  await local.preparePausedContinue({ operationId: 'continue-1', nextSegmentId: 'segment-2',
    boundaryOperationId: pauseId });
  const recovery = pausedPersistence(store);
  await recovery.recoverSegmentTransitions('meeting-1');
  assert.equal(store.getSegmentTransition('meeting-1', 'continue-1').phase, 'COMMITTED');
  assert.equal(store.listSegments('meeting-1').length, 2);
  await recovery.recoverSegmentTransitions('meeting-1');
  assert.equal(store.listSegments('meeting-1').length, 2);
});

test('pending Continue with missing END remains PREPARED and preserves PCM', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  await local.preparePausedContinue({ operationId: 'continue-1', nextSegmentId: 'segment-2',
    boundaryOperationId: pauseId });
  await assert.rejects(pausedPersistence(store, { missing: true }).recoverSegmentTransitions('meeting-1'),
    { code: 'INTEGRITY_UNRESOLVED' });
  assert.equal(store.getSegmentTransition('meeting-1', 'continue-1').phase, 'PREPARED');
  assert.equal(store.listSegments('meeting-1').length, 1);
});

test('retention removes Pause receipt, Segment rows, and Continue outcome together', async () => {
  const { store, local } = await started();
  await local.pause({ operationId: pauseId, boundaryReceipt: pauseReceipt });
  await local.preparePausedContinue({ operationId: 'continue-1', nextSegmentId: 'segment-2',
    boundaryOperationId: pauseId });
  await store.commitSegmentTransition({ ...store.getSegmentTransition('meeting-1', 'continue-1'),
    boundary: pauseReceipt });
  await store.clearMeetingContent('meeting-1');
  assert.equal(await store.getRecording('meeting-1'), null);
  assert.deepEqual(store.listSegments('meeting-1'), []);
  assert.equal(store.getSegmentTransition('meeting-1', 'continue-1'), null);
  assert.equal(await store.getOperation('meeting-1', pauseId), null);
});
