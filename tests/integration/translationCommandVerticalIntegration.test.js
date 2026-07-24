import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplicationDependencies, createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { TranslationExecution, TranslationOutput, TranslationRequest } from '../../src/domain/translation/index.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { GeminiHttpError } from '../../src/infrastructure/geminiClient.js';
import { createGeminiTranslationExecutionProvider as createDefaultGeminiTranslationExecutionProvider } from '../../src/infrastructure/geminiTranslationExecutionProvider.js';
import { createTranslationExecutionWorkerRuntime as createDefaultTranslationExecutionWorkerRuntime } from '../../src/infrastructure/translationExecutionWorkerRuntime.js';

test('POST /api/translation-requests creates a TranslationRequest through production composition wiring', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    asyncMethods: new Set(['createTranslationRequest'])
  });
  const input = translationRequestPayload({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ id: 'source-item-1', text: 'Hello', sequence: 0 }]
    }
  });
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-requests`, input);
    const calls = translationRepository.callsFor('createTranslationRequest');
    const storedRequest = translationRepository.translationRequests.get('request-1');

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(response.body, {
      id: 'request-1',
      sessionId: 'session-1',
      sourceTranscriptRevisionId: 'source-revision-1',
      targetLanguageCode: 'ja',
      sourceTranscriptSnapshot: {
        revisionId: 'source-revision-1',
        items: [{ id: 'source-item-1', text: 'Hello', sequence: 0 }]
      },
      createdAt: '2026-07-14T01:00:00.000Z'
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0] instanceof TranslationRequest, true);
    assert.notStrictEqual(calls[0][0], input);
    assert.strictEqual(storedRequest, calls[0][0]);
    assert.equal(storedRequest.id, 'request-1');
    assert.equal(storedRequest.sessionId, 'session-1');
    assert.equal(storedRequest.sourceTranscriptRevisionId, 'source-revision-1');
    assert.equal(storedRequest.targetLanguageCode, 'ja');
    assert.equal(storedRequest.createdAt, '2026-07-14T01:00:00.000Z');
    assert.deepEqual(storedRequest.sourceTranscriptSnapshot, input.sourceTranscriptSnapshot);
  });

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions accepts and queues a TranslationExecution through production composition wiring', async () => {
  const translationRepository = createTranslationRepositoryFixture();
  const input = translationExecutionPayload();
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl, dependencies) => {
    const response = await postJson(`${baseUrl}/api/translation-executions`, input);
    const calls = translationRepository.callsFor('createTranslationExecution');
    const storedExecution = translationRepository.translationExecutions.get('execution-1');

    assertQueuedExecutionResponse(response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0] instanceof TranslationExecution, true);
    assert.notStrictEqual(calls[0][0], input);
    assert.notStrictEqual(storedExecution, calls[0][0]);
    assert.equal(storedExecution.id, 'execution-1');
    assert.equal(storedExecution.translationRequestId, 'request-1');
    assert.equal(storedExecution.status, 'queued');
    assert.equal(storedExecution.startedAt, '2026-07-14T01:01:00.000Z');
    assertQueuedJob(dependencies);
    assertNoWorkerProcessing(translationRepository);
  });

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions preserves explicit providerKey through production HTTP to persistence', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-1',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const runtime = createRuntimeProviderResolutionFixture({
    responseBody: {
      translatedText: '[gemini:fr] hello',
      detectedSourceLanguageCode: 'en'
    }
  });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'gemini'
  });
  const before = structuredClone(input);

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response, { providerKey: 'gemini' });
      assert.deepEqual(runtime.httpCalls, []);
      assertQueuedSubmissionPersistence(translationRepository, { providerKey: 'gemini' });
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions does not call fake GeminiClient during submission', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-gemini-client',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const geminiClientCalls = [];
  const providerFactoryCalls = [];
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr'
  });
  const before = structuredClone(input);

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.strictEqual(
        dependencies.translationExecutionProviderResolver.resolve(undefined),
        dependencies.translationExecutionProviderResolver.resolve('gemini')
      );
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response);
      assert.equal(providerFactoryCalls.length, 1);
      assert.strictEqual(providerFactoryCalls[0].client, providerFactoryCalls[0].geminiClient);
      assert.deepEqual(geminiClientCalls, []);
      assertQueuedSubmissionPersistence(translationRepository);
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model'
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post() {
            throw new Error('Gemini HTTP client should not be called when fake GeminiClient is supplied');
          }
        };
      },
      geminiClientFactory({ httpClient, model }) {
        assert.equal(typeof httpClient.post, 'function');
        assert.equal(model, 'gemini-runtime-model');
        return {
          async translate(request) {
            geminiClientCalls.push(request);
            return {
              translatedText: `[gemini-client:${request.targetLanguageCode}] ${request.sourceText}`,
              detectedSourceLanguageCode: request.sourceLanguageCode
            };
          }
        };
      },
      geminiTranslationExecutionProviderFactory(options) {
        providerFactoryCalls.push({
          ...options,
          geminiClient: options.client
        });
        return createDefaultGeminiTranslationExecutionProvider(options);
      }
    }
  );

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions preserves omitted providerKey as undefined through production HTTP to persistence', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-2',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const runtime = createRuntimeProviderResolutionFixture({
    responseBody: {
      translatedText: '[gemini:fr] hello',
      detectedSourceLanguageCode: 'en'
    }
  });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr'
  });
  const before = structuredClone(input);

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response);
      assert.deepEqual(runtime.httpCalls, []);
      assertQueuedSubmissionPersistence(translationRepository);
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions dual-writes durable queue when feature is enabled', async () => {
  const durableQueueFilePath = join(
    tmpdir(),
    `live-translate-dual-write-${process.pid}-${Date.now()}-translation-queue.json`
  );
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-durable-queue',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const input = translationExecutionPayload({
    sourceText: 'hello durable queue',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr'
  });

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assertQueuedExecutionResponse(response);
      assertQueuedSubmissionPersistence(translationRepository);
      assert.equal(await dependencies.durableTranslationExecutionQueueRepository.size(), 1);
      assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.peek(), {
        executionId: 'execution-1',
        requestId: 'request-1',
        enqueuedAt: '2026-07-17T08:00:00.000Z',
        status: 'queued',
        fenceToken: 0,
        attempt: 0,
        availableAt: null,
        lastFailure: null
      });
      assert.deepEqual(JSON.parse(await fileSystem.readFile(durableQueueFilePath, 'utf8')), {
        items: [
          {
            executionId: 'execution-1',
            requestId: 'request-1',
            enqueuedAt: '2026-07-17T08:00:00.000Z',
            status: 'queued',
            fenceToken: 0,
            attempt: 0,
            availableAt: null,
            lastFailure: null
          }
        ]
      });
      assert.equal(dependencies.translationExecutionQueue.size(), 1);
      assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), {
        executionId: 'execution-1',
        requestId: 'request-1'
      });
      assert.equal(dependencies.translationExecutionQueue.size(), 0);
      assert.equal(await dependencies.durableTranslationExecutionQueueRepository.size(), 1);
      assertNoWorkerProcessing(translationRepository);
    },
    {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model',
        TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
        TRANSLATION_DURABLE_QUEUE_FILE: durableQueueFilePath
      },
      translationQueueClock: {
        now() {
          return '2026-07-17T08:00:00.000Z';
        }
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post() {
            throw new Error('Gemini HTTP client should not be called during submission');
          }
        };
      },
      geminiClientFactory() {
        return {
          async translate() {
            throw new Error('Gemini client should not execute during submission');
          }
        };
      },
      geminiTranslationExecutionProviderFactory(options) {
        return createDefaultGeminiTranslationExecutionProvider(options);
      }
    }
  );
});

test('POST queued execution is processed successfully by worker through production runner and provider', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-success',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'hello from persisted request',
            sourceLanguageCode: 'en'
          }
        })
      )
    ]
  });
  const geminiClientCalls = [];
  const providerFactoryCalls = [];
  const input = translationExecutionPayload();

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.equal(typeof dependencies.translationExecutionWorker.processNext, 'function');
      assert.strictEqual(
        dependencies.translationExecutionProviderResolver.resolve(undefined),
        dependencies.translationExecutionProviderResolver.resolve('gemini')
      );
      assertQueuedExecutionResponse(response);
      assert.deepEqual(geminiClientCalls, []);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'queued');
      assertNoWorkerProcessing(translationRepository);

      const queuedJob = dependencies.translationExecutionQueue.dequeue();
      assert.deepEqual(queuedJob, {
        executionId: 'execution-1',
        requestId: 'request-1'
      });
      assert.deepEqual(Object.keys(queuedJob), ['executionId', 'requestId']);
      dependencies.translationExecutionQueue.enqueue(queuedJob);

      const workerResult = await dependencies.translationExecutionWorker.processNext();

      assert.deepEqual(workerResult, { status: 'processed', executionId: 'execution-1' });
      assert.equal(providerFactoryCalls.length, 1);
      assert.equal(geminiClientCalls.length, 1);
      assert.deepEqual(geminiClientCalls[0], {
        sourceText: 'hello from persisted request',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr',
        providerIdempotencyKey: 'translation-execution:execution-1'
      });
      assert.equal(Object.hasOwn(geminiClientCalls[0], 'providerKey'), false);
      assertCompletedRuntimePersistence(translationRepository, {
        requestId: 'request-1',
        sessionId: 'session-runtime-success',
        executionId: 'execution-1',
        providerKey: undefined,
        translatedText: '[gemini-client:fr] hello from persisted request',
        targetLanguageCode: 'fr'
      });
      assertNoFailedExecutionPersistence(translationRepository);
      assert.equal(dependencies.translationExecutionQueue.dequeue(), null);
    },
    {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model'
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post() {
            throw new Error('Gemini HTTP client should not be called when fake GeminiClient is supplied');
          }
        };
      },
      geminiClientFactory({ httpClient, model }) {
        assert.equal(typeof httpClient.post, 'function');
        assert.equal(model, 'gemini-runtime-model');
        return {
          async translate(request) {
            geminiClientCalls.push(request);
            return {
              translatedText: `[gemini-client:${request.targetLanguageCode}] ${request.sourceText}`,
              detectedSourceLanguageCode: request.sourceLanguageCode
            };
          }
        };
      },
      geminiTranslationExecutionProviderFactory(options) {
        providerFactoryCalls.push(options);
        return createDefaultGeminiTranslationExecutionProvider(options);
      }
    }
  );
});

test('production worker runtime completes queued execution after start', async () => {
  const scheduler = createFakeScheduler();
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-start',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'hello from runtime start',
            sourceLanguageCode: 'en'
          }
        })
      )
    ]
  });
  const geminiClientCalls = [];
  const input = translationExecutionPayload();

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assertQueuedExecutionResponse(response);
      assert.equal(typeof dependencies.translationExecutionWorkerRuntime.start, 'function');
      assert.equal(dependencies.translationExecutionWorkerRuntime.isRunning(), false);
      assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'queued');
      assert.equal(dependencies.translationExecutionQueue.size(), 1);
      assert.deepEqual(geminiClientCalls, []);

      dependencies.translationExecutionWorkerRuntime.start();
      await scheduler.runNext();

      assert.equal(dependencies.translationExecutionWorkerRuntime.isRunning(), true);
      assert.equal(dependencies.translationExecutionQueue.size(), 0);
      assert.deepEqual(geminiClientCalls, [
        {
          sourceText: 'hello from runtime start',
          sourceLanguageCode: 'en',
          targetLanguageCode: 'fr',
          providerIdempotencyKey: 'translation-execution:execution-1'
        }
      ]);
      assertExecutionLifecycleFor(translationRepository, 'execution-1', ['created', 'queued', 'running', 'completed']);
      assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'completed');
      assert.equal(translationRepository.translationOutputs.get('execution-1-output-0').translatedText, '[runtime:fr] hello from runtime start');
    },
    productionRuntimeOptions({ scheduler, geminiClientCalls })
  );
});

test('production worker runtime stop and restart preserves queued FIFO work', async () => {
  const scheduler = createFakeScheduler();
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          id: 'request-1',
          sessionId: 'session-runtime-restart',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'first queued text',
            sourceLanguageCode: 'en'
          }
        })
      ),
      new TranslationRequest(
        translationRequestPayload({
          id: 'request-2',
          sessionId: 'session-runtime-restart',
          targetLanguageCode: 'de',
          sourceTranscriptSnapshot: {
            sourceText: 'second queued text',
            sourceLanguageCode: 'en'
          }
        })
      ),
      new TranslationRequest(
        translationRequestPayload({
          id: 'request-3',
          sessionId: 'session-runtime-restart',
          targetLanguageCode: 'ja',
          sourceTranscriptSnapshot: {
            sourceText: 'third queued text',
            sourceLanguageCode: 'en'
          }
        })
      )
    ]
  });
  const geminiClientCalls = [];

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const firstResponse = await postJson(
        `${baseUrl}/api/translation-executions`,
        translationExecutionPayload({ id: 'execution-1', translationRequestId: 'request-1' })
      );
      const secondResponse = await postJson(
        `${baseUrl}/api/translation-executions`,
        translationExecutionPayload({ id: 'execution-2', translationRequestId: 'request-2' })
      );

      assertQueuedExecutionResponse(firstResponse);
      assertQueuedExecutionResponse(secondResponse, { executionId: 'execution-2', requestId: 'request-2' });
      assert.equal(dependencies.translationExecutionQueue.size(), 2);

      dependencies.translationExecutionWorkerRuntime.start();
      await scheduler.runNext();

      assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'completed');
      assert.equal(translationRepository.translationExecutions.get('execution-2').status, 'queued');
      assert.deepEqual(geminiClientCalls.map((call) => call.sourceText), ['first queued text']);

      dependencies.translationExecutionWorkerRuntime.stop();
      const thirdResponse = await postJson(
        `${baseUrl}/api/translation-executions`,
        translationExecutionPayload({ id: 'execution-3', translationRequestId: 'request-3' })
      );
      await scheduler.runAll();

      assertQueuedExecutionResponse(thirdResponse, { executionId: 'execution-3', requestId: 'request-3' });
      assert.equal(dependencies.translationExecutionWorkerRuntime.isRunning(), false);
      assert.equal(translationRepository.translationExecutions.get('execution-2').status, 'queued');
      assert.equal(translationRepository.translationExecutions.get('execution-3').status, 'queued');
      assert.equal(dependencies.translationExecutionQueue.size(), 2);

      dependencies.translationExecutionWorkerRuntime.start();
      await scheduler.runNext();
      await scheduler.runNext();

      assert.deepEqual(geminiClientCalls.map((call) => call.sourceText), [
        'first queued text',
        'second queued text',
        'third queued text'
      ]);
      assertExecutionLifecycleFor(translationRepository, 'execution-1', ['created', 'queued', 'running', 'completed']);
      assertExecutionLifecycleFor(translationRepository, 'execution-2', ['created', 'queued', 'running', 'completed']);
      assertExecutionLifecycleFor(translationRepository, 'execution-3', ['created', 'queued', 'running', 'completed']);
      assert.equal(dependencies.translationExecutionQueue.size(), 0);
    },
    productionRuntimeOptions({ scheduler, geminiClientCalls })
  );
});

test('production worker runtime startup replays durable queue into active in-memory queue in FIFO order', async () => {
  const scheduler = createFakeScheduler();
  const durableQueueFilePath = join(
    tmpdir(),
    `live-translate-startup-replay-${process.pid}-${Date.now()}-translation-queue.json`
  );
  await fileSystem.writeFile(
    durableQueueFilePath,
    JSON.stringify(
      {
        items: [
          {
            executionId: 'execution-1',
            requestId: 'request-1',
            enqueuedAt: '2026-07-17T08:00:00.000Z'
          },
          {
            executionId: 'execution-2',
            requestId: 'request-2',
            enqueuedAt: '2026-07-17T08:00:01.000Z'
          },
          {
            executionId: 'execution-3',
            requestId: 'request-3',
            enqueuedAt: '2026-07-17T08:00:02.000Z'
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  );
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          id: 'request-1',
          sessionId: 'session-startup-replay',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'first replay text',
            sourceLanguageCode: 'en'
          }
        })
      ),
      new TranslationRequest(
        translationRequestPayload({
          id: 'request-2',
          sessionId: 'session-startup-replay',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'second replay text',
            sourceLanguageCode: 'en'
          }
        })
      ),
      new TranslationRequest(
        translationRequestPayload({
          id: 'request-3',
          sessionId: 'session-startup-replay',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'third replay text',
            sourceLanguageCode: 'en'
          }
        })
      )
    ],
    executions: [
      new TranslationExecution(
        translationExecutionPayload({
          id: 'execution-1',
          translationRequestId: 'request-1',
          status: 'queued'
        })
      ),
      new TranslationExecution(
        translationExecutionPayload({
          id: 'execution-2',
          translationRequestId: 'request-2',
          status: 'queued'
        })
      ),
      new TranslationExecution(
        translationExecutionPayload({
          id: 'execution-3',
          translationRequestId: 'request-3',
          status: 'queued'
        })
      )
    ]
  });
  const geminiClientCalls = [];

  await withProductionTranslationCommandServer(
    translationRepository,
    async (_baseUrl, dependencies) => {
      await dependencies.translationExecutionWorkerRuntime.start();

      assert.equal(await dependencies.durableTranslationExecutionQueueRepository.size(), 3);
      assert.deepEqual((await dependencies.durableTranslationExecutionQueueRepository.peek()).status, 'queued');
      assert.equal(dependencies.translationExecutionQueue.size(), 3);
      assert.equal(dependencies.translationExecutionWorkerRuntime.isRunning(), true);
      assert.equal(scheduler.pendingCount(), 1);

      assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
        status: 'processed',
        executionId: 'execution-1'
      });
      assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
        status: 'processed',
        executionId: 'execution-2'
      });
      assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
        status: 'processed',
        executionId: 'execution-3'
      });

      assert.deepEqual(
        geminiClientCalls.map((call) => call.sourceText),
        ['first replay text', 'second replay text', 'third replay text']
      );
      assert.equal(await dependencies.durableTranslationExecutionQueueRepository.size(), 0);
      assert.deepEqual(JSON.parse(await fileSystem.readFile(durableQueueFilePath, 'utf8')), { items: [] });
      assert.equal(dependencies.translationExecutionQueue.size(), 0);
    },
    {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model',
        TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
        TRANSLATION_DURABLE_QUEUE_FILE: durableQueueFilePath
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post() {
            throw new Error('Gemini HTTP client should not be called when fake GeminiClient is supplied');
          }
        };
      },
      geminiClientFactory() {
        return {
          async translate(request) {
            geminiClientCalls.push(request);
            return {
              translatedText: `[startup:${request.targetLanguageCode}] ${request.sourceText}`
            };
          }
        };
      },
      geminiTranslationExecutionProviderFactory(options) {
        return createDefaultGeminiTranslationExecutionProvider(options);
      },
      translationExecutionWorkerRuntimeFactory(options) {
        return createDefaultTranslationExecutionWorkerRuntime({
          ...options,
          scheduler,
          pollIntervalMs: 25
        });
      }
    }
  );
});

test('POST /api/translation-executions ignores production provider failure until worker processing', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-failure-1',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const providerError = new Error('runtime provider failed');
  const runtime = createRuntimeProviderResolutionFixture({ postError: providerError });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'gemini'
  });
  const before = structuredClone(input);

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);
      const storedRequest = translationRepository.translationRequests.get('request-1');
      const storedExecution = translationRepository.translationExecutions.get('execution-1');
      const storedOutputs = Array.from(translationRepository.translationOutputs.values());
      const updateCalls = translationRepository.callsFor('updateTranslationExecution');

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response, { providerKey: 'gemini' });
      assert.equal(storedRequest instanceof TranslationRequest, true);
      assert.equal(storedExecution instanceof TranslationExecution, true);
      assert.equal(storedExecution.status, 'queued');
      assert.equal(storedExecution.failureInfo, null);
      assert.equal(storedOutputs.length, 0);
      assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
      assert.deepEqual(executionStatusesFromUpdateCalls(updateCalls), ['queued']);
      assert.equal(updateCalls.some(([execution]) => execution.status === 'completed'), false);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.deepEqual(runtime.httpCalls, []);
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('worker processing rethrows provider error and persists failed lifecycle', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-worker-failure',
          targetLanguageCode: 'fr',
          sourceTranscriptSnapshot: {
            sourceText: 'hello failure path',
            sourceLanguageCode: 'en'
          }
        })
      )
    ]
  });
  const providerError = new GeminiHttpError({
    status: 503,
    code: 'server_error',
    message: 'Gemini HTTP request failed: server_error (503).'
  });
  const geminiClientCalls = [];
  const input = translationExecutionPayload({ providerKey: 'gemini' });

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response, { providerKey: 'gemini' });
      assert.deepEqual(geminiClientCalls, []);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'queued');
      assertNoWorkerProcessing(translationRepository);

      const queuedJob = dependencies.translationExecutionQueue.dequeue();
      assert.deepEqual(queuedJob, {
        executionId: 'execution-1',
        requestId: 'request-1'
      });
      assert.deepEqual(Object.keys(queuedJob), ['executionId', 'requestId']);
      dependencies.translationExecutionQueue.enqueue(queuedJob);

      await assert.rejects(
        dependencies.translationExecutionWorker.processNext(),
        (actualError) => actualError === providerError
      );

      assert.equal(geminiClientCalls.length, 1);
      assert.deepEqual(geminiClientCalls[0], {
        sourceText: 'hello failure path',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr',
        providerIdempotencyKey: 'translation-execution:execution-1'
      });
      assert.equal(Object.hasOwn(geminiClientCalls[0], 'providerKey'), false);
      assert.deepEqual(
        executionStatusesFromCreateAndUpdateCalls(
          translationRepository.callsFor('createTranslationExecution'),
          translationRepository.callsFor('updateTranslationExecution')
        ),
        ['created', 'queued', 'running', 'failed']
      );
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.equal(
        translationRepository
          .callsFor('updateTranslationExecution')
          .some(([execution]) => execution.status === 'completed'),
        false
      );
      const failedExecution = translationRepository.translationExecutions.get('execution-1');
      const persistedRequest = translationRepository.translationRequests.get('request-1');
      assert.equal(failedExecution.status, 'failed');
      assert.equal(failedExecution.id, 'execution-1');
      assert.equal(failedExecution.translationRequestId, 'request-1');
      assert.equal(failedExecution.providerKey, 'gemini');
      assert.deepEqual(failedExecution.failureInfo, {
        reason: 'provider_execution_failed',
        errorName: 'GeminiHttpError',
        code: 'server_error',
        status: 503,
        message: 'Gemini HTTP request failed: server_error (503).'
      });
      assert.equal(persistedRequest.sessionId, 'session-runtime-worker-failure');
      assert.equal(persistedRequest.targetLanguageCode, 'fr');
      assert.equal(persistedRequest.sourceTranscriptSnapshot.sourceLanguageCode, 'en');
      assert.equal(persistedRequest.sourceTranscriptSnapshot.sourceText, 'hello failure path');
      assert.equal(dependencies.translationExecutionQueue.dequeue(), null);
    },
    {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model'
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post() {
            throw new Error('Gemini HTTP client should not be called when fake GeminiClient is supplied');
          }
        };
      },
      geminiClientFactory({ httpClient, model }) {
        assert.equal(typeof httpClient.post, 'function');
        assert.equal(model, 'gemini-runtime-model');
        return {
          async translate(request) {
            geminiClientCalls.push(request);
            throw providerError;
          }
        };
      },
      geminiTranslationExecutionProviderFactory(options) {
        return createDefaultGeminiTranslationExecutionProvider(options);
      }
    }
  );
});

test('POST /api/translation-executions does not surface production provider error at application boundary', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-failure-2',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const providerError = new Error('runtime provider failed by identity');
  const runtime = createRuntimeProviderResolutionFixture({ postError: providerError });
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    ...runtime.options,
    requestHandlerFactory: createRequestHandler,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command requests');
    }
  });

  assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  const result = await dependencies.translationCommandController.createTranslationExecution(
    translationExecutionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'gemini'
    })
  );

  assert.equal(result.status, 'queued');
  assert.equal(result.providerKey, 'gemini');
  assert.deepEqual(runtime.httpCalls, []);
  assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
  assert.deepEqual(
    executionStatusesFromUpdateCalls(translationRepository.callsFor('updateTranslationExecution')),
    ['queued']
  );
  assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'queued');
});

test('POST /api/translation-executions does not surface fake GeminiClient GeminiHttpError during submission', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-gemini-http-error',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const geminiError = new GeminiHttpError({
    status: 429,
    code: 'rate_limited',
    message: 'Gemini HTTP request failed: rate_limited (429).'
  });
  const runtime = createGeminiClientErrorRuntimeFixture({ error: geminiError });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'gemini'
  });
  const before = structuredClone(input);

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);
      const storedExecution = translationRepository.translationExecutions.get('execution-1');
      const storedOutputs = Array.from(translationRepository.translationOutputs.values());
      const updateCalls = translationRepository.callsFor('updateTranslationExecution');

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response, { providerKey: 'gemini' });
      assert.deepEqual(runtime.geminiClientCalls, []);
      assert.equal(storedExecution instanceof TranslationExecution, true);
      assert.equal(storedExecution.status, 'queued');
      assert.notEqual(storedExecution.status, 'completed');
      assert.equal(storedExecution.failureInfo, null);
      assert.equal(storedOutputs.length, 0);
      assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.deepEqual(executionStatusesFromUpdateCalls(updateCalls), ['queued']);
      assert.equal(updateCalls.some(([execution]) => execution.status === 'completed'), false);
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('GeminiHttpError from fake GeminiClient is not raised by submission application boundary', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-gemini-http-error-boundary',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const geminiError = new GeminiHttpError({
    status: 503,
    code: 'server_error',
    message: 'Gemini HTTP request failed: server_error (503).'
  });
  const runtime = createGeminiClientErrorRuntimeFixture({ error: geminiError });
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    ...runtime.options,
    requestHandlerFactory: createRequestHandler,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command requests');
    }
  });

  const result = await dependencies.translationCommandController.createTranslationExecution(
    translationExecutionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'gemini'
    })
  );

  assert.equal(result.status, 'queued');
  assert.equal(result.providerKey, 'gemini');
  assert.deepEqual(runtime.geminiClientCalls, []);
  assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
  assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
  assert.deepEqual(
    executionStatusesFromUpdateCalls(translationRepository.callsFor('updateTranslationExecution')),
    ['queued']
  );
  assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'queued');
  assert.equal(translationRepository.translationExecutions.get('execution-1').failureInfo, null);
});

test('POST /api/translation-executions repository failure prevents provider execution writes', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    failMethods: new Set(['createTranslationExecution'])
  });
  const runtime = createRuntimeProviderResolutionFixture();

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl) => {
      const response = await postJson(
        `${baseUrl}/api/translation-executions`,
        translationExecutionPayload({
          sourceText: 'hello',
          targetLanguageCode: 'fr'
        })
      );
      const bodyText = JSON.stringify(response.body);

      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'internal_error');
      assert.equal(response.body.error.message, 'Unexpected server error.');
      assert.doesNotMatch(bodyText, /fixture repository failure/);
      assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
      assert.equal(translationRepository.callsFor('updateTranslationExecution').length, 0);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.deepEqual(runtime.httpCalls, []);
    },
    runtime.options
  );
});

test('POST /api/translation-executions with fake resolver queues without executing provider', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-fake-resolver',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const fakeProvider = createFakeTranslationExecutionProvider();
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: fakeProvider
  });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'fake'
  });

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.strictEqual(dependencies.translationExecutionProviderResolver, resolver);
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assertQueuedExecutionResponse(response, { providerKey: 'fake' });
      assertQueuedSubmissionPersistence(translationRepository, { providerKey: 'fake' });
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    {
      translationExecutionProviderResolver: resolver
    }
  );
});

test('POST /api/translation-executions with omitted providerKey queues without resolving fake provider', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-fake-default',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const fakeProvider = createFakeTranslationExecutionProvider();
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: fakeProvider
  });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr'
  });

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);

      assert.strictEqual(dependencies.translationExecutionProviderResolver, resolver);
      assertQueuedExecutionResponse(response);
      assertQueuedSubmissionPersistence(translationRepository);
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    {
      translationExecutionProviderResolver: resolver
    }
  );
});

test('POST /api/translation-executions queues unknown providerKey without resolving provider', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    requests: [
      new TranslationRequest(
        translationRequestPayload({
          sessionId: 'session-runtime-fake-missing',
          targetLanguageCode: 'fr'
        })
      )
    ]
  });
  const fakeProvider = createFakeTranslationExecutionProvider();
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: fakeProvider
  });
  const input = translationExecutionPayload({
    sourceText: 'hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    providerKey: 'missing-provider'
  });

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);
      const storedExecution = translationRepository.translationExecutions.get('execution-1');
      const storedOutputs = Array.from(translationRepository.translationOutputs.values());
      const updateCalls = translationRepository.callsFor('updateTranslationExecution');

      assertQueuedExecutionResponse(response, { providerKey: 'missing-provider' });
      assert.equal(storedExecution instanceof TranslationExecution, true);
      assert.equal(storedExecution.status, 'queued');
      assert.equal(storedExecution.failureInfo, null);
      assert.equal(storedOutputs.length, 0);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.deepEqual(executionStatusesFromUpdateCalls(updateCalls), ['queued']);
      assertQueuedJob(dependencies);
      assertNoWorkerProcessing(translationRepository);
    },
    {
      translationExecutionProviderResolver: resolver
    }
  );
});

test('PATCH /api/translation-executions/:executionId URL-decodes and starts a created execution', async () => {
  const executionId = 'execution unicode 1';
  const originalExecution = new TranslationExecution(
    translationExecutionPayload({
      id: executionId,
      startedAt: '2026-07-14T01:02:00.000Z'
    })
  );
  const translationRepository = createTranslationRepositoryFixture({
    executions: [originalExecution],
    asyncMethods: new Set(['getTranslationExecution'])
  });

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await patchJson(`${baseUrl}/api/translation-executions/${encodeURIComponent(executionId)}`, {
      id: 'body-id-should-not-win',
      executionId: 'body-execution-id-should-not-win',
      transition: 'start',
      startedAt: '2026-07-14T01:03:00.000Z'
    });
    const getCalls = translationRepository.callsFor('getTranslationExecution');
    const updateCalls = translationRepository.callsFor('updateTranslationExecution');
    const updatedExecution = updateCalls[0][0];

    assert.equal(response.status, 200);
    assert.deepEqual(getCalls, [[executionId]]);
    assert.equal(updateCalls.length, 1);
    assert.equal(updatedExecution instanceof TranslationExecution, true);
    assert.notStrictEqual(updatedExecution, originalExecution);
    assert.equal(originalExecution.status, 'created');
    assert.equal(originalExecution.startedAt, '2026-07-14T01:02:00.000Z');
    assert.equal(updatedExecution.id, executionId);
    assert.equal(updatedExecution.status, 'running');
    assert.equal(updatedExecution.startedAt, '2026-07-14T01:03:00.000Z');
    assert.deepEqual(response.body, {
      id: executionId,
      translationRequestId: 'request-1',
      status: 'running',
      startedAt: '2026-07-14T01:03:00.000Z',
      completedAt: null,
      failureInfo: null
    });
  });
});

test('PATCH /api/translation-executions/:executionId completes a running execution', async () => {
  const originalExecution = new TranslationExecution(
    translationExecutionPayload({
      id: 'execution-running-1',
      status: 'running',
      startedAt: '2026-07-14T01:04:00.000Z'
    })
  );
  const translationRepository = createTranslationRepositoryFixture({
    executions: [originalExecution],
    asyncMethods: new Set(['updateTranslationExecution'])
  });

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await patchJson(`${baseUrl}/api/translation-executions/execution-running-1`, {
      transition: 'complete',
      completedAt: '2026-07-14T01:05:00.000Z'
    });
    const updateCalls = translationRepository.callsFor('updateTranslationExecution');
    const updatedExecution = updateCalls[0][0];

    assert.equal(response.status, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal(updatedExecution instanceof TranslationExecution, true);
    assert.notStrictEqual(updatedExecution, originalExecution);
    assert.equal(originalExecution.status, 'running');
    assert.equal(originalExecution.completedAt, null);
    assert.equal(updatedExecution.id, 'execution-running-1');
    assert.equal(updatedExecution.status, 'completed');
    assert.equal(updatedExecution.startedAt, '2026-07-14T01:04:00.000Z');
    assert.equal(updatedExecution.completedAt, '2026-07-14T01:05:00.000Z');
    assert.deepEqual(response.body, {
      id: 'execution-running-1',
      translationRequestId: 'request-1',
      status: 'completed',
      startedAt: '2026-07-14T01:04:00.000Z',
      completedAt: '2026-07-14T01:05:00.000Z',
      failureInfo: null
    });
  });
});

test('POST cancel returns the persisted cancelled execution without output or provider execution', async () => {
  const queued = new TranslationExecution(translationExecutionPayload({ providerKey: 'fake' })).queue();
  const translationRepository = createTranslationRepositoryFixture({ executions: [queued] });

  await withTranslationCommandServer(translationRepository, async (baseUrl, dependencies) => {
    const response = await postEmpty(`${baseUrl}/api/translation-executions/${queued.id}/cancel`);
    const stored = translationRepository.translationExecutions.get(queued.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      id: queued.id,
      translationRequestId: 'request-1',
      requestId: 'request-1',
      status: 'cancelled',
      providerKey: 'fake',
      startedAt: '2026-07-14T01:01:00.000Z',
      completedAt: '2026-07-14T01:02:00.000Z',
      failureInfo: null
    });
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.providerIdempotencyKey, queued.providerIdempotencyKey);
    assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
  }, { clock: () => '2026-07-14T01:02:00.000Z' });
});

test('POST cancel maps missing and non-queued executions to deterministic client errors without rewriting them', async () => {
  const statuses = ['created', 'running', 'completed', 'failed', 'cancelled'];
  const executions = statuses.map((status) => executionForControlStatus(status));
  const translationRepository = createTranslationRepositoryFixture({ executions });

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const missing = await postEmpty(`${baseUrl}/api/translation-executions/missing-execution/cancel`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'translation_execution_not_found');

    for (const execution of executions) {
      const response = await postEmpty(`${baseUrl}/api/translation-executions/${execution.id}/cancel`);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'execution_invalid_state');
      assert.strictEqual(translationRepository.translationExecutions.get(execution.id), execution);
    }
    assert.equal(translationRepository.callsFor('updateTranslationExecution').length, 0);
  });
});

test('POST cancel validates a blank execution ID before calling the application service', async () => {
  const translationRepository = createTranslationRepositoryFixture();

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postEmpty(`${baseUrl}/api/translation-executions/%20/cancel`);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_request');
    assert.deepEqual(translationRepository.calls, []);
  });
});

test('POST retry returns a distinct queued execution and leaves the failed source unchanged until the worker runs it', async () => {
  const source = failedExecutionForControl({ providerKey: 'fake' });
  const request = new TranslationRequest(translationRequestPayload({
    sourceTranscriptSnapshot: { sourceText: 'hello', sourceLanguageCode: 'en' }
  }));
  const translationRepository = createTranslationRepositoryFixture({ requests: [request], executions: [source] });
  const providerCalls = [];

  await withProductionTranslationCommandServer(
    translationRepository,
    async (baseUrl, dependencies) => {
      const response = await postEmpty(`${baseUrl}/api/translation-executions/${source.id}/retry`);
      const retry = translationRepository.translationExecutions.get('execution-retry-1');

      assert.equal(response.status, 202);
      assert.deepEqual(response.body, {
        id: 'execution-retry-1',
        translationRequestId: source.translationRequestId,
        requestId: source.translationRequestId,
        status: 'queued',
        providerKey: 'fake',
        startedAt: '2026-07-14T01:03:00.000Z',
        completedAt: null,
        failureInfo: null
      });
      assert.notEqual(retry.id, source.id);
      assert.equal(retry.providerIdempotencyKey, 'translation-execution:execution-retry-1');
      assert.equal(source.status, 'failed');
      assert.deepEqual(source.failureInfo, { reason: 'provider_error' });
      assert.equal(source.providerAttemptStatus, 'failed');
      assert.deepEqual(providerCalls, []);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assertQueuedJob(dependencies, { executionId: retry.id, requestId: retry.translationRequestId });
      await dependencies.translationExecutionQueue.enqueue({ executionId: retry.id, requestId: retry.translationRequestId });

      assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), { status: 'processed', executionId: retry.id });
      assert.equal(providerCalls.length, 1);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 1);
    },
    {
      idGenerator: () => 'execution-retry-1',
      clock: () => '2026-07-14T01:03:00.000Z',
      translationExecutionProvider: {
        async execute(input) {
          providerCalls.push(input);
          return { translatedText: 'Bonjour' };
        }
      }
    }
  );
});

test('POST retry maps ineligible, missing execution, and missing request sources without creating or queueing work', async () => {
  const ineligible = ['created', 'queued', 'running', 'completed', 'cancelled'].map(executionForControlStatus);
  const missingRequestSource = failedExecutionForControl({ id: 'execution-missing-request', translationRequestId: 'missing-request' });
  const translationRepository = createTranslationRepositoryFixture({ executions: [...ineligible, missingRequestSource] });

  await withTranslationCommandServer(translationRepository, async (baseUrl, dependencies) => {
    const missing = await postEmpty(`${baseUrl}/api/translation-executions/missing-execution/retry`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'translation_execution_not_found');

    for (const execution of ineligible) {
      const response = await postEmpty(`${baseUrl}/api/translation-executions/${execution.id}/retry`);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'execution_invalid_state');
      assert.strictEqual(translationRepository.translationExecutions.get(execution.id), execution);
    }

    const missingRequest = await postEmpty(`${baseUrl}/api/translation-executions/${missingRequestSource.id}/retry`);
    assert.equal(missingRequest.status, 404);
    assert.equal(missingRequest.body.error.code, 'translation_request_not_found');
    assert.equal(translationRepository.callsFor('createTranslationExecution').length, 0);
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
  });
});

test('POST retry preserves queued persistence but returns the existing safe enqueue failure response', async () => {
  const source = failedExecutionForControl();
  const request = new TranslationRequest(translationRequestPayload());
  const translationRepository = createTranslationRepositoryFixture({ requests: [request], executions: [source] });
  const enqueueError = new Error('queue stack detail');
  const queue = {
    enqueue() { throw enqueueError; },
    dequeue() { return null; },
    size() { return 0; }
  };

  await withTranslationCommandServer(
    translationRepository,
    async (baseUrl) => {
      const response = await postEmpty(`${baseUrl}/api/translation-executions/${source.id}/retry`);

      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'internal_error');
      assert.doesNotMatch(JSON.stringify(response.body), /queue stack detail/);
      assert.equal(translationRepository.translationExecutions.has('execution-retry-1'), true);
      assert.equal(translationRepository.translationExecutions.get('execution-retry-1').status, 'queued');
    },
    { translationExecutionQueue: queue, idGenerator: () => 'execution-retry-1' }
  );
});

test('POST /api/translation-outputs creates a TranslationOutput through production composition wiring', async () => {
  const translationRepository = createTranslationRepositoryFixture();
  const input = translationOutputPayload({
    providerMetadata: {
      provider: 'fixture-provider',
      nested: { preserved: true }
    }
  });
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-outputs`, input);
    const calls = translationRepository.callsFor('createTranslationOutput');
    const storedOutput = translationRepository.translationOutputs.get('output-1');

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: 'output-1',
      executionId: 'execution-1',
      sequence: 0,
      translatedText: 'Bonjour',
      targetLanguageCode: 'fr',
      providerMetadata: {
        provider: 'fixture-provider',
        nested: { preserved: true }
      },
      providerMetadataAvailable: true,
      createdAt: '2026-07-14T01:06:00.000Z',
      sourceLanguageMetadata: null,
      sourceTranscriptMetadata: null,
      completedAt: '2026-07-14T01:06:00.000Z'
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0] instanceof TranslationOutput, true);
    assert.notStrictEqual(calls[0][0], input);
    assert.strictEqual(storedOutput, calls[0][0]);
    assert.equal(storedOutput.id, 'output-1');
    assert.equal(storedOutput.executionId, 'execution-1');
    assert.equal(storedOutput.translatedText, 'Bonjour');
    assert.equal(storedOutput.targetLanguageCode, 'fr');
    assert.equal(storedOutput.sequence, 0);
    assert.equal(storedOutput.createdAt, '2026-07-14T01:06:00.000Z');
  });

  assert.deepEqual(input, before);
});

test('malformed JSON uses the existing invalid_json response before repository commands run', async () => {
  const translationRepository = createTranslationRepositoryFixture();

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await sendRaw(`${baseUrl}/api/translation-requests`, 'POST', '{"id":');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_json');
    assert.equal(response.body.error.message, 'Request body must be valid JSON.');
    assert.ok(response.body.error.requestId);
    assert.deepEqual(translationRepository.calls, []);
  });
});

test('unexpected repository failure uses existing internal error response without leaking details', async () => {
  const translationRepository = createTranslationRepositoryFixture({
    failMethods: new Set(['createTranslationOutput'])
  });

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-outputs`, translationOutputPayload());
    const bodyText = JSON.stringify(response.body);

    assert.notEqual(response.status, 201);
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal(response.body.error.message, 'Unexpected server error.');
    assert.notEqual(response.body.error.code, 'not_found');
    assert.doesNotMatch(bodyText, /fixture repository failure/);
    assert.doesNotMatch(bodyText, /stack detail/);
  });
});

async function withTranslationCommandServer(translationRepository, run, options = {}) {
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    ...options,
    requestHandlerFactory: createRequestHandler
  });
  const server = http.createServer(dependencies.requestHandler);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`, dependencies);
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

async function withProductionTranslationCommandServer(translationRepository, run, options = {}) {
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    ...options,
    requestHandlerFactory: createRequestHandler,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command requests');
    }
  });
  const server = http.createServer(dependencies.requestHandler);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`, dependencies);
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

function postJson(url, body) {
  return sendJson(url, 'POST', body);
}

async function postEmpty(url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-request-id': 'test-request-id' }
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function patchJson(url, body) {
  return sendJson(url, 'PATCH', body);
}

async function sendJson(url, method, body) {
  return sendRaw(url, method, JSON.stringify(body));
}

async function sendRaw(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'test-request-id'
    },
    body
  });
  const responseBody = await response.json();

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody
  };
}

function createTranslationRepositoryFixture({
  requests = [],
  executions = [],
  asyncMethods = new Set(),
  failMethods = new Set()
} = {}) {
  const translationRequests = new Map(requests.map((request) => [request.id, request]));
  const translationExecutions = new Map(executions.map((execution) => [execution.id, execution]));
  const translationOutputs = new Map();
  const calls = [];

  function record(methodName, args) {
    calls.push([methodName, ...args]);
  }

  function resultFor(methodName, value) {
    if (failMethods.has(methodName)) {
      return Promise.reject(new Error(`fixture repository failure: ${methodName} stack detail`));
    }

    if (asyncMethods.has(methodName)) {
      return Promise.resolve(value);
    }

    return value;
  }

  return {
    calls,
    translationRequests,
    translationExecutions,
    translationOutputs,

    callsFor(methodName) {
      return calls.filter(([nextMethodName]) => nextMethodName === methodName).map(([, ...args]) => args);
    },

    createTranslationRequest(request) {
      record('createTranslationRequest', [request]);
      translationRequests.set(request.id, request);
      return resultFor('createTranslationRequest', request);
    },

    getTranslationRequest(requestId) {
      record('getTranslationRequest', [requestId]);
      return resultFor('getTranslationRequest', translationRequests.get(requestId) ?? null);
    },

    findRequestById(requestId) {
      record('findRequestById', [requestId]);
      return resultFor('findRequestById', translationRequests.get(requestId) ?? null);
    },

    updateTranslationRequest(request) {
      record('updateTranslationRequest', [request]);
      translationRequests.set(request.id, request);
      return resultFor('updateTranslationRequest', request);
    },

    listTranslationRequestsBySession(sessionId) {
      record('listTranslationRequestsBySession', [sessionId]);
      return resultFor(
        'listTranslationRequestsBySession',
        Array.from(translationRequests.values()).filter((request) => request.sessionId === sessionId)
      );
    },

    createTranslationExecution(execution) {
      record('createTranslationExecution', [execution]);
      translationExecutions.set(execution.id, execution);
      return resultFor('createTranslationExecution', execution);
    },

    getTranslationExecution(executionId) {
      record('getTranslationExecution', [executionId]);
      return resultFor('getTranslationExecution', translationExecutions.get(executionId) ?? null);
    },

    findExecutionById(executionId) {
      record('findExecutionById', [executionId]);
      return resultFor('findExecutionById', translationExecutions.get(executionId) ?? null);
    },

    updateTranslationExecution(execution) {
      record('updateTranslationExecution', [execution]);
      translationExecutions.set(execution.id, execution);
      return resultFor('updateTranslationExecution', execution);
    },

    listTranslationExecutionsByRequest(requestId) {
      record('listTranslationExecutionsByRequest', [requestId]);
      return resultFor(
        'listTranslationExecutionsByRequest',
        Array.from(translationExecutions.values()).filter((execution) => execution.translationRequestId === requestId)
      );
    },

    createTranslationOutput(output) {
      record('createTranslationOutput', [output]);
      translationOutputs.set(output.id, output);
      return resultFor('createTranslationOutput', output);
    },

    listTranslationOutputsByExecution(executionId) {
      record('listTranslationOutputsByExecution', [executionId]);
      return resultFor(
        'listTranslationOutputsByExecution',
        Array.from(translationOutputs.values()).filter((output) => output.executionId === executionId)
      );
    },

    listTranslationOutputsBySession(sessionId) {
      record('listTranslationOutputsBySession', [sessionId]);
      const requestIds = new Set(
        Array.from(translationRequests.values())
          .filter((request) => request.sessionId === sessionId)
          .map((request) => request.id)
      );
      const executionIds = new Set(
        Array.from(translationExecutions.values())
          .filter((execution) => requestIds.has(execution.translationRequestId))
          .map((execution) => execution.id)
      );

      return resultFor(
        'listTranslationOutputsBySession',
        Array.from(translationOutputs.values()).filter((output) => executionIds.has(output.executionId))
      );
    },

    listTranslationOutputsByRequest(requestId) {
      record('listTranslationOutputsByRequest', [requestId]);
      const executionIds = new Set(
        Array.from(translationExecutions.values())
          .filter((execution) => execution.translationRequestId === requestId)
          .map((execution) => execution.id)
      );

      return resultFor(
        'listTranslationOutputsByRequest',
        Array.from(translationOutputs.values()).filter((output) => executionIds.has(output.executionId))
      );
    },

    getTranslationOutput(outputId) {
      record('getTranslationOutput', [outputId]);
      return resultFor('getTranslationOutput', translationOutputs.get(outputId) ?? null);
    }
  };
}

function readRepository() {
  return {
    listSessionHistory() {
      return [];
    },
    getSessionDetail() {
      return null;
    }
  };
}

function translationRequestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'ja',
    createdAt: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}

function translationExecutionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: '2026-07-14T01:01:00.000Z',
    ...overrides
  };
}

function executionForControlStatus(status) {
  const base = translationExecutionPayload({ id: `execution-${status}`, status });
  if (status === 'completed' || status === 'cancelled') return new TranslationExecution({ ...base, completedAt: '2026-07-14T01:02:00.000Z' });
  if (status === 'failed') return new TranslationExecution({ ...base, completedAt: '2026-07-14T01:02:00.000Z', failureInfo: { reason: 'provider_error' } });
  if (status === 'running') return new TranslationExecution(base);
  return new TranslationExecution(base);
}

function failedExecutionForControl(overrides = {}) {
  return new TranslationExecution(translationExecutionPayload({
    id: 'execution-failed-source',
    providerKey: 'fake',
    ...overrides
  }))
    .queue()
    .start('2026-07-14T01:01:30.000Z')
    .markProviderAttemptInFlight('2026-07-14T01:01:31.000Z')
    .markProviderAttemptFailed('2026-07-14T01:01:32.000Z')
    .fail({ reason: 'provider_error' }, '2026-07-14T01:02:00.000Z');
}

function translationOutputPayload(overrides = {}) {
  return {
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'Bonjour',
    targetLanguageCode: 'fr',
    createdAt: '2026-07-14T01:06:00.000Z',
    ...overrides
  };
}

function createRuntimeProviderResolutionFixture({
  postError,
  responseBody = {
    translatedText: '[gemini:fr] hello',
    detectedSourceLanguageCode: 'en'
  }
} = {}) {
  const httpCalls = [];

  return {
    httpCalls,
    options: {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model'
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post(request) {
            httpCalls.push(request);

            if (postError) {
              throw postError;
            }

            return {
              ok: true,
              async json() {
                return responseBody;
              }
            };
          }
        };
      }
    }
  };
}

function productionRuntimeOptions({ scheduler, geminiClientCalls }) {
  return {
    env: {
      GEMINI_API_KEY: 'gemini-runtime-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model'
    },
    geminiHttpClientFactory({ apiKey }) {
      assert.equal(apiKey, 'gemini-runtime-api-key');
      return {
        post() {
          throw new Error('Gemini HTTP client should not be called when fake GeminiClient is supplied');
        }
      };
    },
    geminiClientFactory({ httpClient, model }) {
      assert.equal(typeof httpClient.post, 'function');
      assert.equal(model, 'gemini-runtime-model');
      return {
        async translate(request) {
          geminiClientCalls.push(request);
          return {
            translatedText: `[runtime:${request.targetLanguageCode}] ${request.sourceText}`
          };
        }
      };
    },
    geminiTranslationExecutionProviderFactory(options) {
      return createDefaultGeminiTranslationExecutionProvider(options);
    },
    translationExecutionWorkerRuntimeFactory(options) {
      return createDefaultTranslationExecutionWorkerRuntime({
        ...options,
        scheduler,
        pollIntervalMs: 25
      });
    }
  };
}

function createGeminiClientErrorRuntimeFixture({ error }) {
  const geminiClientCalls = [];

  return {
    geminiClientCalls,
    options: {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-runtime-model'
      },
      geminiHttpClientFactory({ apiKey }) {
        assert.equal(apiKey, 'gemini-runtime-api-key');
        return {
          post() {
            throw new Error('Gemini HTTP client should not be called when fake GeminiClient is supplied');
          }
        };
      },
      geminiClientFactory({ httpClient, model }) {
        assert.equal(typeof httpClient.post, 'function');
        assert.equal(model, 'gemini-runtime-model');
        return {
          async translate(request) {
            geminiClientCalls.push(request);
            throw error;
          }
        };
      },
      geminiTranslationExecutionProviderFactory(options) {
        return createDefaultGeminiTranslationExecutionProvider(options);
      }
    }
  };
}

function createFakeScheduler() {
  let nextHandle = 1;
  const scheduled = [];

  return {
    set(callback, delayMs) {
      const entry = {
        handle: nextHandle,
        callback,
        delayMs,
        active: true
      };
      nextHandle += 1;
      scheduled.push(entry);
      return entry.handle;
    },

    clear(handle) {
      const entry = scheduled.find((candidate) => candidate.handle === handle);

      if (entry) {
        entry.active = false;
      }
    },

    pendingCount() {
      return scheduled.filter((entry) => entry.active).length;
    },

    async runNext() {
      const entry = scheduled.find((candidate) => candidate.active);

      if (!entry) {
        return undefined;
      }

      entry.active = false;
      return entry.callback();
    },

    async runAll() {
      while (this.pendingCount() > 0) {
        await this.runNext();
      }
    }
  };
}

function assertQueuedExecutionResponse(
  response,
  { executionId = 'execution-1', requestId = 'request-1', providerKey } = {}
) {
  const expected = {
    id: executionId,
    translationRequestId: requestId,
    status: 'queued',
    startedAt: '2026-07-14T01:01:00.000Z',
    completedAt: null,
    failureInfo: null
  };

  if (providerKey !== undefined) {
    expected.providerKey = providerKey;
  }

  assert.equal(response.status, 202);
  assert.deepEqual(response.body, expected);
  assert.equal(Object.hasOwn(response.body, 'output'), false);
  assert.equal(Object.hasOwn(response.body, 'translatedText'), false);
}

function assertQueuedSubmissionPersistence(translationRepository, { providerKey } = {}) {
  const createExecutionCalls = translationRepository.callsFor('createTranslationExecution');
  const updateExecutionCalls = translationRepository.callsFor('updateTranslationExecution');
  const storedExecution = translationRepository.translationExecutions.get('execution-1');

  assert.equal(createExecutionCalls.length, 1);
  assert.equal(createExecutionCalls[0][0] instanceof TranslationExecution, true);
  assert.deepEqual(executionStatusesFromCreateAndUpdateCalls(createExecutionCalls, updateExecutionCalls), [
    'created',
    'queued'
  ]);
  assert.equal(updateExecutionCalls.some(([execution]) => execution.status === 'running'), false);
  assert.equal(updateExecutionCalls.some(([execution]) => execution.status === 'completed'), false);
  assert.equal(updateExecutionCalls.some(([execution]) => execution.status === 'failed'), false);
  assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
  assert.equal(storedExecution instanceof TranslationExecution, true);
  assert.equal(storedExecution.status, 'queued');
  assert.equal(storedExecution.completedAt, null);
  assert.equal(storedExecution.failureInfo, null);
  assert.equal(storedExecution.providerKey, providerKey);
}

function assertQueuedJob(dependencies, expected = { executionId: 'execution-1', requestId: 'request-1' }) {
  assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), expected);
  assert.equal(dependencies.translationExecutionQueue.dequeue(), null);
}

function assertExecutionLifecycleFor(translationRepository, executionId, expectedStatuses) {
  const createExecutionCalls = translationRepository.callsFor('createTranslationExecution');
  const updateExecutionCalls = translationRepository.callsFor('updateTranslationExecution');
  const statuses = [...createExecutionCalls, ...updateExecutionCalls]
    .map(([execution]) => execution)
    .filter((execution) => execution.id === executionId)
    .map((execution) => execution.status)
    .filter((status, index, allStatuses) => index === 0 || status !== allStatuses[index - 1]);

  assert.deepEqual(statuses, expectedStatuses);
}

function assertNoWorkerProcessing(translationRepository) {
  assert.deepEqual(translationRepository.callsFor('findExecutionById'), []);
  assert.deepEqual(translationRepository.callsFor('findRequestById'), []);
}

function assertCompletedRuntimePersistence(
  translationRepository,
  { requestId, sessionId, executionId, providerKey, translatedText, targetLanguageCode }
) {
  const createExecutionCalls = translationRepository.callsFor('createTranslationExecution');
  const updateExecutionCalls = translationRepository.callsFor('updateTranslationExecution');
  const createOutputCalls = translationRepository.callsFor('createTranslationOutput');
  const storedExecution = translationRepository.translationExecutions.get(executionId);
  const storedOutputs = Array.from(translationRepository.translationOutputs.values());
  const storedOutput = storedOutputs[0];

  assert.equal(createExecutionCalls.length, 1);
  assert.equal(createExecutionCalls[0][0] instanceof TranslationExecution, true);
  assert.deepEqual(executionStatusesFromCreateAndUpdateCalls(createExecutionCalls, updateExecutionCalls), [
    'created',
    'queued',
    'running',
    'completed'
  ]);
  assert.equal(updateExecutionCalls.some(([execution]) => execution.status === 'failed'), false);
  assert.equal(createOutputCalls.length, 1);
  assert.equal(storedOutputs.length, 1);
  assert.equal(
    callIndexForExecutionStatus(translationRepository.calls, 'running') <
      callIndexForMethod(translationRepository.calls, 'createTranslationOutput'),
    true
  );
  assert.equal(
    callIndexForMethod(translationRepository.calls, 'createTranslationOutput') <
      callIndexForExecutionStatus(translationRepository.calls, 'completed'),
    true
  );
  assert.strictEqual(storedExecution, updateExecutionCalls.at(-1)[0]);
  assert.strictEqual(storedOutput, createOutputCalls[0][0]);
  assertExecutionFields(storedExecution, {
    executionId,
    requestId,
    sessionId: undefined,
    status: 'completed',
    providerKey
  });
  assert.equal(Object.hasOwn(storedExecution, 'providerKey'), true);
  assert.equal(storedExecution.providerAttemptStatus, 'succeeded');
  assert.match(storedExecution.providerAttemptedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(storedExecution.providerCompletedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(storedExecution.providerResult, {
    translatedText,
    detectedSourceLanguageCode: 'en'
  });
  assert.equal(storedExecution.completedAt, '2026-07-14T01:01:00.000Z');
  assert.equal(storedOutput instanceof TranslationOutput, true);
  assert.equal(storedOutput.executionId, executionId);
  assert.equal(storedOutput.translatedText, translatedText);
  assert.equal(storedOutput.targetLanguageCode, targetLanguageCode);
  assert.deepEqual(translationRepository.listTranslationOutputsByRequest(requestId), [storedOutput]);
  assert.deepEqual(translationRepository.listTranslationOutputsBySession(sessionId), [storedOutput]);
}

function assertNoFailedExecutionPersistence(translationRepository) {
  const updateExecutionCalls = translationRepository.callsFor('updateTranslationExecution');

  assert.equal(updateExecutionCalls.some(([execution]) => execution.status === 'failed'), false);
}

function executionStatusesFromCreateAndUpdateCalls(createExecutionCalls, updateExecutionCalls) {
  return [...createExecutionCalls, ...updateExecutionCalls]
    .map(([execution]) => execution.status)
    .filter((status, index, allStatuses) => index === 0 || status !== allStatuses[index - 1]);
}

function executionStatusesFromUpdateCalls(updateExecutionCalls) {
  return updateExecutionCalls.map(([execution]) => execution.status);
}

function callIndexForMethod(calls, methodName) {
  return calls.findIndex(([nextMethodName]) => nextMethodName === methodName);
}

function callIndexForExecutionStatus(calls, status) {
  return calls.findIndex(
    ([methodName, execution]) =>
      ['createTranslationExecution', 'updateTranslationExecution'].includes(methodName) && execution.status === status
  );
}

function assertExecutionFields(execution, expected) {
  assert.equal(execution.id, expected.executionId);
  assert.equal(execution.translationRequestId, expected.requestId);
  assert.equal(execution.sessionId, expected.sessionId);
  assert.equal(execution.status, expected.status);
  assert.equal(execution.providerKey, expected.providerKey);
}
