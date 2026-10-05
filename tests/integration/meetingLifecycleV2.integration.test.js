import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const lifecycleTest = process.env.RUN_SUPABASE_LIFECYCLE_TESTS === 'true' ? test : test.skip;

lifecycleTest('Meeting lifecycle v2 serializes concurrent start and transition commands', async (t) => {
  const baseUrl = String(process.env.API_URL || process.env.SUPABASE_URL || '').replace(/\/$/u, '');
  const serviceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  assert.ok(baseUrl && serviceKey, 'local Supabase URL and service role key are required');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'test must use local Supabase');

  const userId = randomUUID();
  const meetingId = randomUUID();
  const operationId = randomUUID();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  t.after(async () => {
    await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers });
  });

  const userResponse = await fetch(`${baseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: userId, email: `issue37-${userId}@example.com`, password: `Issue37-${randomUUID()}-Aa1!`, email_confirm: true })
  });
  assert.ok(userResponse.ok, await userResponse.text());

  const meetingResponse = await fetch(`${baseUrl}/rest/v1/meetings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: meetingId,
      owner_user_id: userId,
      name: 'Issue 37 concurrency',
      source_language_code: 'zh-Hant',
      target_language_code: 'en',
      status: 'created',
      lifecycle_contract_version: 2,
      lifecycle_version: 0
    })
  });
  assert.ok(meetingResponse.ok, await meetingResponse.text());

  const startBody = {
    p_owner_user_id: userId,
    p_meeting_id: meetingId,
    p_command: 'start',
    p_operation_id: operationId,
    p_expected_lifecycle_version: 0,
    p_principal_type: 'user',
    p_principal_id: userId,
    p_payload: {}
  };
  const [firstStart, secondStart] = await Promise.all([
    rpc(baseUrl, headers, startBody),
    rpc(baseUrl, headers, startBody)
  ]);
  assert.ok(firstStart.response.ok, firstStart.text);
  assert.ok(secondStart.response.ok, secondStart.text);
  assert.equal(new Set([firstStart.body.session.id, secondStart.body.session.id]).size, 1);
  assert.equal([firstStart.body.replayed, secondStart.body.replayed].filter(Boolean).length, 1);

  const sessions = await rest(baseUrl, headers, `sessions?meeting_id=eq.${meetingId}&status=in.(created,active,paused)`);
  const segments = await rest(baseUrl, headers, `meeting_segments?meeting_id=eq.${meetingId}&status=eq.active`);
  assert.equal(sessions.length, 1);
  assert.equal(segments.length, 1);

  const lease = firstStart.body.lease;
  const initialFence = {
    p_meeting_id: meetingId,
    p_session_id: firstStart.body.session.id,
    p_segment_id: firstStart.body.segment.id,
    p_lease_id: lease.leaseId,
    p_fence_token: lease.fenceToken
  };
  const validFence = await validateFence(baseUrl, headers, initialFence);
  assert.ok(validFence.response.ok, validFence.text);
  const competing = (command) => rpc(baseUrl, headers, {
    ...startBody,
    p_command: command,
    p_operation_id: randomUUID(),
    p_expected_lifecycle_version: 1,
    p_lease_id: lease.leaseId,
    p_fence_token: lease.fenceToken
  });
  const transitions = await Promise.all([competing('rollover'), competing('stop')]);
  assert.equal(transitions.filter(({ response }) => response.ok).length, 1);
  assert.equal(transitions.filter(({ response }) => response.status === 400).length, 1);

  const activeAfterCompetition = await rest(baseUrl, headers, `meeting_segments?meeting_id=eq.${meetingId}&status=eq.active`);
  assert.ok(activeAfterCompetition.length <= 1);
  const staleFence = await validateFence(baseUrl, headers, initialFence);
  assert.equal(staleFence.response.status, 400);
  assert.match(staleFence.text, /recorder_lease_invalid/u);
});

lifecycleTest('Meeting lifecycle v2 expires stale recorders and rejects a terminal restart', async (t) => {
  const baseUrl = String(process.env.API_URL || process.env.SUPABASE_URL || '').replace(/\/$/u, '');
  const serviceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  assert.ok(baseUrl && serviceKey, 'local Supabase URL and service role key are required');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'test must use local Supabase');

  const userId = randomUUID();
  const meetingId = randomUUID();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  t.after(async () => {
    await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers });
  });

  const userResponse = await fetch(`${baseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: userId,
      email: `issue37-stale-${userId}@example.com`,
      password: `Issue37-${randomUUID()}-Aa1!`,
      email_confirm: true
    })
  });
  assert.ok(userResponse.ok, await userResponse.text());

  const meetingResponse = await fetch(`${baseUrl}/rest/v1/meetings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: meetingId,
      owner_user_id: userId,
      name: 'Issue 37 stale recorder',
      source_language_code: 'zh-Hant',
      target_language_code: 'en',
      status: 'created',
      lifecycle_contract_version: 2,
      lifecycle_version: 0
    })
  });
  assert.ok(meetingResponse.ok, await meetingResponse.text());

  const start = await rpc(baseUrl, headers, {
    p_owner_user_id: userId,
    p_meeting_id: meetingId,
    p_command: 'start',
    p_operation_id: randomUUID(),
    p_expected_lifecycle_version: 0,
    p_principal_type: 'user',
    p_principal_id: userId,
    p_payload: {}
  });
  assert.ok(start.response.ok, start.text);

  const artifactId = randomUUID();
  const artifactResponse = await fetch(`${baseUrl}/rest/v1/audio_artifacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: artifactId,
      owner_user_id: userId,
      meeting_id: meetingId,
      session_id: start.body.session.id,
      segment_id: start.body.segment.id,
      storage_path: `${userId}/${meetingId}/${start.body.segment.id}/recording.webm`,
      kind: 'source_webm',
      file_name: 'recording.webm',
      mime_type: 'audio/webm',
      status: 'uploading'
    })
  });
  assert.ok(artifactResponse.ok, await artifactResponse.text());

  const staleResponse = await fetch(`${baseUrl}/rest/v1/meetings?id=eq.${meetingId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ last_heartbeat_at: new Date(Date.now() - (16 * 60 * 1000)).toISOString() })
  });
  assert.ok(staleResponse.ok, await staleResponse.text());

  const expireResponse = await fetch(`${baseUrl}/rest/v1/rpc/expire_stale_meetings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_limit: 10 })
  });
  const expireText = await expireResponse.text();
  assert.ok(expireResponse.ok, expireText);
  const expired = JSON.parse(expireText);
  assert.equal(expired.expiredCount, 1);
  assert.deepEqual(expired.meetingIds, [meetingId]);

  const [meeting] = await rest(baseUrl, headers, `meetings?id=eq.${meetingId}`);
  assert.equal(meeting.status, 'completed');
  assert.equal(meeting.purge_status, 'pending');
  assert.ok(meeting.ended_at);
  assert.ok(meeting.purge_at);

  const pastPurgeResponse = await fetch(`${baseUrl}/rest/v1/meetings?id=eq.${meetingId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ purge_at: new Date(Date.now() - 1000).toISOString() })
  });
  assert.ok(pastPurgeResponse.ok, await pastPurgeResponse.text());

  const expiredArtifactWrite = await fetch(`${baseUrl}/rest/v1/audio_artifacts?id=eq.${artifactId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'ready' })
  });
  const expiredArtifactWriteText = await expiredArtifactWrite.text();
  assert.equal(expiredArtifactWrite.status, 400);
  assert.match(expiredArtifactWriteText, /meeting_purge_deadline_expired/u);

  const [session] = await rest(baseUrl, headers, `sessions?meeting_id=eq.${meetingId}`);
  assert.equal(session.status, 'stopped');
  assert.equal(session.current_segment_id, null);
  const [segment] = await rest(baseUrl, headers, `meeting_segments?meeting_id=eq.${meetingId}`);
  assert.equal(segment.status, 'interrupted');

  const restart = await rpc(baseUrl, headers, {
    p_owner_user_id: userId,
    p_meeting_id: meetingId,
    p_command: 'start',
    p_operation_id: randomUUID(),
    p_expected_lifecycle_version: meeting.lifecycle_version,
    p_principal_type: 'user',
    p_principal_id: userId,
    p_payload: {}
  });
  assert.equal(restart.response.status, 400);
  assert.match(restart.text, /meeting_terminal/u);
});

async function rpc(baseUrl, headers, body) {
  const response = await fetch(`${baseUrl}/rest/v1/rpc/execute_meeting_lifecycle_command`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

async function rest(baseUrl, headers, path) {
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, { headers });
  const text = await response.text();
  assert.ok(response.ok, text);
  return text ? JSON.parse(text) : [];
}

async function validateFence(baseUrl, headers, body) {
  const response = await fetch(`${baseUrl}/rest/v1/rpc/validate_meeting_recorder_write`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  return { response, text: await response.text() };
}
