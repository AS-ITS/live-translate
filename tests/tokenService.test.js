import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTokenConfig, createLiveToken, normalizeTokenRequest } from '../server/tokenService.js';

test('normalizeTokenRequest accepts valid language and defaults echoTargetLanguage', () => {
  assert.deepEqual(normalizeTokenRequest({ targetLanguageCode: 'ja' }), {
    targetLanguageCode: 'ja',
    echoTargetLanguage: true
  });
});

test('normalizeTokenRequest rejects unsupported language', () => {
  assert.throws(() => normalizeTokenRequest({ targetLanguageCode: 'xx' }), {
    message: 'Unsupported targetLanguageCode',
    status: 400
  });
});

test('normalizeTokenRequest rejects supplied blank or malformed language instead of defaulting', () => {
  for (const targetLanguageCode of ['', ' ', 'zh-TW', ['ja']]) {
    assert.throws(() => normalizeTokenRequest({ targetLanguageCode }), {
      message: 'Unsupported targetLanguageCode',
      status: 400
    });
  }
});

test('buildTokenConfig locks live translate model and audio settings', () => {
  const config = buildTokenConfig(
    { targetLanguageCode: 'zh-Hant', echoTargetLanguage: false },
    new Date('2026-07-06T00:00:00.000Z')
  );

  assert.equal(config.uses, 1);
  assert.equal(config.expireTime, '2026-07-06T00:30:00.000Z');
  assert.equal(config.newSessionExpireTime, '2026-07-06T00:01:00.000Z');
  assert.equal(config.liveConnectConstraints.model, 'gemini-3.5-live-translate-preview');
  assert.deepEqual(config.liveConnectConstraints.config.responseModalities, ['AUDIO']);
  assert.equal(config.liveConnectConstraints.config.generationConfig.translationConfig.targetLanguageCode, 'zh-Hant');
  assert.equal(config.liveConnectConstraints.config.generationConfig.translationConfig.echoTargetLanguage, false);
  assert.deepEqual(config.httpOptions, { apiVersion: 'v1alpha' });
});

test('buildTokenConfig includes live glossary instruction only when entries are provided', () => {
  const config = buildTokenConfig(
    {
      targetLanguageCode: 'ja',
      echoTargetLanguage: true,
      glossaryEntries: [{ source: 'Codex', target: 'コーデックス' }]
    },
    new Date('2026-07-06T00:00:00.000Z')
  );

  const text = config.liveConnectConstraints.config.systemInstruction.parts[0].text;
  assert.match(text, /Glossary instructions/);
  assert.match(text, /Source term: Codex/);
  assert.match(text, /Required translation: コーデックス/);
  assert.equal(buildTokenConfig({ targetLanguageCode: 'ja', echoTargetLanguage: true }).liveConnectConstraints.config.systemInstruction, undefined);
});

test('createLiveToken maps Gemini token response', async () => {
  let tokenConfig;
  const client = {
    authTokens: {
      async create({ config }) {
        tokenConfig = config;
        return { name: 'test-token' };
      }
    }
  };

  const result = await createLiveToken(
    { targetLanguageCode: 'en' },
    { client, now: new Date('2026-07-06T00:00:00.000Z') }
  );

  assert.equal(result.token, 'test-token');
  assert.equal(result.expiresAt, '2026-07-06T00:30:00.000Z');
  assert.deepEqual(result.liveConnectConfig, tokenConfig.liveConnectConstraints.config);
  assert.deepEqual(result.liveGlossaryEntries, []);
});

test('createLiveToken resolves live-scoped glossary entries for token and browser config', async () => {
  let requestedScope;
  let tokenConfig;
  const client = {
    authTokens: {
      async create({ config }) {
        tokenConfig = config;
        return { name: 'test-token' };
      }
    }
  };
  const glossary = {
    async entriesFor(targetLanguageCode, options) {
      assert.equal(targetLanguageCode, 'ja');
      requestedScope = options.scope;
      return [{ source: 'Codex', target: 'コーデックス', replacementAliases: ['code x'] }];
    }
  };

  const result = await createLiveToken(
    { targetLanguageCode: 'ja' },
    { client, glossary, now: new Date('2026-07-06T00:00:00.000Z') }
  );

  assert.equal(requestedScope, 'live');
  assert.deepEqual(result.liveConnectConfig, tokenConfig.liveConnectConstraints.config);
  assert.deepEqual(result.liveGlossaryEntries, [{ source: 'Codex', target: 'コーデックス', replacementAliases: ['code x'] }]);
  assert.match(result.liveConnectConfig.systemInstruction.parts[0].text, /Codex/);
});

test('createLiveToken maps provider failures to 502', async () => {
  const client = {
    authTokens: {
      async create() {
        throw new Error('provider down');
      }
    }
  };

  await assert.rejects(() => createLiveToken({ targetLanguageCode: 'en' }, { client }), {
    message: 'Failed to create Gemini ephemeral token',
    status: 502
  });
});
