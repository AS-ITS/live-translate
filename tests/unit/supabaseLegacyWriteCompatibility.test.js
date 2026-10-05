import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';
import { createSupabaseSessionRepository } from '../../src/infrastructure/supabaseSessionRepository.js';
import { setRequestUser } from '../../server/requestIdentity.js';

function response(body = []) {
  return { ok: true, status: 200, async json() { return body; } };
}

test('v2 repository writes preserve legacy fields as null while reads remain available', async () => {
  const calls = [];
  const segment = {
    id: 'segment-1', owner_user_id: 'owner-1', meeting_id: 'meeting-1', session_id: 'session-1',
    lifecycle_contract_version: 2, sequence: 0, status: 'created', started_at: null,
    ended_at: null, live_session_id: 'legacy-live-session', settings_snapshot: {}, checkpoint: {},
    error_info: null, created_at: '2026-09-24T00:00:00.000Z', updated_at: '2026-09-24T00:00:00.000Z'
  };
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return response(url.includes('/meeting_segments') ? [segment] : []);
    }
  });
  setRequestUser({ id: 'owner-1' });

  await repository.createMeetingSegment({
    id: 'segment-1', meetingId: 'meeting-1', sessionId: 'session-1', sequence: 0,
    status: 'created', lifecycleContractVersion: 2, liveSessionId: 'legacy-live-session',
    createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z'
  });

  const body = JSON.parse(calls.find(({ options }) => options.method === 'POST').options.body)[0];
  assert.equal(body.live_session_id, null);
  setRequestUser(null);
});

test('v2 session repository stops writing legacy segment and transcript columns', async () => {
  let body;
  const repository = createSupabaseSessionRepository({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'POST') body = JSON.parse(options.body)[0];
      return response([]);
    },
    idFactory: () => 'session-1'
  });
  setRequestUser({ id: 'owner-1' });

  await repository.createSessionRecord({
    id: 'session-1', meetingId: 'meeting-1', segmentId: 'segment-1', lifecycleContractVersion: 2,
    status: 'created', targetLanguageCode: 'en', createdAt: '2026-09-24T00:00:00.000Z'
  });

  assert.equal(body.segment_id, null);
  assert.deepEqual(body.transcript_items, []);
  setRequestUser(null);
});
