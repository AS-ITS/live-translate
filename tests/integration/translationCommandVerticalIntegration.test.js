import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createTranslationCommandController } from '../../server/translationCommandController.js';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';

test('POST /api/translation-requests creates and stores a TranslationRequest through the full write path', async () => {
  const translationRepository = createTranslationRepositoryFixture();
  const input = translationRequestPayload();
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-requests`, input);

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(response.body, {
      id: 'request-1',
      sessionId: 'session-1',
      sourceTranscriptRevisionId: 'source-revision-1',
      targetLanguageCode: 'ja',
      sourceTranscriptSnapshot: null,
      createdAt: 1000
    });
    assert.equal(translationRepository.translationRequests.has('request-1'), true);
    assert.equal(translationRepository.translationRequests.get('request-1').id, 'request-1');
  });

  assert.deepEqual(input, before);
});

test('POST /api/translation-executions creates and stores a pending TranslationExecution through the full write path', async () => {
  const translationRepository = createTranslationRepositoryFixture();
  const input = translationExecutionPayload();
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-executions`, input);

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: 'execution-1',
      translationRequestId: 'request-1',
      status: 'pending',
      startedAt: 1000,
      completedAt: null,
      failureInfo: null
    });
    assert.equal(translationRepository.translationExecutions.has('execution-1'), true);
    assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'pending');
  });

  assert.deepEqual(input, before);
});

test('PATCH /api/translation-executions/:executionId applies a legal domain transition through the service', async () => {
  const translationRepository = createTranslationRepositoryFixture();

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    await postJson(`${baseUrl}/api/translation-executions`, translationExecutionPayload());
    const originalExecution = translationRepository.translationExecutions.get('execution-1');

    const response = await patchJson(`${baseUrl}/api/translation-executions/execution-1`, {
      id: 'wrong-id',
      executionId: 'wrong-execution-id',
      transition: 'start',
      startedAt: 1100
    });

    const storedExecution = translationRepository.translationExecutions.get('execution-1');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      id: 'execution-1',
      translationRequestId: 'request-1',
      status: 'running',
      startedAt: 1100,
      completedAt: null,
      failureInfo: null
    });
    assert.notStrictEqual(storedExecution, originalExecution);
    assert.equal(Object.isFrozen(originalExecution), true);
    assert.equal(originalExecution.status, 'pending');
    assert.equal(storedExecution.status, 'running');
  });
});

test('POST /api/translation-outputs creates and stores a TranslationOutput through the full write path', async () => {
  const translationRepository = createTranslationRepositoryFixture();
  const input = translationOutputPayload();
  const before = structuredClone(input);

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-outputs`, input);

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: 'output-1',
      executionId: 'execution-1',
      sequence: 0,
      translatedText: 'Bonjour',
      targetLanguageCode: 'fr',
      providerMetadata: null,
      providerMetadataAvailable: false,
      createdAt: 1200
    });
    assert.equal(translationRepository.translationOutputs.has('output-1'), true);
    assert.equal(translationRepository.translationOutputs.get('output-1').executionId, 'execution-1');
    assert.equal(translationRepository.translationOutputs.get('output-1').targetLanguageCode, 'fr');
    assert.equal(translationRepository.translationOutputs.get('output-1').sequence, 0);
  });

  assert.deepEqual(input, before);
});

test('invalid TranslationRequest input follows existing internal error path and is not stored', async () => {
  const translationRepository = createTranslationRepositoryFixture();

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/translation-requests`, {
      ...translationRequestPayload(),
      targetLanguageCode: ''
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal(response.body.error.message, 'Unexpected server error.');
    assert.equal(translationRepository.translationRequests.size, 0);
  });
});

test('illegal TranslationExecution transition is rejected by domain rules without replacing stored state', async () => {
  const translationRepository = createTranslationRepositoryFixture();

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    await postJson(`${baseUrl}/api/translation-executions`, translationExecutionPayload());
    const runningResponse = await patchJson(`${baseUrl}/api/translation-executions/execution-1`, {
      transition: 'start',
      startedAt: 1100
    });
    const runningExecution = translationRepository.translationExecutions.get('execution-1');

    const illegalResponse = await patchJson(`${baseUrl}/api/translation-executions/execution-1`, {
      transition: 'start',
      startedAt: 1200
    });

    assert.equal(runningResponse.status, 200);
    assert.equal(illegalResponse.status, 500);
    assert.equal(illegalResponse.body.error.code, 'internal_error');
    assert.strictEqual(translationRepository.translationExecutions.get('execution-1'), runningExecution);
    assert.equal(translationRepository.translationExecutions.get('execution-1').status, 'running');
    assert.equal(translationRepository.translationExecutions.get('execution-1').startedAt, 1100);
  });
});

test('GET /health still works through the same request handler', async () => {
  const translationRepository = createTranslationRepositoryFixture();

  await withTranslationCommandServer(translationRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(response.body.requestId);
  });
});

async function withTranslationCommandServer(translationRepository, run) {
  const translationCommandService = createTranslationCommandService({
    translationRepository
  });
  const translationCommandController = createTranslationCommandController({
    translationCommandService
  });
  const requestHandler = createRequestHandler({
    translationCommandController
  });
  const server = http.createServer(requestHandler);

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

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      'x-request-id': 'test-request-id'
    }
  });
  const body = await response.json();

  return {
    status: response.status,
    headers: response.headers,
    body
  };
}

function postJson(url, body) {
  return sendJson(url, 'POST', body);
}

function patchJson(url, body) {
  return sendJson(url, 'PATCH', body);
}

async function sendJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'test-request-id'
    },
    body: JSON.stringify(body)
  });
  const responseBody = await response.json();

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody
  };
}

function createTranslationRepositoryFixture() {
  const translationRequests = new Map();
  const translationExecutions = new Map();
  const translationOutputs = new Map();

  return {
    translationRequests,
    translationExecutions,
    translationOutputs,

    createTranslationRequest(request) {
      translationRequests.set(request.id, request);
      return request;
    },

    getTranslationRequest(requestId) {
      return translationRequests.get(requestId) ?? null;
    },

    updateTranslationRequest(request) {
      translationRequests.set(request.id, request);
      return request;
    },

    createTranslationExecution(execution) {
      translationExecutions.set(execution.id, execution);
      return execution;
    },

    getTranslationExecution(executionId) {
      return translationExecutions.get(executionId) ?? null;
    },

    updateTranslationExecution(execution) {
      translationExecutions.set(execution.id, execution);
      return execution;
    },

    createTranslationOutput(output) {
      translationOutputs.set(output.id, output);
      return output;
    },

    listTranslationOutputsByExecution(executionId) {
      return Array.from(translationOutputs.values()).filter((output) => output.executionId === executionId);
    },

    getTranslationOutput(outputId) {
      return translationOutputs.get(outputId) ?? null;
    }
  };
}

function translationRequestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'ja',
    createdAt: 1000,
    ...overrides
  };
}

function translationExecutionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
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
    createdAt: 1200,
    ...overrides
  };
}
