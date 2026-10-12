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
  assert.match(result.liveConnectConfig.systemInstruction.parts[0].text, /replacement rule, not an additional hint/);
  assert.match(result.liveConnectConfig.systemInstruction.parts[0].text, /once for each corresponding occurrence of the source term/);
  assert.match(result.liveConnectConfig.systemInstruction.parts[0].text, /Preserve intentional repetitions, repeated words, pauses, and distinct utterances/);
  assert.match(result.liveConnectConfig.systemInstruction.parts[0].text, /Do not summarize, collapse, or omit repeated speech/);
});

test('createLiveToken merges global and meeting glossary entries in provider config', async () => {
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

  assert.deepEqual(result.liveGlossaryEntries, [
    { source: 'global', target: '全域', replacementAliases: [] },
    { source: 'Acme', target: 'アクメ', replacementAliases: ['ACME'] }
  ]);
  const instruction = tokenConfig.liveConnectConstraints.config.systemInstruction.parts[0].text;
  assert.match(instruction, /current target language/);
  assert.match(instruction, /Source term: global\nRequired translation: 全域/);
  assert.match(instruction, /Source term: Acme\nRequired translation: アクメ/);
});

test('createLiveToken lets meeting glossary override the same global source in provider config', async () => {
  let tokenConfig;
  const client = { authTokens: { async create({ config }) { tokenConfig = config; return { name: 'meeting-token' }; } } };
  const result = await createLiveToken(
    { targetLanguageCode: 'en', meetingId: 'meeting-1' },
    {
      client,
      glossary: { entriesFor: async () => [{ source: 'Acme', target: 'Global Acme', replacementAliases: [] }] },
      meetingRepository: { async getMeeting() { return { id: 'meeting-1', glossaryEntries: [{ source: 'Acme', target: 'Meeting Acme', replacementAliases: [] }] }; } }
    }
  );

  assert.deepEqual(result.liveGlossaryEntries, [{ source: 'Acme', target: 'Meeting Acme', replacementAliases: [] }]);
  const instruction = tokenConfig.liveConnectConstraints.config.systemInstruction.parts[0].text;
  assert.match(instruction, /Required translation: Meeting Acme/);
  assert.doesNotMatch(instruction, /Required translation: Global Acme/);
});

test('createLiveToken waits for global glossary before creating a meeting token', async () => {
  let resolveEntries;
  let tokenCreates = 0;
  const pendingEntries = new Promise((resolve) => { resolveEntries = resolve; });
  const token = createLiveToken(
    { targetLanguageCode: 'en', meetingId: 'meeting-1' },
    {
      client: { authTokens: { async create() { tokenCreates += 1; return { name: 'meeting-token' }; } } },
      glossary: { entriesFor: async () => pendingEntries },
      meetingRepository: { async getMeeting() { return { id: 'meeting-1', glossaryEntries: [] }; } }
    }
  );

  await Promise.resolve();
  assert.equal(tokenCreates, 0);
  resolveEntries([{ source: 'global', target: 'Global term', replacementAliases: [] }]);
  const result = await token;
  assert.deepEqual(result.liveGlossaryEntries, [{ source: 'global', target: 'Global term', replacementAliases: [] }]);
  assert.equal(tokenCreates, 1);
});

test('meeting-private glossary wins and active Segment snapshot survives token rebuild', async () => {
  const createdConfigs = [];
  const client = { authTokens: { async create({ config }) { createdConfigs.push(config); return { name: `token-${createdConfigs.length}` }; } } };
  const settingsSnapshot = {
    glossaryEntries: [{ source: '你好', target: 'Hi', replacementAliases: [] }],
    privateGlossaryEntries: [{ source: '你好', translations: { en: 'speak Hi' }, replacementAliases: { en: [] } }]
  };
  const meetingRepository = {
    async getMeeting() {
      return { id: 'meeting-1', ...settingsSnapshot };
    },
    async listMeetingSegments() {
      return [{ id: 'segment-1', sequence: 1, status: 'active', settingsSnapshot }];
    }
  };

  const first = await createLiveToken({ targetLanguageCode: 'en', meetingId: 'meeting-1' }, { client, meetingRepository });
  const rebuilt = await createLiveToken({ targetLanguageCode: 'en', meetingId: 'meeting-1' }, { client, meetingRepository });

  const expected = [{ source: '你好', target: 'speak Hi', replacementAliases: ['Hi'] }];
  assert.deepEqual(first.liveGlossaryEntries, expected);
  assert.deepEqual(rebuilt.liveGlossaryEntries, expected);
  for (const config of createdConfigs) {
    const instruction = config.liveConnectConstraints.config.systemInstruction.parts[0].text;
    assert.match(instruction, /Source term: 你好\nRequired translation: speak Hi/);
    assert.equal((instruction.match(/Source term: 你好/g) || []).length, 1);
  }
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

test('createLiveToken never falls back to process.env.GEMINI_API_KEY', async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'environment-only-key';
  try {
    await assert.rejects(() => createLiveToken({ targetLanguageCode: 'en' }), {
      message: 'GEMINI_API_KEY is not configured',
      status: 500
    });
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test('authoritative Segment freezes global glossary until the next Segment boundary', async () => {
  const client = { authTokens: { async create() { return { name: 'token' }; } } };
  const result = await createLiveToken(
    { targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant', meetingId: 'meeting-1' },
    {
      client,
      glossary: { entriesFor: async () => [{ source: '你好', target: 'current-global' }] },
      meetingRepository: { async getMeeting() { return { id: 'meeting-1' }; } },
      authoritativeSegment: {
        settingsSnapshot: {
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en',
          globalGlossaryEntries: [{ source: '你好', target: 'snapshot-global' }],
          glossaryEntries: [{ source: '你好', target: 'meeting-wins' }],
          privateGlossaryEntries: []
        }
      }
    }
  );
  assert.deepEqual(result.liveGlossaryEntries, [
    { source: '你好', target: 'meeting-wins', replacementAliases: [] }
  ]);
});
