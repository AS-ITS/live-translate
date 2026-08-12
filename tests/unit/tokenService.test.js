import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LIVE_TRANSLATE_MODEL,
  buildTokenConfig,
  createLiveToken,
  resolveLiveTranslateModel
} from '../../server/tokenService.js';

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
