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

test('createLiveToken maps Gemini token response', async () => {
  const client = {
    authTokens: {
      async create() {
        return { name: 'test-token' };
      }
    }
  };

  const result = await createLiveToken(
    { targetLanguageCode: 'en' },
    { client, now: new Date('2026-07-06T00:00:00.000Z') }
  );

  assert.deepEqual(result, {
    token: 'test-token',
    expiresAt: '2026-07-06T00:30:00.000Z'
  });
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
