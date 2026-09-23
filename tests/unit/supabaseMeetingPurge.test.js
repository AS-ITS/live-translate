import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseMeetingPurgeRepository } from '../../src/infrastructure/supabaseMeetingPurgeRepository.js';
import { createSupabaseMeetingPurgeStorage } from '../../src/infrastructure/supabaseMeetingPurgeStorage.js';

function response(body = [], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('Supabase purge repository claims, lists artifacts, and deletes by owner scope', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.includes('/rpc/claim_due_meeting_purges')) return response([{ meetingId: 'meeting-1', ownerUserId: 'owner-1' }]);
    if (url.includes('/audio_artifacts')) return response([{ storage_path: 'owner-1/meeting-1/audio.webm' }]);
    if (url.includes('/export_artifacts')) return response([{ storage_path: 'owner-1/meeting-1/export.txt' }]);
    return response([], 204);
  };
  const repository = createSupabaseMeetingPurgeRepository({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl
  });

  const claims = await repository.claimDue({ workerId: 'worker-1', limit: 3 });
  const artifacts = await repository.listArtifacts(claims[0]);
  await repository.deleteMeeting(claims[0]);

  assert.deepEqual(claims, [{ meetingId: 'meeting-1', ownerUserId: 'owner-1' }]);
  assert.deepEqual(artifacts, {
    audioPaths: ['owner-1/meeting-1/audio.webm'],
    exportPaths: ['owner-1/meeting-1/export.txt']
  });
  assert.match(calls[0][0], /\/rpc\/claim_due_meeting_purges$/u);
  assert.match(calls.at(-1)[0], /\/rest\/v1\/meetings\?/u);
  assert.match(calls.at(-1)[0], /id=eq\.meeting-1/u);
  assert.match(calls.at(-1)[0], /owner_user_id=eq\.owner-1/u);
});

test('Supabase purge storage deletes only the requested bucket paths', async () => {
  const calls = [];
  const storage = createSupabaseMeetingPurgeStorage({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return response();
    }
  });

  await storage.remove({ bucket: 'meeting-audio', paths: ['owner-1/meeting-1/audio.webm'] });
  await storage.remove({ bucket: 'meeting-exports', paths: [] });

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/storage\/v1\/object\/meeting-audio$/u);
  assert.deepEqual(JSON.parse(calls[0][1].body), { prefixes: ['owner-1/meeting-1/audio.webm'] });
});
