import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';

const populatedSummary = Object.freeze({
  totalItems: 4,
  sourceFinalCount: 1,
  translationFinalCount: 1,
  sourcePartialCount: 1,
  translationPartialCount: 1,
  hasTranscript: true
});

const emptySummary = Object.freeze({
  totalItems: 0,
  sourceFinalCount: 0,
  translationFinalCount: 0,
  sourcePartialCount: 0,
  translationPartialCount: 0,
  hasTranscript: false
});

test('GET /api/sessions returns mapped legacy session history through production wiring', async () => {
  const firstRecord = sessionRecord({
    id: 'session-newer',
    status: 'failed',
    startedAt: 3000,
    endedAt: undefined,
    durationMs: undefined,
    targetLanguageCode: undefined,
    targetLanguageLabel: undefined,
    failureReason: 'unexpected_close',
    failureCategory: 'provider',
    transcriptSummary: undefined
  });
  const secondRecord = sessionRecord({
    id: 'session-older',
    status: 'completed',
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    targetLanguageCode: 'fr',
    targetLanguageLabel: 'French',
    transcriptSummary: populatedSummary
  });
  const sessionRepository = legacyRepository({
    records: [firstRecord, secondRecord]
  });

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions`);

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body));
    assert.deepEqual(
      response.body.map((item) => item.id),
      ['session-newer', 'session-older']
    );
    assert.deepEqual(response.body[0], {
      id: 'session-newer',
      status: 'failed',
      startedAt: 3000,
      endedAt: null,
      durationMs: null,
      targetLanguageCode: null,
      targetLanguageLabel: null,
      failureReason: 'unexpected_close',
      failureCategory: 'provider',
      transcriptSummary: emptySummary,
      recordKind: 'session',
      retranslatedFrom: null,
      legacy: true
    });
    assert.deepEqual(response.body[1], {
      id: 'session-older',
      status: 'completed',
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      targetLanguageCode: 'fr',
      targetLanguageLabel: 'French',
      failureReason: null,
      failureCategory: null,
      transcriptSummary: populatedSummary,
      recordKind: 'session',
      retranslatedFrom: null,
      legacy: true
    });
  });
});

test('GET /api/sessions/:sessionId returns mapped legacy detail through production wiring', async () => {
  const record = sessionRecord({
    id: 'session-detail',
    targetLanguageCode: 'ja',
    targetLanguageLabel: 'Japanese',
    transcriptSummary: populatedSummary
  });
  const detail = {
    sessionRecord: record,
    transcriptItems: [
      transcriptItem({
        id: 'translation-final-4',
        sessionId: 'session-detail',
        stream: 'translation',
        status: 'final',
        text: '世界。',
        sequence: 4
      }),
      transcriptItem({
        id: 'source-final-1',
        sessionId: 'session-detail',
        stream: 'source',
        status: 'final',
        text: 'Hello.',
        sequence: 1
      }),
      transcriptItem({
        id: 'translation-partial-2',
        sessionId: 'session-detail',
        stream: 'translation',
        status: 'partial',
        text: '世',
        sequence: 2
      }),
      transcriptItem({
        id: 'source-partial-3',
        sessionId: 'session-detail',
        stream: 'source',
        status: 'partial',
        text: 'draft',
        sequence: 3
      }),
      transcriptItem({
        id: 'translation-final-2',
        sessionId: 'session-detail',
        stream: 'translation',
        status: 'final',
        text: 'こんにちは',
        sequence: 2
      }),
      transcriptItem({
        id: 'source-final-5',
        sessionId: 'session-detail',
        stream: 'source',
        status: 'final',
        text: 'World.',
        sequence: 5
      })
    ]
  };
  const sessionRepository = legacyRepository({
    details: { 'session-detail': detail }
  });

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions/session-detail`);
    const body = response.body;

    assert.equal(response.status, 200);
    assert.equal(body.legacy, true);
    assert.deepEqual(body.session, {
      id: 'session-detail',
      status: 'completed',
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      failureReason: null,
      failureCategory: null,
      selectedInputDeviceId: 'device-1',
      inputDeviceLabelSnapshot: 'Studio Mic',
      transcriptSummary: populatedSummary,
      recordKind: 'session',
      retranslatedFrom: null
    });
    assert.deepEqual(body.sourceTranscript, {
      id: 'source:session-detail',
      sessionId: 'session-detail',
      revisionId: 'source-revision:session-detail:final',
      status: 'finalized',
      items: [
        transcriptItem({
          id: 'source-final-1',
          sessionId: 'session-detail',
          stream: 'source',
          status: 'final',
          text: 'Hello.',
          sequence: 1
        }),
        transcriptItem({
          id: 'source-final-5',
          sessionId: 'session-detail',
          stream: 'source',
          status: 'final',
          text: 'World.',
          sequence: 5
        })
      ],
      createdAt: 1000,
      finalizedAt: 5000,
      legacy: true
    });
    assert.deepEqual(
      body.translationOutputs.map((output) => output.id),
      ['legacy-output:session-detail:ja']
    );
    assert.deepEqual(body.readingContent.translationArticle, {
      kind: 'translationArticle',
      status: 'available',
      targetLanguageCode: 'ja',
      targetLanguageLabel: 'Japanese',
      version: null,
      text: 'こんにちは 世界。',
      paragraphs: ['こんにちは 世界。'],
      createdAt: 1000,
      completedAt: 5000,
      emptyReason: null
    });
    assert.deepEqual(body.readingContent.sourceTranscript, {
      kind: 'sourceTranscript',
      status: 'available',
      text: 'Hello. World.',
      paragraphs: ['Hello. World.'],
      createdAt: 1000,
      finalizedAt: 5000,
      emptyReason: null
    });
    assert.deepEqual(body.translationOutputs[0], {
      id: 'legacy-output:session-detail:ja',
      translationRequestId: 'legacy-request:session-detail:ja',
      sessionId: 'session-detail',
      sourceTranscriptRevisionId: 'source-revision:session-detail:final',
      targetLanguageCode: 'ja',
      targetLanguageLabel: 'Japanese',
      status: 'completed',
      items: [
        transcriptItem({
          id: 'translation-final-2',
          sessionId: 'session-detail',
          stream: 'translation',
          status: 'final',
          text: 'こんにちは',
          sequence: 2
        }),
        transcriptItem({
          id: 'translation-final-4',
          sessionId: 'session-detail',
          stream: 'translation',
          status: 'final',
          text: '世界。',
          sequence: 4
        })
      ],
      provider: null,
      model: null,
      providerMetadataAvailable: false,
      createdAt: 1000,
      completedAt: 5000,
      legacy: true
    });
    assert.deepEqual(body.selectedTranslationOutput, body.translationOutputs[0]);
  });
});

test('GET /api/sessions/:sessionId returns no translation output without final translations', async () => {
  const detail = {
    sessionRecord: sessionRecord({ id: 'session-source-only' }),
    transcriptItems: [
      transcriptItem({
        id: 'source-final-1',
        sessionId: 'session-source-only',
        stream: 'source',
        status: 'final',
        text: 'Only source.',
        sequence: 1
      }),
      transcriptItem({
        id: 'translation-partial-2',
        sessionId: 'session-source-only',
        stream: 'translation',
        status: 'partial',
        text: 'draft',
        sequence: 2
      })
    ]
  };
  const sessionRepository = legacyRepository({
    details: { 'session-source-only': detail }
  });

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions/session-source-only`);

    assert.equal(response.status, 200);
    assert.equal(response.body.legacy, true);
    assert.deepEqual(
      response.body.sourceTranscript.items.map((item) => item.id),
      ['source-final-1']
    );
    assert.deepEqual(response.body.translationOutputs, []);
    assert.equal(response.body.selectedTranslationOutput, null);
  });
});

test('GET /api/sessions/:sessionId prefers formal output for selected article read model', async () => {
  const record = sessionRecord({
    id: 'session-formal',
    targetLanguageCode: 'ja',
    targetLanguageLabel: 'Japanese',
    translationCommandState: {
      requests: [{
        id: 'legacy-request:session-formal:ja',
        sessionId: 'session-formal',
        sourceTranscriptRevisionId: 'source-revision:session-formal:final',
        sourceTranscriptSnapshot: null,
        targetLanguageCode: 'ja',
        createdAt: 1000
      }],
      executions: [{
        id: 'legacy-execution:session-formal:ja',
        translationRequestId: 'legacy-request:session-formal:ja',
        status: 'completed',
        startedAt: 1000,
        completedAt: 5000,
        failureInfo: null
      }],
      outputs: [{
        id: 'live-output:session-formal:ja',
        executionId: 'legacy-execution:session-formal:ja',
        sequence: 0,
        translatedText: 'Formal paragraph one.\n\nFormal paragraph two.',
        targetLanguageCode: 'ja',
        providerMetadata: null,
        createdAt: 5000,
        completedAt: 5000,
        sessionId: 'session-formal',
        requestId: 'legacy-request:session-formal:ja',
        sourceText: 'Hello source.',
        sourceLanguageMetadata: null,
        sourceTranscriptMetadata: {
          revisionId: 'source-revision:session-formal:final',
          snapshot: { sourceText: 'Hello source.' }
        },
        version: 1
      }]
    }
  });
  const detail = {
    sessionRecord: record,
    transcriptItems: [
      transcriptItem({
        id: 'source-final-1',
        sessionId: 'session-formal',
        stream: 'source',
        status: 'final',
        text: 'Hello source.',
        sequence: 1
      }),
      transcriptItem({
        id: 'translation-final-2',
        sessionId: 'session-formal',
        stream: 'translation',
        status: 'final',
        text: 'Legacy chunk.',
        sequence: 2
      })
    ]
  };
  const sessionRepository = legacyRepository({
    records: [record],
    details: { 'session-formal': detail }
  });

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions/session-formal`);

    assert.equal(response.status, 200);
    assert.equal(response.body.selectedTranslationOutput.id, 'live-output:session-formal:ja');
    assert.equal(response.body.selectedTranslationOutput.version, 1);
    assert.equal(response.body.readingContent.translationArticle.text, 'Formal paragraph one.\n\nFormal paragraph two.');
    assert.deepEqual(response.body.readingContent.translationArticle.paragraphs, [
      'Formal paragraph one.',
      'Formal paragraph two.'
    ]);
    assert.equal(response.body.readingContent.translationArticle.version, 1);
    assert.equal(response.body.readingContent.sourceTranscript.text, 'Hello source.');
  });
});

test('GET /api/sessions/:sessionId maps missing legacy session to structured 404', async () => {
  const sessionRepository = legacyRepository();

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions/non-existent-session`);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'session_not_found');
    assert.equal(response.body.error.message, 'Session not found.');
    assert.ok(response.body.error.requestId);
  });
});

test('unexpected legacy persistence errors use internal error handling', async () => {
  const sessionRepository = {
    ...legacyRepository(),
    listSessionRecords() {
      return [];
    },
    getSessionRecord() {
      throw new Error('sensitive persistence host db.internal:5432 stack detail');
    }
  };

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions/session-error`);
    const bodyText = JSON.stringify(response.body);

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal(response.body.error.message, 'Unexpected server error.');
    assert.notEqual(response.body.error.code, 'session_not_found');
    assert.doesNotMatch(bodyText, /sensitive persistence host/);
    assert.doesNotMatch(bodyText, /db\.internal/);
    assert.doesNotMatch(bodyText, /stack detail/);
  });
});

test('GET /api/sessions/:sessionId does not mutate legacy input data', async () => {
  const detail = {
    sessionRecord: sessionRecord({
      id: 'session-immutable',
      transcriptSummary: { ...populatedSummary }
    }),
    transcriptItems: [
      transcriptItem({
        id: 'translation-final-4',
        sessionId: 'session-immutable',
        stream: 'translation',
        status: 'final',
        text: 'Second output.',
        sequence: 4
      }),
      transcriptItem({
        id: 'source-final-3',
        sessionId: 'session-immutable',
        stream: 'source',
        status: 'final',
        text: 'Second source.',
        sequence: 3
      }),
      transcriptItem({
        id: 'translation-final-2',
        sessionId: 'session-immutable',
        stream: 'translation',
        status: 'final',
        text: 'First output.',
        sequence: 2
      }),
      transcriptItem({
        id: 'source-final-1',
        sessionId: 'session-immutable',
        stream: 'source',
        status: 'final',
        text: 'First source.',
        sequence: 1
      })
    ]
  };
  const before = jsonClone(detail);
  const sessionRepository = legacyRepository({
    details: { 'session-immutable': detail }
  });

  await withSessionReadServer(sessionRepository, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/sessions/session-immutable`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.sourceTranscript.items.map((item) => item.id),
      ['source-final-1', 'source-final-3']
    );
    assert.deepEqual(
      response.body.translationOutputs[0].items.map((item) => item.id),
      ['translation-final-2', 'translation-final-4']
    );
  });

  assert.deepEqual(detail, before);
  assert.deepEqual(
    detail.transcriptItems.map((item) => item.id),
    ['translation-final-4', 'source-final-3', 'translation-final-2', 'source-final-1']
  );
});

async function withSessionReadServer(sessionRepository, run) {
  const dependencies = createApplicationDependencies({
    env: { DATA_DIR: join(tmpdir(), `live-translate-session-read-${process.pid}`) },
    sessionRepository
  });
  const handler = createRequestHandler({
    sessionReadController: dependencies.sessionReadController,
    translationHistoryController: dependencies.translationHistoryController
  });
  const server = http.createServer(handler);

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
    body
  };
}

function legacyRepository({ records = [], details = {} } = {}) {
  return {
    createSessionRecord() {},
    updateSessionRecord() {},
    appendTranscriptItem() {},
    finalizeSessionRecord() {},
    listSessionRecords() {
      return records;
    },
    getSessionRecord(id) {
      return details[id] ?? null;
    },
    deleteSessionRecord() {
      return false;
    }
  };
}

function sessionRecord(overrides = {}) {
  const record = {
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
    transcriptSummary: overrides.transcriptSummary ?? populatedSummary,
    ...(overrides.translationCommandState ? { translationCommandState: overrides.translationCommandState } : {})
  };

  if (Object.hasOwn(overrides, 'endedAt') && overrides.endedAt === undefined) {
    delete record.endedAt;
  }
  if (Object.hasOwn(overrides, 'durationMs') && overrides.durationMs === undefined) {
    delete record.durationMs;
  }
  if (Object.hasOwn(overrides, 'targetLanguageCode') && overrides.targetLanguageCode === undefined) {
    delete record.targetLanguageCode;
  }
  if (Object.hasOwn(overrides, 'targetLanguageLabel') && overrides.targetLanguageLabel === undefined) {
    delete record.targetLanguageLabel;
  }
  if (Object.hasOwn(overrides, 'transcriptSummary') && overrides.transcriptSummary === undefined) {
    delete record.transcriptSummary;
  }

  return record;
}

function transcriptItem(overrides = {}) {
  return {
    id: overrides.id || 'item-1',
    sessionId: overrides.sessionId || 'session-1',
    stream: overrides.stream || 'source',
    status: overrides.status || 'final',
    text: overrides.text || 'Text.',
    sequence: overrides.sequence ?? 1,
    startedAt: overrides.startedAt ?? 1100,
    finalizedAt: overrides.finalizedAt ?? 1200
  };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
