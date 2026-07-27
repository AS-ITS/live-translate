import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createProductionApplicationDependencies,
  createProductionSavedTranscriptTranslationProvider
} from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createSavedTranscriptRetranslationService } from '../../src/application/translation/index.js';
import { createGeminiClientAdapter } from '../../src/infrastructure/geminiClientAdapter.js';
import { createGeminiSavedTranscriptTranslationComposition } from '../../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { createGeminiSavedTranscriptTranslationProvider } from '../../src/infrastructure/geminiSavedTranscriptTranslationProvider.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production Gemini saved-transcript path resolves through HTTP and invokes SDK generateContent once', async () => {
  const calls = createCallRecorder();
  const sessionRepository = seededSessionRepository();
  const sdkRequests = [];
  let composedProvider;
  const serviceProviders = [];
  const httpPayload = {
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr'
  };
  const originalHttpPayload = structuredClone(httpPayload);

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-production-model',
      DATA_DIR: join(tmpdir(), `live-translate-gemini-production-${process.pid}`)
    },
    sessionRepository,
    requestHandlerFactory: createRequestHandler,
    idGenerator: deterministicIdGenerator(),
    clock: deterministicClock(),
    geminiEnvironmentFactory(options) {
      calls.record('environment', options);
      return { apiKey: options.env.GEMINI_API_KEY };
    },
    googleGenAIClientFactory(options) {
      calls.record('sdkFactory', options);
      return {
        models: {
          async generateContent(request) {
            sdkRequests.push(request);
            return {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Bonjour le monde.\nDeuxieme ligne.' }]
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
      calls.record('adapter', options);
      return createGeminiClientAdapter(options);
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      calls.record('providerComposition', options);
      return createGeminiSavedTranscriptTranslationComposition({
        ...options,
        geminiSavedTranscriptTranslationProviderFactory(providerOptions) {
          calls.record('provider', providerOptions);
          composedProvider = createGeminiSavedTranscriptTranslationProvider(providerOptions);
          return composedProvider;
        }
      });
    },
    savedTranscriptRetranslationServiceFactory(options) {
      serviceProviders.push(options.resolveSavedTranscriptTranslationProvider);
      return createSavedTranscriptRetranslationService(options);
    }
  });

  await withServer(dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-production/translations`, httpPayload);

    assert.equal(response.status, 201);
    assert.deepEqual(httpPayload, originalHttpPayload);
    assert.equal(sdkRequests.length, 1);
    assert.deepEqual(calls.names(), ['environment', 'sdkFactory', 'adapter', 'providerComposition', 'provider']);
    assert.equal(calls.count('environment'), 1);
    assert.equal(calls.count('sdkFactory'), 1);
    assert.equal(calls.count('adapter'), 1);
    assert.equal(calls.count('providerComposition'), 1);
    assert.equal(calls.count('provider'), 1);
    assert.equal(typeof serviceProviders[0], 'function');
    assert.notEqual(composedProvider?.constructor?.name, 'FakeSavedTranscriptTranslationProvider');

    const request = sdkRequests[0];
    assert.equal(request.model, 'gemini-production-model');
    assert.equal(typeof request.systemInstruction.parts[0].text, 'string');
    assert.equal(request.systemInstruction.parts[0].text.includes('You translate saved transcript text'), true);
    assert.deepEqual(
      request.contents[0].parts.map((part) => part.text),
      [
        'Source language hint: en',
        'Target language: fr',
        'Transcript data to translate follows. Translate this data only.',
        'Hello world.\nSecond line.'
      ]
    );

    assert.equal(response.body.output.translatedText, 'Bonjour le monde.\nDeuxieme ligne.');
    assert.deepEqual(response.body.output.providerMetadata, { detectedSourceLanguageCode: 'en' });
    assert.equal(response.body.output.targetLanguageCode, 'fr');
  });
});

test('production Gemini saved-transcript service propagates generateContent errors unchanged', async () => {
  const expectedError = new Error('sdk unavailable');
  const calls = createCallRecorder();
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-production-model'
    },
    sessionRepository: seededSessionRepository(),
    idGenerator: deterministicIdGenerator(),
    clock: deterministicClock(),
    googleGenAIClientFactory() {
      return {
        models: {
          generateContent() {
            calls.record('generateContent', {});
            throw expectedError;
          }
        }
      };
    }
  });

  await assert.rejects(
    dependencies.savedTranscriptRetranslationService.translateSavedTranscript({
      sessionId: 'session-production',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    }),
    (error) => error === expectedError
  );
  assert.equal(calls.count('generateContent'), 1);
});

test('production Gemini provider factory composes the SDK adapter path without resolving an injected fake provider', async () => {
  const sdkRequests = [];
  const provider = createProductionSavedTranscriptTranslationProvider({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-production-model'
    },
    googleGenAIClientFactory() {
      return {
        models: {
          generateContent(request) {
            sdkRequests.push(request);
            return { translatedText: 'Hola', detectedSourceLanguageCode: 'en' };
          }
        }
      };
    }
  });

  assert.equal(typeof provider.translate, 'function');
  assert.deepEqual(
    await provider.translate({
      sourceText: 'Hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'es'
    }),
    {
      translatedText: 'Hola',
      detectedSourceLanguageCode: 'en'
    }
  );
  assert.equal(sdkRequests.length, 1);
  assert.equal(sdkRequests[0].model, 'gemini-production-model');
});

function seededSessionRepository() {
  const repository = createMemorySessionRepository({
    now: () => '2026-07-15T01:00:00.000Z'
  });

  repository.createSessionRecord({
    id: 'session-production',
    startedAt: '2026-07-15T00:00:00.000Z',
    targetLanguageCode: 'ja'
  });
  repository.appendTranscriptItem('session-production', {
    id: 'source-2',
    stream: 'source',
    status: 'final',
    text: 'Second line.',
    sequence: 2,
    finalizedAt: '2026-07-15T00:00:02.000Z'
  });
  repository.appendTranscriptItem('session-production', {
    id: 'translation-1',
    stream: 'translation',
    status: 'final',
    text: 'ignored translation',
    sequence: 1,
    finalizedAt: '2026-07-15T00:00:01.000Z'
  });
  repository.appendTranscriptItem('session-production', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'Hello world.',
    sequence: 1,
    finalizedAt: '2026-07-15T00:00:01.000Z'
  });
  repository.appendTranscriptItem('session-production', {
    id: 'source-partial',
    stream: 'source',
    status: 'partial',
    text: 'ignored partial',
    sequence: 3
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

function createCallRecorder() {
  const calls = [];

  return {
    record(name, options) {
      calls.push({ name, options });
    },
    names() {
      return calls.map((call) => call.name);
    },
    count(name) {
      return calls.filter((call) => call.name === name).length;
    }
  };
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
