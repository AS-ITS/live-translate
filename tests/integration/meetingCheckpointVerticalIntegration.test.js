import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';

test('meeting checkpoint API persists through production file-backed composition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-meeting-api-'));
  const env = {
    MEETING_RECORDS_FILE: join(directory, 'meetings.json'),
    SESSION_RECORDS_FILE: join(directory, 'sessions.json'),
    TRANSLATION_GLOSSARY_FILE: join(directory, 'glossary.json')
  };

  const firstDependencies = createProductionApplicationDependencies(productionOptions({ env }));

  await withServer(firstDependencies.requestHandler, async (baseUrl) => {
    const created = await postJson(`${baseUrl}/api/meetings`, {});
    assert.equal(created.status, 201);
    const { meeting, segment } = await created.json();

    const checkpointResponse = await putJson(
      `${baseUrl}/api/meetings/${encodeURIComponent(meeting.id)}/segments/${encodeURIComponent(segment.id)}/checkpoint`,
      {
        idempotencyKey: 'checkpoint-1',
        durableChunks: [
          {
            idempotencyKey: 'chunk-translation-2',
            meetingId: meeting.id,
            segmentId: segment.id,
            stream: 'translation',
            sequence: 2,
            text: 'world',
            timestamp: 1000
          },
          {
            idempotencyKey: 'chunk-source-1',
            meetingId: meeting.id,
            segmentId: segment.id,
            stream: 'source',
            sequence: 1,
            text: 'hello',
            timestamp: 1000
          }
        ],
        pendingPartial: null
      }
    );
    assert.equal(checkpointResponse.status, 200);

    const recoveryResponse = await postJson(
      `${baseUrl}/api/meetings/${encodeURIComponent(meeting.id)}/segments/${encodeURIComponent(segment.id)}/recover`,
      {
        idempotencyKey: 'recover-1',
        checkpoint: {
          idempotencyKey: 'checkpoint-recover-1',
          durableChunks: [
            {
              idempotencyKey: 'chunk-source-3',
              meetingId: meeting.id,
              segmentId: segment.id,
              stream: 'source',
              sequence: 3,
              text: 'resume',
              timestamp: 1100
            }
          ],
          pendingPartial: null
        },
        nextLiveSessionId: 'live-session-2',
        failureReason: 'token_expired',
        failureCategory: 'token',
        outcome: 'interrupted'
      }
    );
    assert.equal(recoveryResponse.status, 201);
  });

  const reloadedDependencies = createProductionApplicationDependencies(productionOptions({ env }));
  await withServer(reloadedDependencies.requestHandler, async (baseUrl) => {
    const response = await getJson(`${baseUrl}/api/meetings/meeting-1/segments/segment-1/checkpoint`);
    const body = await response.json();
    const segmentsResponse = await getJson(`${baseUrl}/api/meetings/meeting-1/segments`);
    const segmentsBody = await segmentsResponse.json();
    const meetingsResponse = await getJson(`${baseUrl}/api/meetings`);
    const meetingsBody = await meetingsResponse.json();
    const meetingDetailResponse = await getJson(`${baseUrl}/api/meetings/meeting-1`);
    const meetingDetailBody = await meetingDetailResponse.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.checkpoint.durableChunks.map(({ stream, sequence, text }) => ({ stream, sequence, text })),
      [
        { stream: 'source', sequence: 1, text: 'hello' },
        { stream: 'source', sequence: 3, text: 'resume' },
        { stream: 'translation', sequence: 2, text: 'world' }
      ]
    );
    assert.equal(segmentsResponse.status, 200);
    assert.deepEqual(
      segmentsBody.segments.map(({ id, status, liveSessionId, errorInfo }) => ({ id, status, liveSessionId, errorInfo })),
      [
        { id: 'segment-1', status: 'interrupted', liveSessionId: null, errorInfo: { reason: 'token_expired', category: 'token' } },
        { id: 'segment-2', status: 'active', liveSessionId: 'live-session-2', errorInfo: null }
      ]
    );
    assert.equal(meetingsResponse.status, 200);
    assert.deepEqual(
      meetingsBody.map(({ id, segmentSummary, transcriptSummary }) => ({
        id,
        segmentSummary,
        transcriptSummary
      })),
      [
        {
          id: 'meeting-1',
          segmentSummary: {
            totalSegments: 2,
            countsByStatus: { interrupted: 1, active: 1 },
            hasInterruptedSegments: true,
            hasFailedSegments: false
          },
          transcriptSummary: {
            totalItems: 3,
            sourceFinalCount: 2,
            translationFinalCount: 1,
            hasTranscript: true
          }
        }
      ]
    );
    assert.equal(meetingDetailResponse.status, 200);
    assert.deepEqual(
      meetingDetailBody.transcriptItems.map(({ segmentId, segmentStatus, stream, sequence, text }) => ({
        segmentId,
        segmentStatus,
        stream,
        sequence,
        text
      })),
      [
        { segmentId: 'segment-1', segmentStatus: 'interrupted', stream: 'source', sequence: 1, text: 'hello' },
        { segmentId: 'segment-1', segmentStatus: 'interrupted', stream: 'translation', sequence: 2, text: 'world' },
        { segmentId: 'segment-1', segmentStatus: 'interrupted', stream: 'source', sequence: 3, text: 'resume' }
      ]
    );
  });
});

function productionOptions({ env }) {
  return {
    env,
    requestHandlerFactory: createRequestHandler,
    translationExecutionProvider: { async execute() {} },
    resolveSavedTranscriptTranslationProvider() {
      return { async translate() {} };
    },
    savedTranscriptRetranslationServiceFactory() {
      return { async translateSavedTranscript() {} };
    },
    idGenerator: staticIdGenerator()
  };
}

function staticIdGenerator() {
  const counters = new Map();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function getJson(url) {
  return fetch(url, { method: 'GET' });
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function putJson(url, body) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
