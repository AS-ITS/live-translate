import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestUser } from '../../server/requestIdentity.js';
import { createSupabaseGlossary } from '../../src/infrastructure/supabaseGlossary.js';

test('Supabase glossary lists entries using the timestamp ordering column', async () => {
  const calls = [];
  const glossary = createSupabaseGlossary({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            id: 'entry-1',
            owner_user_id: 'user-a',
            source: 'Codex',
            translation: 'Codex',
            source_language_code: 'zh-Hant',
            target_language_code: 'en',
            created_at: '2026-09-11T03:55:06.814Z',
            updated_at: '2026-09-11T03:55:06.814Z'
          }];
        }
      };
    }
  });

  setRequestUser({ id: 'user-a' });
  const entries = await glossary.listEntries();
  setRequestUser(null);

  assert.match(calls[0], /order=created_at\.asc/);
  assert.equal(entries[0].createdAt, '2026-09-11T03:55:06.814Z');
  assert.equal(entries[0].updatedAt, '2026-09-11T03:55:06.814Z');
});
