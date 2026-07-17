import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApplicationDependencies, createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { TranslationExecution, TranslationOutput, TranslationRequest } from '../../src/domain/translation/index.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { GeminiHttpError } from '../../src/infrastructure/geminiClient.js';
import { createGeminiTranslationExecutionProvider as createDefaultGeminiTranslationExecutionProvider } from '../../src/infrastructure/geminiTranslationExecutionProvider.js';

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

test('POST /api/translation-executions creates a pending TranslationExecution through production composition wiring', async () => {
  const translationRepository = createTranslationRepositoryFixture();
  const input = translationExecutionPayload();
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-executions`, input);
    const calls = translationRepository.callsFor('createTranslationExecution');
    const storedExecution = translationRepository.translationExecutions.get('execution-1');

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: 'execution-1',
      translationRequestId: 'request-1',
      status: 'pending',
      startedAt: '2026-07-14T01:01:00.000Z',
      completedAt: null,
      failureInfo: null
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0] instanceof TranslationExecution, true);
    assert.notStrictEqual(calls[0][0], input);
    assert.strictEqual(storedExecution, calls[0][0]);
    assert.equal(storedExecution.id, 'execution-1');
    assert.equal(storedExecution.translationRequestId, 'request-1');
    assert.equal(storedExecution.status, 'pending');
    assert.equal(storedExecution.startedAt, '2026-07-14T01:01:00.000Z');
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
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'pending',
        startedAt: '2026-07-14T01:01:00.000Z',
        completedAt: null,
        failureInfo: null,
        providerKey: 'gemini'
      });
      assert.equal(runtime.httpCalls.length, 1);
      assert.equal(runtime.httpCalls[0].path, '/v1beta/models/gemini-runtime-model:generateContent');
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.at(-1).text, 'hello');
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.some((part) => part.text === 'Target language: fr'), true);
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.some((part) => part.text === 'Source language hint: en'), true);
      assert.deepEqual(runtime.httpCalls[0].body.metadata, {});
      assertCompletedRuntimePersistence(translationRepository, {
        requestId: 'request-1',
        sessionId: 'session-runtime-1',
        executionId: 'execution-1',
        providerKey: 'gemini',
        translatedText: '[gemini:fr] hello',
        targetLanguageCode: 'fr'
      });
      assertNoFailedExecutionPersistence(translationRepository);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions completes through GeminiTranslationExecutionProvider and fake GeminiClient', async () => {
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
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'pending',
        startedAt: '2026-07-14T01:01:00.000Z',
        completedAt: null,
        failureInfo: null
      });
      assert.equal(providerFactoryCalls.length, 1);
      assert.strictEqual(providerFactoryCalls[0].client, providerFactoryCalls[0].geminiClient);
      assert.deepEqual(geminiClientCalls, [
        {
          sourceText: 'hello',
          sourceLanguageCode: 'en',
          targetLanguageCode: 'fr'
        }
      ]);
      assertCompletedRuntimePersistence(translationRepository, {
        requestId: 'request-1',
        sessionId: 'session-runtime-gemini-client',
        executionId: 'execution-1',
        providerKey: undefined,
        translatedText: '[gemini-client:fr] hello',
        targetLanguageCode: 'fr'
      });
      assertNoFailedExecutionPersistence(translationRepository);
    },
    {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        GEMINI_MODEL: 'gemini-runtime-model'
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
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'pending',
        startedAt: '2026-07-14T01:01:00.000Z',
        completedAt: null,
        failureInfo: null
      });
      assert.equal(runtime.httpCalls.length, 1);
      assert.equal(runtime.httpCalls[0].path, '/v1beta/models/gemini-runtime-model:generateContent');
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.at(-1).text, 'hello');
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.some((part) => part.text === 'Target language: fr'), true);
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.some((part) => part.text === 'Source language hint: en'), true);
      assert.deepEqual(runtime.httpCalls[0].body.metadata, {});
      assertCompletedRuntimePersistence(translationRepository, {
        requestId: 'request-1',
        sessionId: 'session-runtime-2',
        executionId: 'execution-1',
        providerKey: undefined,
        translatedText: '[gemini:fr] hello',
        targetLanguageCode: 'fr'
      });
      assertNoFailedExecutionPersistence(translationRepository);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions persists failed execution when production runtime provider throws', async () => {
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
      const bodyText = JSON.stringify(response.body);
      const storedRequest = translationRepository.translationRequests.get('request-1');
      const storedExecution = translationRepository.translationExecutions.get('execution-1');
      const storedOutputs = Array.from(translationRepository.translationOutputs.values());
      const updateCalls = translationRepository.callsFor('updateTranslationExecution');

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'internal_error');
      assert.equal(response.body.error.message, 'Unexpected server error.');
      assert.doesNotMatch(bodyText, /runtime provider failed/);
      assert.equal(storedRequest instanceof TranslationRequest, true);
      assert.equal(storedExecution instanceof TranslationExecution, true);
      assert.equal(storedExecution.status, 'failed');
      assert.notEqual(storedExecution.status, 'completed');
      assert.deepEqual(storedExecution.failureInfo, { reason: 'provider_execution_failed' });
      assert.equal(storedOutputs.length, 0);
      assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0][0].status, 'failed');
      assert.equal(updateCalls.some(([execution]) => execution.status === 'completed'), false);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.equal(runtime.httpCalls.length, 1);
      assert.equal(runtime.httpCalls[0].body.contents[0].parts.at(-1).text, 'hello');
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions propagates original production provider error through application boundary', async () => {
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

  await assert.rejects(
    dependencies.translationCommandController.createTranslationExecution(
      translationExecutionPayload({
        sourceText: 'hello',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr',
        providerKey: 'gemini'
      })
    ),
    (actualError) => actualError === providerError
  );

  assert.equal(runtime.httpCalls.length, 1);
  assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
  assert.equal(translationRepository.callsFor('updateTranslationExecution').length, 1);
  assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'failed');
});

test('POST /api/translation-executions persists failed execution when fake GeminiClient throws GeminiHttpError', async () => {
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
      const bodyText = JSON.stringify(response.body);
      const storedExecution = translationRepository.translationExecutions.get('execution-1');
      const storedOutputs = Array.from(translationRepository.translationOutputs.values());
      const updateCalls = translationRepository.callsFor('updateTranslationExecution');

      assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
      assert.equal(dependencies.retryPolicy.maxRetries, 0);
      assert.equal(response.status, 429);
      assert.equal(response.body.error.code, 'rate_limited');
      assert.equal(response.body.error.message, 'Too many requests. Please try again later.');
      assert.doesNotMatch(bodyText, /Gemini HTTP request failed/);
      assert.equal(runtime.geminiClientCalls.length, 1);
      assert.deepEqual(runtime.geminiClientCalls[0], {
        sourceText: 'hello',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr'
      });
      assert.equal(storedExecution instanceof TranslationExecution, true);
      assert.equal(storedExecution.status, 'failed');
      assert.notEqual(storedExecution.status, 'completed');
      assert.deepEqual(storedExecution.failureInfo, { reason: 'provider_execution_failed' });
      assert.equal(storedOutputs.length, 0);
      assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0][0].status, 'failed');
      assert.equal(updateCalls.some(([execution]) => execution.status === 'completed'), false);
    },
    runtime.options
  );

  assert.deepEqual(input, before);
});

test('GeminiHttpError from fake GeminiClient is rethrown unchanged through application boundary', async () => {
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

  await assert.rejects(
    dependencies.translationCommandController.createTranslationExecution(
      translationExecutionPayload({
        sourceText: 'hello',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'fr',
        providerKey: 'gemini'
      })
    ),
    (actualError) => {
      assert.strictEqual(actualError, geminiError);
      assert.equal(actualError.name, 'GeminiHttpError');
      assert.equal(actualError.status, 503);
      assert.equal(actualError.code, 'server_error');
      assert.equal(actualError.message, 'Gemini HTTP request failed: server_error (503).');
      return true;
    }
  );

  assert.equal(runtime.geminiClientCalls.length, 1);
  assert.equal(translationRepository.callsFor('createTranslationExecution').length, 1);
  assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
  assert.equal(translationRepository.callsFor('updateTranslationExecution').length, 1);
  assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'failed');
  assert.deepEqual(translationRepository.translationExecutions.get('execution-1').failureInfo, {
    reason: 'provider_execution_failed'
  });
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

test('POST /api/translation-executions reaches fake execution provider through execution provider resolver', async () => {
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
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'pending',
        startedAt: '2026-07-14T01:01:00.000Z',
        completedAt: null,
        failureInfo: null,
        providerKey: 'fake'
      });
      assertCompletedRuntimePersistence(translationRepository, {
        requestId: 'request-1',
        sessionId: 'session-runtime-fake-resolver',
        executionId: 'execution-1',
        providerKey: 'fake',
        translatedText: '[fake] hello',
        targetLanguageCode: 'fr'
      });
      assertNoFailedExecutionPersistence(translationRepository);
    },
    {
      translationExecutionProviderResolver: resolver
    }
  );
});

test('POST /api/translation-executions resolves omitted providerKey through fake resolver default', async () => {
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
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'pending',
        startedAt: '2026-07-14T01:01:00.000Z',
        completedAt: null,
        failureInfo: null
      });
      assertCompletedRuntimePersistence(translationRepository, {
        requestId: 'request-1',
        sessionId: 'session-runtime-fake-default',
        executionId: 'execution-1',
        providerKey: undefined,
        translatedText: '[fake] hello',
        targetLanguageCode: 'fr'
      });
      assertNoFailedExecutionPersistence(translationRepository);
    },
    {
      translationExecutionProviderResolver: resolver
    }
  );
});

test('POST /api/translation-executions marks execution failed when fake resolver rejects unknown provider', async () => {
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
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/translation-executions`, input);
      const bodyText = JSON.stringify(response.body);
      const storedExecution = translationRepository.translationExecutions.get('execution-1');
      const storedOutputs = Array.from(translationRepository.translationOutputs.values());
      const updateCalls = translationRepository.callsFor('updateTranslationExecution');

      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'internal_error');
      assert.equal(response.body.error.message, 'Unexpected server error.');
      assert.doesNotMatch(bodyText, /missing-provider/);
      assert.equal(storedExecution instanceof TranslationExecution, true);
      assert.equal(storedExecution.status, 'failed');
      assert.deepEqual(storedExecution.failureInfo, { reason: 'provider_execution_failed' });
      assert.equal(storedOutputs.length, 0);
      assert.equal(translationRepository.callsFor('createTranslationOutput').length, 0);
      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0][0].status, 'failed');
    },
    {
      translationExecutionProviderResolver: resolver
    }
  );
});

test('PATCH /api/translation-executions/:executionId URL-decodes and starts a pending execution', async () => {
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
    assert.equal(originalExecution.status, 'pending');
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
      createdAt: '2026-07-14T01:06:00.000Z'
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

async function withTranslationCommandServer(translationRepository, run) {
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    requestHandlerFactory: createRequestHandler
  });
  const server = http.createServer(dependencies.requestHandler);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
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
        GEMINI_MODEL: 'gemini-runtime-model'
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

function createGeminiClientErrorRuntimeFixture({ error }) {
  const geminiClientCalls = [];

  return {
    geminiClientCalls,
    options: {
      env: {
        GEMINI_API_KEY: 'gemini-runtime-api-key',
        GEMINI_MODEL: 'gemini-runtime-model'
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
  assert.equal(updateExecutionCalls.length, 1);
  assert.equal(updateExecutionCalls[0][0].status, 'completed');
  assert.equal(updateExecutionCalls.some(([execution]) => execution.status === 'failed'), false);
  assert.equal(createOutputCalls.length, 1);
  assert.equal(storedOutputs.length, 1);
  assert.strictEqual(storedExecution, updateExecutionCalls[0][0]);
  assert.strictEqual(storedOutput, createOutputCalls[0][0]);
  assertExecutionFields(storedExecution, {
    executionId,
    requestId,
    sessionId: undefined,
    status: 'completed',
    providerKey
  });
  assert.equal(Object.hasOwn(storedExecution, 'providerKey'), true);
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

function assertExecutionFields(execution, expected) {
  assert.equal(execution.id, expected.executionId);
  assert.equal(execution.translationRequestId, expected.requestId);
  assert.equal(execution.sessionId, expected.sessionId);
  assert.equal(execution.status, expected.status);
  assert.equal(execution.providerKey, expected.providerKey);
}
