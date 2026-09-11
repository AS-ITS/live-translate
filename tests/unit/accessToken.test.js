import assert from 'node:assert/strict';
import test from 'node:test';
import { accessTokenHeaders, authenticatedFetch } from '../../src/lib/accessToken.js';

function fakeSupabase(session) {
  const calls = { getSession: 0, signOut: 0 };
  return {
    calls,
    auth: {
      async getSession() {
        calls.getSession += 1;
        return { data: { session: typeof session === 'function' ? session() : session } };
      },
      async signOut() { calls.signOut += 1; },
    },
  };
}

test('access token headers preserve caller headers and use the current Supabase session', async () => {
  const original = { 'Content-Type': 'application/json', 'X-Test': 'yes' };
  const supabase = fakeSupabase({ access_token: 'supabase-token' });
  const next = await accessTokenHeaders(original, supabase);
  assert.deepEqual(next, { ...original, Authorization: 'Bearer supabase-token' });
  assert.deepEqual(original, { 'Content-Type': 'application/json', 'X-Test': 'yes' });
});

test('authenticated fetch does not inject a fallback token when there is no session', async () => {
  const supabase = fakeSupabase(null);
  let received;
  const fetchImpl = authenticatedFetch((url, init) => {
    received = { url, init };
    return Promise.resolve({ ok: true });
  }, supabase);
  await fetchImpl('/api/sessions', { method: 'GET', headers: { Accept: 'application/json' } });
  assert.deepEqual(received.init.headers, { Accept: 'application/json' });
  assert.equal(supabase.calls.getSession, 1);
});

test('authenticated fetch gets the latest session for every request', async () => {
  let current = { access_token: 'first-token' };
  const supabase = fakeSupabase(() => current);
  const headers = [];
  const fetchImpl = authenticatedFetch((_url, init) => {
    headers.push(init.headers);
    return Promise.resolve({ ok: true });
  }, supabase);
  await fetchImpl('/api/one');
  current = { access_token: 'second-token' };
  await fetchImpl('/api/two');
  assert.deepEqual(headers, [
    { Authorization: 'Bearer first-token' },
    { Authorization: 'Bearer second-token' },
  ]);
  assert.equal(supabase.calls.getSession, 2);
});

test('auth API failures clear the Supabase session without logging the token', async () => {
  const supabase = fakeSupabase({ access_token: 'secret-token' });
  let requestedHeaders;
  const response = {
    status: 401,
    clone: () => ({ json: async () => ({ error: { code: 'auth_invalid' } }) }),
  };
  await authenticatedFetch((_url, init) => {
    requestedHeaders = init.headers;
    return Promise.resolve(response);
  }, supabase)('/api/private');
  assert.deepEqual(requestedHeaders, { Authorization: 'Bearer secret-token' });
  assert.equal(supabase.calls.signOut, 1);
});
