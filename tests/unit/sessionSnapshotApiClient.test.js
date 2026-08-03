import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSnapshotApiClient } from '../../src/lib/sessionSnapshotApiClient.js';

test('session snapshot client preserves HTTP status and backend error code', async () => {
  const client = createSessionSnapshotApiClient({
    fetchImpl() {
      return {
        ok: false,
        status: 413,
        async json() {
          return { error: { code: 'request_too_large' } };
        }
      };
    }
  });

  await assert.rejects(
    () => client.sync({ session: { id: 'session-1' }, transcriptItems: [] }),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.code, 'request_too_large');
      return true;
    }
  );
});
