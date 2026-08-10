import assert from 'node:assert/strict';
import test from 'node:test';
import { accessTokenHeaders, authenticatedFetch } from '../../src/lib/accessToken.js';

test('access token headers preserve caller headers without mutating them', () => {
  const original = { 'Content-Type': 'application/json', 'X-Test': 'yes' };
  const next = accessTokenHeaders(original);

  assert.deepEqual(next, original);
  assert.notStrictEqual(next, original);
  assert.deepEqual(original, { 'Content-Type': 'application/json', 'X-Test': 'yes' });
});

test('authenticated fetch preserves request init and adds no empty token header', async () => {
  let received;
  const fetchImpl = authenticatedFetch((url, init) => {
    received = { url, init };
    return Promise.resolve({ ok: true });
  });
  const init = { method: 'GET', headers: { Accept: 'application/json' } };

  await fetchImpl('/api/sessions', init);

  assert.equal(received.url, '/api/sessions');
  assert.deepEqual(received.init.headers, { Accept: 'application/json' });
  assert.deepEqual(init, { method: 'GET', headers: { Accept: 'application/json' } });
});
