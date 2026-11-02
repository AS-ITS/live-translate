import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const project = process.env.ISSUE41_ISOLATED_PROJECT;
assert.match(project || '', /^issue41-[a-z0-9-]+$/u, 'isolated Issue #41 project required');
const db = `supabase_db_${project}`;
const rest = `supabase_rest_${project}`;
const storage = `supabase_storage_${project}`;
const base = process.env.ISSUE41_ISOLATED_URL;
assert.match(base || '', /^http:\/\/127\.0\.0\.1:\d+$/u, 'isolated loopback URL required');

function sql(query) {
  return execFileSync('docker', ['exec', db, 'psql', '-U', 'postgres', '-At', '-c', query], { encoding: 'utf8' }).trim();
}
function containerEnv(name, key) {
  const [container] = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }));
  return container.Config.Env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
}
function jwt(secret, ownerId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: ownerId, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300
  })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

test('authenticated Session POST and atomic PATCH preserve permitted metadata', async () => {
  const [ownerId, meetingId, segmentId] = sql(`select m.owner_user_id, m.id, s.id
    from public.meetings m join public.meeting_segments s on s.meeting_id=m.id
    where s.status='active' and public.meeting_recording_accessible(m.owner_user_id,m.id)
    order by m.created_at desc limit 1`).split('|');
  assert.ok(ownerId && meetingId && segmentId, 'isolated active Meeting fixture unavailable');
  const anonKey = containerEnv(storage, 'ANON_KEY');
  const jwks = JSON.parse(containerEnv(rest, 'PGRST_JWT_SECRET') || '{}');
  const secret = Buffer.from(jwks.keys?.find((key) => key.kty === 'oct')?.k || '', 'base64url');
  assert.ok(anonKey && secret.length, 'isolated credentials unavailable');
  const headers = {
    apikey: anonKey, Authorization: `Bearer ${jwt(secret, ownerId)}`,
    'Content-Type': 'application/json', Prefer: 'return=representation'
  };
  const sessionId = randomUUID();
  const columns = 'id,owner_user_id,meeting_id,segment_id,current_segment_id,recording_id,status,source_language_code,target_language_code,started_at,ended_at,created_at,lifecycle_contract_version';
  const rpc = async (patch, overrides = {}, requestHeaders = headers) => {
    const response = await fetch(`${base}/rest/v1/rpc/patch_session_metadata`, {
      method: 'POST', headers: requestHeaders,
      body: JSON.stringify({ p_owner_user_id: ownerId, p_meeting_id: meetingId, p_session_id: sessionId,
        p_patch: patch, ...overrides })
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await fetch(`${base}/rest/v1/sessions?select=${columns}`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: sessionId, owner_user_id: ownerId, meeting_id: meetingId,
        segment_id: segmentId, status: 'created', target_language_code: 'en',
        payload: { name: 'original', targetLanguageLabel: 'English', shouldRecordInputAudio: true,
          echoTargetLanguage: false }, transcript_items: [] })
    });
    if (created.status !== 201) assert.fail(`Session POST ${created.status}: ${await created.text()}`);
    const createdRows = await created.json();
    assert.deepEqual(Object.keys(createdRows[0]).sort(), columns.split(',').sort());

    const [name, status] = await Promise.all([rpc({ name: 'updated' }), rpc({ status: 'active' })]);
    assert.equal(name.status, 200, JSON.stringify(name.body));
    assert.equal(status.status, 200, JSON.stringify(status.body));
    for (const result of [name.body, status.body]) {
      assert.equal(result.payload, undefined);
      assert.equal(result.transcript_items, undefined);
    }
    const cleared = await rpc({ targetLanguageLabel: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    const stored = JSON.parse(sql(`select payload::text from public.sessions where id='${sessionId}'`));
    assert.equal(stored.name, 'updated');
    assert.equal(stored.status, 'active');
    assert.equal(stored.shouldRecordInputAudio, true);
    assert.equal(stored.echoTargetLanguage, false);
    assert.equal(Object.hasOwn(stored, 'targetLanguageLabel'), false);

    const denied = await fetch(`${base}/rest/v1/sessions?select=payload,transcript_items&id=eq.${sessionId}`, { headers });
    assert.equal(denied.status, 403, 'content columns were readable');
    const beforeRejected = sql(`select payload::text, status, segment_id from public.sessions where id='${sessionId}'`);
    const contentCounts = () => sql(`select
      (select count(*) from public.subtitle_cues),
      (select count(*) from public.meeting_events),
      (select count(*) from public.audio_artifacts),
      (select count(*) from public.export_artifacts),
      (select count(*) from public.translation_outputs),
      (select count(*) from public.meeting_segments where checkpoint <> '{}'::jsonb)`);
    const beforeContent = contentCounts();
    const otherOwnerId = randomUUID();
    const rejected = {
      checkpoint: await rpc({ checkpoint: { text: 'secret' } }),
      unknown: await rpc({ unknown: 'value' }),
      meeting: await rpc({ name: 'cross meeting' }, { p_meeting_id: randomUUID() }),
      owner: await rpc({ name: 'cross owner' }, { p_owner_user_id: otherOwnerId },
        { ...headers, Authorization: `Bearer ${jwt(secret, otherOwnerId)}` }),
      session: await rpc({ name: 'cross session' }, { p_session_id: randomUUID() })
    };
    const afterRejected = sql(`select payload::text, status, segment_id from public.sessions where id='${sessionId}'`);
    assert.deepEqual(afterRejected, beforeRejected, 'rejected PATCH changed Session metadata');
    assert.equal(contentCounts(), beforeContent, 'rejected PATCH wrote Meeting content');
    for (const key of ['checkpoint', 'unknown']) {
      assert.equal(rejected[key].status, 500, `${key}: ${JSON.stringify(rejected[key].body)}`);
      assert.equal(rejected[key].body.code, 'P0043', key);
      assert.equal(rejected[key].body.message, 'meeting_content_local_only', key);
    }
    for (const key of ['meeting', 'owner', 'session']) {
      assert.equal(rejected[key].status, 403, `${key}: ${JSON.stringify(rejected[key].body)}`);
      assert.equal(rejected[key].body.code, '42501', key);
    }
  } finally {
    sql(`delete from public.sessions where id='${sessionId}'`);
  }
});
