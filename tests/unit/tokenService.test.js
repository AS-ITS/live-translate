import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LIVE_TRANSLATE_MODEL,
  buildTokenConfig,
  classifyGeminiProviderError,
  createLiveToken,
  resolveLiveTranslateModel,
  safeGeminiProviderDiagnostic
} from '../../server/tokenService.js';

test('classifies and sanitizes provider token errors', () => {
  assert.equal(classifyGeminiProviderError({ status: 401, message: 'invalid API key' }), 'invalid_api_key');
  assert.equal(classifyGeminiProviderError({ status: 403, message: 'permission denied' }), 'permission_api_unavailable');
  assert.equal(classifyGeminiProviderError({ status: 404, message: 'model not found' }), 'invalid_model');
  assert.equal(classifyGeminiProviderError({ status: 400, message: 'context window compression is unsupported' }), 'invalid_live_config');
  assert.equal(classifyGeminiProviderError({ status: 400, message: 'languageCodes parameter is not supported' }), 'invalid_live_config');
  assert.equal(classifyGeminiProviderError({ status: 429, message: 'rate limit exceeded' }), 'rate_limit');
  const diagnostic = safeGeminiProviderDiagnostic({ status: 400, code: 'bad_request', message: 'https://example.test?key=AIzaSyA-secret token=secret' });
  assert.equal(diagnostic.category, 'unknown_provider_error');
  assert.equal(diagnostic.status, 400);
  assert.equal(diagnostic.code, 'bad_request');
  assert.match(diagnostic.message, /^\[redacted-url\] token=\[redacted\]$/);
  assert.doesNotMatch(diagnostic.message, /AIza|secret/);
});

test('buildTokenConfig accepts an explicit live translate model', () => {
  const config = buildTokenConfig(
    {
      targetLanguageCode: 'en',
      echoTargetLanguage: true,
      liveTranslateModel: 'gemini-live-env-model'
    },
    new Date('2026-07-06T00:00:00.000Z')
  );

  assert.equal(config.liveConnectConstraints.model, 'gemini-live-env-model');
});

test('resolveLiveTranslateModel reads and validates the environment model', () => {
  assert.equal(resolveLiveTranslateModel({}), DEFAULT_LIVE_TRANSLATE_MODEL);
  assert.equal(resolveLiveTranslateModel({ LIVE_TRANSLATE_MODEL: '  gemini-live-custom  ' }), 'gemini-live-custom');
  assert.throws(
    () => resolveLiveTranslateModel({ LIVE_TRANSLATE_MODEL: '   ' }),
    /^Error: Invalid LIVE_TRANSLATE_MODEL$/
  );
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
  assert.equal(result.liveConnectModel, DEFAULT_LIVE_TRANSLATE_MODEL);
  assert.deepEqual(result.liveConnectConfig, tokenConfig.liveConnectConstraints.config);
  assert.deepEqual(result.liveGlossaryEntries, []);
});

test('transcription token config enables resumption and context compression', () => {
  const config = buildTokenConfig({
    mode: 'transcription',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    echoTargetLanguage: false
  }, new Date('2026-07-06T00:00:00.000Z'));

  assert.equal(config.liveConnectConstraints.model, 'gemini-3.5-transcribe-live');
  assert.deepEqual(config.liveConnectConstraints.config.sessionResumption, {});
  assert.deepEqual(config.liveConnectConstraints.config.contextWindowCompression, { slidingWindow: {} });
  assert.equal(config.uses, 1);
  assert.equal(config.expireTime, '2026-07-06T00:30:00.000Z');
  assert.equal(config.newSessionExpireTime, '2026-07-06T00:01:00.000Z');
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

test('createLiveToken uses the meeting glossary snapshot instead of the global glossary', async () => {
  let tokenConfig;
  const client = { authTokens: { async create({ config }) { tokenConfig = config; return { name: 'meeting-token' }; } } };
  const result = await createLiveToken(
    { targetLanguageCode: 'ja', meetingId: 'meeting-1' },
    {
      client,
      glossary: { entriesFor: async () => [{ source: 'global', target: '全域' }] },
      meetingRepository: {
        async getMeeting(id) {
          assert.equal(id, 'meeting-1');
          return { glossaryEntries: [{ source: 'Acme', translations: { ja: 'アクメ' }, replacementAliases: { ja: ['ACME'] } }] };
        }
      }
    }
  );

  assert.deepEqual(result.liveGlossaryEntries, [{ source: 'Acme', target: 'アクメ', replacementAliases: ['ACME'] }]);
  assert.match(tokenConfig.liveConnectConstraints.config.systemInstruction.parts[0].text, /Acme/);
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
