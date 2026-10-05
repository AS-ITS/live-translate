import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseMeetingShareService } from '../../src/infrastructure/supabaseMeetingShareService.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('public meeting share resolution uses the service role without an authenticated request', async () => {
  const calls = [];
  const service = createSupabaseMeetingShareService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options]);
      return response([{
        id: 'share-1',
        owner_user_id: 'owner-1',
        meeting_id: 'meeting-1',
        role: 'viewer',
        resource_type: 'meeting',
        short_code: 'SDR96VY9',
        created_at: '2026-09-30T00:00:00.000Z',
        expires_at: null,
        revoked_at: null
      }]);
    }
  });

  const share = await service.resolveCode('sdr96vy9');

  assert.equal(share.id, 'share-1');
  assert.equal(share.meetingId, 'meeting-1');
  assert.equal(share._ownerUserId, 'owner-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/rest\/v1\/viewer_shares\?select=\*&short_code_hash=eq\./u);
  assert.equal(calls[0][0].includes('SDR96VY9'), false);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer service-key');
});

test('meeting share mutations still require an authenticated owner', async () => {
  const service = createSupabaseMeetingShareService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async () => response([])
  });

  await assert.rejects(
    () => service.createMeetingShare('meeting-1'),
    (error) => error.code === 'auth_required' && error.status === 401
  );
});
