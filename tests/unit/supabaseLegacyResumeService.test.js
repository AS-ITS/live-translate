import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseLegacyResumeService } from '../../src/infrastructure/supabaseLegacyResumeService.js';

test('legacy resume service sends immutable identity and checkpoint to dedicated RPC', async () => {
  const calls = [];
  const service = createSupabaseLegacyResumeService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options) => {
      calls.push({ name: url.split('/').at(-1), body: JSON.parse(options.body) });
      return { ok: true, status: 200, async json() { return { segment: { id: 'segment-2' } }; } };
    }
  });
  const result = await service.execute({
    ownerUserId: 'owner-1', meetingId: 'meeting-1', sourceSegmentId: 'segment-1',
    operationId: 'continue-1', payloadHash: 'hash-1', nextLiveSessionId: 'live-2',
    expectedSessionId: 'session-1', checkpoint: { lastFinalCueSequence: 3 },
    globalGlossaryEntries: [{ source: '你好', target: 'global' }]
  });
  assert.equal(result.segment.id, 'segment-2');
  assert.deepEqual(calls, [{
    name: 'resume_legacy_meeting_segment',
    body: {
      p_owner_user_id: 'owner-1',
      p_meeting_id: 'meeting-1',
      p_source_segment_id: 'segment-1',
      p_operation_id: 'continue-1',
      p_payload_hash: 'hash-1',
      p_next_live_session_id: 'live-2',
      p_expected_session_id: 'session-1',
      p_checkpoint: { lastFinalCueSequence: 3 },
      p_global_glossary_entries: [{ source: '你好', target: 'global' }]
    }
  }]);
});

test('legacy resume service maps payload conflict to HTTP 409', async () => {
  const service = createSupabaseLegacyResumeService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async json() { return { message: 'meeting_lifecycle_conflict' }; }
    })
  });
  await assert.rejects(service.execute({
    ownerUserId: 'owner-1', meetingId: 'meeting-1', sourceSegmentId: 'segment-1',
    operationId: 'continue-1', payloadHash: 'hash-1', nextLiveSessionId: 'live-2'
  }), { code: 'meeting_lifecycle_conflict', status: 409 });
});
