import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';
import { createSupabaseMeetingShareService } from '../../src/infrastructure/supabaseMeetingShareService.js';
import { newerViewerMetadata } from '../../src/readModels/meetingReadModels.js';
import { setRequestUser } from '../../server/requestIdentity.js';

test('metadata query projects lifecycle and ordered identity without reading content', async () => {
  const meeting = { id: 'meeting-1', ownerUserId: 'owner-1', status: 'active', lifecycleVersion: 4, retentionPolicyVersion: 2, purgeAt: '2030-01-01T00:00:00.000Z', glossaryEntries: [{ source: 'secret' }] };
  const repository = {
    listMeetings() { return []; },
    getMeeting() { return meeting; },
    listMeetingSegments() { throw new Error('content hydration forbidden'); },
    getMeetingViewerPage() { throw new Error('subtitle_cues forbidden'); },
    listMeetingSegmentMetadata(id, ownerId) {
      assert.equal(id, meeting.id);
      assert.equal(ownerId, meeting.ownerUserId);
      return [
        { id: 'segment-2', meetingId: id, sessionId: 'session-2', sequence: 2, status: 'active', checkpoint: { finalCues: [{ sourceText: 'secret' }] } },
        { id: 'segment-1', meetingId: id, sessionId: 'session-1', sequence: 1, status: 'completed' }
      ];
    }
  };
  const service = createMeetingReadQueryService({ meetingRepository: repository });
  const metadata = await service.getMeetingViewerMetadata(meeting.id);
  assert.equal(metadata.recordingState, 'active');
  assert.equal(metadata.meeting.lifecycleVersion, 4);
  assert.deepEqual(metadata.segments.map(({ id, sessionId }) => [id, sessionId]), [['segment-1', 'session-1'], ['segment-2', 'session-2']]);
  for (const forbidden of ['cues', 'transcript', 'translation', 'checkpoint', 'glossaryEntries', 'sourceText']) {
    assert.equal(JSON.stringify(metadata).toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }

  repository.listMeetingSegmentMetadata = () => [{ id: 'segment-2', sessionId: 'session-2', sequence: 2, status: 'completed' }];
  assert.equal((await service.getMeetingViewerMetadata(meeting.id)).recordingState, 'paused');
  meeting.status = 'completed';
  assert.equal((await service.getMeetingViewerMetadata(meeting.id)).recordingState, 'ended');
  meeting.purgeAt = '2000-01-01T00:00:00.000Z';
  await assert.rejects(service.getMeetingViewerMetadata(meeting.id), (error) => error.code === 'meeting_content_expired' && error.status === 410);
});

test('older metadata cannot replace newer lifecycle or another meeting', () => {
  const current = { meeting: { id: 'meeting-1', lifecycleVersion: 5 }, recordingState: 'ended' };
  assert.equal(newerViewerMetadata(current, { meeting: { id: 'meeting-1', lifecycleVersion: 4 } }), current);
  assert.equal(newerViewerMetadata(current, { meeting: { id: 'meeting-1', lifecycleVersion: 5 } }), current);
  assert.equal(newerViewerMetadata(current, { meeting: { id: 'meeting-2', lifecycleVersion: 6 } }), current);
  const newer = { meeting: { id: 'meeting-1', lifecycleVersion: 6 }, recordingState: 'active' };
  assert.equal(newerViewerMetadata(current, newer), newer);
});

test('Supabase metadata repository selects segment identity only', async () => {
  const urls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (/subtitle_cues|meeting_events|checkpoint/iu.test(String(url))) throw new Error('content table forbidden');
      if (String(url).includes('/rest/v1/meetings?')) return { ok: true, status: 200, async json() { return [
        { id: 'meeting-1', owner_user_id: 'owner-1', status: 'failed', lifecycle_contract_version: 2, lifecycle_version: 3, started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T01:00:00Z', failure_info: { reason: 'sensitive' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', settings: {} }
      ]; } };
      return { ok: true, status: 200, async json() { return [
        { id: 'segment-1', meeting_id: 'meeting-1', session_id: 'session-1', sequence: 1, status: 'active', started_at: null, ended_at: null, created_at: '2026-01-01T00:00:00Z' }
      ]; } };
    }
  });
  setRequestUser({ id: 'owner-1' });
  try {
    const metadata = await createMeetingReadQueryService({ meetingRepository: repository }).getMeetingViewerMetadata('meeting-1');
    assert.equal(metadata.segments[0].sessionId, 'session-1');
    assert.equal(metadata.meeting.lifecycleVersion, 3);
    assert.equal(metadata.recordingState, 'ended');
    assert.doesNotMatch(JSON.stringify(metadata), /sensitive|failureInfo/iu);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/rest\/v1\/meetings\?select=id,owner_user_id,name,status,source_language_code,target_language_code,lifecycle_contract_version,lifecycle_version,started_at,ended_at,purge_at,retention_policy_version,created_at,updated_at/u);
    assert.match(urls[0], /id=eq\.meeting-1&owner_user_id=eq\.owner-1/u);
    assert.match(urls[1], /\/rest\/v1\/meeting_segments\?select=id,meeting_id,session_id,sequence,status,started_at,ended_at,created_at/u);
    assert.match(urls[1], /meeting_id=eq\.meeting-1&owner_user_id=eq\.owner-1/u);
    assert.match(urls[1], /order=sequence.asc,created_at.asc,id.asc/u);
    assert.doesNotMatch(urls.join(' '), /select=\*|settings_snapshot|checkpoint|subtitle_cues|meeting_events/iu);
  } finally {
    setRequestUser(null);
  }
});

test('Supabase metadata scope cannot read another owner or meeting', async () => {
  const calls = [];
  const token = 'b'.repeat(32);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const meetingRows = [
    { id: 'meeting-a', owner_user_id: 'owner-a', status: 'active', lifecycle_contract_version: 2, lifecycle_version: 2, started_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', settings: {} },
    { id: 'meeting-b', owner_user_id: 'owner-b', status: 'active', lifecycle_contract_version: 2, lifecycle_version: 3, started_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', settings: {} }
  ];
  const segmentRows = [
    { id: 'segment-a', meeting_id: 'meeting-a', owner_user_id: 'owner-a', session_id: 'session-a', sequence: 0, status: 'active' },
    { id: 'segment-b', meeting_id: 'meeting-b', owner_user_id: 'owner-b', session_id: 'session-b', sequence: 0, status: 'active' }
  ];
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' };
  const fetchImpl = async (url) => {
      const requestUrl = new URL(url);
      calls.push(requestUrl);
      if (requestUrl.pathname.endsWith('/viewer_shares')) {
        const match = requestUrl.searchParams.get('token_hash') === `eq.${tokenHash}`;
        return { ok: true, status: 200, async json() { return match ? [
          { id: 'share-a', owner_user_id: 'owner-a', meeting_id: 'meeting-a', role: 'viewer', resource_type: 'meeting', created_at: '2026-01-01T00:00:00Z', revoked_at: null }
        ] : []; } };
      }
      const owner = requestUrl.searchParams.get('owner_user_id')?.slice(3);
      assert.ok(owner, 'owner scope required');
      if (requestUrl.pathname.endsWith('/meetings')) {
        const id = requestUrl.searchParams.get('id')?.slice(3);
        return { ok: true, status: 200, async json() { return meetingRows.filter((row) => row.id === id && row.owner_user_id === owner); } };
      }
      if (requestUrl.pathname.endsWith('/meeting_segments')) {
        const meetingId = requestUrl.searchParams.get('meeting_id')?.slice(3);
        return { ok: true, status: 200, async json() { return segmentRows.filter((row) => row.meeting_id === meetingId && row.owner_user_id === owner); } };
      }
      throw new Error(`unexpected content query: ${requestUrl.pathname}`);
    };
  const share = await createSupabaseMeetingShareService({ env, fetchImpl }).resolveShare(token);
  assert.equal(share.meetingId, 'meeting-a');
  const repository = createSupabaseMeetingRepository({ env, fetchImpl });
  const service = createMeetingReadQueryService({ meetingRepository: repository });
  setRequestUser({ id: share._ownerUserId });
  try {
    assert.equal(await service.getMeetingViewerMetadata('meeting-b'), null);
    assert.equal(calls.filter((url) => url.pathname.endsWith('/meeting_segments')).length, 0, 'unauthorized meeting must not trigger segment query');
    const allowed = await service.getMeetingViewerMetadata('meeting-a');
    assert.deepEqual(allowed.segments.map((segment) => segment.id), ['segment-a']);
    assert.equal(allowed.meeting.id, 'meeting-a');
    assert.equal(calls.length, 4);
  } finally {
    setRequestUser(null);
  }
});
