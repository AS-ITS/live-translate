import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createPcm16WavBytes } from '../../src/lib/audio.js';
import {
  LONG_MEETING_SEGMENT_INTERVAL_MS,
  LONG_MEETING_SOAK_DURATION_MS,
  LONG_MEETING_SOAK_ROLLOVER_COUNT,
  LONG_MEETING_SOAK_SEGMENT_COUNT,
  assertNoMissingDuplicateOrOutOfOrderChunks,
  buildLongMeetingSoakScenario,
  checkpointForSegment
} from '../helpers/longMeetingScenario.js';

test('130 minute long meeting soak persists checkpoints, recovery, and segmented audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-long-meeting-soak-'));
  const env = {
    MEETING_RECORDS_FILE: join(directory, 'meetings.json'),
    SESSION_RECORDS_FILE: join(directory, 'sessions.json'),
    SESSION_AUDIO_DIR: join(directory, 'session-audio'),
    TRANSLATION_GLOSSARY_FILE: join(directory, 'glossary.json')
  };
  const scenario = buildLongMeetingSoakScenario();
  const clock = createScriptedClock([
    0,
    ...Array.from({ length: LONG_MEETING_SOAK_ROLLOVER_COUNT }, (_, index) => (index + 1) * LONG_MEETING_SEGMENT_INTERVAL_MS),
    LONG_MEETING_SOAK_DURATION_MS
  ]);
  const transitionLiveSessionIds = [];
  let rolloverCount = 0;
  let recoveryCount = 0;

  const firstDependencies = createProductionApplicationDependencies(productionOptions({ env, clock }));
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
      if (closePath === 'recover') recoveryCount += 1;
      else rolloverCount += 1;
      transitionLiveSessionIds.push(closeBody.nextLiveSessionId);
      currentSegment = (await closeResponse.json()).segment;
    }

    await syncStoppedSessionSnapshot({ baseUrl, scenario, meetingId: meeting.id, segmentId: currentSegment.id });
    await uploadSegmentedAudio({ baseUrl, sessionId: 'session-soak', segmentCount: scenario.segments.length });
  });

  const reloadedDependencies = createProductionApplicationDependencies(productionOptions({ env, clock }));
  await withServer(reloadedDependencies.requestHandler, async (baseUrl) => {
    const detailResponse = await getJson(`${baseUrl}/api/meetings/meeting-1`);
    const segmentsResponse = await getJson(`${baseUrl}/api/meetings/meeting-1/segments`);
    const sessionResponse = await getJson(`${baseUrl}/api/sessions/session-soak`);
    const inputAudioResponse = await getBinary(`${baseUrl}/api/meetings/meeting-1/audio/input`);
    const translationAudioResponse = await getBinary(`${baseUrl}/api/meetings/meeting-1/audio/translation`);

    assert.equal(detailResponse.status, 200);
    assert.equal(segmentsResponse.status, 200);
    assert.equal(sessionResponse.status, 200);
    assert.equal(inputAudioResponse.status, 200);
    assert.equal(translationAudioResponse.status, 200);

    const detail = await detailResponse.json();
    const segmentsBody = await segmentsResponse.json();
    const sessionDetail = await sessionResponse.json();
    const allLiveSessionIds = detail.segments.map((segment) => segment.liveSessionId);

    assert.equal(scenario.durationMs, LONG_MEETING_SOAK_DURATION_MS);
    assert.equal(rolloverCount + recoveryCount, LONG_MEETING_SOAK_ROLLOVER_COUNT);
    assert.equal(rolloverCount, LONG_MEETING_SOAK_ROLLOVER_COUNT - 1);
    assert.equal(recoveryCount, 1);
    assert.equal(detail.meeting.segmentSummary.totalSegments, LONG_MEETING_SOAK_SEGMENT_COUNT);
    assert.deepEqual(detail.segments.map((segment) => segment.sequence), Array.from({ length: LONG_MEETING_SOAK_SEGMENT_COUNT }, (_, index) => index));
    assert.deepEqual(segmentsBody.segments.map((segment) => segment.sequence), Array.from({ length: LONG_MEETING_SOAK_SEGMENT_COUNT }, (_, index) => index));
    assert.equal(new Set(allLiveSessionIds).size, LONG_MEETING_SOAK_SEGMENT_COUNT);
    assert.deepEqual(transitionLiveSessionIds, allLiveSessionIds.slice(1));
    assert.deepEqual(detail.meeting.segmentSummary.countsByStatus, {
      active: 1,
      completed: 7,
      interrupted: 1
    });
    assert.equal(detail.meeting.segmentSummary.hasInterruptedSegments, true);
    assert.equal(detail.meeting.transcriptSummary.totalItems, scenario.expectedChunks.length);
    assert.equal(scenario.expectedChunks.length, LONG_MEETING_SOAK_SEGMENT_COUNT * 2);
    assertNoMissingDuplicateOrOutOfOrderChunks(assert, detail.transcriptItems, scenario.expectedChunks);
    assertNoCrossSegmentPollution(detail.transcriptItems);
    assert.equal(detail.readingContent.sourceTranscript.text.includes('long meeting source segment 9'), true);
    assert.equal(detail.readingContent.translationArticle.text.includes('long meeting translation segment 9'), true);
    assert.equal(sessionDetail.session.status, 'stopped');
    assert.equal(sessionDetail.session.audioArtifacts.input.storageMode, 'segmented');
    assert.equal(sessionDetail.session.audioArtifacts.translation.storageMode, 'segmented');
    assert.equal(sessionDetail.session.audioArtifacts.input.segments.length, LONG_MEETING_SOAK_SEGMENT_COUNT);
    assert.equal(sessionDetail.session.audioArtifacts.translation.segments.length, LONG_MEETING_SOAK_SEGMENT_COUNT);
    assert.equal(inputAudioResponse.headers.get('content-type'), 'audio/wav');
    assert.equal(translationAudioResponse.headers.get('content-type'), 'audio/wav');
  });
});

async function syncStoppedSessionSnapshot({ baseUrl, scenario, meetingId, segmentId }) {
  const transcriptItems = scenario.expectedChunks.map((chunk) => ({
    id: chunk.idempotencyKey,
    stream: chunk.stream,
    status: 'final',
    text: chunk.text,
    sequence: chunk.sequence,
    startedAt: chunk.timestamp,
    finalizedAt: chunk.timestamp
  }));

  const response = await putJson(`${baseUrl}/api/sessions/session-soak`, {
    session: {
      id: 'session-soak',
      startedAt: 0,
      endedAt: LONG_MEETING_SOAK_DURATION_MS,
      durationMs: LONG_MEETING_SOAK_DURATION_MS,
      targetLanguageCode: 'en',
      targetLanguageLabel: 'English',
      sourceLanguageCode: 'zh-Hant',
      meetingId,
      segmentId,
      status: 'stopped',
      failureReason: 'user_stop',
      failureCategory: 'user_intent'
    },
    transcriptItems
  });

  assert.equal(response.status, 200);
}

async function uploadSegmentedAudio({ baseUrl, sessionId, segmentCount }) {
  for (const kind of ['input', 'translation']) {
    for (let index = 0; index < segmentCount; index += 1) {
      const bytes = Buffer.from(createPcm16WavBytes(new Uint8Array([index + 1, 0, index + 2, 0]), { sampleRate: 24000 }));
      const response = await postBinary(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/audio/${kind}/segments/${index}`,
        bytes,
        {
          'content-type': 'audio/wav',
          'x-file-name': `${kind}-meeting.wav`
        }
      );
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.artifact.storageMode, 'segmented');
      assert.equal(body.artifact.segments.length, index + 1);
      assert.equal(body.artifact.storagePath, undefined);
      assert.equal(body.artifact.segments.at(-1).storagePath, undefined);
    }
  }
}

function assertNoCrossSegmentPollution(transcriptItems) {
  for (const item of transcriptItems) {
    assert.match(item.text, new RegExp(`segment ${item.segmentSequence + 1}$`));
    assert.equal(item.segmentId, `segment-${item.segmentSequence + 1}`);
  }
}

function productionOptions({ env, clock }) {
  return {
    env,
    clock,
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

function createScriptedClock(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function withServer(handler, callback) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      try {
        await callback(`http://127.0.0.1:${address.port}`);
        server.close((error) => error ? reject(error) : resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function getJson(url) {
  return fetch(url);
}

function getBinary(url) {
  return fetch(url);
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function putJson(url, body) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function postBinary(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers,
    body
  });
}
