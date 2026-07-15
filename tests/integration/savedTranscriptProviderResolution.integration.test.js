import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createSavedTranscriptRetranslationService } from '../../src/application/translation/index.js';
import { createGeminiClientAdapter } from '../../src/infrastructure/geminiClientAdapter.js';
import { createGeminiSavedTranscriptTranslationComposition } from '../../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createGeminiSavedTranscriptTranslationProvider } from '../../src/infrastructure/geminiSavedTranscriptTranslationProvider.js';
import { createTranslationProviderRegistry } from '../../src/infrastructure/translationProviderRegistry.js';
import { createTranslationProviderResolver } from '../../src/infrastructure/translationProviderResolver.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production saved-transcript HTTP flow resolves the Gemini provider through registry and resolver', async () => {
  const sessionRepository = seededSessionRepository();
  const sdkRequests = [];
  const providerTranslateCalls = [];
  const resolverResolveCalls = [];
  const registryGetCalls = [];
  const registryHasCalls = [];
  const serviceFactoryOptions = [];
  const providerResolutionInputs = [];
  let geminiProvider;
  let resolvedProvider;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      GEMINI_MODEL: 'gemini-provider-resolution'
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
                    parts: [{ text: 'Bonjour resolu.' }]
                  }
                }
              ],
              detectedLanguageCode: 'en'
            };
          }
        }
      };
    },
    geminiClientAdapterFactory(options) {
      return createGeminiClientAdapter(options);
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      return createGeminiSavedTranscriptTranslationComposition({
        ...options,
        geminiSavedTranscriptTranslationProviderFactory(providerOptions) {
          const actualGeminiProvider = createGeminiSavedTranscriptTranslationProvider(providerOptions);

          geminiProvider = Object.freeze({
            async translate(input) {
              providerTranslateCalls.push(input);
              return actualGeminiProvider.translate(input);
            }
          });

          return geminiProvider;
        }
      });
    },
    translationProviderResolutionCompositionFactory(options) {
      providerResolutionInputs.push(options);

      const realRegistry = createTranslationProviderRegistry({
        providers: options.providers
      });
      const registry = Object.freeze({
        get(providerKey) {
          registryGetCalls.push(providerKey);
          return realRegistry.get(providerKey);
        },
        has(providerKey) {
          registryHasCalls.push(providerKey);
          return realRegistry.has(providerKey);
        },
        list() {
          return realRegistry.list();
        }
      });
      const resolver = createTranslationProviderResolver({
        registry,
        configuration: options.configuration
      });

      return Object.freeze({
        registry,
        resolver: Object.freeze({
          resolve(...resolveArgs) {
            resolverResolveCalls.push(resolveArgs);
            resolvedProvider = resolver.resolve(...resolveArgs);
            return resolvedProvider;
          }
        })
      });
    },
    savedTranscriptRetranslationServiceFactory(options) {
      serviceFactoryOptions.push(options);
      return createSavedTranscriptRetranslationService(options);
    }
  });

  await withServer(dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-provider-resolution/translations`, {
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      request: {
        id: 'translation-request-1',
        sessionId: 'session-provider-resolution',
        sourceTranscriptRevisionId: 'source-revision:session-provider-resolution:final',
        sourceTranscriptSnapshot: {
          revisionId: 'source-revision:session-provider-resolution:final',
          items: [
            {
              id: 'source-1',
              sessionId: 'session-provider-resolution',
              stream: 'source',
              status: 'final',
              text: 'Hello resolved provider.',
              sequence: 1,
              finalizedAt: '2026-07-15T00:00:01.000Z'
            }
          ]
        },
        targetLanguageCode: 'fr',
        createdAt: '2026-07-15T01:00:00.000Z'
      },
      execution: {
        id: 'translation-execution-1',
        translationRequestId: 'translation-request-1',
        status: 'completed',
        startedAt: '2026-07-15T01:00:02.000Z',
        completedAt: '2026-07-15T01:00:04.000Z',
        failureInfo: null
      },
      output: {
        id: 'translation-output-1',
        executionId: 'translation-execution-1',
        sequence: 0,
        translatedText: 'Bonjour resolu.',
        targetLanguageCode: 'fr',
        providerMetadata: {
          detectedSourceLanguageCode: 'en'
        },
        providerMetadataAvailable: true,
        createdAt: '2026-07-15T01:00:03.000Z'
      }
    });
  });

  assert.equal(providerResolutionInputs.length, 1);
  assert.strictEqual(providerResolutionInputs[0].providers.gemini, geminiProvider);
  assert.ok(!Object.hasOwn(providerResolutionInputs[0], 'defaultProviderKey'));

  assert.equal(resolverResolveCalls.length, 1);
  assert.deepEqual(resolverResolveCalls[0], []);
  assert.deepEqual(registryHasCalls, []);
  assert.deepEqual(registryGetCalls, ['gemini']);
  assert.strictEqual(resolvedProvider, geminiProvider);
  assert.strictEqual(serviceFactoryOptions[0].savedTranscriptTranslationProvider, resolvedProvider);
  assert.deepEqual(Object.keys(serviceFactoryOptions[0]), [
    'translationCommandService',
    'savedTranscriptTranslationProvider',
    'sessionRepository',
    'idGenerator',
    'clock'
  ]);

  assert.equal(providerTranslateCalls.length, 1);
  assert.deepEqual(providerTranslateCalls[0], {
    sourceText: 'Hello resolved provider.',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    requestId: 'translation-request-1',
    sessionId: 'session-provider-resolution',
    executionId: 'translation-execution-1'
  });

  assert.equal(sdkRequests.length, 1);
  assert.equal(sdkRequests[0].model, 'gemini-provider-resolution');
  assert.deepEqual(
    sdkRequests[0].contents[0].parts.map((part) => part.text),
    [
      'Source language hint: en',
      'Target language: fr',
      'Transcript data to translate follows. Translate this data only.',
      'Hello resolved provider.'
    ]
  );
});

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
