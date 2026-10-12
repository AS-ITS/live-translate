import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestUser } from '../../server/requestIdentity.js';
import { createSupabaseGlossary } from '../../src/infrastructure/supabaseGlossary.js';

test('Supabase glossary preserves every target translation when creating and updating an entry', async () => {
  const requests = [];
  const glossary = createSupabaseGlossary({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'service-key'
    },
    idFactory: () => '75eb24c0-f432-4fb7-9d88-9ab4c8728473',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      const row = Array.isArray(body) ? body[0] : body;
      return {
        ok: true,
        status: options.method === 'POST' ? 201 : 200,
        async json() { return [row]; }
      };
    }
  });

  setRequestUser({ id: 'user-a' });
  try {
    const created = await glossary.createEntry({
      source: '麥克風',
      sourceLanguageCode: 'zh-Hant',
      translations: { en: 'Microphone', ja: 'マイク' }
    });
    const updated = await glossary.updateEntry(created.id, {
      ...created,
      translations: { en: 'Microphone', ja: 'マイク', ko: '마이크' }
    });

    assert.deepEqual(created.translations, { en: 'Microphone', ja: 'マイク' });
    assert.deepEqual(updated.translations, { en: 'Microphone', ja: 'マイク', ko: '마이크' });
    assert.deepEqual(JSON.parse(requests[0].options.body)[0].translations, created.translations);
    assert.deepEqual(JSON.parse(requests[1].options.body).translations, updated.translations);
    assert.equal(JSON.parse(requests[1].options.body).target_language_code, 'en');
    assert.equal(JSON.parse(requests[1].options.body).translation, 'Microphone');
  } finally {
    setRequestUser(null);
  }
});

test('Supabase glossary reads legacy scalar translation rows', async () => {
  const glossary = createSupabaseGlossary({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'service-key'
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return [{
          id: 'entry-legacy',
          source: '會議室',
          source_language_code: 'zh-Hant',
          target_language_code: 'en',
          translation: 'Meeting room',
          translations: {}
        }];
      }
    })
  });

  setRequestUser({ id: 'user-a' });
  try {
    const entries = await glossary.listEntries();
    assert.deepEqual(entries[0].translations, { en: 'Meeting room' });
  } finally {
    setRequestUser(null);
  }
});
