import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMeetingReadController } from '../../server/meetingReadController.js';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

test('POST /api/meetings creates an active meeting and first segment', async () => {
  const response = await request(createHandler(), { method: 'POST', url: '/api/meetings' });
  const body = response.json();

  assert.equal(response.status, 201);
  assert.equal(body.meeting.status, 'active');
  assert.equal(body.segment.status, 'active');
  assert.equal(body.segment.meetingId, body.meeting.id);
});

test('Meeting Management creates a draft, updates settings, and starts its first segment', async () => {
  const handler = createHandler();
  const createResponse = await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({
      draft: true,
      name: '產品會議',
      sourceLanguageCode: 'zh-Hant',
      targetLanguageCode: 'en',
      glossaryEntries: [{ source: '產品', target: 'Product', replacementAliases: [] }]
    })
  });
  const created = createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.equal(created.meeting.status, 'created');
  assert.equal(created.segment.status, 'created');

  const updateResponse = await request(handler, {
    method: 'PATCH',
    url: `/api/meetings/${created.meeting.id}`,
    body: JSON.stringify({ name: '更新後產品會議', targetLanguageCode: 'ja', glossaryEntries: [] })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.json().meeting.targetLanguageCode, 'ja');

  const startResponse = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/segments/${created.segment.id}/start`,
    body: JSON.stringify({ liveSessionId: 'live-session-management-1' })
  });
  const started = startResponse.json();
  assert.equal(startResponse.status, 201);
  assert.equal(started.meeting.status, 'active');
  assert.equal(started.segment.status, 'active');
  assert.equal(started.segment.liveSessionId, 'live-session-management-1');
});

test('DELETE /api/meetings/:meetingId deletes an unstarted draft and rejects started meetings', async () => {
  const handler = createHandler();
  const draft = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ draft: true, name: '可刪除草稿' })
  })).json();

  const deleted = await request(handler, { method: 'DELETE', url: `/api/meetings/${draft.meeting.id}` });
  assert.equal(deleted.status, 204);
  assert.equal((await request(handler, { method: 'GET', url: `/api/meetings/${draft.meeting.id}` })).status, 404);

  const active = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const rejected = await request(handler, { method: 'DELETE', url: `/api/meetings/${active.meeting.id}` });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json().error.code, 'meeting_delete_not_allowed');
});

test('GET /api/meetings/:meetingId/segments returns ordered segments', async () => {
  const handler = createHandler();
  const createResponse = await request(handler, { method: 'POST', url: '/api/meetings' });
  const { meeting } = createResponse.json();

  const response = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments` });

  assert.equal(response.status, 200);
  assert.equal(response.json().meetingId, meeting.id);
  assert.deepEqual(response.json().segments.map((segment) => segment.sequence), [0]);
});

test('GET /api/meetings returns meeting history summaries', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      durableChunks: [
        chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'source', sequence: 1, text: 'hello' }),
        chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'translation', sequence: 2, text: 'world' })
      ]
    }))
  });

  const response = await request(handler, { method: 'GET', url: '/api/meetings' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, meeting.id);
  assert.equal(body[0].recordKind, 'meeting');
  assert.deepEqual(body[0].segmentSummary, {
    totalSegments: 1,
    countsByStatus: { active: 1 },
    hasInterruptedSegments: false,
    hasFailedSegments: false
  });
  assert.deepEqual(body[0].transcriptSummary, {
    totalItems: 2,
    sourceFinalCount: 1,
    translationFinalCount: 1,
    hasTranscript: true
  });
});

test('GET /api/meetings/:meetingId returns composed meeting detail with transcript items and timeline', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/rollover`,
    body: JSON.stringify({
      idempotencyKey: 'rollover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [
          chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'source', sequence: 1, text: 'segment one source' }),
          chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'translation', sequence: 2, text: 'segment one translation' })
        ]
      }),
      nextLiveSessionId: 'live-session-2'
    })
  });
  await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/segment-2/recover`,
    body: JSON.stringify({
      idempotencyKey: 'recover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: 'segment-2',
        durableChunks: [
          chunk({ meetingId: meeting.id, segmentId: 'segment-2', stream: 'source', sequence: 3, text: 'segment two source' }),
          chunk({ meetingId: meeting.id, segmentId: 'segment-2', stream: 'translation', sequence: 4, text: 'segment two translation' })
        ]
      }),
      nextLiveSessionId: 'live-session-3',
      failureReason: 'token_expired',
      failureCategory: 'token',
      outcome: 'interrupted'
    })
  });

  const response = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}` });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.meeting.id, meeting.id);
  assert.deepEqual(body.timeline.map(({ id, status }) => ({ id, status })), [
    { id: 'segment-1', status: 'completed' },
    { id: 'segment-2', status: 'interrupted' },
    { id: 'segment-3', status: 'active' }
  ]);
  assert.deepEqual(
    body.transcriptItems.map(({ segmentId, segmentStatus, stream, sequence, text }) => ({
      segmentId,
      segmentStatus,
      stream,
      sequence,
      text
    })),
    [
      { segmentId: 'segment-1', segmentStatus: 'completed', stream: 'source', sequence: 1, text: 'segment one source' },
      { segmentId: 'segment-1', segmentStatus: 'completed', stream: 'translation', sequence: 2, text: 'segment one translation' },
      { segmentId: 'segment-2', segmentStatus: 'interrupted', stream: 'source', sequence: 3, text: 'segment two source' },
      { segmentId: 'segment-2', segmentStatus: 'interrupted', stream: 'translation', sequence: 4, text: 'segment two translation' }
    ]
  );
  assert.equal(body.readingContent.sourceTranscript.status, 'available');
  assert.equal(body.readingContent.translationArticle.status, 'available');
});

test('PUT and GET checkpoint persist durable chunks idempotently', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const body = checkpoint({
    meetingId: meeting.id,
    segmentId: segment.id,
    durableChunks: [
      chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'translation', sequence: 2, text: 'world' }),
      chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'source', sequence: 1, text: 'hello' })
    ]
  });

  const first = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(body)
  });
  const duplicate = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(body)
  });
  const read = await request(handler, {
    method: 'GET',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`
  });

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(read.status, 200);
  assert.deepEqual(
    read.json().checkpoint.durableChunks.map(({ stream, sequence, text }) => ({ stream, sequence, text })),
    [
      { stream: 'source', sequence: 1, text: 'hello' },
      { stream: 'translation', sequence: 2, text: 'world' }
    ]
  );
});

test('checkpoint accepts long payloads above the general JSON request limit', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const durableChunks = Array.from({ length: 24 }, (_, index) => chunk({
    meetingId: meeting.id,
    segmentId: segment.id,
    sequence: index + 1,
    text: 'long meeting transcript '.repeat(30)
  }));

  const response = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, durableChunks }))
  });

  assert.ok(response.body.length > 10_000);
  assert.equal(response.status, 200);
  assert.equal(response.json().checkpoint.durableChunks.length, durableChunks.length);
});

test('checkpoint rejects payloads above the configured Meeting limit', async () => {
  const handler = createHandler({ meetingCheckpointMaxBytes: 1_000 });
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const response = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, text: 'x'.repeat(2_000) })]
    }))
  });

  assert.equal(response.status, 413);
  assert.equal(response.json().error.code, 'request_too_large');
});

test('checkpoint conflict returns HTTP 409', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const url = `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`;

  await request(handler, {
    method: 'PUT',
    url,
    body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })] }))
  });
  const response = await request(handler, {
    method: 'PUT',
    url,
    body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'changed' })] }))
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'checkpoint_conflict');
});

test('checkpoint accepts a monotonic merged Cue update', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const url = `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`;
  const cue = finalCue({ segmentId: segment.id });

  await request(handler, { method: 'PUT', url, body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, finalCues: [cue] })) });
  const response = await request(handler, {
    method: 'PUT',
    url,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      finalCues: [{ ...cue, sourceText: '你好世界', translatedText: 'hello world', endTimeMs: 200, finalizedReason: 'merged' }]
    }))
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().checkpoint.finalCues[0].sourceText, '你好世界');
});

test('POST /api/meetings/:meetingId/segments/:segmentId/rollover creates next segment', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/rollover`,
    body: JSON.stringify({
      idempotencyKey: 'rollover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })]
      }),
      nextLiveSessionId: 'live-session-2'
    })
  });

  assert.equal(response.status, 201);
  assert.equal(response.json().completedSegment.status, 'completed');
  assert.equal(response.json().completedSegment.liveSessionId, 'live-session-1');
  assert.equal(response.json().segment.sequence, 1);
  assert.equal(response.json().segment.status, 'active');
  assert.equal(response.json().segment.liveSessionId, 'live-session-2');
});

test('POST /api/meetings/:meetingId/segments/:segmentId/recover interrupts current segment and creates next segment', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/recover`,
    body: JSON.stringify({
      idempotencyKey: 'recover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })]
      }),
      nextLiveSessionId: 'live-session-2',
      failureReason: 'token_expired',
      failureCategory: 'token',
      outcome: 'interrupted'
    })
  });

  assert.equal(response.status, 201);
  assert.equal(response.json().interruptedSegment.status, 'interrupted');
  assert.equal(response.json().interruptedSegment.checkpoint.idempotencyKey, 'recover-1');
  assert.deepEqual(response.json().interruptedSegment.errorInfo, { reason: 'token_expired', category: 'token' });
  assert.equal(response.json().segment.sequence, 1);
  assert.equal(response.json().segment.status, 'active');
  assert.equal(response.json().segment.liveSessionId, 'live-session-2');
});

test('POST /api/meetings/:meetingId/segments/:segmentId/recover fails current segment without next segment', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/recover`,
    body: JSON.stringify({
      idempotencyKey: 'recover-failed-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })]
      }),
      nextLiveSessionId: 'live-session-2',
      failureReason: 'auth_failed',
      failureCategory: 'token',
      outcome: 'failed'
    })
  });
  const segments = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments` });

  assert.equal(response.status, 201);
  assert.equal(response.json().failedSegment.status, 'failed');
  assert.deepEqual(response.json().failedSegment.errorInfo, { reason: 'auth_failed', category: 'token' });
  assert.deepEqual(segments.json().segments.map((stored) => stored.id), ['segment-1']);
});

test('POST recovery conflict returns HTTP 409', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const url = `/api/meetings/${meeting.id}/segments/${segment.id}/recover`;
  const body = {
    idempotencyKey: 'recover-1',
    checkpoint: checkpoint({ meetingId: meeting.id, segmentId: segment.id }),
    nextLiveSessionId: 'live-session-2',
    failureReason: 'unexpected_close',
    failureCategory: 'provider',
    outcome: 'interrupted'
  };

  await request(handler, { method: 'POST', url, body: JSON.stringify(body) });
  const response = await request(handler, {
    method: 'POST',
    url,
    body: JSON.stringify({ ...body, nextLiveSessionId: 'live-session-3' })
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'checkpoint_conflict');
});

test('missing meeting or segment returns HTTP 404', async () => {
  const handler = createHandler();
  const { meeting } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  const missingMeeting = await request(handler, { method: 'GET', url: '/api/meetings/missing/segments' });
  const missingMeetingDetail = await request(handler, { method: 'GET', url: '/api/meetings/missing' });
  const missingSegment = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments/missing/checkpoint` });

  assert.equal(missingMeeting.status, 404);
  assert.equal(missingMeeting.json().error.code, 'meeting_not_found');
  assert.equal(missingMeetingDetail.status, 404);
  assert.equal(missingMeetingDetail.json().error.code, 'meeting_not_found');
  assert.equal(missingSegment.status, 404);
  assert.equal(missingSegment.json().error.code, 'meeting_segment_not_found');
});

function createHandler({ meetingCheckpointMaxBytes } = {}) {
  const repository = createMemoryMeetingRepository();
  let meetingId = 0;
  let segmentId = 0;
  const meetingCheckpointService = createMeetingCheckpointService({
    meetingRepository: repository,
    idGenerator(prefix) {
      if (prefix === 'meeting') return `meeting-${++meetingId}`;
      if (prefix === 'segment') return `segment-${++segmentId}`;
      return `${prefix}-1`;
    },
    clock: () => 1000
  });
  const meetingReadController = createMeetingReadController({
    meetingReadQueryService: createMeetingReadQueryService({ meetingRepository: repository })
  });

  return createRequestHandler({
    sessionReadController: sessionReadController(),
    meetingReadController,
    meetingCheckpointService,
    ...(meetingCheckpointMaxBytes === undefined ? {} : { meetingCheckpointMaxBytes })
  });
}

function sessionReadController() {
  return {
    listSessions() {
      return [];
    },
    getSession() {
      return null;
    }
  };
}

function checkpoint({ meetingId, segmentId, durableChunks = [], finalCues = [] }) {
  return {
    idempotencyKey: 'checkpoint-1',
    durableChunks,
    ...(finalCues.length > 0 ? { finalCues } : {}),
    pendingPartial: null,
    meetingId,
    segmentId
  };
}

function finalCue(overrides = {}) {
  return {
    cueId: 'cue:session-1:segment-1:1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    sequence: 1,
    startTimeMs: 0,
    endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    sourceText: '你好',
    translatedText: 'hello',
    status: 'final',
    finalizedReason: 'final',
    ...overrides
  };
}

function chunk(overrides = {}) {
  const stream = overrides.stream ?? 'source';
  const sequence = overrides.sequence ?? 1;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `chunk-${stream}-${sequence}`,
    meetingId: overrides.meetingId,
    segmentId: overrides.segmentId,
    stream,
    sequence,
    text: overrides.text ?? 'text',
    timestamp: 1000
  };
}

async function request(handler, { method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const req = new Readable({ read() {} });
  req.url = url;
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  if (body) req.push(body);
  req.push(null);

  const chunks = [];
  const res = {
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = responseHeaders;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await handler(req, res);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return {
    status: res.statusCode,
    headers: res.headers,
    body: rawBody,
    json() {
      return rawBody ? JSON.parse(rawBody) : {};
    }
  };
}
