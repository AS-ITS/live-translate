import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationTest = process.env.RUN_SUPABASE_LIFECYCLE_TESTS === 'true' ? test : test.skip;

integrationTest('legacy resume persists one successor for concurrent replay', async (t) => {
  const client = localSupabaseClient();
  const fixture = await createLegacyFixture(client, t, 'concurrent');
  const operationId = randomUUID();
  const checkpoint = await persistLegacyCheckpoint(client, fixture, operationId);
  const body = resumeBody(fixture, operationId, checkpoint);

  const [first, second] = await Promise.all([
    rpc(client, 'resume_legacy_meeting_segment', body),
    rpc(client, 'resume_legacy_meeting_segment', body)
  ]);

  assert.ok(first.response.ok, first.text);
  assert.ok(second.response.ok, second.text);
  assert.equal(first.body.segment.id, second.body.segment.id);
  assert.equal([first.body.replayed, second.body.replayed].filter(Boolean).length, 1);

  const successors = await rest(
    client,
    `meeting_segments?meeting_id=eq.${fixture.meetingId}&sequence=eq.2&select=id,session_id,status`
  );
  const operations = await rest(
    client,
    `meeting_lifecycle_operations?meeting_id=eq.${fixture.meetingId}&operation_id=eq.${operationId}&select=operation_id,result`
  );

  assert.equal(successors.length, 1);
  assert.equal(successors[0].session_id, fixture.sessionId);
  assert.equal(operations.length, 1);
});

integrationTest('legacy resume reconciles the committed successor after a lost acknowledgement', async (t) => {
  const client = localSupabaseClient();
  const fixture = await createLegacyFixture(client, t, 'lost-ack');
  const operationId = randomUUID();
  const checkpoint = await persistLegacyCheckpoint(client, fixture, operationId);
  const body = resumeBody(fixture, operationId, checkpoint);

  const committed = await rpc(client, 'resume_legacy_meeting_segment', body);
  assert.ok(committed.response.ok, committed.text);

  const reconciled = await rpc(client, 'get_legacy_resume_operation', {
    p_owner_user_id: fixture.userId,
    p_meeting_id: fixture.meetingId,
    p_operation_id: operationId
  });

  assert.ok(reconciled.response.ok, reconciled.text);
  assert.equal(reconciled.body.replayed, true);
  assert.equal(reconciled.body.segment.id, committed.body.segment.id);

  const replay = await rpc(client, 'resume_legacy_meeting_segment', body);
  assert.ok(replay.response.ok, replay.text);
  assert.equal(replay.body.segment.id, committed.body.segment.id);
});

integrationTest('unflushed legacy resume rejects checkpoint content without a partial commit', async (t) => {
  const client = localSupabaseClient();
  const fixture = await createLegacyFixture(client, t, 'unflushed');
  const operationId = randomUUID();
  const result = await rpc(client, 'resume_legacy_meeting_segment', resumeBody(fixture, operationId));

  assert.equal(result.body.code, 'P0042');
  assert.equal(result.body.message, 'checkpoint_conflict');
  const source = await rest(client, `meeting_segments?id=eq.${fixture.sourceSegmentId}&select=status,session_id,checkpoint`);
  const successors = await rest(client, `meeting_segments?meeting_id=eq.${fixture.meetingId}&sequence=eq.2&select=id`);
  const operations = await rest(client, `meeting_lifecycle_operations?meeting_id=eq.${fixture.meetingId}&operation_id=eq.${operationId}&select=operation_id`);
  assert.equal(source[0].status, 'active');
  assert.equal(source[0].session_id, null);
  assert.deepEqual(source[0].checkpoint, {});
  assert.equal(successors.length, 0);
  assert.equal(operations.length, 0);
});

function localSupabaseClient() {
  const baseUrl = String(process.env.API_URL || process.env.SUPABASE_URL || '').replace(/\/$/u, '');
  const serviceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  assert.ok(baseUrl && serviceKey, 'local Supabase URL and service role key are required');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'test must use local Supabase');
  return {
    baseUrl,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  };
}

async function createLegacyFixture(client, t, label) {
  const userId = randomUUID();
  const meetingId = randomUUID();
  const sessionId = randomUUID();
  const sourceSegmentId = randomUUID();

  t.after(async () => {
    await fetch(`${client.baseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: client.headers
    });
  });

  await expectOk(fetch(`${client.baseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: client.headers,
    body: JSON.stringify({
      id: userId,
      email: `legacy-resume-${label}-${userId}@example.test`,
      password: `Legacy-${randomUUID()}-Aa1!`,
      email_confirm: true
    })
  }));
  await insert(client, 'meetings', {
    id: meetingId,
    owner_user_id: userId,
    name: `Legacy resume ${label}`,
    source_language_code: 'zh-Hant',
    target_language_code: 'en',
    status: 'active',
    lifecycle_contract_version: 1,
    settings: {}
  });
  await insert(client, 'sessions', {
    id: sessionId,
    owner_user_id: userId,
    meeting_id: meetingId,
    status: 'created',
    target_language_code: 'en',
    payload: {},
    transcript_items: [],
    lifecycle_contract_version: 1
  });
  await insert(client, 'meeting_segments', {
    id: sourceSegmentId,
    owner_user_id: userId,
    meeting_id: meetingId,
    session_id: null,
    sequence: 1,
    status: 'active',
    lifecycle_contract_version: 1,
    live_session_id: `${label}-live-1`,
    settings_snapshot: {}
  });
  await expectOk(fetch(`${client.baseUrl}/rest/v1/sessions?id=eq.${sessionId}`, {
    method: 'PATCH',
    headers: client.headers,
    body: JSON.stringify({ segment_id: sourceSegmentId })
  }));

  return { userId, meetingId, sessionId, sourceSegmentId, label };
}

async function persistLegacyCheckpoint(client, fixture, operationId) {
  const operationKey = `checkpoint:${fixture.sourceSegmentId}:legacy-resume:${operationId}`;
  const canonicalPayload = JSON.stringify({ meetingId: fixture.meetingId, segmentId: fixture.sourceSegmentId, finalCues: [] });
  const nextCheckpoint = {
    meetingId: fixture.meetingId,
    segmentId: fixture.sourceSegmentId,
    lastFinalCueSequence: 0,
    finalCues: [],
    revision: 1,
    _operationPayloads: { [operationKey]: canonicalPayload }
  };
  const result = await rpc(client, 'apply_meeting_checkpoint_operation_v2', {
    p_meeting_id: fixture.meetingId,
    p_segment_id: fixture.sourceSegmentId,
    p_expected_revision: 0,
    p_operation_key: operationKey,
    p_canonical_payload: canonicalPayload,
    p_next_checkpoint: nextCheckpoint,
    p_cues: [],
    p_next_status: 'active',
    p_ended_at: null,
    p_error_info: null
  });
  assert.ok(result.response.ok, result.text);
  const source = await rest(client, `meeting_segments?id=eq.${fixture.sourceSegmentId}&select=checkpoint`);
  assert.deepEqual(source[0].checkpoint, result.body);
  return result.body;
}

function resumeBody(fixture, operationId, checkpoint = {
  meetingId: fixture.meetingId,
  segmentId: fixture.sourceSegmentId,
  lastFinalCueSequence: 0,
  finalCues: []
}) {
  return {
    p_owner_user_id: fixture.userId,
    p_meeting_id: fixture.meetingId,
    p_source_segment_id: fixture.sourceSegmentId,
    p_operation_id: operationId,
    p_payload_hash: `payload-${operationId}`,
    p_next_live_session_id: `${fixture.label}-live-2`,
    p_expected_session_id: fixture.sessionId,
    p_checkpoint: checkpoint,
    p_global_glossary_entries: []
  };
}

async function insert(client, table, body) {
  await expectOk(fetch(`${client.baseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: client.headers,
    body: JSON.stringify(body)
  }));
}

async function rpc(client, name, body) {
  const response = await fetch(`${client.baseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: client.headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

async function rest(client, path) {
  const response = await fetch(`${client.baseUrl}/rest/v1/${path}`, { headers: client.headers });
  const text = await response.text();
  assert.ok(response.ok, text);
  return text ? JSON.parse(text) : [];
}

async function expectOk(responsePromise) {
  const response = await responsePromise;
  const text = await response.text();
  assert.ok(response.ok, text);
}
