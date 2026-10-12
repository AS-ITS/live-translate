import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudSaveCoordinator } from '../../src/lib/cloudSaveCoordinator.js';

test('cloud save coordinator does not report synced while any channel failed', () => {
  const states = [];
  const coordinator = createCloudSaveCoordinator({ onChange: (snapshot) => states.push(snapshot.state) });

  coordinator.begin({ id: 'cue:1', kind: 'cue' });
  coordinator.begin({ id: 'checkpoint:1', kind: 'checkpoint' });
  coordinator.fail('cue:1', { status: 503, code: 'cloud_unavailable', requestId: 'request-1' });
  const afterCheckpoint = coordinator.succeed('checkpoint:1');

  assert.equal(afterCheckpoint.state, 'cloud_failed');
  assert.equal(afterCheckpoint.failedCount, 1);
  assert.equal(afterCheckpoint.error.requestId, 'request-1');
  assert.deepEqual(states, ['cloud_pending', 'cloud_pending', 'cloud_failed', 'cloud_failed']);
});

test('cloud save coordinator clears stale error after bounded retry succeeds', () => {
  const coordinator = createCloudSaveCoordinator();
  coordinator.begin({ id: 'cue:1', kind: 'cue' });
  coordinator.fail('cue:1', { status: 403, code: 'recorder_session_mismatch' });

  assert.equal(coordinator.begin({ id: 'cue:1', kind: 'cue' }).state, 'cloud_retrying');
  const synced = coordinator.succeed('cue:1');

  assert.deepEqual(synced, {
    state: 'cloud_synced',
    pendingCount: 0,
    retryingCount: 0,
    failedCount: 0,
    error: null
  });
});

test('cloud save coordinator keeps failures separated by stable operation id', () => {
  const coordinator = createCloudSaveCoordinator();
  coordinator.begin({ id: 'cue:source', kind: 'cue' });
  coordinator.begin({ id: 'cue:successor', kind: 'cue' });
  coordinator.fail('cue:source', { status: 503 });
  coordinator.succeed('cue:successor');

  assert.deepEqual(coordinator.snapshot(), {
    state: 'cloud_failed',
    pendingCount: 0,
    retryingCount: 0,
    failedCount: 1,
    error: { status: 503, code: null, requestId: null, message: null }
  });
});
