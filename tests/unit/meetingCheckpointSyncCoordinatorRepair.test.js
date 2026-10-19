import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';
import { validateFinalCue, normalizeCueCheckpoint } from '../../src/domain/subtitleCue/index.js';

const cue = (cueId, overrides = {}) => ({
  cueId,
  sessionId: 'session-1',
  segmentId: 'segment-1',
  status: 'final',
  sequence: 1,
  sourceText: 'hello',
  translationText: 'bonjour',
  ...overrides
});

function coordinatorForConflicts(remote, conflicts = 1) {
  const calls = [];
  const statuses = [];
  const errors = [];
  const timers = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (calls.length <= conflicts) throw Object.assign(new Error('checkpoint conflict'), { status: 409 });
    },
    getCheckpoint: async () => remote(),
    onStatusChange: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  return { coordinator, calls, statuses, errors, timers };
}

test('409 missing remote Cue survives repeated conflicts and publishes exactly once', async () => {
  const { coordinator, calls, statuses, errors } = coordinatorForConflicts(
    () => ({ checkpoint: { finalCues: [] } }), 2
  );
  coordinator.enqueueCues([cue('cue-1')]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls.map((call) => call.finalCues.map((item) => item.cueId)),
    [['cue-1'], ['cue-1'], ['cue-1']]);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 3);
  assert.equal(errors.length, 0);
  assert.ok(statuses.includes('ready'));
});

test('409 removes only the acknowledged Cue and keeps other pending Cues', async () => {
  const saved = cue('cue-1');
  const { coordinator, calls } = coordinatorForConflicts(
    () => ({ checkpoint: { finalCues: [saved] } })
  );
  coordinator.enqueueCues([saved, cue('cue-2', { sequence: 2 })]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[1].finalCues.map((item) => item.cueId), ['cue-2']);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 2);
});

test('409 remote older or conflicting Cue cannot acknowledge newer local content', async () => {
  const local = cue('cue-1', { refinement: { status: 'completed', version: 2 }, refinedTranslation: 'new' });
  for (const remoteCue of [
    cue('cue-1', { refinement: { status: 'completed', version: 1 }, refinedTranslation: 'old' }),
    cue('cue-1', { refinement: { status: 'completed', version: 2 }, refinedTranslation: 'different' })
  ]) {
    const { coordinator, calls } = coordinatorForConflicts(
      () => ({ checkpoint: { finalCues: [remoteCue] } })
    );
    coordinator.enqueueCues([local]);
    assert.equal(await coordinator.flush(), false);
    assert.equal(await coordinator.flush(), true);
    assert.deepEqual(calls[1].finalCues, [local]);
  }
});

test('stale 409 response cannot delete a newer Cue enqueued during readback', async () => {
  const oldCue = cue('cue-1', { refinement: { status: 'pending', version: 1 } });
  const newCue = cue('cue-1', { refinement: { status: 'completed', version: 2 }, refinedTranslation: 'new' });
  let releaseReadback;
  const readback = new Promise((resolve) => { releaseReadback = resolve; });
  const { coordinator, calls } = coordinatorForConflicts(() => readback);
  coordinator.enqueueCues([oldCue]);
  const firstFlush = coordinator.flush();
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.enqueueCues([newCue]);
  releaseReadback({ checkpoint: { finalCues: [oldCue] } });
  assert.equal(await firstFlush, false);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[1].finalCues, [newCue]);
});

test('409 readback with another owner cannot acknowledge a local Cue', async () => {
  for (const latest of [
    { meetingId: 'meeting-2', segmentId: 'segment-1', checkpoint: { finalCues: [cue('cue-1')] } },
    { meetingId: 'meeting-1', segmentId: 'segment-2', checkpoint: { finalCues: [cue('cue-1')] } },
    { checkpoint: { finalCues: [cue('cue-1', { sessionId: 'session-2' })] } }
  ]) {
    const { coordinator, calls } = coordinatorForConflicts(() => latest);
    coordinator.enqueueCues([cue('cue-1')]);
    assert.equal(await coordinator.flush(), false);
    assert.equal(await coordinator.flush(), true);
    assert.deepEqual(calls[1].finalCues.map((item) => item.cueId), ['cue-1']);
  }
});

test('persistent 409 stops automatic retries after three attempts and reports conflict', async () => {
  const { coordinator, calls, statuses, errors, timers } = coordinatorForConflicts(
    () => ({ checkpoint: { finalCues: [] } }), 4
  );
  coordinator.enqueueCues([cue('cue-1')]);
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(await coordinator.flush(), false);
  assert.equal(calls.length, 4);
  assert.equal(timers.length, 4); // One initial timer and three retry timers.
  assert.equal(statuses.at(-1), 'error');
  assert.equal(errors.length, 1);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[4].finalCues.map((item) => item.cueId), ['cue-1']);
});

test('same Cue ID in two sessions retains both session-owned versions', async () => {
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => calls.push(payload),
    setTimeoutFn: () => ({}),
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueueCues([cue('cue-1'), cue('cue-1', { sessionId: 'session-2' })]);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[0].finalCues.map((item) => item.sessionId), ['session-1', 'session-2']);
});

const completeCue = (overrides = {}) => ({
  cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1',
  sequence: 1, startTimeMs: 0, endTimeMs: 300,
  sourceLanguageCode: 'en', targetLanguageCode: 'fr',
  sourceText: 'hello', translatedText: 'bonjour',
  status: 'final', finalizedReason: 'final', ...overrides
});

const readback = (finalCues = [], cueCheckpoint) => ({
  meetingId: 'meeting-1', segmentId: 'segment-1',
  checkpoint: { finalCues, cueCheckpoint }
});

test('409 acknowledges a Cue after domain status and version defaults', async () => {
  const local = completeCue();
  const { coordinator, calls } = coordinatorForConflicts(() => readback([validateFinalCue(local)]));
  coordinator.enqueueCues([local]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 1);
});

test('409 treats optional initialTranslation undefined as the stored null', async () => {
  const local = completeCue({
    rawSource: 'hello', rawTranslation: 'bonjour',
    initialTranslation: undefined, refinement: { version: 1 }
  });
  const { coordinator, calls } = coordinatorForConflicts(() => readback([validateFinalCue(local)]));
  coordinator.enqueueCues([local]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 1);
});

test('409 ignores Cue property insertion order after normalization', async () => {
  const local = completeCue();
  const reordered = Object.fromEntries(Object.entries(validateFinalCue(local)).reverse());
  const { coordinator, calls } = coordinatorForConflicts(() => readback([reordered]));
  coordinator.enqueueCues([local]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 1);
});

for (const [name, localOverride, remoteOverride] of [
  ['source', { sourceVersion: 2, refinement: { version: 1 } }, { sourceVersion: 1, refinement: { version: 2 } }],
  ['translation', { translationVersion: 2, refinement: { version: 1 } }, { translationVersion: 1, refinement: { version: 2 } }],
  ['both sides', { sourceVersion: 2, translationVersion: 2, refinement: { version: 1 } },
    { sourceVersion: 1, translationVersion: 1, refinement: { version: 2 } }]
]) {
  test(`409 does not acknowledge newer local ${name} from a higher refinement version`, async () => {
    const local = validateFinalCue(completeCue(localOverride));
    const remote = validateFinalCue(completeCue(remoteOverride));
    const { coordinator, calls } = coordinatorForConflicts(() => readback([remote]));
    coordinator.enqueueCues([local]);
    assert.equal(await coordinator.flush(), false);
    assert.equal(await coordinator.flush(), true);
    assert.deepEqual(calls[1].finalCues, [local]);
  });
}

test('409 acknowledges a newer readback that covers both sides and refinement', async () => {
  const local = validateFinalCue(completeCue({
    sourceVersion: 2, translationVersion: 2, refinement: { version: 1 }
  }));
  const remote = validateFinalCue(completeCue({
    sourceVersion: 3, translationVersion: 3,
    refinement: { version: 2, status: 'completed' }, refinedTranslation: 'salut'
  }));
  const { coordinator, calls } = coordinatorForConflicts(() => readback([remote]));
  coordinator.enqueueCues([local]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 1);
});

test('409 retains a Cue when remote Cue ID differs', async () => {
  const local = validateFinalCue(completeCue());
  const remote = validateFinalCue(completeCue({ cueId: 'cue-foreign' }));
  const { coordinator, calls } = coordinatorForConflicts(() => readback([remote]));
  coordinator.enqueueCues([local]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[1].finalCues, [local]);
});

test('409 acknowledges a normalized cueCheckpoint and clears only its scope', async () => {
  const local = { nextSequence: 2 };
  const { coordinator, calls } = coordinatorForConflicts(() => readback([], normalizeCueCheckpoint(local)));
  coordinator.enqueueCues([], local);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 1);
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-2' });
  coordinator.enqueueCues([], { nextSequence: 3 });
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].segmentId, 'segment-2');
});

test('409 cannot clear a cueCheckpoint using another segment readback', async () => {
  const local = { nextSequence: 2 };
  const { coordinator, calls } = coordinatorForConflicts(() => ({
    meetingId: 'meeting-1', segmentId: 'segment-foreign',
    checkpoint: { finalCues: [], cueCheckpoint: normalizeCueCheckpoint(local) }
  }));
  coordinator.enqueueCues([], local);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls[1].segmentId, 'segment-1');
  assert.deepEqual(calls[1].cueCheckpoint, local);
});

test('409 replay stops submitting after readback proves the Cue durable', async () => {
  const local = validateFinalCue(completeCue());
  let reads = 0;
  const { coordinator, calls } = coordinatorForConflicts(() => readback(++reads === 1 ? [] : [local]), 3);
  coordinator.enqueueCues([local]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 2);
});

test('enqueue preserves independent side and refinement versions for compatible Cue snapshots', async () => {
  const sideNewer = validateFinalCue(completeCue({ sourceVersion: 2, refinement: { version: 1 } }));
  const refinementNewer = validateFinalCue(completeCue({ sourceVersion: 1, refinement: { version: 2 } }));
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => calls.push(payload),
    setTimeoutFn: () => ({}), clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueueCues([sideNewer]);
  coordinator.enqueueCues([refinementNewer]);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls[0].finalCues[0].sourceVersion, 2);
  assert.equal(calls[0].finalCues[0].refinement.version, 2);
});
