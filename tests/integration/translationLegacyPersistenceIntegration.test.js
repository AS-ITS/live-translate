import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';

const transcriptSummary = Object.freeze({
  totalItems: 1,
  sourceFinalCount: 1,
  translationFinalCount: 0,
  sourcePartialCount: 0,
  translationPartialCount: 0,
  hasTranscript: true
});

test('translation command HTTP path persists command state through production composition legacy adapter', async () => {
  const sessionRepository = legacySessionRepository({
    records: [
      sessionRecord({
        id: 'session-1',
        targetLanguageCode: 'ja',
        targetLanguageLabel: 'Japanese',
        transcriptSummary,
        metadata: { preserved: true }
      })
    ],
    transcriptItems: {
      'session-1': [
        transcriptItem({
          id: 'source-final-1',
          sessionId: 'session-1',
          stream: 'source',
          status: 'final',
          text: 'Hello world.',
          sequence: 1
        })
      ]
    }
  });
  const requestBody = translationRequestPayload({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision:session-1:final',
      items: [{ id: 'source-final-1', text: 'Hello world.', nested: { preserved: true } }]
    }
  });
  const requestBodyBefore = structuredClone(requestBody);

  await withApplicationServer(sessionRepository, async (baseUrl) => {
    const requestResponse = await postJson(`${baseUrl}/api/translation-requests`, requestBody);

    assert.equal(requestResponse.status, 201);
    assert.deepEqual(requestResponse.body, requestBody);
    assertCommandState(sessionRepository, {
      requests: [
        {
          id: 'request-1',
          sessionId: 'session-1',
          sourceTranscriptRevisionId: 'source-revision:session-1:final',
          sourceTranscriptSnapshot: {
            revisionId: 'source-revision:session-1:final',
            items: [{ id: 'source-final-1', text: 'Hello world.', nested: { preserved: true } }]
          },
          targetLanguageCode: 'ja',
          createdAt: '2026-07-14T01:00:00.000Z'
        }
      ],
      executions: [],
      outputs: []
    });

    assert.deepEqual(requestBody, requestBodyBefore);
    requestBody.sourceTranscriptSnapshot.items[0].nested.preserved = false;
    assert.equal(
      sessionRepository.getSessionRecord('session-1').sessionRecord.translationCommandState.requests[0]
        .sourceTranscriptSnapshot.items[0].nested.preserved,
      true
    );
    assert.deepEqual(requestBodyBefore, translationRequestPayload({ sourceTranscriptSnapshot: requestBodyBefore.sourceTranscriptSnapshot }));

    const executionId = 'execution unicode 1';
    const executionResponse = await postJson(
      `${baseUrl}/api/translation-executions`,
      translationExecutionPayload({
        id: executionId
      })
    );

    assert.equal(executionResponse.status, 201);
    assert.deepEqual(executionResponse.body, {
      id: executionId,
      translationRequestId: 'request-1',
      status: 'pending',
      startedAt: '2026-07-14T01:01:00.000Z',
      completedAt: null,
      failureInfo: null
    });

    const runningResponse = await patchJson(`${baseUrl}/api/translation-executions/${encodeURIComponent(executionId)}`, {
      id: 'body-id-ignored',
      executionId: 'body-execution-id-ignored',
      transition: 'start',
      startedAt: '2026-07-14T01:02:00.000Z'
    });

    assert.equal(runningResponse.status, 200);
    assert.deepEqual(runningResponse.body, {
      id: executionId,
      translationRequestId: 'request-1',
      status: 'running',
      startedAt: '2026-07-14T01:02:00.000Z',
      completedAt: null,
      failureInfo: null
    });

    const completedResponse = await patchJson(`${baseUrl}/api/translation-executions/${encodeURIComponent(executionId)}`, {
      transition: 'complete',
      completedAt: '2026-07-14T01:03:00.000Z'
    });

    assert.equal(completedResponse.status, 200);
    assert.deepEqual(completedResponse.body, {
      id: executionId,
      translationRequestId: 'request-1',
      status: 'completed',
      startedAt: '2026-07-14T01:02:00.000Z',
      completedAt: '2026-07-14T01:03:00.000Z',
      failureInfo: null
    });

    const outputResponse = await postJson(
      `${baseUrl}/api/translation-outputs`,
      translationOutputPayload({
        executionId
      })
    );

    assert.equal(outputResponse.status, 201);
    assert.deepEqual(outputResponse.body, {
      id: 'output-1',
      executionId,
      sequence: 0,
      translatedText: 'Bonjour',
      targetLanguageCode: 'fr',
      providerMetadata: {
        provider: 'fixture-provider',
        nested: { preserved: true }
      },
      providerMetadataAvailable: true,
      createdAt: '2026-07-14T01:04:00.000Z'
    });

    assertCommandState(sessionRepository, {
      requests: [
        {
          id: 'request-1',
          sessionId: 'session-1',
          sourceTranscriptRevisionId: 'source-revision:session-1:final',
          sourceTranscriptSnapshot: {
            revisionId: 'source-revision:session-1:final',
            items: [{ id: 'source-final-1', text: 'Hello world.', nested: { preserved: true } }]
          },
          targetLanguageCode: 'ja',
          createdAt: '2026-07-14T01:00:00.000Z'
        }
      ],
      executions: [
        {
          id: executionId,
          translationRequestId: 'request-1',
          status: 'completed',
          startedAt: '2026-07-14T01:02:00.000Z',
          completedAt: '2026-07-14T01:03:00.000Z',
          failureInfo: null
        }
      ],
      outputs: [
        {
          id: 'output-1',
          executionId,
          sequence: 0,
          translatedText: 'Bonjour',
          targetLanguageCode: 'fr',
          providerMetadata: {
            provider: 'fixture-provider',
            nested: { preserved: true }
          },
          createdAt: '2026-07-14T01:04:00.000Z'
        }
      ]
    });

    const persistedDetail = sessionRepository.getSessionRecord('session-1');
    assert.equal(persistedDetail.sessionRecord.metadata.preserved, true);
    assert.deepEqual(persistedDetail.sessionRecord.transcriptSummary, transcriptSummary);
    assert.deepEqual(
      persistedDetail.transcriptItems.map((item) => item.id),
      ['source-final-1']
    );
    assert.equal(persistedDetail.sessionRecord.translationCommandState.executions.length, 1);

    const historyResponse = await getJson(`${baseUrl}/api/sessions`);
    assert.equal(historyResponse.status, 200);
    assert.equal(historyResponse.body.length, 1);
    assert.equal(Object.hasOwn(historyResponse.body[0], 'translationCommandState'), false);
    assert.deepEqual(historyResponse.body[0], {
      id: 'session-1',
      status: 'completed',
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      targetLanguageCode: 'ja',
      targetLanguageLabel: 'Japanese',
      failureReason: null,
      failureCategory: null,
      transcriptSummary,
      legacy: true
    });

    const detailResponse = await getJson(`${baseUrl}/api/sessions/session-1`);
    assert.equal(detailResponse.status, 200);
    assert.equal(Object.hasOwn(detailResponse.body, 'translationCommandState'), false);
    assert.equal(Object.hasOwn(detailResponse.body.session, 'translationCommandState'), false);
    assert.deepEqual(
      detailResponse.body.sourceTranscript.items.map((item) => item.id),
      ['source-final-1']
    );
    assert.deepEqual(detailResponse.body.translationOutputs, []);
    assert.equal(detailResponse.body.selectedTranslationOutput, null);
  });
});

test('translation request for missing legacy session uses existing internal error response', async () => {
  const sessionRepository = legacySessionRepository();

  await withApplicationServer(sessionRepository, async (baseUrl) => {
    const response = await postJson(
      `${baseUrl}/api/translation-requests`,
      translationRequestPayload({
        sessionId: 'missing-session'
      })
    );
    const bodyText = JSON.stringify(response.body);

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal(response.body.error.message, 'Unexpected server error.');
    assert.ok(response.body.error.requestId);
    assert.doesNotMatch(bodyText, /Session record not found/);
    assert.deepEqual(sessionRepository.listSessionRecords(), []);
  });
});

async function withApplicationServer(sessionRepository, run) {
  const dependencies = createApplicationDependencies({
    sessionRepository,
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

function assertCommandState(sessionRepository, expectedState) {
  const detail = sessionRepository.getSessionRecord('session-1');

  assert.deepEqual(detail.sessionRecord.translationCommandState, expectedState);
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
    body: responseBody
  };
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
    body
  };
}

function legacySessionRepository({ records = [], transcriptItems = {} } = {}) {
  const storedRecords = new Map(records.map((record) => [record.id, clone(record)]));
  const storedTranscriptItems = new Map(
    Object.entries(transcriptItems).map(([sessionId, items]) => [sessionId, clone(items)])
  );

  return {
    getSessionRecord(sessionId) {
      const record = storedRecords.get(sessionId);

      if (!record) {
        return null;
      }

      return {
        sessionRecord: clone(record),
        transcriptItems: clone(storedTranscriptItems.get(sessionId) || [])
      };
    },

    listSessionRecords() {
      return Array.from(storedRecords.values(), clone);
    },

    updateSessionRecord(sessionId, patch = {}) {
      const record = storedRecords.get(sessionId);

      if (!record) {
        throw new Error(`Session record not found: ${sessionId}`);
      }

      const nextRecord = {
        ...record,
        ...clone(patch),
        id: record.id,
        createdAt: record.createdAt
      };
      storedRecords.set(sessionId, nextRecord);

      return clone(nextRecord);
    }
  };
}

function sessionRecord(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    status: overrides.status || 'completed',
    startedAt: overrides.startedAt ?? 1000,
    endedAt: overrides.endedAt ?? 5000,
    durationMs: overrides.durationMs ?? 4000,
    targetLanguageCode: overrides.targetLanguageCode ?? 'fr',
    targetLanguageLabel: overrides.targetLanguageLabel ?? 'French',
    failureReason: overrides.failureReason ?? null,
    failureCategory: overrides.failureCategory ?? null,
    selectedInputDeviceId: overrides.selectedInputDeviceId ?? 'device-1',
    inputDeviceLabelSnapshot: overrides.inputDeviceLabelSnapshot ?? 'Studio Mic',
    transcriptSummary: overrides.transcriptSummary ?? transcriptSummary,
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? 900,
    updatedAt: overrides.updatedAt ?? 1000
  };
}

function transcriptItem(overrides = {}) {
  return {
    id: overrides.id || 'source-final-1',
    sessionId: overrides.sessionId || 'session-1',
    stream: overrides.stream || 'source',
    status: overrides.status || 'final',
    text: overrides.text || 'Text.',
    sequence: overrides.sequence ?? 1,
    startedAt: overrides.startedAt ?? 1100,
    finalizedAt: overrides.finalizedAt ?? 1200
  };
}

function translationRequestPayload(overrides = {}) {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision:session-1:final',
    sourceTranscriptSnapshot: null,
    targetLanguageCode: 'ja',
    createdAt: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}

function translationExecutionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    status: 'pending',
    startedAt: '2026-07-14T01:01:00.000Z',
    completedAt: null,
    failureInfo: null,
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
    providerMetadata: {
      provider: 'fixture-provider',
      nested: { preserved: true }
    },
    createdAt: '2026-07-14T01:04:00.000Z',
    ...overrides
  };
}

function clone(value) {
  return structuredClone(value);
}
