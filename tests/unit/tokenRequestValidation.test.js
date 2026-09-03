import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIVE_TRANSLATE_MODEL, buildTokenConfig, normalizeTokenRequest } from '../../server/tokenService.js';

test('token request validation defaults target language and echo option', () => {
  assert.deepEqual(normalizeTokenRequest({}), {
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    echoTargetLanguage: true
  });
});

test('transcription token request selects source-only mode', () => {
  assert.deepEqual(normalizeTokenRequest({ mode: 'transcription', sourceLanguageCode: 'en' }), {
    mode: 'transcription',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'en',
    echoTargetLanguage: true
  });
});

test('token request validation preserves explicit echoTargetLanguage false', () => {
  assert.deepEqual(normalizeTokenRequest({ targetLanguageCode: 'ja', echoTargetLanguage: false }), {
    targetLanguageCode: 'ja',
    sourceLanguageCode: 'zh-Hant',
    echoTargetLanguage: false
  });
});

test('token request validation rejects unsupported target language', () => {
  assert.throws(() => normalizeTokenRequest({ targetLanguageCode: 'xx' }), {
    message: 'Unsupported targetLanguageCode',
    status: 400
  });
});

test('token request validation preserves valid source language', () => {
  assert.deepEqual(normalizeTokenRequest({ targetLanguageCode: 'ja', sourceLanguageCode: 'en' }), {
    targetLanguageCode: 'ja',
    sourceLanguageCode: 'en',
    echoTargetLanguage: true
  });
});

test('token request validation rejects unsupported source language', () => {
  assert.throws(() => normalizeTokenRequest({ targetLanguageCode: 'ja', sourceLanguageCode: 'xx' }), {
    message: 'Unsupported sourceLanguageCode',
    status: 400
  });
});

test('token request validation rejects malformed target language instead of defaulting', () => {
  for (const targetLanguageCode of ['', ' ', 'zh-TW', ['ja']]) {
    assert.throws(() => normalizeTokenRequest({ targetLanguageCode }), {
      message: 'Unsupported targetLanguageCode',
      status: 400
    });
  }
});

test('token config uses v1beta and single-use Gemini Live constraints', () => {
  const config = buildTokenConfig(
    { targetLanguageCode: 'en', echoTargetLanguage: true },
    new Date('2026-07-07T00:00:00.000Z')
  );

  assert.equal(config.uses, 1);
  assert.equal(config.expireTime, '2026-07-07T00:30:00.000Z');
  assert.equal(config.newSessionExpireTime, '2026-07-07T00:01:00.000Z');
  assert.equal(config.liveConnectConstraints.model, DEFAULT_LIVE_TRANSLATE_MODEL);
  assert.deepEqual(config.liveConnectConstraints.config.responseModalities, ['AUDIO']);
  assert.deepEqual(config.liveConnectConstraints.config.realtimeInputConfig, {
    automaticActivityDetection: {}
  });
  assert.equal(config.liveConnectConstraints.config.generationConfig.translationConfig.sourceLanguageCode, undefined);
  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /Primary input language hint: zh-Hant/);
  assert.deepEqual(config.httpOptions, { apiVersion: 'v1beta' });
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
  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /translated speech audio/);
  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /Source term: Gemini/);
  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /Primary input language hint: zh-Hant/);
});

test('transcription token config emits text-only verbatim input transcription', () => {
  const config = buildTokenConfig({ mode: 'transcription', sourceLanguageCode: 'zh-Hant' });
  assert.equal(config.liveConnectConstraints.model, 'gemini-3.5-transcribe-live');
  assert.deepEqual(config.liveConnectConstraints.config.responseModalities, ['TEXT']);
  assert.deepEqual(config.liveConnectConstraints.config.inputAudioTranscription, {
    mode: 'VERBATIM'
  });
  assert.equal(config.liveConnectConstraints.config.generationConfig, undefined);
  assert.match(config.liveConnectConstraints.config.systemInstruction.parts[0].text, /Primary input language hint: zh-Hant/);
});
