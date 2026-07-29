import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCheckpointApiClient } from '../../src/lib/meetingCheckpointApiClient.js';

test('meeting checkpoint API client creates a meeting', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({ meeting: { id: 'meeting-1' }, segment: { id: 'segment-1' } });
    }
  });

  const result = await client.createMeeting();

  assert.equal(result.meeting.id, 'meeting-1');
  assert.equal(result.segment.id, 'segment-1');
  assert.deepEqual(calls, [{ url: '/api/meetings', options: { method: 'POST' } }]);
});

test('meeting checkpoint API client creates a meeting with live session association', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({ meeting: { id: 'meeting-1' }, segment: { id: 'segment-1', liveSessionId: 'live-session-1' } });
    }
  });

  const result = await client.createMeeting({ liveSessionId: 'live-session-1' });

  assert.equal(result.segment.liveSessionId, 'live-session-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { liveSessionId: 'live-session-1' });
});

test('meeting checkpoint API client lists meeting segments and reads checkpoints', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/segments')) {
        return ok({ meetingId: 'meeting-1', segments: [{ id: 'segment-1' }] });
      }
      return ok({ checkpoint: { durableChunks: [{ idempotencyKey: 'chunk-1' }] } });
    }
  });

  const segments = await client.listSegments({ meetingId: 'meeting-1' });
  const checkpoint = await client.getCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1' });

  assert.equal(segments.segments[0].id, 'segment-1');
  assert.equal(checkpoint.checkpoint.durableChunks[0].idempotencyKey, 'chunk-1');
  assert.deepEqual(calls.map(({ url, options }) => ({ url, method: options.method })), [
    { url: '/api/meetings/meeting-1/segments', method: 'GET' },
    { url: '/api/meetings/meeting-1/segments/segment-1/checkpoint', method: 'GET' }
  ]);
});

test('meeting checkpoint API client updates a segment checkpoint', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({ checkpoint: { durableChunks: [{ idempotencyKey: 'chunk-1' }] } });
    }
  });
  const durableChunks = [{ idempotencyKey: 'chunk-1', meetingId: 'meeting-1', segmentId: 'segment-1', stream: 'source', sequence: 0, text: 'hello', timestamp: 1000 }];

  const result = await client.updateCheckpoint({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    idempotencyKey: 'checkpoint-1',
    durableChunks
  });

  assert.equal(result.checkpoint.durableChunks.length, 1);
  assert.equal(calls[0].url, '/api/meetings/meeting-1/segments/segment-1/checkpoint');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    idempotencyKey: 'checkpoint-1',
    durableChunks,
    pendingPartial: null
  });
});

test('meeting checkpoint API client rolls over a segment', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({
        completedSegment: { id: 'segment-1', status: 'completed' },
        segment: { id: 'segment-2', status: 'active' }
      });
    }
  });
  const checkpoint = { idempotencyKey: 'checkpoint-1', durableChunks: [], pendingPartial: null };

  const result = await client.rolloverSegment({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    idempotencyKey: 'rollover-1',
    checkpoint,
    nextLiveSessionId: 'live-session-2'
  });

  assert.equal(result.segment.id, 'segment-2');
  assert.equal(calls[0].url, '/api/meetings/meeting-1/segments/segment-1/rollover');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    idempotencyKey: 'rollover-1',
    checkpoint,
    nextLiveSessionId: 'live-session-2'
  });
});

test('meeting checkpoint API client recovers a segment', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({
        interruptedSegment: { id: 'segment-1', status: 'interrupted' },
        segment: { id: 'segment-2', status: 'active' }
      });
    }
  });
  const checkpoint = { idempotencyKey: 'checkpoint-1', durableChunks: [], pendingPartial: null };

  const result = await client.recoverSegment({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    idempotencyKey: 'recover-1',
    checkpoint,
    nextLiveSessionId: 'live-session-2',
    failureReason: 'token_expired',
    failureCategory: 'token',
    outcome: 'interrupted'
  });

  assert.equal(result.segment.id, 'segment-2');
  assert.equal(calls[0].url, '/api/meetings/meeting-1/segments/segment-1/recover');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    idempotencyKey: 'recover-1',
    checkpoint,
    nextLiveSessionId: 'live-session-2',
    failureReason: 'token_expired',
    failureCategory: 'token',
    outcome: 'interrupted'
  });
});

test('meeting checkpoint API client parses failed recovery response', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async () => ok({
      failedSegment: { id: 'segment-1', status: 'failed' }
    })
  });

  const result = await client.recoverSegment({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    idempotencyKey: 'recover-1',
    checkpoint: { idempotencyKey: 'checkpoint-1', durableChunks: [], pendingPartial: null },
    nextLiveSessionId: 'live-session-2',
    failureReason: 'auth_failed',
    failureCategory: 'token',
    outcome: 'failed'
  });

  assert.equal(result.failedSegment.id, 'segment-1');
});

test('meeting checkpoint API client rejects malformed and failed responses', async () => {
  const malformedClient = createMeetingCheckpointApiClient({ fetchImpl: async () => ok({ meeting: {}, segment: {} }) });
  await assert.rejects(malformedClient.createMeeting(), /meeting\.id and segment\.id/);

  const failedClient = createMeetingCheckpointApiClient({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({}) }) });
  await assert.rejects(
    failedClient.updateCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1', idempotencyKey: 'checkpoint-1', durableChunks: [] }),
    /HTTP 409/
  );
});

function ok(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  };
}
