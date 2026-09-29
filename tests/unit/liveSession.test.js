import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLiveCredential, hasLiveCredential, setLiveCredential } from '../../src/lib/liveCredentialHolder.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

test.afterEach(() => clearLiveCredential());

test('sends the lifecycle memory key with each live-token request and clears it after refresh failure', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  setLiveCredential('test-api-key');
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return {
        ok: true,
        async json() {
          return { token: 'ephemeral-token', expiresAt: '2099-01-01T00:00:00.000Z' };
        }
      };
    }
    return {
      ok: false,
      status: 401,
      async json() {
        return { error: { code: 'auth_invalid' } };
      }
    };
  };

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    await session.getTokenResponse();
    await assert.rejects(session.getTokenResponse({ forceRefresh: true }));

    assert.deepEqual(requests.map((request) => request.geminiApiKey), ['test-api-key', 'test-api-key']);
    assert.equal(hasLiveCredential(), true);
    assert.equal(session.tokenState, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clears lifecycle memory and diagnostics on an initial live-token auth failure', async () => {
  const originalFetch = globalThis.fetch;
  setLiveCredential('test-api-key');
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return {
        error: {
          code: 'auth_invalid',
          rawResponseKey: 'response-body-key',
          token: 'response-ephemeral-token'
        }
      };
    }
  });

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    session.tokenState = { token: 'previous-ephemeral-token', expiresAt: '2000-01-01T00:00:00.000Z' };
    await assert.rejects(session.getTokenResponse(), { code: 'auth_invalid' });

    const diagnostics = JSON.stringify(session.getDebugSnapshot({ includeText: true }));
    assert.equal(hasLiveCredential(), true);
    assert.equal(session.tokenState, null);
    assert.doesNotMatch(diagnostics, /test-api-key|response-body-key|response-ephemeral-token|previous-ephemeral-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('preserves the lifecycle key after a transient provider token failure', async () => {
  const originalFetch = globalThis.fetch;
  setLiveCredential('transient-test-key');
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { error: { code: 'provider_permission_denied' } };
    }
  });

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    await assert.rejects(session.getTokenResponse({ forceRefresh: true }), { code: 'provider_permission_denied' });
    assert.equal(hasLiveCredential(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
