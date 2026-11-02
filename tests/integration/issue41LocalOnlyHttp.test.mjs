import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CONTAINER = 'supabase_storage_lt41-forward-isolated-20261020';
const REST = 'supabase_rest_lt41-forward-isolated-20261020';
const DB = 'supabase_db_lt41-forward-isolated-20261020';
const BASE = 'http://127.0.0.1:57321';

function containerEnv(name, key) {
  const [container] = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }));
  return container.Config.Env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
}

function signedUserJwt(secret, ownerId = randomUUID()) {
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({
    sub: ownerId, role: 'authenticated', aud: 'authenticated', jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 300
  })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function storageSignedUrl(baseUrl, signedPath) {
  assert.equal(typeof signedPath, 'string', 'Storage did not return a signed URL');
  if (/^https?:\/\//.test(signedPath)) return new URL(signedPath);
  if (signedPath.startsWith('/storage/v1/')) return new URL(signedPath, baseUrl);
  assert.ok(signedPath.startsWith('/object/sign/'), 'unexpected Storage signed URL path');
  return new URL(`/storage/v1${signedPath}`, baseUrl);
}

test('isolated Supabase rejects old content writes and historical direct reads', async () => {
  const anonKey = containerEnv(CONTAINER, 'ANON_KEY');
  const serviceKey = containerEnv(CONTAINER, 'SERVICE_KEY');
  const jwks = JSON.parse(containerEnv(REST, 'PGRST_JWT_SECRET') || '{}');
  const jwtSecret = Buffer.from(jwks.keys?.find((key) => key.kty === 'oct')?.k || '', 'base64url');
  assert.ok(anonKey && serviceKey && jwtSecret.length, 'isolated Supabase credentials unavailable');
  const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  for (const table of ['subtitle_cues', 'meeting_events', 'audio_artifacts', 'export_artifacts']) {
    const response = await fetch(`${BASE}/rest/v1/${table}`, {
      method: 'POST', headers: serviceHeaders, body: '{}'
    });
    assert.equal(response.ok, false, `${table} service_role write succeeded`);
    const body = await response.json();
    assert.equal(body.code, 'P0043', `${table} rejected outside content guard`);
  }
  for (const [table, body] of [
    ['meetings', { id: randomUUID(), settings: { transcript: 'secret' } }],
    ['meeting_segments', { id: randomUUID(), settings_snapshot: { transcript: 'secret' } }],
    ['sessions', { id: randomUUID(), payload: { transcript: 'secret' } }]
  ]) {
    const response = await fetch(`${BASE}/rest/v1/${table}`, {
      method: 'POST', headers: serviceHeaders, body: JSON.stringify(body)
    });
    assert.equal(response.ok, false, `${table} free JSON content write succeeded`);
    assert.equal((await response.json()).code, 'P0043', `${table} bypassed metadata guard`);
  }

  const rpc = await fetch(`${BASE}/rest/v1/rpc/publish_meeting_cue_v2`, {
    method: 'POST', headers: serviceHeaders, body: '{}'
  });
  assert.equal(rpc.ok, false, 'legacy service_role Cue RPC succeeded');

  const storage = await fetch(`${BASE}/storage/v1/object/meeting-audio/issue41-cutover-test/recording.webm`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'audio/webm' },
    body: new Uint8Array([1, 2])
  });
  assert.equal(storage.ok, false, 'legacy service_role Storage upload succeeded');

  const userHeaders = { apikey: anonKey, Authorization: `Bearer ${signedUserJwt(jwtSecret)}` };
  for (const path of ['sessions?select=payload', 'meeting_segments?select=checkpoint', 'subtitle_cues?select=source_text']) {
    const response = await fetch(`${BASE}/rest/v1/${path}`, { headers: userHeaders });
    assert.equal(response.ok, false, `${path} exposed historical content`);
  }
  for (const path of ['sessions?select=id,status', 'meeting_segments?select=id,status', 'meetings?select=id,status']) {
    const response = await fetch(`${BASE}/rest/v1/${path}`, { headers: userHeaders });
    assert.equal(response.status, 200, `${path} blocked required metadata read: ${await response.text()}`);
  }
});

test('isolated historical Storage URL remains bounded after cutover', async () => {
  const historicalStorage = 'supabase_storage_lt41-security-isolated-20261019';
  const historicalRest = 'supabase_rest_lt41-security-isolated-20261019';
  const historicalDb = 'supabase_db_lt41-security-isolated-20261019';
  const historicalBase = 'http://127.0.0.1:55321';
  const serviceKey = containerEnv(historicalStorage, 'SERVICE_KEY');
  const anonKey = containerEnv(historicalStorage, 'ANON_KEY');
  const jwks = JSON.parse(containerEnv(historicalRest, 'PGRST_JWT_SECRET') || '{}');
  const jwtSecret = Buffer.from(jwks.keys?.find((key) => key.kty === 'oct')?.k || '', 'base64url');
  assert.ok(serviceKey && anonKey && jwtSecret.length);
  const query = (sql) => execFileSync('docker', [
    'exec', historicalDb, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', sql
  ], { encoding: 'utf8' }).trim();
  assert.equal(query("select count(*) from pg_trigger where tgname = 'lt41_local_only_storage_guard'"), '0',
    'historical fixture must be created before the isolated cutover migration');
  assert.equal(query("select count(*) from pg_trigger where tgname = 'meeting_storage_reject_expired_write' and tgenabled = 'O'"), '1');
  const [ownerId, meetingId] = query(`select owner_user_id, id from public.meetings
    where public.meeting_recording_accessible(owner_user_id, id) order by created_at limit 1`).split('|');
  assert.ok(ownerId && meetingId, 'active isolated owner/Meeting fixture unavailable');
  const objectPath = `${ownerId}/${meetingId}/issue41-historical-${randomUUID()}.txt`;
  const objectUrl = `${historicalBase}/storage/v1/object/meeting-exports/${objectPath}`;
  const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const userHeaders = { apikey: anonKey, Authorization: `Bearer ${signedUserJwt(jwtSecret, ownerId)}` };
  const secondContextHeaders = { apikey: anonKey, Authorization: `Bearer ${signedUserJwt(jwtSecret, ownerId)}` };
  assert.notEqual(userHeaders.Authorization, secondContextHeaders.Authorization);
  const signUrl = `${historicalBase}/storage/v1/object/sign/meeting-exports/${objectPath}`;
  let oldSignedUrl;
  let shortSignedUrl;
  let fixtureCreated = false;
  let fixtureRemoved = false;
  try {
    const upload = await fetch(objectUrl, {
      method: 'POST', headers: { ...serviceHeaders, 'Content-Type': 'text/plain' }, body: 'historical fixture'
    });
    assert.equal(upload.status, 200, `isolated historical fixture upload: ${await upload.text()}`);
    fixtureCreated = true;
    const signed = await fetch(signUrl, {
      method: 'POST', headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 600 })
    });
    if (signed.status !== 200) assert.fail(`pre-cutover sign: ${await signed.text()}`);
    oldSignedUrl = (await signed.json()).signedURL;
    const shortSigned = await fetch(signUrl, {
      method: 'POST', headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 1 })
    });
    if (shortSigned.status !== 200) assert.fail(`pre-cutover short sign: ${await shortSigned.text()}`);
    shortSignedUrl = (await shortSigned.json()).signedURL;
    const baselineUrl = storageSignedUrl(historicalBase, oldSignedUrl);
    const baseline = await fetch(baselineUrl);
    const baselineBody = await baseline.text();
    assert.equal(baseline.status, 200,
      `pre-cutover GET ${baselineUrl.origin}${baselineUrl.pathname}: HTTP ${baseline.status} ${baselineBody}`);
    assert.equal(baselineBody, 'historical fixture', 'pre-cutover signed URL returned different content');
    const migration = readFileSync(new URL('../../supabase/migrations/20261102000000_issue41_local_only_cutover.sql', import.meta.url));
    execFileSync('docker', ['exec', '-i', historicalDb, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-1'], { input: migration, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(query("select count(*) from pg_trigger where tgname = 'lt41_local_only_storage_guard' and tgenabled = 'O'"), '1');
    const [userDownload, secondContextDownload, serviceDownload, userSign, secondContextSign,
      serviceSign, oldDownload, userUpload, secondContextUpload, serviceUpload] = await Promise.all([
      fetch(objectUrl.replace('/object/', '/object/authenticated/'), { headers: userHeaders }),
      fetch(objectUrl.replace('/object/', '/object/authenticated/'), { headers: secondContextHeaders }),
      fetch(objectUrl.replace('/object/', '/object/authenticated/'), { headers: serviceHeaders }),
      fetch(signUrl, { method: 'POST', headers: { ...userHeaders, 'Content-Type': 'application/json' }, body: '{"expiresIn":120}' }),
      fetch(signUrl, { method: 'POST', headers: { ...secondContextHeaders, 'Content-Type': 'application/json' }, body: '{"expiresIn":120}' }),
      fetch(signUrl, { method: 'POST', headers: { ...serviceHeaders, 'Content-Type': 'application/json' }, body: '{"expiresIn":120}' }),
      fetch(baselineUrl),
      fetch(`${historicalBase}/storage/v1/object/meeting-audio/${ownerId}/${meetingId}/new-user.webm`, {
        method: 'POST', headers: { ...userHeaders, 'Content-Type': 'audio/webm' }, body: new Uint8Array([1])
      }),
      fetch(`${historicalBase}/storage/v1/object/meeting-exports/${ownerId}/${meetingId}/new-second-context.txt`, {
        method: 'POST', headers: { ...secondContextHeaders, 'Content-Type': 'text/plain' }, body: 'new content'
      }),
      fetch(`${historicalBase}/storage/v1/object/meeting-exports/${ownerId}/${meetingId}/new-service.txt`, {
        method: 'POST', headers: { ...serviceHeaders, 'Content-Type': 'text/plain' }, body: 'new content'
      })
    ]);
    console.log('post-cutover isolated Storage HTTP statuses', JSON.stringify({
      userDownload: userDownload.status, secondContextDownload: secondContextDownload.status,
      serviceDownload: serviceDownload.status, userSign: userSign.status,
      secondContextSign: secondContextSign.status, serviceSign: serviceSign.status,
      oldDownload: oldDownload.status, userUpload: userUpload.status,
      secondContextUpload: secondContextUpload.status, serviceUpload: serviceUpload.status
    }));
    assert.notEqual(userDownload.status, 200, 'same-owner authenticated historical download succeeded');
    assert.notEqual(secondContextDownload.status, 200, 'second context historical download succeeded');
    assert.notEqual(userSign.status, 200, 'same-owner authenticated historical URL signing succeeded');
    assert.notEqual(secondContextSign.status, 200, 'second context historical URL signing succeeded');
    assert.equal(oldDownload.status, 200, 'previously issued URL stopped working before expiry');
    assert.notEqual(userUpload.status, 200, 'legacy authenticated upload succeeded');
    assert.notEqual(secondContextUpload.status, 200, 'second context legacy upload succeeded');
    assert.notEqual(serviceUpload.status, 200, 'service_role new upload succeeded');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const expiredDownload = await fetch(storageSignedUrl(historicalBase, shortSignedUrl));
    assert.notEqual(expiredDownload.status, 200, 'expired signed URL remained usable');
    const deleted = await fetch(objectUrl, { method: 'DELETE', headers: serviceHeaders });
    assert.ok(deleted.ok, `isolated fixture deletion: ${await deleted.text()}`);
    fixtureRemoved = true;
    const revokedDownload = await fetch(baselineUrl);
    assert.notEqual(revokedDownload.status, 200, 'signed URL remained usable after fixture deletion');
    console.log('isolated Storage access statuses', JSON.stringify({
      userDownload: userDownload.status, serviceDownload: serviceDownload.status,
      secondContextDownload: secondContextDownload.status, userSign: userSign.status,
      secondContextSign: secondContextSign.status, serviceSign: serviceSign.status,
      oldDownload: oldDownload.status, expiredDownload: expiredDownload.status,
      revokedDownload: revokedDownload.status, userUpload: userUpload.status,
      secondContextUpload: secondContextUpload.status,
      serviceUpload: serviceUpload.status
    }));
  } finally {
    if (fixtureCreated && !fixtureRemoved) {
      // Only the object created by this test is removed; no trigger or policy is disabled.
      await fetch(objectUrl, { method: 'DELETE', headers: serviceHeaders });
    }
  }
});
