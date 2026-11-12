import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { setRequestUser } from '../../server/requestIdentity.js';
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

test('Supabase token and code resolution reject revoked and expired shares', async () => {
  let now = Date.parse('2026-10-31T00:00:00.000Z');
  const token = 'a'.repeat(32);
  const code = 'SDR96VY9';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const row = {
    id: 'share-1', owner_user_id: 'owner-1', meeting_id: 'meeting-1',
    role: 'viewer', resource_type: 'meeting', token_hash: hash(token),
    short_code: code, short_code_hash: hash(code),
    created_at: '2026-10-30T00:00:00.000Z', expires_at: new Date(now + 60_000).toISOString(), revoked_at: null
  };
  const calls = [];
  const service = createSupabaseMeetingShareService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    clock: () => now,
    fetchImpl: async (url, init) => {
      const requestUrl = new URL(url);
      calls.push({ requestUrl, method: init.method });
      assert.equal(requestUrl.pathname, '/rest/v1/viewer_shares');
      if (init.method === 'PATCH') {
        const permitted = requestUrl.searchParams.get('id') === 'eq.share-1' &&
          requestUrl.searchParams.get('meeting_id') === 'eq.meeting-1' &&
          requestUrl.searchParams.get('owner_user_id') === 'eq.owner-1';
        if (permitted) row.revoked_at = JSON.parse(init.body).revoked_at;
        return response(permitted ? [row] : []);
      }
      const found = requestUrl.searchParams.get('token_hash') === `eq.${row.token_hash}` ||
        requestUrl.searchParams.get('short_code_hash') === `eq.${row.short_code_hash}`;
      return response(found ? [row] : []);
    }
  });

  assert.equal((await service.resolveShare(token)).meetingId, 'meeting-1');
  assert.equal((await service.resolveCode(code))._ownerUserId, 'owner-1');
  setRequestUser({ id: 'owner-2' });
  try {
    assert.equal(await service.revokeShare('meeting-1', row.id), false);
    assert.equal((await service.resolveShare(token)).id, row.id);
    setRequestUser({ id: 'owner-1' });
    assert.equal(await service.revokeShare('meeting-1', row.id), true);
  } finally {
    setRequestUser(null);
  }
  assert.equal(await service.resolveShare(token), null);
  assert.equal(await service.resolveCode(code), null);
  assert.equal(calls.some(({ method }) => method === 'PATCH'), true);

  row.revoked_at = null;
  now += 60_001;
  assert.equal(await service.resolveShare(token), null);
  assert.equal(await service.resolveCode(code), null);
});
