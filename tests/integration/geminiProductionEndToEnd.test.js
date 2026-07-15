import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createSavedTranscriptRetranslationService } from '../../src/application/translation/index.js';
import { createGeminiSavedTranscriptTranslationProvider } from '../../src/infrastructure/geminiSavedTranscriptTranslationProvider.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production HTTP translation flow invokes Gemini SDK generateContent exactly once', async () => {
  const sdkRequests = [];
  const serviceProviders = [];
  let productionProvider;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      GEMINI_MODEL: 'gemini-production-wp6'
    },
    sessionRepository: seededSessionRepository(),
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
      productionProvider = createGeminiSavedTranscriptTranslationProvider({ client, model });

      return {
        savedTranscriptTranslationProvider: productionProvider
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      serviceProviders.push(options.savedTranscriptTranslationProvider);
      return createSavedTranscriptRetranslationService(options);
    }
  });

  await withServer(dependencies.requestHandler, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/saved-transcripts/session-wp6/translations`, {
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    });

    assert.equal(response.status, 201);
    assert.strictEqual(serviceProviders[0], productionProvider);
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

    assert.equal(response.body.output.translatedText, 'TRADUCTION INCHANGEE');
    assert.equal(response.body.output.targetLanguageCode, 'fr');
    assert.deepEqual(response.body.output.providerMetadata, {
      detectedSourceLanguageCode: 'en'
    });
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
