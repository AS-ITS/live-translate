import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import {
  assertNoMissingDuplicateOrOutOfOrderChunks,
  buildLongMeetingScenario,
  checkpointForSegment
} from '../helpers/longMeetingScenario.js';

test('meeting checkpoint API persists through production file-backed composition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-meeting-api-'));
  const env = {
    MEETING_RECORDS_FILE: join(directory, 'meetings.json'),
    SESSION_RECORDS_FILE: join(directory, 'sessions.json'),
    TRANSLATION_GLOSSARY_FILE: join(directory, 'glossary.json')
  };

  const firstDependencies = createProductionApplicationDependencies(productionOptions({ env }));
  let meetingId;
  let firstSegmentId;

  await withServer(firstDependencies.requestHandler, async (baseUrl) => {
    const created = await postJson(`${baseUrl}/api/meetings`, {});
    assert.equal(created.status, 201);
    const { meeting, segment } = await created.json();
    meetingId = meeting.id;
    firstSegmentId = segment.id;

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
    const response = await getJson(`${baseUrl}/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(firstSegmentId)}/checkpoint`);
    const body = await response.json();
    const segmentsResponse = await getJson(`${baseUrl}/api/meetings/${encodeURIComponent(meetingId)}/segments`);
    const segmentsBody = await segmentsResponse.json();
    const meetingsResponse = await getJson(`${baseUrl}/api/meetings`);
    const meetingsBody = await meetingsResponse.json();
    const meetingDetailResponse = await getJson(`${baseUrl}/api/meetings/${encodeURIComponent(meetingId)}`);
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
        { id: firstSegmentId, status: 'interrupted', liveSessionId: null, errorInfo: { reason: 'token_expired', category: 'token' } },
        { id: segmentsBody.segments[1].id, status: 'active', liveSessionId: 'live-session-2', errorInfo: null }
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
          id: meetingId,
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
        { segmentId: firstSegmentId, segmentStatus: 'interrupted', stream: 'source', sequence: 1, text: 'hello' },
        { segmentId: firstSegmentId, segmentStatus: 'interrupted', stream: 'translation', sequence: 2, text: 'world' },
        { segmentId: firstSegmentId, segmentStatus: 'interrupted', stream: 'source', sequence: 3, text: 'resume' }
      ]
    );
  });
});

test('long meeting reliability scenario persists and reloads 2+ hours of ordered checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-long-meeting-api-'));
  const env = {
    MEETING_RECORDS_FILE: join(directory, 'meetings.json'),
    SESSION_RECORDS_FILE: join(directory, 'sessions.json'),
    TRANSLATION_GLOSSARY_FILE: join(directory, 'glossary.json')
  };
  const scenario = buildValidLongMeetingScenario();

  const firstDependencies = createProductionApplicationDependencies(productionOptions({
    env,
    idGenerator: scenarioIdGenerator(scenario)
  }));
  await withServer(firstDependencies.requestHandler, async (baseUrl) => {
    const created = await postJson(`${baseUrl}/api/meetings`, {
      liveSessionId: scenario.segments[0].liveSessionId
    });
    assert.equal(created.status, 201);
    const { meeting, segment } = await created.json();
    let currentSegment = segment;

    for (const scenarioSegment of scenario.segments) {
      assert.equal(currentSegment.id, scenarioSegment.id);
      const checkpointResponse = await putJson(
        `${baseUrl}/api/meetings/${encodeURIComponent(meeting.id)}/segments/${encodeURIComponent(currentSegment.id)}/checkpoint`,
        checkpointForSegment(scenarioSegment, `checkpoint:${scenarioSegment.id}:sync`)
      );
      assert.equal(checkpointResponse.status, 200);

      if (scenarioSegment.sequence === scenario.segments.length - 1) {
        break;
      }

      const closeInput = {
        idempotencyKey: `${scenarioSegment.closeAction.type}:${scenarioSegment.id}`,
        checkpoint: checkpointForSegment(scenarioSegment, `checkpoint:${scenarioSegment.id}:${scenarioSegment.closeAction.type}`),
        nextLiveSessionId: scenarioSegment.nextLiveSessionId
      };
      const closePath = scenarioSegment.closeAction.type === 'recover' ? 'recover' : 'rollover';
      const closeBody = scenarioSegment.closeAction.type === 'recover'
        ? {
            ...closeInput,
            failureReason: scenarioSegment.closeAction.failureReason,
            failureCategory: scenarioSegment.closeAction.failureCategory,
            outcome: 'interrupted'
          }
        : closeInput;
      const closeResponse = await postJson(
        `${baseUrl}/api/meetings/${encodeURIComponent(meeting.id)}/segments/${encodeURIComponent(currentSegment.id)}/${closePath}`,
        closeBody
      );
      assert.equal(closeResponse.status, 201);
      currentSegment = (await closeResponse.json()).segment;
    }
  });

  const reloadedDependencies = createProductionApplicationDependencies(productionOptions({ env }));
  await withServer(reloadedDependencies.requestHandler, async (baseUrl) => {
    const detailResponse = await getJson(`${baseUrl}/api/meetings/${encodeURIComponent(scenario.meetingId)}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();

    assert.equal(detail.meeting.segmentSummary.totalSegments, scenario.segments.length);
    assert.deepEqual(detail.meeting.segmentSummary.countsByStatus, {
      active: 1,
      completed: 11,
      interrupted: 2
    });
    assert.equal(detail.meeting.segmentSummary.hasInterruptedSegments, true);
    assert.equal(detail.meeting.transcriptSummary.totalItems, scenario.expectedChunks.length);
    assertNoMissingDuplicateOrOutOfOrderChunks(assert, detail.transcriptItems, scenario.expectedChunks);
    assert.equal(
      detail.readingContent.sourceTranscript.text.includes('long meeting source segment 14'),
      true
    );
    assert.equal(
      detail.readingContent.translationArticle.text.includes('long meeting translation segment 14'),
      true
    );
  });
});

function productionOptions({ env, idGenerator = staticIdGenerator() }) {
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
    idGenerator
  };
}

function staticIdGenerator() {
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000006'
  ];
  let index = 0;
  return () => ids[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function scenarioIdGenerator(scenario) {
  const ids = [scenario.meetingId, ...scenario.segments.map((segment) => segment.id)];
  let index = 0;
  return () => ids[index++] ?? staticIdGenerator()();
}

function buildValidLongMeetingScenario() {
  const source = buildLongMeetingScenario();
  const meetingId = '00000000-0000-4000-8000-000000000011';
  const segments = source.segments.map((segment, index) => {
    const segmentId = `00000000-0000-4000-8000-${String(index + 0x101).padStart(12, '0')}`;
    return {
      ...segment,
      id: segmentId,
      chunks: segment.chunks.map((chunk) => ({ ...chunk, meetingId, segmentId }))
    };
  });
  return {
    ...source,
    meetingId,
    segments,
    expectedChunks: segments.flatMap((segment) => segment.chunks)
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
