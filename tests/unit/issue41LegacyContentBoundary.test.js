import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithRequestUser } from '../../server/requestIdentity.js';
import { createExportArtifactService } from '../../src/application/exportArtifactService.js';
import { createExportWorker } from '../../src/application/exportWorker.js';
import { createSupabaseMeetingExportSource } from '../../src/infrastructure/supabaseMeetingExportSource.js';

test('an old export job cannot read or persist content for a v2 Meeting', async () => {
  const calls = [];
  const sourceReader = createSupabaseMeetingExportSource({
    env: { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'test-key' },
    fetchImpl: async (url) => {
      calls.push(`GET ${new URL(url).pathname}`);
      assert.match(url, /\/rest\/v1\/meetings\?/u);
      return new Response(JSON.stringify([{ id: 'meeting-2', status: 'active', lifecycle_contract_version: 2 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const forbidden = (name) => async () => { calls.push(name); throw new Error(`${name} must not run`); };
  const repository = {
    getById: async () => ({ id: 'artifact-old', meetingId: 'meeting-2', sourceHash: 'old-hash', attempt: 0 }),
    findByKey: forbidden('findByKey'), create: forbidden('create'), listByMeeting: forbidden('listByMeeting'),
    update: forbidden('update'), remove: forbidden('remove'), removeByMeeting: forbidden('removeByMeeting')
  };
  const queue = {
    enqueue: forbidden('enqueue'),
    claim: async () => [{ messageId: 'old-job', readCt: 1, message: { ownerUserId: 'owner-1', meetingId: 'meeting-2', artifactId: 'artifact-old' } }],
    acknowledge: forbidden('acknowledge'),
    retry: async ({ errorCode }) => { calls.push(`retry ${errorCode}`); }
  };
  const storage = { put: forbidden('put'), remove: forbidden('remove'), createSignedUrl: forbidden('createSignedUrl') };
  const exportArtifactService = createExportArtifactService({ artifactRepository: repository, sourceReader, queue, storage });
  const worker = createExportWorker({ exportArtifactService, queue });

  const result = await runWithRequestUser({ kind: 'worker' }, () => worker.runOnce({ limit: 1 }));
  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(calls, ['GET /rest/v1/meetings', 'retry meeting_content_local_only']);
});
