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
