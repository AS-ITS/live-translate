import assert from 'node:assert/strict';
import test from 'node:test';
import { createStructuredLogger } from '../../src/infrastructure/structuredLogger.js';

test('provider diagnostic logs only the safe allowlist', () => {
  let output = '';
  const logger = createStructuredLogger({ write: (line) => { output = line; }, clock: () => '2026-09-24T00:00:00.000Z' });
  logger.log({
    event: 'gemini_token_provider_failure',
    requestId: 'request-1',
    stage: 'google_auth_token_request',
    deployment: 'production',
    hasSupabaseAccessToken: true,
    hasGeminiApiKey: true,
    geminiApiKeyLength: 53,
    model: 'gemini-3.5-live-translate-preview',
    apiVersion: 'v1beta',
    status: 403,
    code: 'PERMISSION_DENIED',
    category: 'permission_api_unavailable',
    tokenCreated: false,
    message: 'AIzaSyDoNotLogThis',
    authorization: 'Bearer supabase-jwt',
    token: 'ephemeral-token'
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.status, 403);
  assert.equal(parsed.tokenCreated, false);
  assert.equal(parsed.message, undefined);
  assert.doesNotMatch(output, /AIzaSyDoNotLogThis|supabase-jwt|ephemeral-token|authorization/i);
});
