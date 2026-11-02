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
  assert.deepEqual(calls, [{ url: '/api/meetings', options: { method: 'POST', headers: {} } }]);
});

test('meeting checkpoint API client accepts v2 creation before its first Segment', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async () => ok({
      meeting: { id: 'meeting-v2', lifecycleContractVersion: 2, lifecycleVersion: 0, status: 'created' },
      segment: null
    })
  });
  const result = await client.createMeeting();
  assert.equal(result.meeting.id, 'meeting-v2');
  assert.equal(result.segment, null);
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
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[1].options.headers.Accept, 'application/json');
  assert.deepEqual(calls.map(({ url, options }) => ({ url, method: options.method })), [
    { url: '/api/meetings/meeting-1/segments', method: 'GET' },
    { url: '/api/meetings/meeting-1/segments/segment-1/checkpoint', method: 'GET' }
  ]);
});

test('meeting checkpoint API client accepts an empty checkpoint response', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async () => ok({ meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint: null })
  });

  const result = await client.getCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  assert.equal(result.checkpoint, null);
});

test('meeting checkpoint API client completes a meeting', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({ meeting: { id: 'meeting-1', status: 'completed' } });
    }
  });

  const result = await client.completeMeeting({ meetingId: 'meeting-1' });

  assert.equal(result.meeting.status, 'completed');
  assert.deepEqual(calls, [{
    url: '/api/meetings/meeting-1/complete',
    options: { method: 'POST', headers: {} }
  }]);
});

test('meeting checkpoint API client executes lifecycle v2 commands and heartbeats', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/heartbeat')) return ok({ leaseId: 'lease-1', fenceToken: 2 });
      return ok({
        meeting: { id: 'meeting-1', lifecycle_version: 1 },
        session: { id: 'session-1' },
        segment: { id: 'segment-1' },
        lease: { leaseId: 'lease-1', fenceToken: 2 }
      });
    }
  });

  await client.executeRecordingCommand({
    meetingId: 'meeting-1',
    command: 'start',
    operationId: 'operation-1',
    expectedLifecycleVersion: 0
  });
  await client.renewRecordingLease({ meetingId: 'meeting-1', leaseId: 'lease-1', fenceToken: 2 });

  assert.equal(calls[0].url, '/api/meetings/meeting-1/recording/start');
  assert.deepEqual(JSON.parse(calls[0].options.body), { operationId: 'operation-1', expectedLifecycleVersion: 0 });
  assert.equal(calls[1].url, '/api/meetings/meeting-1/recording/lease/heartbeat');
});

test('meeting checkpoint API client accepts transactional legacy resume without lifecycle lease fields', async () => {
  const calls = [];
  const response = {
    meeting: { id: 'meeting-1' },
    segment: { id: 'segment-2' },
    operation: { payloadHash: 'hash-1', sourceSegmentId: 'segment-1' },
    effectiveGlossaryRevision: 'revision-1'
  };
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok(response);
    }
  });

  const resumed = await client.resumeLegacySegment({
    meetingId: 'meeting-1',
    operationId: 'continue-1',
    sourceSegmentId: 'segment-1'
  });
  const reconciled = await client.getLegacyResumeOperation({
    meetingId: 'meeting-1',
    operationId: 'continue-1',
    sourceSegmentId: 'segment-1'
  });

  assert.equal(resumed.segment.id, 'segment-2');
  assert.equal(reconciled.effectiveGlossaryRevision, 'revision-1');
  assert.equal(calls[0].url, '/api/meetings/meeting-1/recording/legacy-resume');
  assert.equal(JSON.parse(calls[1].options.body).reconcileOnly, true);
});

test('meeting checkpoint API client marks a timed out lifecycle mutation as unknown outcome', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    lifecycleTimeoutMs: 1
  });
  const request = client.executeRecordingCommand({ meetingId: 'meeting-1', command: 'rollover', operationId: 'operation-1', expectedLifecycleVersion: 1 });
  await assert.rejects(request, (error) => error.code === 'request_timeout' && error.outcomeUnknown === true);
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

test('meeting checkpoint API client allows terminal interruption without a replacement live session', async () => {
  const calls = [];
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({
        meeting: { id: 'meeting-1', status: 'interrupted' },
        interruptedSegment: { id: 'segment-1', status: 'interrupted' },
        segment: { id: 'segment-2', status: 'created', liveSessionId: null }
      });
    }
  });

  await client.recoverSegment({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    idempotencyKey: 'interrupt-1',
    checkpoint: { idempotencyKey: 'checkpoint-1', durableChunks: [], pendingPartial: null },
    nextLiveSessionId: null,
    failureReason: 'unexpected_close',
    failureCategory: 'provider',
    outcome: 'interrupted'
  });

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).nextLiveSessionId, null);
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

test('meeting checkpoint API client preserves server error diagnostics', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async () => ({
      ok: false,
      status: 413,
      headers: { get: (name) => name === 'x-request-id' ? 'request-413' : null },
      json: async () => ({ error: { code: 'request_too_large' } })
    })
  });

  await assert.rejects(
    client.updateCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1', idempotencyKey: 'checkpoint-1', durableChunks: [] }),
    (error) => error.status === 413 && error.code === 'request_too_large' && error.requestId === 'request-413'
  );
});

test('meeting checkpoint API client preserves structured checkpoint error details', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ error: {
        code: 'subtitle_cue_invalid',
        message: 'Subtitle cue is invalid.',
        requestId: 'request-cue-400',
        details: ['segmentId must be a valid UUID.']
      } })
    })
  });

  await assert.rejects(
    client.updateCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1', idempotencyKey: 'checkpoint-1', durableChunks: [] }),
    (error) => error.status === 400
      && error.code === 'subtitle_cue_invalid'
      && error.apiMessage === 'Subtitle cue is invalid.'
      && error.details[0] === 'segmentId must be a valid UUID.'
      && error.requestId === 'request-cue-400'
  );
});

test('recover 409 retains operation, response code, and requestId without claiming checkpoint failed', async () => {
  const client = createMeetingCheckpointApiClient({
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      headers: { get: () => 'request-recover-409' },
      json: async () => ({ error: { code: 'checkpoint_conflict', message: 'Recovery conflict.' } })
    })
  });
  await assert.rejects(client.recoverSegment({
    meetingId: 'meeting-1', segmentId: 'segment-1', idempotencyKey: 'recover-1',
    checkpoint: { idempotencyKey: 'checkpoint-1', durableChunks: [], pendingPartial: null },
    nextLiveSessionId: 'live-2', failureReason: 'manual_resume', failureCategory: 'user_intent', outcome: 'interrupted'
  }), (error) => error.operation === 'recover-segment'
    && error.status === 409
    && error.code === 'checkpoint_conflict'
    && error.requestId === 'request-recover-409'
    && /^Meeting recover API/.test(error.message));
});

function ok(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  };
}
