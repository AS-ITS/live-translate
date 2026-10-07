import assert from 'node:assert/strict';
import test from 'node:test';
import { latestOpenMeetingSegment, resumeLegacyMeetingSegment } from '../../src/lib/legacyMeetingResume.js';
import { activateRecoveredMeetingSegment, meetingRequestErrorMessage } from '../../src/features/live/useLiveRecordingController.js';

const flight = { run: (_key, task) => task() };
const active = (id, sequence) => ({ id, sequence, status: 'active', liveSessionId: `old-${id}` });

test('resume selects the server latest active segment instead of a stale local draft and keeps cue identity', async () => {
  const calls = [];
  const client = {
    async listSegments() { return { segments: [{ id: 'old', sequence: 1, status: 'interrupted' }, active('current', 2)] }; },
    async recoverSegment(input) { calls.push(input); return { segment: active('next', 3) }; }
  };
  const result = await resumeLegacyMeetingSegment({
    client, meetingId: 'meeting-1', nextLiveSessionId: 'live-next', singleFlight: flight,
    finalCues: [{ cueId: 'old-cue', segmentId: 'old' }, { cueId: 'current-cue', segmentId: 'current' }],
    cueCheckpoint: { nextSequence: 9 }
  });
  assert.equal(result.segment.id, 'next');
  assert.equal(calls[0].segmentId, 'current');
  assert.deepEqual(calls[0].checkpoint.finalCues.map((cue) => cue.cueId), ['current-cue']);
  assert.equal(calls[0].idempotencyKey, 'recover:current:live-next');
});

test('recover 409 retries once only if the meeting advances to a new active segment', async () => {
  let lists = 0;
  const recovered = [];
  const client = {
    async listSegments() {
      lists += 1;
      return { segments: [active(lists === 1 ? 'first' : 'second', lists)] };
    },
    async recoverSegment({ segmentId }) {
      recovered.push(segmentId);
      if (segmentId === 'first') throw Object.assign(new Error('conflict'), { code: 'checkpoint_conflict', status: 409 });
      return { segment: active('third', 3) };
    }
  };
  const result = await resumeLegacyMeetingSegment({ client, meetingId: 'm', nextLiveSessionId: 'live', singleFlight: flight });
  assert.equal(result.segment.id, 'third');
  assert.deepEqual(recovered, ['first', 'second']);
});

test('recover 409 on an unchanged segment stops instead of retrying indefinitely', async () => {
  let attempts = 0;
  const client = {
    async listSegments() { return { segments: [active('same', 1)] }; },
    async recoverSegment() { attempts += 1; throw Object.assign(new Error('conflict'), { code: 'checkpoint_conflict', status: 409 }); }
  };
  await assert.rejects(resumeLegacyMeetingSegment({ client, meetingId: 'm', nextLiveSessionId: 'live', singleFlight: flight }), { code: 'checkpoint_conflict' });
  assert.equal(attempts, 1);
});

test('stop cancels pending resume before it writes, and missing open segment cannot recover', async () => {
  let writes = 0;
  const client = {
    async listSegments() { return { segments: [active('current', 2)] }; },
    async recoverSegment() { writes += 1; }
  };
  const result = await resumeLegacyMeetingSegment({ client, meetingId: 'm', nextLiveSessionId: 'live', singleFlight: flight, shouldContinue: () => false });
  assert.equal(result, null);
  assert.equal(writes, 0);
  assert.equal(latestOpenMeetingSegment([{ id: 'old', status: 'interrupted' }]), null);
});

test('successful recover activates the next segment before callbacks and error identifies recover, not checkpoint', () => {
  const activeRef = { current: { meetingId: 'm', segmentId: 'old' } };
  const sync = [];
  activateRecoveredMeetingSegment({ meetingId: 'm', recoveryResult: { segment: { id: 'next' } }, activeMeetingCheckpointRef: activeRef, startCheckpointSync: (value) => sync.push(value) });
  assert.deepEqual(activeRef.current, { meetingId: 'm', segmentId: 'next' });
  assert.deepEqual(sync, [activeRef.current]);
  const message = meetingRequestErrorMessage({ operation: 'recover-segment', status: 409, code: 'checkpoint_conflict', requestId: 'req-1' });
  assert.match(message, /^recover HTTP 409/);
  assert.match(message, /checkpoint_conflict/);
  assert.match(message, /req-1/);
  assert.doesNotMatch(message, /^checkpoint/);
});
