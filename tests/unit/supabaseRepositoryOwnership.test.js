import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestUser } from '../../server/requestIdentity.js';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';

test('Supabase meeting repository scopes reads and writes to request owner', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return [{ id: 'meeting-a', owner_user_id: 'user-a', status: 'created', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }]; } };
    }
  });

  setRequestUser({ id: 'user-a' });
  const meeting = await repository.createMeeting({ id: 'meeting-a', createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(meeting.id, 'meeting-a');
  assert.match(calls[0].init.body, /user-a/);

  await repository.getMeeting('meeting-a');
  assert.match(calls[1].url, /owner_user_id=eq\.user-a/);
  setRequestUser(null);
});

test('Supabase meeting repository serializes numeric timestamps for Postgres', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return [{ id: 'meeting-a', owner_user_id: 'user-a', status: 'created', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }]; } };
    }
  });

  setRequestUser({ id: 'user-a' });
  await repository.createMeeting({ id: 'meeting-a', createdAt: 1789098906814 });
  setRequestUser(null);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body[0].created_at, '2026-09-11T03:55:06.814Z');
  assert.equal(body[0].updated_at, '2026-09-11T03:55:06.814Z');
});
