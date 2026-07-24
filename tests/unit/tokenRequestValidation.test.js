import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIVE_TRANSLATE_MODEL, buildTokenConfig, normalizeTokenRequest } from '../../server/tokenService.js';

test('token request validation defaults target language and echo option', () => {
  assert.deepEqual(normalizeTokenRequest({}), {
    targetLanguageCode: 'en',
    echoTargetLanguage: true
  });
});

test('token request validation preserves explicit echoTargetLanguage false', () => {
  assert.deepEqual(normalizeTokenRequest({ targetLanguageCode: 'ja', echoTargetLanguage: false }), {
    targetLanguageCode: 'ja',
    echoTargetLanguage: false
  });
});

test('token request validation rejects unsupported target language', () => {
  assert.throws(() => normalizeTokenRequest({ targetLanguageCode: 'xx' }), {
    message: 'Unsupported targetLanguageCode',
    status: 400
  });
});

test('token config uses v1alpha and single-use Gemini Live constraints', () => {
  const config = buildTokenConfig(
    { targetLanguageCode: 'en', echoTargetLanguage: true },
    new Date('2026-07-07T00:00:00.000Z')
  );

  assert.equal(config.uses, 1);
  assert.equal(config.expireTime, '2026-07-07T00:30:00.000Z');
  assert.equal(config.newSessionExpireTime, '2026-07-07T00:01:00.000Z');
  assert.equal(config.liveConnectConstraints.model, DEFAULT_LIVE_TRANSLATE_MODEL);
  assert.deepEqual(config.liveConnectConstraints.config.responseModalities, ['AUDIO']);
  assert.deepEqual(config.httpOptions, { apiVersion: 'v1alpha' });
});

test('token config can carry live glossary instruction in connect constraints', () => {
  const config = buildTokenConfig(
    {
      targetLanguageCode: 'en',
      echoTargetLanguage: true,
      glossaryEntries: [{ source: 'Gemini', target: 'Gemini' }]
    },
    new Date('2026-07-07T00:00:00.000Z')
  );

  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /Glossary instructions/);
  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /Source term: Gemini/);
});
