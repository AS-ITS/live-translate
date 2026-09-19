import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestScope, setRequestUser } from '../../server/requestIdentity.js';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';

test('member CRUD uses the actor JWT for an owner-scoped resource', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'service-key',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return []; } };
    }
  });
  setRequestUser({ id: 'member-a', ownerUserId: 'owner-a', actorUserId: 'member-a' });
  setRequestScope({ actorUserId: 'member-a', resourceOwnerUserId: 'owner-a', accessToken: 'member-jwt', capability: 'user' });
  await repository.getMeeting('meeting-a');
  assert.equal(calls[0].init.headers.apikey, 'publishable-key');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer member-jwt');
  assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /service-key/);
  setRequestScope(null);
  setRequestUser(null);
});

test('scoped user CRUD fails closed when the publishable key is unavailable', async () => {
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return []; } })
  });
  setRequestUser({ id: 'member-a', ownerUserId: 'owner-a', actorUserId: 'member-a' });
  setRequestScope({ actorUserId: 'member-a', resourceOwnerUserId: 'owner-a', accessToken: 'member-jwt', capability: 'user' });
  await assert.rejects(repository.getMeeting('meeting-a'), { code: 'cloud_capability_unavailable', status: 503 });
  setRequestScope(null);
  setRequestUser(null);
});
