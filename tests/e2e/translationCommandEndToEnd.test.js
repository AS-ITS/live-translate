import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';

const transcriptSummary = Object.freeze({
  totalItems: 2,
  sourceFinalCount: 1,
  translationFinalCount: 1,
  sourcePartialCount: 0,
  translationPartialCount: 0,
  hasTranscript: true
});

test('translation command persists through production HTTP path and preserves legacy session read compatibility', async () => {
  const originalRecord = sessionRecord({
    metadata: {
      owner: 'phase-2b',
      nested: { preserved: true }
    },
    history: {
      entries: [{ id: 'history-1', status: 'completed' }]
    },
    export: {
      formats: ['txt', 'srt', 'vtt']
    }
  });
  const originalTranscriptItems = [
    transcriptItem({
      id: 'source-final-1',
      stream: 'source',
      status: 'final',
      text: 'Hello world.',
      sequence: 1
    }),
    transcriptItem({
      id: 'translation-final-2',
      stream: 'translation',
      status: 'final',
      text: 'Bonjour le monde.',
      sequence: 2
    })
  ];
  const sessionRepository = legacySessionRepository({
    records: [originalRecord],
    transcriptItems: {
      'session-1': originalTranscriptItems
    }
  });
  const requestPayload = translationRequestPayload({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision:session-1:final',
      items: [
        {
          id: 'source-final-1',
          text: 'Hello world.',
          nested: { preserved: true }
        }
      ]
    }
  });
  const executionId = 'execution/日本語';
  const outputPayload = translationOutputPayload({ executionId });
  const requestPayloadBefore = clone(requestPayload);
  const executionPayload = translationExecutionPayload({ id: executionId });
  const executionPayloadBefore = clone(executionPayload);
  const outputPayloadBefore = clone(outputPayload);

  await withApplicationServer(sessionRepository, async (baseUrl) => {
    const createRequestResponse = await postJson(`${baseUrl}/api/translation-requests`, requestPayload);

    assert.equal(createRequestResponse.status, 201);
    assert.deepEqual(createRequestResponse.body, requestPayloadBefore);

    const createExecutionResponse = await postJson(`${baseUrl}/api/translation-executions`, executionPayload);

    assert.equal(createExecutionResponse.status, 202);
    assert.deepEqual(createExecutionResponse.body, {
      id: executionId,
      translationRequestId: 'request-1',
      status: 'queued',
      startedAt: '2026-07-14T01:01:00.000Z',
      completedAt: null,
      failureInfo: null
    });

    const runningResponse = await patchJson(`${baseUrl}/api/translation-executions/${encodeURIComponent(executionId)}`, {
      id: 'body-id-must-not-win',
      executionId: 'body-execution-id-must-not-win',
      transition: 'start',
      startedAt: '2026-07-14T01:02:00.000Z'
    });

    assert.equal(runningResponse.status, 200);
    assert.equal(runningResponse.body.id, executionId);
    assert.equal(runningResponse.body.status, 'running');
    assert.equal(runningResponse.body.startedAt, '2026-07-14T01:02:00.000Z');

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

    const outputResponse = await postJson(`${baseUrl}/api/translation-outputs`, outputPayload);

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

    assert.deepEqual(requestPayload, requestPayloadBefore);
    assert.deepEqual(executionPayload, executionPayloadBefore);
    assert.deepEqual(outputPayload, outputPayloadBefore);

    requestPayload.sourceTranscriptSnapshot.items[0].nested.preserved = false;
    outputPayload.providerMetadata.nested.preserved = false;

    const persistedDetail = sessionRepository.getSessionRecord('session-1');
    const commandState = persistedDetail.sessionRecord.translationCommandState;

    assert.equal(commandState.requests.length, 1);
    assert.deepEqual(commandState.requests[0], {
      id: 'request-1',
      sessionId: 'session-1',
      sourceTranscriptRevisionId: 'source-revision:session-1:final',
      sourceTranscriptSnapshot: {
        revisionId: 'source-revision:session-1:final',
        items: [
          {
            id: 'source-final-1',
            text: 'Hello world.',
            nested: { preserved: true }
          }
        ]
      },
      targetLanguageCode: 'ja',
      createdAt: '2026-07-14T01:00:00.000Z'
    });
    assert.equal(commandState.requests[0].id, 'request-1');
    assert.equal(commandState.requests[0].sessionId, 'session-1');
    assert.equal(commandState.requests[0].targetLanguageCode, 'ja');
    assert.equal(commandState.requests[0].createdAt, '2026-07-14T01:00:00.000Z');

    assert.equal(commandState.executions.length, 1);
    assert.deepEqual(commandState.executions[0], {
      id: executionId,
      translationRequestId: 'request-1',
      status: 'completed',
      startedAt: '2026-07-14T01:02:00.000Z',
      completedAt: '2026-07-14T01:03:00.000Z',
      failureInfo: null
    });
    assert.equal(commandState.executions[0].id, executionId);
    assert.equal(commandState.executions[0].translationRequestId, 'request-1');
    assert.equal(commandState.executions[0].status, 'completed');
    assert.equal(commandState.executions[0].startedAt, '2026-07-14T01:02:00.000Z');
    assert.equal(commandState.executions[0].completedAt, '2026-07-14T01:03:00.000Z');

    assert.equal(commandState.outputs.length, 1);
    assert.deepEqual(commandState.outputs[0], {
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
    });
    assert.equal(commandState.outputs[0].id, 'output-1');
    assert.equal(commandState.outputs[0].executionId, executionId);
    assert.equal(commandState.outputs[0].targetLanguageCode, 'fr');
    assert.equal(commandState.outputs[0].translatedText, 'Bonjour');
    assert.equal(commandState.outputs[0].createdAt, '2026-07-14T01:04:00.000Z');

    assert.deepEqual(persistedDetail.sessionRecord.metadata, originalRecord.metadata);
    assert.deepEqual(persistedDetail.sessionRecord.history, originalRecord.history);
    assert.deepEqual(persistedDetail.sessionRecord.export, originalRecord.export);
    assert.deepEqual(persistedDetail.sessionRecord.transcriptSummary, transcriptSummary);
    assert.deepEqual(persistedDetail.transcriptItems, originalTranscriptItems);

    const sessionReadResponse = await getJson(`${baseUrl}/api/sessions/session-1`);

    assert.equal(sessionReadResponse.status, 200);
    assert.deepEqual(sessionReadResponse.body, {
      session: {
        id: 'session-1',
        status: 'completed',
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
        failureReason: null,
        failureCategory: null,
        selectedInputDeviceId: 'device-1',
        inputDeviceLabelSnapshot: 'Studio Mic',
        transcriptSummary
      },
      sourceTranscript: {
        id: 'source:session-1',
        sessionId: 'session-1',
        revisionId: 'source-revision:session-1:final',
        status: 'finalized',
        items: [originalTranscriptItems[0]],
        createdAt: 1000,
        finalizedAt: 5000,
        legacy: true
      },
      translationOutputs: [
        {
          id: 'legacy-output:session-1:fr',
          translationRequestId: 'legacy-request:session-1:fr',
          sessionId: 'session-1',
          sourceTranscriptRevisionId: 'source-revision:session-1:final',
          targetLanguageCode: 'fr',
          targetLanguageLabel: 'French',
          status: 'completed',
          items: [originalTranscriptItems[1]],
          provider: null,
          model: null,
          providerMetadataAvailable: false,
          createdAt: 1000,
          completedAt: 5000,
          legacy: true
        }
      ],
      selectedTranslationOutput: {
        id: 'legacy-output:session-1:fr',
        translationRequestId: 'legacy-request:session-1:fr',
        sessionId: 'session-1',
        sourceTranscriptRevisionId: 'source-revision:session-1:final',
        targetLanguageCode: 'fr',
        targetLanguageLabel: 'French',
        status: 'completed',
        items: [originalTranscriptItems[1]],
        provider: null,
        model: null,
        providerMetadataAvailable: false,
        createdAt: 1000,
        completedAt: 5000,
        legacy: true
      },
      legacy: true
    });
    assert.equal(Object.hasOwn(sessionReadResponse.body, 'translationCommandState'), false);
    assert.equal(Object.hasOwn(sessionReadResponse.body.session, 'translationCommandState'), false);

    const historyResponse = await getJson(`${baseUrl}/api/sessions`);

    assert.equal(historyResponse.status, 200);
    assert.deepEqual(historyResponse.body, [
      {
        id: 'session-1',
        status: 'completed',
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
        targetLanguageCode: 'fr',
        targetLanguageLabel: 'French',
        failureReason: null,
        failureCategory: null,
        transcriptSummary,
        legacy: true
      }
    ]);
    assert.equal(Object.hasOwn(historyResponse.body[0], 'translationCommandState'), false);
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
    history: overrides.history ?? null,
    export: overrides.export ?? null,
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
    status: 'created',
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
