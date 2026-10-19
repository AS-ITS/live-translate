import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestUser } from '../../server/requestIdentity.js';
import { MeetingSegment } from '../../src/domain/meeting/index.js';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'fixture-service-key' };
const current = new MeetingSegment({
  id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'active',
  startedAt: 1, createdAt: 1, updatedAt: 1, checkpoint: { revision: 0, finalCues: [] }
});
const checkpoint = {
  revision: 1, idempotencyKey: 'op-a', durableChunks: [], finalCues: [],
  _operationPayloads: { 'op-a': 'payload-a' }
};

test('Supabase checkpoint adapter sends one transactional RPC and returns its committed state', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({ env, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => checkpoint };
  } });
  setRequestUser({ id: 'owner-1' });
  try {
    const result = await repository.commitCheckpoint({
      current, next: current.withCheckpoint(checkpoint, 2), incoming: { idempotencyKey: 'op-a' }
    });
    assert.equal(result.checkpoint.revision, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/apply_meeting_checkpoint_operation_v2$/u);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.p_expected_revision, 0);
    assert.equal(body.p_operation_key, 'op-a');
    assert.equal(body.p_canonical_payload, 'payload-a');
    assert.equal(Object.hasOwn(body, 'p_owner_user_id'), false);
  } finally {
    setRequestUser(null);
  }
});

test('Supabase SQLSTATE checkpoint conflict remains structured 409 at adapter boundary', async () => {
  const repository = createSupabaseMeetingRepository({ env, fetchImpl: async () => ({
    ok: false, status: 400, json: async () => ({ code: 'P0042', message: 'checkpoint_conflict' })
  }) });
  setRequestUser({ id: 'owner-1' });
  try {
    await assert.rejects(repository.commitCheckpoint({
      current, next: current.withCheckpoint(checkpoint, 2), incoming: { idempotencyKey: 'op-a' }
    }), (error) => error.code === 'checkpoint_conflict' && error.status === 409);
  } finally {
    setRequestUser(null);
  }
});

test('generic segment updates do not replay revisioned checkpoint Cues into Cue rows', async () => {
  const calls = [];
  const cue = {
    cueId: 'cue-a', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
    sourceText: 'A', translatedText: 'A', sourceVersion: 1, translationVersion: 1,
    startTimeMs: 1, endTimeMs: 2
  };
  const entity = current.withCheckpoint({ ...checkpoint, finalCues: [cue] }, 2);
  const repository = createSupabaseMeetingRepository({ env, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/subtitle_cues')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => [{
      id: entity.id, owner_user_id: 'owner-1', meeting_id: entity.meetingId,
      sequence: entity.sequence, status: entity.status, checkpoint: entity.checkpoint,
      started_at: new Date(entity.startedAt).toISOString(),
      created_at: new Date(entity.createdAt).toISOString(),
      updated_at: new Date(entity.updatedAt).toISOString()
    }] };
  } });
  setRequestUser({ id: 'owner-1' });
  try {
    await repository.updateMeetingSegment(entity);
    assert.equal(calls.filter(({ url, init }) => url.includes('/subtitle_cues') && init.method === 'POST').length, 0);
  } finally {
    setRequestUser(null);
  }
});
