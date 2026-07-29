import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createSavedTranscriptRetranslationService } from '../../src/application/translation/index.js';
import { createGeminiSavedTranscriptTranslationComposition } from '../../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createTranslationProviderConfiguration } from '../../src/infrastructure/translationProviderConfiguration.js';
import { createTranslationProviderResolutionComposition } from '../../src/infrastructure/translationProviderResolutionComposition.js';
import { createTranslationProviderResolver } from '../../src/infrastructure/translationProviderResolver.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('saved-transcript HTTP retranslation uses explicit providerKey instead of configured default', async () => {
  const harness = createProviderSelectionHarness();

  await withServer(harness.dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-provider-resolution/translations`, {
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja',
      providerKey: 'fake'
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.output.translatedText, 'FAKE ja: Hello resolved provider.');
    assert.equal(response.body.output.targetLanguageCode, 'ja');
    assert.deepEqual(response.body.output.providerMetadata, {
      detectedSourceLanguageCode: 'en'
    });
  });

  assert.deepEqual(harness.providerConfigurations, [{ defaultProviderKey: 'gemini' }]);
  assert.equal(harness.providerResolutionInputs.length, 1);
  assert.deepEqual(Object.keys(harness.providerResolutionInputs[0].providers).sort(), ['fake', 'gemini']);
  assert.strictEqual(harness.providerResolutionInputs[0].providers.gemini, harness.geminiProvider());
  assert.strictEqual(harness.providerResolutionInputs[0].providers.fake, harness.fakeProvider);
  assert.ok(!Object.hasOwn(harness.providerResolutionInputs[0], 'defaultProviderKey'));

  assert.deepEqual(harness.resolverResolveCalls, [
    {
      providerKey: 'fake',
      configuration: { defaultProviderKey: 'gemini' }
    }
  ]);
  assert.deepEqual(harness.registryGetCalls, ['fake']);
  assert.deepEqual(harness.registryHasCalls, []);
  assert.deepEqual(harness.fakeProviderTranslateCalls, [
    {
      sourceText: 'Hello resolved provider.',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja',
      requestId: 'translation-request-1',
      sessionId: 'session-provider-resolution',
      executionId: 'translation-execution-1'
    }
  ]);
  assert.deepEqual(harness.geminiProviderTranslateCalls, []);
  assert.deepEqual(harness.sdkRequests, []);

  assert.deepEqual(persistedTranslationState(harness.sessionRepository).outputs.map((output) => output.translatedText), [
    'FAKE ja: Hello resolved provider.'
  ]);
});

test('saved-transcript HTTP retranslation uses configured default when providerKey is omitted', async () => {
  const harness = createProviderSelectionHarness({
    sdkText: 'GEMINI ja: Hello resolved provider.'
  });

  await withServer(harness.dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-provider-resolution/translations`, {
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja'
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.output.translatedText, 'GEMINI ja: Hello resolved provider.');
    assert.equal(response.body.output.targetLanguageCode, 'ja');
    assert.deepEqual(response.body.output.providerMetadata, {
      detectedSourceLanguageCode: 'en'
    });
  });

  assert.deepEqual(harness.providerConfigurations, [{ defaultProviderKey: 'gemini' }]);
  assert.deepEqual(harness.resolverResolveCalls, [
    {
      providerKey: undefined,
      configuration: { defaultProviderKey: 'gemini' }
    }
  ]);
  assert.deepEqual(harness.registryGetCalls, ['gemini']);
  assert.deepEqual(harness.registryHasCalls, []);
  assert.deepEqual(harness.fakeProviderTranslateCalls, []);
  assert.equal(harness.geminiProviderTranslateCalls.length, 1);
  assert.equal(harness.geminiProviderTranslateCalls[0].targetLanguageCode, 'ja');
  assert.equal(harness.sdkRequests.length, 1);
  assert.equal(harness.sdkRequests[0].model, 'gemini-provider-resolution-wp6');
  assert.deepEqual(
    harness.sdkRequests[0].contents[0].parts.map((part) => part.text),
    [
      'Source language hint: en',
      'Target language: ja',
      'Hello resolved provider.'
    ]
  );

  assert.deepEqual(persistedTranslationState(harness.sessionRepository).outputs.map((output) => output.translatedText), [
    'GEMINI ja: Hello resolved provider.'
  ]);
});

test('saved-transcript HTTP retranslation propagates unknown provider without fallback or persistence', async () => {
  const harness = createProviderSelectionHarness();

  await withServer(harness.dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-provider-resolution/translations`, {
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja',
      providerKey: 'does-not-exist'
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal(response.body.error.message, 'Unexpected server error.');
  });

  assert.deepEqual(harness.resolverResolveCalls, [
    {
      providerKey: 'does-not-exist',
      configuration: { defaultProviderKey: 'gemini' }
    }
  ]);
  assert.deepEqual(harness.registryGetCalls, ['does-not-exist']);
  assert.deepEqual(harness.registryHasCalls, []);
  assert.deepEqual(harness.fakeProviderTranslateCalls, []);
  assert.deepEqual(harness.geminiProviderTranslateCalls, []);
  assert.deepEqual(harness.sdkRequests, []);

  assert.equal(persistedTranslationState(harness.sessionRepository), undefined);
});

function createProviderSelectionHarness({ sdkText = 'GEMINI ja: Hello resolved provider.' } = {}) {
  const sessionRepository = seededSessionRepository();
  const sdkRequests = [];
  const fakeProviderTranslateCalls = [];
  const geminiProviderTranslateCalls = [];
  const resolverResolveCalls = [];
  const registryGetCalls = [];
  const registryHasCalls = [];
  const providerConfigurations = [];
  const providerResolutionInputs = [];
  let geminiProvider;

  const fakeProvider = Object.freeze({
    async translate(input) {
      fakeProviderTranslateCalls.push(input);
      return {
        translatedText: `FAKE ${input.targetLanguageCode}: ${input.sourceText}`,
        detectedSourceLanguageCode: input.sourceLanguageCode,
        providerKey: 'fake'
      };
    }
  });

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-provider-resolution-wp6',
      TRANSLATION_PROVIDER: 'gemini',
      DATA_DIR: join(tmpdir(), `live-translate-provider-resolution-${process.pid}`)
    },
    sessionRepository,
    requestHandlerFactory: createRequestHandler,
    idGenerator: deterministicIdGenerator(),
    clock: deterministicClock(),
    googleGenAIClientFactory() {
      return {
        models: {
          async generateContent(request) {
            sdkRequests.push(request);
            return {
              candidates: [
                {
                  content: {
                    parts: [{ text: sdkText }]
                  }
                }
              ],
              detectedLanguageCode: 'en'
            };
          }
        }
      };
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      const actualGeminiProvider = createGeminiSavedTranscriptTranslationComposition(options).savedTranscriptTranslationProvider;

      geminiProvider = Object.freeze({
        async translate(input) {
          geminiProviderTranslateCalls.push(input);
          return actualGeminiProvider.translate(input);
        }
      });

      return {
        savedTranscriptTranslationProvider: geminiProvider
      };
    },
    translationProviderConfigurationFactory(options) {
      const configuration = createTranslationProviderConfiguration(options);
      providerConfigurations.push(configuration);
      return configuration;
    },
    translationProviderResolutionCompositionFactory(options) {
      const providers = {
        ...options.providers,
        fake: fakeProvider
      };
      providerResolutionInputs.push({
        ...options,
        providers
      });

      return createTranslationProviderResolutionComposition({
        providers,
        configuration: options.configuration,
        resolverFactory({ registry, configuration }) {
          const recordingRegistry = Object.freeze({
            get(providerKey) {
              registryGetCalls.push(providerKey);
              return registry.get(providerKey);
            },
            has(providerKey) {
              registryHasCalls.push(providerKey);
              return registry.has(providerKey);
            },
            list() {
              return registry.list();
            }
          });
          const resolver = createTranslationProviderResolver({
            registry: recordingRegistry,
            configuration
          });

          return Object.freeze({
            resolve(resolveOptions) {
              resolverResolveCalls.push({
                providerKey: resolveOptions.providerKey,
                configuration: {
                  defaultProviderKey: resolveOptions.configuration.defaultProviderKey
                }
              });
              return resolver.resolve({
                providerKey: resolveOptions.providerKey
              });
            }
          });
        }
      });
    },
    savedTranscriptRetranslationServiceFactory(options) {
      return createSavedTranscriptRetranslationService(options);
    }
  });

  return {
    dependencies,
    sessionRepository,
    sdkRequests,
    fakeProvider,
    fakeProviderTranslateCalls,
    geminiProvider: () => geminiProvider,
    geminiProviderTranslateCalls,
    resolverResolveCalls,
    registryGetCalls,
    registryHasCalls,
    providerConfigurations,
    providerResolutionInputs
  };
}

function seededSessionRepository() {
  const repository = createMemorySessionRepository({
    now: () => '2026-07-15T00:00:00.000Z'
  });

  repository.createSessionRecord({
    id: 'session-provider-resolution',
    startedAt: '2026-07-15T00:00:00.000Z',
    targetLanguageCode: 'ja'
  });
  repository.appendTranscriptItem('session-provider-resolution', {
    id: 'translation-1',
    stream: 'translation',
    status: 'final',
    text: 'ignored existing translation',
    sequence: 1,
    finalizedAt: '2026-07-15T00:00:00.500Z'
  });
  repository.appendTranscriptItem('session-provider-resolution', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'Hello resolved provider.',
    sequence: 1,
    finalizedAt: '2026-07-15T00:00:01.000Z'
  });

  return repository;
}

function persistedTranslationState(sessionRepository) {
  const sessionDetail = sessionRepository.getSessionRecord('session-provider-resolution');
  return sessionDetail.sessionRecord.translationCommandState;
}

function deterministicIdGenerator() {
  const counters = new Map();

  return (prefix) => {
    const next = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function deterministicClock() {
  const values = [
    '2026-07-15T01:00:00.000Z',
    '2026-07-15T01:00:01.000Z',
    '2026-07-15T01:00:02.000Z',
    '2026-07-15T01:00:03.000Z',
    '2026-07-15T01:00:04.000Z'
  ];
  let index = 0;

  return () => values[index++] || values.at(-1);
}

async function withServer(handler, run) {
  const server = http.createServer(handler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}
