import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createSessionReadController } from '../../server/sessionReadController.js';
import { createPcm16WavBytes } from '../../src/lib/audio.js';

test('GET /api/sessions calls listSessionHistory exactly once', async () => {
  let listCalls = 0;
  const handler = createHandler({
    listSessionHistory() {
      listCalls += 1;
      return [];
    }
  });

  await request(handler, { method: 'GET', url: '/api/sessions' });

  assert.equal(listCalls, 1);
});

test('GET /api/sessions returns the service result unchanged as JSON', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const handler = createHandler({
    listSessionHistory() {
      return history;
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), history);
});

test('GET /api/sessions/:sessionId passes the exact sessionId to getSessionDetail', async () => {
  const calls = [];
  const handler = createHandler({
    getSessionDetail(sessionId) {
      calls.push(sessionId);
      return detailDTO({ id: sessionId });
    }
  });

  await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.deepEqual(calls, ['session-1']);
});

test('GET /api/sessions/:sessionId returns HTTP 200 with the DTO unchanged as JSON', async () => {
  const detail = detailDTO({ id: 'session-1' });
  const handler = createHandler({
    getSessionDetail() {
      return detail;
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), detail);
});

test('GET /api/sessions/:sessionId returns HTTP 404 when service returns null', async () => {
  const handler = createHandler({
    getSessionDetail() {
      return null;
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/missing' });
  const body = response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'session_not_found');
});

test('GET /api/sessions/:sessionId returns safe 503 and logs only status and code', async () => {
  const logs = [];
  const handler = createHandler({
    getSessionDetail() {
      const error = new Error('Supabase response body must not be logged.');
      error.status = 503;
      error.code = 'supabase_request_failed';
      error.supabaseStatus = 503;
      return Promise.reject(error);
    },
    requestLogger(event) {
      logs.push(event);
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(response.status, 503);
  assert.deepEqual(response.json().error, {
    code: 'supabase_request_failed',
    message: 'Local Supabase request failed.',
    requestId: response.json().error.requestId
  });
  const requestLog = logs.at(-1);
  assert.equal(requestLog.errorCode, 'supabase_request_failed');
  assert.equal(requestLog.supabaseStatus, 503);
  assert.equal(Object.hasOwn(requestLog, 'responseBody'), false);
  assert.equal(Object.hasOwn(requestLog, 'stack'), false);
});

test('GET /api/sessions/:sessionId/translations returns safe 503 and logs Supabase diagnostics', async () => {
  const logs = [];
  const error = new Error('Supabase response body must not be logged.');
  error.status = 503;
  error.code = 'supabase_request_failed';
  error.supabaseStatus = 503;
  const handler = createRequestHandler({
    translationHistoryController: {
      listSessionTranslations: async () => { throw error; }
    },
    requestLogger(event) {
      logs.push(event);
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1/translations' });

  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, 'supabase_request_failed');
  const requestLog = logs.at(-1);
  assert.equal(requestLog.errorCode, 'supabase_request_failed');
  assert.equal(requestLog.supabaseStatus, 503);
  assert.equal(Object.hasOwn(requestLog, 'responseBody'), false);
  assert.equal(Object.hasOwn(requestLog, 'stack'), false);
});

test('DELETE /api/sessions/:sessionId deletes finalized session records', async () => {
  const calls = [];
  const handler = createHandler({
    sessionRepository: {
      async getSessionRecord(id) {
        calls.push(['get', id]);
        return { sessionRecord: historyItem({ id, status: 'stopped' }), transcriptItems: [] };
      },
      async deleteSessionRecord(id) {
        calls.push(['delete', id]);
        return true;
      }
    }
  });

  const response = await request(handler, { method: 'DELETE', url: '/api/sessions/session%201' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { deleted: true, sessionId: 'session 1' });
  assert.deepEqual(calls, [
    ['get', 'session 1'],
    ['delete', 'session 1']
  ]);
});

test('DELETE /api/sessions/:sessionId returns 404 for missing or active records', async () => {
  const missingHandler = createHandler({
    sessionRepository: {
      async getSessionRecord() {
        return null;
      },
      async deleteSessionRecord() {
        throw new Error('should not delete missing sessions');
      }
    }
  });
  const activeHandler = createHandler({
    sessionRepository: {
      async getSessionRecord(id) {
        return { sessionRecord: historyItem({ id, status: 'active' }), transcriptItems: [] };
      },
      async deleteSessionRecord() {
        throw new Error('should not delete active sessions');
      }
    }
  });

  const missingResponse = await request(missingHandler, { method: 'DELETE', url: '/api/sessions/missing' });
  const activeResponse = await request(activeHandler, { method: 'DELETE', url: '/api/sessions/active' });

  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.json().error.code, 'session_not_found');
  assert.equal(activeResponse.status, 404);
  assert.equal(activeResponse.json().error.code, 'session_not_found');
});

test('DELETE /api/sessions/:sessionId rejects malformed IDs', async () => {
  const handler = createHandler({
    sessionRepository: {
      async getSessionRecord() {
        throw new Error('should not read malformed session ids');
      },
      async deleteSessionRecord() {
        throw new Error('should not delete malformed session ids');
      }
    }
  });

  const response = await request(handler, { method: 'DELETE', url: '/api/sessions/%' });

  assert.equal(response.status, 400);
  assert.equal(response.json().error.code, 'invalid_request');
});

test('POST and GET /api/sessions/:sessionId/audio/:kind persist and download session audio', async () => {
  const calls = [];
  const sessionRecord = historyItem({ id: 'session-1', status: 'stopped' });
  const audioRepository = {
    async save(input) {
      calls.push(['save', input.sessionId, input.kind, input.bytes.toString('utf8'), input.fileName]);
      return {
        kind: input.kind,
        mimeType: 'audio/wav',
        byteLength: input.bytes.byteLength,
        fileName: input.fileName,
        storagePath: 'session-1/translation.wav',
        createdAt: 1234
      };
    },
    async read(metadata) {
      calls.push(['read', metadata.storagePath]);
      return { metadata, bytes: Buffer.from('wav-bytes') };
    }
  };
  const handler = createHandler({
    sessionAudioArtifactRepository: audioRepository,
    sessionRepository: {
      async getSessionRecord(id) {
        calls.push(['get', id]);
        return { sessionRecord, transcriptItems: [] };
      },
      async updateSessionRecord(id, patch) {
        calls.push(['update', id, patch.audioArtifacts.translation.fileName]);
        sessionRecord.audioArtifacts = patch.audioArtifacts;
        return { ...sessionRecord };
      }
    }
  });

  const upload = await request(handler, {
    method: 'POST',
    url: '/api/sessions/session-1/audio/translation',
    body: Buffer.from('wav-bytes'),
    headers: { 'content-type': 'audio/wav', 'x-file-name': 'translated.wav' }
  });
  const uploadBody = upload.json();

  assert.equal(upload.status, 201);
  assert.equal(uploadBody.artifact.downloadUrl, '/api/sessions/session-1/audio/translation');

  const download = await request(handler, {
    method: 'GET',
    url: '/api/sessions/session-1/audio/translation'
  });

  assert.equal(download.status, 200);
  assert.equal(download.headers['Content-Type'], 'audio/wav');
  assert.equal(download.body.toString('utf8'), 'wav-bytes');
  assert.deepEqual(calls, [
    ['get', 'session-1'],
    ['save', 'session-1', 'translation', 'wav-bytes', 'translated.wav'],
    ['update', 'session-1', 'translated.wav'],
    ['get', 'session-1'],
    ['read', 'session-1/translation.wav']
  ]);
});

test('PUT /api/sessions/:sessionId accepts large snapshots under the configured snapshot limit', async () => {
  const calls = [];
  const sessionRecord = historyItem({ id: 'session-large', status: 'active' });
  const handler = createHandler({
    sessionSnapshotMaxBytes: 20_000,
    sessionRepository: {
      async getSessionRecord(id) {
        calls.push(['get', id]);
        return calls.length === 1 ? null : { sessionRecord, transcriptItems: [] };
      },
      async createSessionRecord(record) {
        calls.push(['create', record.id]);
        return record;
      },
      async appendTranscriptItem(sessionId, item) {
        calls.push(['append', sessionId, item.id]);
        return item;
      },
      async updateSessionRecord(id) {
        calls.push(['update', id]);
        return sessionRecord;
      },
      async finalizeSessionRecord() {
        throw new Error('should not finalize active snapshot');
      }
    }
  });
  const text = 'a'.repeat(12_000);
  const body = JSON.stringify({
    session: { ...sessionRecord, targetLanguageCode: 'fr', status: 'active' },
    transcriptItems: [{ id: 'item-large', stream: 'source', status: 'final', text, sequence: 1 }]
  });

  const response = await request(handler, {
    method: 'PUT',
    url: '/api/sessions/session-large',
    body,
    headers: { 'content-type': 'application/json' }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ['get', 'session-large'],
    ['create', 'session-large'],
    ['get', 'session-large'],
    ['append', 'session-large', 'item-large'],
    ['get', 'session-large'],
    ['update', 'session-large'],
    ['get', 'session-large']
  ]);
});

test('PUT /api/sessions/:sessionId rejects snapshots over the configured snapshot limit', async () => {
  const handler = createHandler({
    sessionSnapshotMaxBytes: 100,
    sessionRepository: {
      async getSessionRecord() {
        throw new Error('should not read oversized snapshots');
      }
    }
  });

  const response = await request(handler, {
    method: 'PUT',
    url: '/api/sessions/session-large',
    body: JSON.stringify({
      session: { id: 'session-large', targetLanguageCode: 'fr', status: 'active' },
      transcriptItems: [{ id: 'item-large', stream: 'source', status: 'final', text: 'a'.repeat(200), sequence: 1 }]
    }),
    headers: { 'content-type': 'application/json' }
  });

  assert.equal(response.status, 413);
  assert.equal(response.json().error.code, 'request_too_large');
});

test('POST /api/sessions/:sessionId/audio/:kind/segments persists manifest and GET composes WAV download', async () => {
  const sessionRecord = historyItem({ id: 'session-1', status: 'stopped' });
  const segmentBytes = [
    Buffer.from(createPcm16WavBytes(new Uint8Array([1, 0, 2, 0]), { sampleRate: 24000 })),
    Buffer.from(createPcm16WavBytes(new Uint8Array([3, 0, 4, 0]), { sampleRate: 24000 }))
  ];
  const stored = new Map();
  const audioRepository = {
    async saveSegment(input) {
      const storagePath = `${input.sessionId}/${input.kind}-segments/${input.segmentIndex}.wav`;
      stored.set(storagePath, Buffer.from(input.bytes));
      return {
        index: input.segmentIndex,
        byteLength: input.bytes.byteLength,
        storagePath,
        createdAt: 1000 + input.segmentIndex
      };
    },
    async read(metadata) {
      const bytes = Buffer.concat(metadata.segments.map((segment) => stored.get(segment.storagePath)));
      return { metadata, bytes };
    }
  };
  const handler = createHandler({
    sessionAudioArtifactRepository: audioRepository,
    sessionRepository: {
      async getSessionRecord() {
        return { sessionRecord, transcriptItems: [] };
      },
      async updateSessionRecord(id, patch) {
        sessionRecord.audioArtifacts = patch.audioArtifacts;
        return { ...sessionRecord };
      }
    }
  });

  for (let index = 0; index < segmentBytes.length; index += 1) {
    const upload = await request(handler, {
      method: 'POST',
      url: `/api/sessions/session-1/audio/translation/segments/${index}`,
      body: segmentBytes[index],
      headers: { 'content-type': 'audio/wav', 'x-file-name': 'translated.wav' }
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.json().artifact.storagePath, undefined);
    assert.equal(upload.json().artifact.segments[0].storagePath, undefined);
  }

  const download = await request(handler, {
    method: 'GET',
    url: '/api/sessions/session-1/audio/translation'
  });

  assert.equal(download.status, 200);
  assert.equal(download.headers['Content-Type'], 'audio/wav');
  assert.equal(download.headers['Content-Disposition'], 'attachment; filename="translated.wav"');
});

test('DELETE /api/sessions/:sessionId deletes stored audio artifacts', async () => {
  const calls = [];
  const audioArtifacts = {
    translation: { kind: 'translation', storagePath: 'session-1/translation.wav' }
  };
  const handler = createHandler({
    sessionAudioArtifactRepository: {
      async deleteMany(artifacts) {
        calls.push(['deleteAudio', artifacts]);
      }
    },
    sessionRepository: {
      async getSessionRecord(id) {
        calls.push(['get', id]);
        return { sessionRecord: historyItem({ id, status: 'stopped', audioArtifacts }), transcriptItems: [] };
      },
      async deleteSessionRecord(id) {
        calls.push(['deleteSession', id]);
        return true;
      }
    }
  });

  const response = await request(handler, { method: 'DELETE', url: '/api/sessions/session-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ['get', 'session-1'],
    ['deleteAudio', audioArtifacts],
    ['deleteSession', 'session-1']
  ]);
});

test('DELETE /api/sessions/:sessionId cascades deletion for a linked meeting', async () => {
  const calls = [];
  const handler = createHandler({
    sessionRepository: {
      async getSessionRecord(id) {
        calls.push(['get', id]);
        return { sessionRecord: historyItem({ id, meetingId: 'meeting-1', status: 'stopped' }), transcriptItems: [] };
      }
    },
    meetingDeletionService: {
      async deleteMeeting(input) {
        calls.push(['deleteMeeting', input.meetingId]);
        return { deletedSessionCount: 2, deletedSegmentCount: 2 };
      }
    }
  });

  const response = await request(handler, { method: 'DELETE', url: '/api/sessions/session-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    deleted: true,
    sessionId: 'session-1',
    meetingId: 'meeting-1',
    deletedSessionCount: 2,
    deletedSegmentCount: 2
  });
  assert.deepEqual(calls, [['get', 'session-1'], ['deleteMeeting', 'meeting-1']]);
});

test('GET /api/meetings/:meetingId/audio/:kind downloads linked whole-meeting audio artifact', async () => {
  const calls = [];
  const audioArtifacts = {
      input: {
        kind: 'input',
        mimeType: 'audio/wav',
        fileName: 'meeting-input.wav',
        storagePath: 'session-1/input.wav'
      }
  };
  const handler = createHandler({
    sessionAudioArtifactRepository: {
      async read(metadata) {
        calls.push(['read', metadata.storagePath]);
        return { metadata, bytes: createPcm16WavBytes(new Uint8Array([1, 0]), { sampleRate: 16000 }) };
      }
    },
    sessionRepository: {
      async listSessionRecords() {
        calls.push(['list']);
        return [
          historyItem({ id: 'session-1', meetingId: 'meeting-1', status: 'stopped', audioArtifacts })
        ];
      }
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/meetings/meeting-1/audio/input' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'audio/wav');
  assert.equal(response.headers['Content-Disposition'], 'attachment; filename="live-translate-meeting-meeting-1-input.wav"');
  assert.equal(response.body.readUInt32LE(40), 2);
  assert.deepEqual(calls, [
    ['list'],
    ['read', 'session-1/input.wav']
  ]);
});

test('GET /api/meetings/:meetingId/audio/:kind merges linked sessions by segment sequence', async () => {
  const first = createPcm16WavBytes(new Uint8Array([1, 0]), { sampleRate: 16000 });
  const second = createPcm16WavBytes(new Uint8Array([2, 0]), { sampleRate: 16000 });
  const handler = createHandler({
    meetingRepository: {
      async listMeetingSegments() {
        return [
          { liveSessionId: 'session-2', sequence: 1 },
          { liveSessionId: 'session-1', sequence: 0 }
        ];
      }
    },
    sessionAudioArtifactRepository: {
      async read(metadata) {
        return { metadata, bytes: metadata.storagePath.includes('session-1') ? first : second };
      }
    },
    sessionRepository: {
      async listSessionRecords() {
        return [
          historyItem({ id: 'session-2', meetingId: 'meeting-1', startedAt: 2000, audioArtifacts: { input: { kind: 'input', storagePath: 'session-2/input.wav' } } }),
          historyItem({ id: 'session-1', meetingId: 'meeting-1', startedAt: 1000, audioArtifacts: { input: { kind: 'input', storagePath: 'session-1/input.wav' } } })
        ];
      }
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/meetings/meeting-1/audio/input' });

  assert.equal(response.status, 200);
  assert.equal(response.body.readUInt32LE(40), 4);
  assert.deepEqual([...response.body.subarray(44)], [1, 0, 2, 0]);
});

test('DELETE /api/sessions/:sessionId/translations/:outputId deletes formal retranslation outputs', async () => {
  const calls = [];
  const handler = createHandler({
    translationRepository: {
      async getTranslationOutput(outputId) {
        calls.push(['get', outputId]);
        return {
          id: outputId,
          sessionId: 'session 1',
          requestId: 'request-1',
          version: 1
        };
      },
      async deleteTranslationOutput(outputId) {
        calls.push(['delete', outputId]);
        return true;
      }
    }
  });

  const response = await request(handler, { method: 'DELETE', url: '/api/sessions/session%201/translations/output%201' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { deleted: true, sessionId: 'session 1', outputId: 'output 1' });
  assert.deepEqual(calls, [
    ['get', 'output 1'],
    ['delete', 'output 1']
  ]);
});

test('DELETE /api/sessions/:sessionId/translations/:outputId returns 404 for missing, wrong-session, or live outputs', async () => {
  const missingHandler = createHandler({
    translationRepository: translationRepositoryForOutput(null)
  });
  const wrongSessionHandler = createHandler({
    translationRepository: translationRepositoryForOutput({ id: 'output-1', sessionId: 'other-session', requestId: 'request-1', version: 1 })
  });
  const liveOutputHandler = createHandler({
    translationRepository: translationRepositoryForOutput({ id: 'live-output:session-1:ja', sessionId: 'session-1', requestId: 'request-live', version: 1 })
  });

  for (const handler of [missingHandler, wrongSessionHandler, liveOutputHandler]) {
    const response = await request(handler, { method: 'DELETE', url: '/api/sessions/session-1/translations/output-1' });

    assert.equal(response.status, 404);
    assert.equal(response.json().error.code, 'translation_output_not_found');
  }
});

test('DELETE /api/sessions/:sessionId/translations/:outputId rejects malformed output path', async () => {
  const handler = createHandler({
    translationRepository: translationRepositoryForOutput({ id: 'output-1', sessionId: 'session-1', requestId: 'request-1', version: 1 })
  });

  const response = await request(handler, { method: 'DELETE', url: '/api/sessions/session-1/translations/%' });

  assert.equal(response.status, 400);
  assert.equal(response.json().error.code, 'invalid_request');
});

test('GET /api/sessions/:sessionId does not expose completed formal retranslation outputs on the original session', async () => {
  const liveOutput = formalOutput({ id: 'live-output:session-1:ja', targetLanguageCode: 'ja', translatedText: 'Live article', version: 1 });
  const retranslationOutput = formalOutput({ id: 'output-fr-1', executionId: 'execution-fr-1', requestId: 'request-fr-1', targetLanguageCode: 'fr', translatedText: 'Bonjour terminé', version: 1 });
  const handler = createHandler({
    getSessionDetail() {
      return detailDTO({ id: 'session-1' });
    },
    translationHistory: {
      outputs: [liveOutput, retranslationOutput],
      executions: []
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.translationHistory.outputs, []);
});

test('GET /api/sessions/:sessionId keeps live output as the primary article read model', async () => {
  const liveOutput = formalOutput({ id: 'live-output:session-1:ja', targetLanguageCode: 'ja', translatedText: 'Live article', version: 1 });
  const retranslationOutput = formalOutput({ id: 'output-fr-1', targetLanguageCode: 'fr', translatedText: 'Bonjour terminé', version: 1 });
  const handler = createHandler({
    getSessionDetail() {
      return detailDTO({ id: 'session-1' });
    },
    translationHistory: {
      outputs: [retranslationOutput, liveOutput],
      executions: []
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.readingContent.translationArticle.text, 'Live article');
  assert.equal(body.selectedTranslationOutput.id, 'live-output:session-1:ja');
  assert.deepEqual(body.translationHistory.outputs, []);
});

test('GET /api/sessions/:sessionId falls back to legacy translation outputs only when no formal retranslation outputs exist', async () => {
  const handler = createHandler({
    getSessionDetail() {
      return detailDTO({
        id: 'session-1',
        translationOutputs: [{
          id: 'legacy-output-1',
          targetLanguageCode: 'ja',
          items: [{ text: 'Legacy line one' }, { text: 'Legacy line two' }],
          completedAt: '2026-07-21T00:00:00.000Z'
        }]
      });
    },
    translationHistory: {
      outputs: [formalOutput({ id: 'live-output:session-1:ja', targetLanguageCode: 'ja', translatedText: 'Live article', version: 1 })],
      executions: []
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.translationHistory.outputs, [{
    id: 'legacy-output-1',
    targetLanguageCode: 'ja',
    version: null,
    source: 'legacy',
    translatedText: 'Legacy line one\nLegacy line two',
    completedAt: '2026-07-21T00:00:00.000Z'
  }]);
});

test('unexpected service errors are not converted into HTTP 404', async () => {
  const handler = createHandler({
    getSessionDetail() {
      throw new Error('storage unavailable');
    }
  });

  const response = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal_error');
});

test('missing sessionQueryService throws TypeError', () => {
  assert.throws(() => createSessionReadController(), TypeError);
});

test('missing listSessionHistory throws TypeError', () => {
  assert.throws(
    () =>
      createSessionReadController({
        sessionQueryService: {
          getSessionDetail() {
            return null;
          }
        }
      }),
    TypeError
  );
});

test('missing getSessionDetail throws TypeError', () => {
  assert.throws(
    () =>
      createSessionReadController({
        sessionQueryService: {
          listSessionHistory() {
            return [];
          }
        }
      }),
    TypeError
  );
});

test('Promise-returning service methods work through the HTTP route handler', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const detail = detailDTO({ id: 'session-1' });
  const handler = createHandler({
    listSessionHistory() {
      return Promise.resolve(history);
    },
    getSessionDetail(sessionId) {
      return Promise.resolve(sessionId === 'session-1' ? detail : null);
    }
  });

  const listResponse = await request(handler, { method: 'GET', url: '/api/sessions' });
  const detailResponse = await request(handler, { method: 'GET', url: '/api/sessions/session-1' });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.json(), history);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(detailResponse.json(), detail);
});

test('controller delegates without reconstructing service DTOs', () => {
  const history = [historyItem({ id: 'session-1' })];
  const detail = detailDTO({ id: 'session-1' });
  const controller = createSessionReadController({
    sessionQueryService: createService({ history, detail })
  });

  assert.strictEqual(controller.listSessions(), history);
  assert.strictEqual(controller.getSession('session-1'), detail);
});

function createHandler(serviceOverrides = {}) {
  const sessionQueryService = createService(serviceOverrides);
  const sessionReadController = createSessionReadController({ sessionQueryService });

  return createRequestHandler({
    sessionReadController,
    ...(serviceOverrides.sessionRepository ? { sessionRepository: serviceOverrides.sessionRepository } : {}),
    ...(serviceOverrides.meetingRepository ? { meetingRepository: serviceOverrides.meetingRepository } : {}),
    ...(serviceOverrides.meetingDeletionService ? { meetingDeletionService: serviceOverrides.meetingDeletionService } : {}),
    ...(serviceOverrides.sessionAudioArtifactRepository ? { sessionAudioArtifactRepository: serviceOverrides.sessionAudioArtifactRepository } : {}),
    ...(serviceOverrides.translationRepository ? { translationRepository: serviceOverrides.translationRepository } : {}),
    ...(serviceOverrides.translationHistory
      ? { translationHistoryController: createTranslationHistoryController(serviceOverrides.translationHistory) }
      : {}),
    ...(serviceOverrides.sessionSnapshotMaxBytes ? { sessionSnapshotMaxBytes: serviceOverrides.sessionSnapshotMaxBytes } : {}),
    ...(serviceOverrides.sessionAudioMaxBytes ? { sessionAudioMaxBytes: serviceOverrides.sessionAudioMaxBytes } : {}),
    ...(serviceOverrides.requestLogger ? { requestLogger: serviceOverrides.requestLogger } : {})
  });
}

function translationRepositoryForOutput(output) {
  return {
    async getTranslationOutput() {
      return output;
    },
    async deleteTranslationOutput() {
      throw new Error('should not delete ineligible translation outputs');
    }
  };
}

function createService(overrides = {}) {
  const history = overrides.history ?? [];
  const detail = overrides.detail ?? null;

  return {
    listSessionHistory:
      overrides.listSessionHistory ||
      function listSessionHistory() {
        return history;
      },
    getSessionDetail:
      overrides.getSessionDetail ||
      function getSessionDetail() {
        return detail;
      }
  };
}

async function request(handler, { method = 'GET', url = '/api/sessions', body = '', headers = {} } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' };

  const response = {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, nextHeaders) {
      this.statusCode = statusCode;
      this.headers = nextHeaders;
    },
    end(nextBody = '') {
      this.body = Buffer.isBuffer(nextBody) ? nextBody : Buffer.from(String(nextBody));
    }
  };

  await handler(req, response);

  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body.toString('utf8') || '{}')
  };
}

function historyItem(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    ...(Object.hasOwn(overrides, 'meetingId') ? { meetingId: overrides.meetingId } : {}),
    status: overrides.status || 'completed',
    startedAt: overrides.startedAt ?? 1000,
    endedAt: overrides.endedAt ?? 2000,
    durationMs: overrides.durationMs ?? 1000,
    targetLanguageCode: overrides.targetLanguageCode || 'fr',
    targetLanguageLabel: overrides.targetLanguageLabel || 'French',
    failureReason: overrides.failureReason ?? null,
    failureCategory: overrides.failureCategory ?? null,
    audioArtifacts: overrides.audioArtifacts || {},
    transcriptSummary: overrides.transcriptSummary || {
      totalItems: 0,
      sourceFinalCount: 0,
      translationFinalCount: 0,
      sourcePartialCount: 0,
      translationPartialCount: 0,
      hasTranscript: false
    },
    legacy: true
  };
}

function detailDTO(overrides = {}) {
  const id = overrides.id || 'session-1';

  const detail = {
    session: {
      id,
      status: overrides.status || 'completed'
    },
    sourceTranscript: {
      id: `source:${id}`,
      sessionId: id,
      items: []
    },
    translationOutputs: overrides.translationOutputs || [],
    selectedTranslationOutput: null,
    legacy: true
  };

  if (Object.hasOwn(overrides, 'readingContent')) {
    detail.readingContent = overrides.readingContent;
  }

  return detail;
}

function createTranslationHistoryController(translationHistory) {
  return {
    listSessionTranslations({ sessionId, includeReadModel }) {
      assert.equal(sessionId, 'session-1');
      assert.equal(includeReadModel, true);
      return { translationHistory };
    }
  };
}

function formalOutput(overrides = {}) {
  return {
    id: overrides.id || 'output-1',
    executionId: overrides.executionId || null,
    requestId: overrides.requestId || null,
    targetLanguageCode: overrides.targetLanguageCode || 'fr',
    version: overrides.version ?? 1,
    source: overrides.source || 'formal',
    translatedText: overrides.translatedText || 'Translated article',
    createdAt: overrides.createdAt || '2026-07-21T00:00:00.000Z',
    completedAt: overrides.completedAt || '2026-07-21T00:00:02.000Z'
  };
}
