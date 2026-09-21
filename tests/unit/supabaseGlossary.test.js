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

test('Supabase glossary creates entries with UUID ids and ignores compatibility category ids', async () => {
  const requests = [];
  const glossary = createSupabaseGlossary({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      const row = JSON.parse(options.body)[0];
      return {
        ok: true,
        status: 201,
        async json() {
          return [{
            ...row,
            created_at: '2026-09-21T00:00:00.000Z',
            updated_at: '2026-09-21T00:00:00.000Z'
          }];
        }
      };
    }
  });

  setRequestUser({ id: 'user-a' });
  const entry = await glossary.createEntry({
    source: 'Codex',
    sourceLanguageCode: 'zh-Hant',
    translations: { en: 'Codex' },
    category: 'other',
    scope: 'live'
  });
  setRequestUser(null);

  const row = JSON.parse(requests[0].options.body)[0];
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(row.category_id, null);
  assert.equal(entry.id, row.id);
});

test('Supabase glossary provisions default categories for an owner without categories', async () => {
  const calls = [];
  let categories = [];
  const glossary = createSupabaseGlossary({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options = {}) => {
      const method = options.method || 'GET';
      calls.push({ url, options });
      if (method === 'GET') {
        return { ok: true, status: 200, async json() { return categories; } };
      }
      categories = JSON.parse(options.body);
      return { ok: true, status: 201, async json() { return categories; } };
    }
  });

  setRequestUser({ id: 'user-a' });
  const result = await glossary.listCategories();
  setRequestUser(null);

  assert.equal(result.length, 6);
  assert.deepEqual(result.map((category) => category.label), ['產品名稱', '部門／職能', '縮寫', '會議常用語', '技術名詞', '其他']);
  assert.ok(result.every((category) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(category.id)));
  assert.equal(calls.filter(({ options }) => (options.method || 'GET') === 'GET').length, 2);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 1);
});
