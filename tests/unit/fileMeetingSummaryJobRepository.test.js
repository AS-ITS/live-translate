import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFileMeetingSummaryJobRepository } from '../../src/infrastructure/fileMeetingSummaryJobRepository.js';

test('file summary job repository preserves terminal state and duplicate enqueue identity across reloads', async () => {
  const directory = await fileSystem.mkdtemp(join(tmpdir(), 'live-translate-summary-jobs-'));
  const filePath = join(directory, 'jobs.json');
  const input = { jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1', enqueuedAt: '2026-08-04T00:00:00.000Z' };
  const firstRepository = createFileMeetingSummaryJobRepository({ filePath, fileSystem });

  const first = await firstRepository.enqueue(input);
  const duplicate = await firstRepository.enqueue({ ...input, jobId: 'job-duplicate' });
  const claimed = await firstRepository.claim(first.jobId, {
    leaseId: 'lease-1',
    claimedAt: '2026-08-04T00:00:00.000Z',
    leaseExpiresAt: '2026-08-04T01:00:00.000Z'
  });
  await firstRepository.complete(first.jobId, { leaseId: claimed.leaseId, fenceToken: claimed.fenceToken }, '2026-08-04T00:01:00.000Z');
  const failed = await firstRepository.enqueue({ jobId: 'job-2', sessionId: 'session-2', meetingId: 'meeting-2', enqueuedAt: '2026-08-04T00:00:00.000Z' });
  const failedClaim = await firstRepository.claim(failed.jobId, {
    leaseId: 'lease-2',
    claimedAt: '2026-08-04T00:00:00.000Z',
    leaseExpiresAt: '2026-08-04T01:00:00.000Z'
  });
  await firstRepository.fail(failed.jobId, { leaseId: failedClaim.leaseId, fenceToken: failedClaim.fenceToken }, {
    failedAt: '2026-08-04T00:02:00.000Z',
    failureInfo: { reason: 'provider_error', message: 'failed' }
  });

  const secondRepository = createFileMeetingSummaryJobRepository({ filePath, fileSystem });
  const persisted = await secondRepository.get(first.jobId);

  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.completedAt, '2026-08-04T00:01:00.000Z');
  assert.equal((await secondRepository.get('job-2')).status, 'failed');
  assert.equal((await secondRepository.list()).length, 2);
});
