import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_JOB_MAX_ATTEMPTS, createBackgroundJobMessage } from '../../src/application/backgroundJobs.js';
import { createSupabaseBackgroundJobQueue } from '../../src/infrastructure/supabaseBackgroundJobQueue.js';
import { createMp3ArtifactService } from '../../src/application/mp3ArtifactService.js';

test('background job messages contain identifiers only and require an owner', () => {
  assert.deepEqual(createBackgroundJobMessage({ ownerUserId: 'u1', executionId: 'e1', requestId: 'r1' }), {
    ownerUserId: 'u1', executionId: 'e1', requestId: 'r1'
  });
  assert.throws(() => createBackgroundJobMessage({ executionId: 'e1' }), /ownerUserId/);
  assert.equal(BACKGROUND_JOB_MAX_ATTEMPTS, 3);
});

test('Supabase queue maps claim fence and archives only after three attempts', async () => {
  const calls = [];
  const queue = createSupabaseBackgroundJobQueue({
    queueName: 'mp3_jobs',
    client: { async request(path, options) { calls.push({ path, options }); return path.endsWith('claim') ? [{ msg_id: 7, read_ct: 2, message: { ownerUserId: 'u1', artifactId: 'a1' } }] : [{ depth: 4 }]; } }
  });
  assert.deepEqual(await queue.claim(), [{ messageId: '7', readCt: 2, visibilityTimeoutAt: null, message: { ownerUserId: 'u1', artifactId: 'a1' } }]);
  await queue.retry({ messageId: 7, readCt: 2, attempt: 3 });
  assert.equal(calls.at(-1).path, 'rpc/background_job_archive');
});

test('MP3 worker preserves WebM and makes ready state idempotent', async () => {
  const updates = [];
  const service = createMp3ArtifactService({
    artifactRepository: { async getOrCreate() { return { id: 'a1', kind: 'mp3', status: 'queued', attempt: 0 }; }, async update(id, value) { updates.push({ id, value }); return { id, ...value }; } },
    converter: { async convert() { return { byteSize: 10, storagePath: 'u1/m1/s1/recording.mp3' }; } }
  });
  assert.equal((await service.process({ ownerUserId: 'u1', meetingId: 'm1', segmentId: 's1' })).status, 'ready');
  assert.equal(updates[0].value.status, 'processing');
  assert.equal(updates[1].value.fileName, 'recording.mp3');
});
