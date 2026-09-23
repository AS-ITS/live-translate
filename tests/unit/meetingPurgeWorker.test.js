import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingPurgeWorker } from '../../src/application/meetingPurgeWorker.js';

test('purge worker removes both Storage artifact groups before deleting the Meeting', async () => {
  const calls = [];
  const repository = {
    async claimDue(input) {
      calls.push(['claim', input]);
      return [{ meetingId: 'meeting-1', ownerUserId: 'owner-1' }];
    },
    async listArtifacts() {
      return { audioPaths: ['owner-1/meeting-1/audio.webm'], exportPaths: ['owner-1/meeting-1/export.txt'] };
    },
    async deleteMeeting(claim) { calls.push(['delete', claim]); },
    async markFailed() { calls.push(['failed']); }
  };
  const storage = { async remove(input) { calls.push(['storage', input]); } };
  const worker = createMeetingPurgeWorker({ repository, storage, workerId: 'worker-1' });

  const result = await worker.runOnce({ limit: 2 });

  assert.deepEqual(result, { claimed: 1, purged: 1, failed: 0 });
  assert.deepEqual(calls, [
    ['claim', { workerId: 'worker-1', limit: 2 }],
    ['storage', { bucket: 'meeting-audio', paths: ['owner-1/meeting-1/audio.webm'] }],
    ['storage', { bucket: 'meeting-exports', paths: ['owner-1/meeting-1/export.txt'] }],
    ['delete', { meetingId: 'meeting-1', ownerUserId: 'owner-1' }]
  ]);
});

test('purge worker marks a failed claim and continues with the bounded batch', async () => {
  const failed = [];
  const repository = {
    async claimDue() { return [{ meetingId: 'meeting-1', ownerUserId: 'owner-1' }]; },
    async listArtifacts() { throw Object.assign(new Error('storage unavailable'), { code: 'storage_unavailable' }); },
    async deleteMeeting() { throw new Error('must not delete'); },
    async markFailed(input) { failed.push(input); }
  };
  const worker = createMeetingPurgeWorker({
    repository,
    storage: { async remove() {} },
    workerId: 'worker-1'
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { claimed: 1, purged: 0, failed: 1 });
  assert.equal(failed[0].claim.meetingId, 'meeting-1');
  assert.equal(failed[0].error.code, 'storage_unavailable');
});

test('purge worker emits best-effort retention metrics', async () => {
  const metrics = [];
  const repository = {
    async claimDue() { return [{ meetingId: 'meeting-1', ownerUserId: 'owner-1' }]; },
    async listArtifacts() { return { audioPaths: [], exportPaths: [] }; },
    async deleteMeeting() {},
    async markFailed() {}
  };
  const worker = createMeetingPurgeWorker({
    repository,
    storage: { async remove() {} },
    workerId: 'worker-1',
    clock: (() => { let now = 100; return () => (now += 5); })(),
    observabilityMetrics: {
      recordCounter(...input) { metrics.push(['counter', ...input]); },
      recordLatency(...input) { metrics.push(['latency', ...input]); }
    }
  });

  await worker.runOnce();

  assert.equal(metrics[0][1], 'meeting_purge_claimed_total');
  assert.equal(metrics.some((item) => item[1] === 'meeting_purge_completed_total'), true);
  assert.equal(metrics.some((item) => item[1] === 'meeting_purge_latency_ms'), true);
});
