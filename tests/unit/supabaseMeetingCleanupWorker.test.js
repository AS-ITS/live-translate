import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseMeetingCleanupWorker } from '../../src/infrastructure/supabaseMeetingCleanupWorker.js';

const env = { SUPABASE_URL: 'https://local.test', SUPABASE_SECRET_KEY: 'test-service-key' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json' } });

test('cloud cleanup caps one claim at 20 Storage objects and leaves continuation marker', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/claim_due_recording_cleanup')) return json([{
      recording_id: 'recording-1', meeting_id: 'meeting-1', owner_user_id: 'owner-1', phase: 'storage'
    }]);
    if (url.endsWith('/list_meeting_storage_paths')) return json(Array.from({ length: 21 }, (_, index) => ({
      bucket: 'meeting-audio', path: `owner-1/meeting-1/${index}`
    })));
    if (url.includes('/storage/v1/object/meeting-audio')) return json([]);
    if (url.endsWith('/advance_recording_cleanup')) return json(true);
    throw new Error(`Unexpected request: ${url}`);
  };
  const worker = createSupabaseMeetingCleanupWorker({ env, fetchImpl });
  assert.deepEqual(await worker.runOnce(), { claimed: 1, cleared: 0, rows: 0, objects: 20 });
  const deletion = calls.find((call) => call.url.includes('/storage/v1/object/meeting-audio'));
  assert.equal(JSON.parse(deletion.options.body).prefixes.length, 20);
  const advance = calls.find((call) => call.url.endsWith('/advance_recording_cleanup'));
  assert.equal(JSON.parse(advance.options.body).p_next_phase, 'storage');
});

test('Storage failure is isolated and leaves a retryable persisted claim', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/claim_due_recording_cleanup')) return json([{
      recording_id: 'recording-1', meeting_id: 'meeting-1', owner_user_id: 'owner-1', phase: 'storage'
    }]);
    if (url.endsWith('/list_meeting_storage_paths')) return json([{
      bucket: 'meeting-audio', path: 'owner-1/meeting-1/file'
    }]);
    if (url.includes('/storage/v1/object/meeting-audio')) return json({ error: 'failed' }, 503);
    if (url.endsWith('/advance_recording_cleanup')) return json(true);
    throw new Error(`Unexpected request: ${url}`);
  };
  const worker = createSupabaseMeetingCleanupWorker({ env, fetchImpl });
  assert.equal((await worker.runOnce()).failed, 1);
  const advance = calls.find((call) => call.url.endsWith('/advance_recording_cleanup'));
  assert.equal(JSON.parse(advance.options.body).p_next_phase, 'storage');
  assert.equal(JSON.parse(advance.options.body).p_error, 'cleanup_failed');
});
