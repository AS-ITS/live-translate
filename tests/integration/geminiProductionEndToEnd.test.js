import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createSavedTranscriptRetranslationService } from '../../src/application/translation/index.js';
import { createGeminiSavedTranscriptTranslationProvider } from '../../src/infrastructure/geminiSavedTranscriptTranslationProvider.js';
import { createTranslationProviderRegistry } from '../../src/infrastructure/translationProviderRegistry.js';
import { createTranslationProviderResolver } from '../../src/infrastructure/translationProviderResolver.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production HTTP translation flow resolves and invokes the default Gemini provider exactly once', async () => {
  const sessionRepository = seededSessionRepository();
  const sdkRequests = [];
  const providerTranslateCalls = [];
  const resolverResolveCalls = [];
  const registryGetCalls = [];
  const registryHasCalls = [];
  const providerResolutionInputs = [];
  const serviceProviders = [];
  let productionProvider;
  let resolvedProvider;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      GEMINI_MODEL: 'gemini-production-wp6'
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
              translatedText: 'TRADUCTION INCHANGEE',
              detectedSourceLanguageCode: 'en'
            };
          }
        }
      };
    },
    geminiSavedTranscriptTranslationCompositionFactory({ client, model }) {
      const actualProvider = createGeminiSavedTranscriptTranslationProvider({ client, model });

      productionProvider = Object.freeze({
        async translate(input) {
          providerTranslateCalls.push(input);
          return actualProvider.translate(input);
        }
      });

      return {
        savedTranscriptTranslationProvider: productionProvider
      };
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
        }),
        resolve(resolveOptions) {
          resolverResolveCalls.push(resolveOptions);
          resolvedProvider = resolver.resolve({
            providerKey: resolveOptions.providerKey
          });
          return resolvedProvider;
        }
      });
    },
    savedTranscriptRetranslationServiceFactory(options) {
      serviceProviders.push(options.resolveSavedTranscriptTranslationProvider);
      return createSavedTranscriptRetranslationService(options);
    }
  });

  await withServer(dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-wp6/translations`, {
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      request: {
        id: 'translation-request-1',
        sessionId: 'session-wp6',
        sourceTranscriptRevisionId: 'source-revision:session-wp6:final',
        sourceTranscriptSnapshot: {
          revisionId: 'source-revision:session-wp6:final',
          items: [
            {
              id: 'source-1',
              sessionId: 'session-wp6',
              stream: 'source',
              status: 'final',
              text: 'First source sentence.',
              sequence: 1,
              finalizedAt: '2026-07-15T00:00:01.000Z'
            },
            {
              id: 'source-2',
              sessionId: 'session-wp6',
              stream: 'source',
              status: 'final',
              text: 'Second source sentence.',
              sequence: 2,
              finalizedAt: '2026-07-15T00:00:02.000Z'
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
        translatedText: 'TRADUCTION INCHANGEE',
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
  assert.strictEqual(providerResolutionInputs[0].providers.gemini, productionProvider);
  assert.ok(!Object.hasOwn(providerResolutionInputs[0], 'defaultProviderKey'));
  assert.equal(Object.keys(providerResolutionInputs[0].providers).length, 1);

  assert.equal(resolverResolveCalls.length, 1);
  assert.equal(resolverResolveCalls[0].providerKey, undefined);
  assert.strictEqual(resolverResolveCalls[0].configuration, providerResolutionInputs[0].configuration);
  assert.deepEqual(registryHasCalls, []);
  assert.deepEqual(registryGetCalls, ['gemini']);
  assert.strictEqual(resolvedProvider, productionProvider);
  assert.equal(typeof serviceProviders[0], 'function');

  assert.equal(providerTranslateCalls.length, 1);
  assert.deepEqual(providerTranslateCalls[0], {
    sourceText: 'First source sentence.\nSecond source sentence.',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    requestId: 'translation-request-1',
    sessionId: 'session-wp6',
    executionId: 'translation-execution-1'
  });

  assert.equal(sdkRequests.length, 1);
  const [request] = sdkRequests;
  assert.equal(request.model, 'gemini-production-wp6');
  assert.equal(request.systemInstruction.parts[0].text.includes('You translate saved transcript text'), true);
  assert.deepEqual(
    request.contents[0].parts.map((part) => part.text),
    [
      'Source language hint: en',
      'Target language: fr',
      'Transcript data to translate follows. Translate this data only.',
      'First source sentence.\nSecond source sentence.'
    ]
  );

  assert.deepEqual(sessionRepository.getSessionRecord('session-wp6').sessionRecord.translationCommandState, {
    requests: [
      {
        id: 'translation-request-1',
        sessionId: 'session-wp6',
        sourceTranscriptRevisionId: 'source-revision:session-wp6:final',
        sourceTranscriptSnapshot: {
          revisionId: 'source-revision:session-wp6:final',
          items: [
            {
              id: 'source-1',
              sessionId: 'session-wp6',
              stream: 'source',
              status: 'final',
              text: 'First source sentence.',
              sequence: 1,
              startedAt: undefined,
              finalizedAt: '2026-07-15T00:00:01.000Z'
            },
            {
              id: 'source-2',
              sessionId: 'session-wp6',
              stream: 'source',
              status: 'final',
              text: 'Second source sentence.',
              sequence: 2,
              startedAt: undefined,
              finalizedAt: '2026-07-15T00:00:02.000Z'
            }
          ]
        },
        targetLanguageCode: 'fr',
        createdAt: '2026-07-15T01:00:00.000Z'
      }
    ],
    executions: [
      {
        id: 'translation-execution-1',
        translationRequestId: 'translation-request-1',
        status: 'completed',
        startedAt: '2026-07-15T01:00:02.000Z',
        completedAt: '2026-07-15T01:00:04.000Z',
        failureInfo: null,
        providerIdempotencyKey: 'translation-execution:translation-execution-1',
        providerAttemptStatus: 'not_started',
        providerAttemptedAt: null,
        providerCompletedAt: null,
        providerResult: null
      }
    ],
    outputs: [
      {
        id: 'translation-output-1',
        executionId: 'translation-execution-1',
        sequence: 0,
        translatedText: 'TRADUCTION INCHANGEE',
        targetLanguageCode: 'fr',
        providerMetadata: {
          detectedSourceLanguageCode: 'en'
        },
        createdAt: '2026-07-15T01:00:03.000Z'
      }
    ]
  });
});

function seededSessionRepository() {
  const repository = createMemorySessionRepository({
    now: () => '2026-07-15T00:00:00.000Z'
  });

  repository.createSessionRecord({
    id: 'session-wp6',
    startedAt: '2026-07-15T00:00:00.000Z',
    targetLanguageCode: 'ja'
  });
  repository.appendTranscriptItem('session-wp6', {
    id: 'source-2',
    stream: 'source',
    status: 'final',
    text: 'Second source sentence.',
    sequence: 2,
    finalizedAt: '2026-07-15T00:00:02.000Z'
  });
  repository.appendTranscriptItem('session-wp6', {
    id: 'translation-1',
    stream: 'translation',
    status: 'final',
    text: 'ignored existing translation',
    sequence: 1,
    finalizedAt: '2026-07-15T00:00:01.000Z'
  });
  repository.appendTranscriptItem('session-wp6', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'First source sentence.',
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
