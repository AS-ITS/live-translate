import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiCredentialRepository } from '../../server/geminiCredentialRepository.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('credential repository calls service-role RPCs without exposing plaintext in metadata', async () => {
  const calls = [];
  const repository = createGeminiCredentialRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/upsert_my_gemini_credential')) return response([{ configured: true, last_four: '1234', key_version: 'vault-v1' }]);
      if (url.endsWith('/read_my_gemini_key')) return response([{ api_key: 'secret-api-key' }]);
      return response([{ configured: true, last_four: '1234', key_version: 'vault-v1' }]);
    }
  });

  const metadata = await repository.upsert('user-a', 'secret-api-key');
  assert.deepEqual(metadata, { configured: true, last_four: '1234', key_version: 'vault-v1' });
  assert.equal(await repository.resolveKey('user-a'), 'secret-api-key');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer service-key');
  assert.match(calls[0].init.body, /secret-api-key/);
});

test('credential repository is disabled without Supabase server configuration', () => {
  assert.equal(createGeminiCredentialRepository({ env: {} }), null);
});
