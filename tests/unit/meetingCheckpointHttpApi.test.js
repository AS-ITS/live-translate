import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

test('POST /api/meetings creates an active meeting and first segment', async () => {
  const response = await request(createHandler(), { method: 'POST', url: '/api/meetings' });
  const body = response.json();

  assert.equal(response.status, 201);
  assert.equal(body.meeting.status, 'active');
  assert.equal(body.segment.status, 'active');
  assert.equal(body.segment.meetingId, body.meeting.id);
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

test('missing meeting or segment returns HTTP 404', async () => {
  const handler = createHandler();
  const { meeting } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  const missingMeeting = await request(handler, { method: 'GET', url: '/api/meetings/missing/segments' });
  const missingSegment = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments/missing/checkpoint` });

  assert.equal(missingMeeting.status, 404);
  assert.equal(missingMeeting.json().error.code, 'meeting_not_found');
  assert.equal(missingSegment.status, 404);
  assert.equal(missingSegment.json().error.code, 'meeting_segment_not_found');
});

function createHandler() {
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

  return createRequestHandler({
    sessionReadController: sessionReadController(),
    meetingCheckpointService
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

function checkpoint({ meetingId, segmentId, durableChunks = [] }) {
  return {
    idempotencyKey: 'checkpoint-1',
    durableChunks,
    pendingPartial: null,
    meetingId,
    segmentId
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
