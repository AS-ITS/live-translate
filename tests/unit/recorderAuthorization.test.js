import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeRecorderRequest } from '../../src/application/recorderAuthorization.js';

function dependencies(overrides = {}) {
  return {
    sessionShareService: { resolveShare: async () => ({ id: 'share-1', sessionId: 'session-1', role: 'recorder', expiresAt: 999999 }) },
    recorderGrantService: { validate: () => ({ sessionId: 'session-1', shareId: 'share-1', leaseId: 'lease-1', fenceToken: 2, expiresAt: 999999 }) },
    recorderLeaseService: { current: async () => ({ sessionId: 'session-1', leaseId: 'lease-1', fenceToken: 2, expiresAt: 999999 }) },
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    headers: {
      'x-recorder-token': 'recorder-token',
      'x-recorder-grant': 'recorder-grant',
      'x-recorder-lease-id': 'lease-1',
      'x-recorder-fence-token': '2'
    },
    ...overrides
  };
}

test('Recorder authorization binds share, grant, lease, fence, and Session', async () => {
  const result = await authorizeRecorderRequest({
    request: request(),
    sessionId: 'session-1',
    ...dependencies()
  });
  assert.equal(result.share.id, 'share-1');
  assert.equal(result.lease.fenceToken, 2);
});

test('Recorder authorization rejects a stale fence token', async () => {
  await assert.rejects(
    () => authorizeRecorderRequest({
      request: request({ headers: { ...request().headers, 'x-recorder-fence-token': '1' } }),
      sessionId: 'session-1',
      ...dependencies()
    }),
    (error) => error.code === 'recorder_lease_invalid'
  );
});

test('Viewer shares cannot authorize Recorder writes', async () => {
  await assert.rejects(
    () => authorizeRecorderRequest({
      request: request(),
      sessionId: 'session-1',
      ...dependencies({
        sessionShareService: { resolveShare: async () => ({ id: 'share-1', sessionId: 'session-1', role: 'viewer' }) }
      })
    }),
    (error) => error.code === 'recorder_forbidden'
  );
});
