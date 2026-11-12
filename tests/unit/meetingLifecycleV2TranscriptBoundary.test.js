import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithRequestUser, setRequestScope } from '../../server/requestIdentity.js';
import {
  commitLocalRolloverAfterDurableBarrier,
  finalizedTranscriptItemsForRecording,
  recordingLifecycleContractVersion,
  sessionSnapshotPayloadForRecording,
  stopLifecycleV2AfterFailure
} from '../../src/features/live/useLiveRecordingController.js';
import { createSupabaseSessionRepository } from '../../src/infrastructure/supabaseSessionRepository.js';
import { applyTranscriptEvent, createTranscriptState } from '../../src/lib/transcript.js';

test('local rollover commits only after every durable barrier step succeeds', async () => {
  for (const failedStep of ['checkpoint', 'container', 'writes', 'journal']) {
    const calls = [];
    let currentSegmentId = 'segment-1';
    const step = (name) => async () => {
      calls.push(name);
      if (name === failedStep) {
        if (name === 'checkpoint') return false;
        throw new Error(`${name} failed`);
      }
      return true;
    };
    await assert.rejects(commitLocalRolloverAfterDurableBarrier({
      flushCheckpoint: step('checkpoint'),
      sealAudioContainer: step('container'),
      sealSegmentWrites: step('writes'),
      sealPcmJournal: step('journal'),
      commitSegment: async () => { calls.push('commit'); currentSegmentId = 'segment-2'; }
    }));
    assert.equal(currentSegmentId, 'segment-1', `${failedStep} advanced currentSegmentId`);
    assert.equal(calls.includes('commit'), false, `${failedStep} committed the successor`);
  }
  const calls = [];
  await commitLocalRolloverAfterDurableBarrier({
    flushCheckpoint: async () => { calls.push('checkpoint'); return true; },
    sealAudioContainer: async () => { calls.push('container'); },
    sealSegmentWrites: async () => { calls.push('writes'); },
    sealPcmJournal: async () => { calls.push('journal'); },
    commitSegment: async () => { calls.push('commit'); }
  });
  assert.deepEqual(calls, ['checkpoint', 'container', 'writes', 'journal', 'commit']);
});

test('durable Session or Meeting identity keeps lifecycle v2 off the legacy resume path', () => {
  assert.equal(recordingLifecycleContractVersion({
    sessionRecord: { id: 'session-1', lifecycleContractVersion: 2 }
  }), 2);
  assert.equal(recordingLifecycleContractVersion({
    meeting: { id: 'meeting-1', lifecycle_contract_version: 2 }
  }), 2);
  assert.equal(recordingLifecycleContractVersion({
    sessionRecord: { id: 'session-1' },
    meeting: { id: 'meeting-1', lifecycleContractVersion: 1 }
  }), 1);
});

test('lifecycle v2 finalized transcript items skip Session append and snapshot payload', () => {
  const previous = createTranscriptState();
  const next = applyTranscriptEvent(previous, {
    stream: 'source',
    text: '正式字幕',
    isFinal: true,
    now: 100
  });
  const calls = [];
  const repository = {
    appendTranscriptItem(...args) {
      calls.push(args);
      return args.at(-1);
    }
  };

  const finalized = finalizedTranscriptItemsForRecording({
    lifecycleContractVersion: 2,
    repository,
    sessionId: 'session-v2',
    previousTranscriptState: previous,
    nextTranscriptState: next
  });

  assert.deepEqual(finalized.map((item) => item.text), ['正式字幕']);
  assert.deepEqual(calls, []);
  assert.deepEqual(sessionSnapshotPayloadForRecording({
    lifecycleContractVersion: 2,
    session: { id: 'session-v2', status: 'active' },
    transcriptItems: finalized
  }), {
    session: { id: 'session-v2', status: 'active' },
    transcriptItems: []
  });
});

test('legacy finalized transcript items retain Session append and snapshot payload', () => {
  const previous = createTranscriptState();
  const next = applyTranscriptEvent(previous, {
    stream: 'translation',
    text: 'Final subtitle',
    isFinal: true,
    now: 100
  });
  const calls = [];
  const repository = {
    getSessionRecord() {
      return { sessionRecord: { segmentId: 'segment-v1' }, transcriptItems: [] };
    },
    appendTranscriptItem(sessionId, item) {
      calls.push({ sessionId, item });
      return { ...item, sessionId };
    }
  };

  const appended = finalizedTranscriptItemsForRecording({
    repository,
    sessionId: 'session-v1',
    previousTranscriptState: previous,
    nextTranscriptState: next
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-v1');
  assert.equal(calls[0].item.segmentId, 'segment-v1');
  assert.deepEqual(sessionSnapshotPayloadForRecording({
    session: { id: 'session-v1', status: 'active' },
    transcriptItems: appended
  }).transcriptItems, appended);
});

test('Supabase Session repository ignores transcript mutations for lifecycle v2 rows', async () => {
  const requests = [];
  const repository = createSupabaseSessionRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response([{
        id: 'session-v2',
        lifecycle_contract_version: 2,
        payload: {
          id: 'session-v2',
          targetLanguageCode: 'en',
          status: 'active'
        },
        transcript_items: []
      }]);
    }
  });

  await runWithRequestUser({ id: 'owner-1' }, async () => {
    setRequestScope({
      actorUserId: 'owner-1',
      resourceOwnerUserId: 'owner-1',
      accessToken: 'access-token',
      capability: 'user'
    });
    const item = await repository.appendTranscriptItem('session-v2', {
      id: 'source-1',
      stream: 'source',
      status: 'final',
      text: '正式字幕',
      sequence: 1
    });
    assert.equal(item.id, 'source-1');
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'GET');
});

test('lifecycle v2 Session reads use relational active Segment after rollover', async () => {
  const repository = createSupabaseSessionRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async () => response([{
      id: 'session-v2',
      meeting_id: 'meeting-1',
      segment_id: 'segment-b',
      current_segment_id: 'segment-b',
      lifecycle_contract_version: 2,
      payload: {
        id: 'session-v2',
        meetingId: 'meeting-1',
        segmentId: 'segment-a',
        targetLanguageCode: 'en',
        status: 'active'
      },
      transcript_items: []
    }])
  });

  await runWithRequestUser({ id: 'owner-1' }, async () => {
    setRequestScope({
      actorUserId: 'owner-1',
      resourceOwnerUserId: 'owner-1',
      accessToken: 'access-token',
      capability: 'user'
    });
    const detail = await repository.getSessionRecord('session-v2');
    assert.equal(detail.sessionRecord.segmentId, 'segment-b');
  });
});

test('lifecycle v2 unrecoverable failure stops instead of recovering', async () => {
  const calls = [];
  const stopped = await stopLifecycleV2AfterFailure({
    lifecycle: { meetingId: 'meeting-v2', segmentId: 'segment-v2' },
    failureReason: 'provider_unavailable',
    failureCategory: 'provider',
    flushCheckpoint: async () => calls.push('flush-checkpoint'),
    executeRecordingCommand: async (command, payload) => calls.push({ command, payload }),
    stopHeartbeats: () => calls.push('stop-heartbeats'),
    clearWriteFence: (meetingId) => calls.push({ clearWriteFence: meetingId }),
    preventFurtherWrites: () => calls.push('prevent-further-writes')
  });

  assert.equal(stopped, true);
  assert.deepEqual(calls, [
    'flush-checkpoint',
    {
      command: 'stop',
      payload: {
        failureReason: 'provider_unavailable',
        failureCategory: 'provider'
      }
    },
    'stop-heartbeats',
    { clearWriteFence: 'meeting-v2' },
    'prevent-further-writes'
  ]);
  assert.equal(calls.some((call) => call?.command === 'recover'), false);
});

test('lifecycle v2 cannot ACK stop after a failed checkpoint flush', async () => {
  const calls = [];
  await assert.rejects(stopLifecycleV2AfterFailure({
    lifecycle: { meetingId: 'meeting-v2', segmentId: 'segment-v2' },
    flushCheckpoint: async () => false,
    executeRecordingCommand: async () => calls.push('stop')
  }), /Checkpoint flush failed/);
  assert.deepEqual(calls, []);
});

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body
  };
}
