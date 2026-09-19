import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const shouldRun = process.env.RUN_SUPABASE_RLS_TESTS === 'true';
const rlsTest = shouldRun ? test : test.skip;

function configuration() {
  const baseUrl = String(process.env.SUPABASE_TEST_URL || process.env.SUPABASE_URL || '').replace(/\/$/u, '');
  const publishableKey = String(
    process.env.SUPABASE_TEST_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      ''
  );
  const serviceRoleKey = String(
    process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
  );

  if (!baseUrl || !publishableKey || !serviceRoleKey) {
    throw new Error(
      'RUN_SUPABASE_RLS_TESTS=true requires SUPABASE_TEST_URL, SUPABASE_TEST_PUBLISHABLE_KEY, and SUPABASE_TEST_SERVICE_ROLE_KEY.'
    );
  }

  const parsed = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) && process.env.ALLOW_REMOTE_RLS_TESTS !== 'true') {
    throw new Error('Supabase RLS integration tests only allow local URLs unless ALLOW_REMOTE_RLS_TESTS=true.');
  }

  return { baseUrl, publishableKey, serviceRoleKey };
}

function assertHttpSuccess(response, label) {
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${label} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`
  );
}

function assertHttpDenied(response, label) {
  assert.ok(response.status >= 400 && response.status < 500, `${label} unexpectedly returned HTTP ${response.status}`);
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createHarness(config) {
  async function request(path, { method = 'GET', token = null, key = config.publishableKey, body } = {}) {
    const headers = {
      apikey: key,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json', prefer: 'return=representation' })
    };
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, status: response.status, body: await readResponse(response) };
  }

  async function rest(table, options = {}) {
    return request(`/rest/v1/${table}${options.query || ''}`, options);
  }

  async function createUser(label) {
    const email = `issue35-rls-${label}-${randomUUID()}@example.com`;
    const password = `Issue35-${randomUUID()}-Aa1!`;
    const created = await request('/auth/v1/admin/users', {
      method: 'POST',
      token: config.serviceRoleKey,
      key: config.serviceRoleKey,
      body: { email, password, email_confirm: true, user_metadata: { full_name: label } }
    });
    assertHttpSuccess(created, `create ${label} user`);

    const signedIn = await request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      key: config.publishableKey,
      body: { email, password }
    });
    assertHttpSuccess(signedIn, `sign in ${label} user`);
    assert.ok(created.body?.id, `create ${label} user did not return an id`);
    assert.ok(signedIn.body?.access_token, `sign in ${label} user did not return an access token`);
    return { id: created.body.id, email, accessToken: signedIn.body.access_token };
  }

  async function updateProfile(userId, patch) {
    const result = await rest('profiles', {
      method: 'PATCH',
      token: config.serviceRoleKey,
      key: config.serviceRoleKey,
      query: `?id=eq.${encodeURIComponent(userId)}`,
      body: patch
    });
    assertHttpSuccess(result, `update profile ${userId}`);
  }

  async function deleteUser(userId) {
    const result = await request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      token: config.serviceRoleKey,
      key: config.serviceRoleKey
    });
    assert.ok(
      [200, 204, 404].includes(result.status),
      `delete test user returned HTTP ${result.status}: ${JSON.stringify(result.body)}`
    );
  }

  return Object.freeze({ request, rest, createUser, updateProfile, deleteUser });
}

rlsTest('Issue #35 local Supabase RLS allow/deny matrix', async (t) => {
  const config = configuration();
  const harness = createHarness(config);
  const users = [];
  let owner = null;
  const ids = {
    meeting: randomUUID(),
    segment: randomUUID(),
    session: randomUUID(),
    cue: randomUUID(),
    glossaryCategory: randomUUID(),
    glossaryEntry: randomUUID(),
    summary: randomUUID(),
    audio: randomUUID(),
    exportArtifact: randomUUID(),
    deniedSegment: randomUUID(),
    allowedSegment: randomUUID()
  };

  t.after(async () => {
    const cleanup = [
      ['meeting_glossary_entries', `?owner_user_id=eq.${owner?.id || ''}`],
      ['glossary_entries', `?owner_user_id=eq.${owner?.id || ''}`],
      ['glossary_categories', `?owner_user_id=eq.${owner?.id || ''}`],
      ['meeting_summaries', `?owner_user_id=eq.${owner?.id || ''}`],
      ['audio_artifacts', `?owner_user_id=eq.${owner?.id || ''}`],
      ['export_artifacts', `?owner_user_id=eq.${owner?.id || ''}`],
      ['subtitle_cues', `?owner_user_id=eq.${owner?.id || ''}`],
      ['sessions', `?owner_user_id=eq.${owner?.id || ''}`],
      ['meeting_segments', `?owner_user_id=eq.${owner?.id || ''}`],
      ['meeting_members', `?owner_user_id=eq.${owner?.id || ''}`],
      ['meetings', `?owner_user_id=eq.${owner?.id || ''}`]
    ];
    if (owner) {
      for (const [table, query] of cleanup) {
        const result = await harness.rest(table, {
          method: 'DELETE',
          token: config.serviceRoleKey,
          key: config.serviceRoleKey,
          query
        });
        assert.ok([200, 204].includes(result.status), `cleanup ${table} returned HTTP ${result.status}`);
      }
    }
    await Promise.all(users.map((user) => harness.deleteUser(user.id)));
  });

  const provision = async (label) => {
    const user = await harness.createUser(label);
    users.push(user);
    return user;
  };
  owner = await provision('owner');
  const activeMember = await provision('active-member');
  const pendingMember = await provision('pending-member');
  const disabledMember = await provision('disabled-member');
  const nonMember = await provision('non-member');
  const superAdmin = await provision('super-admin');

  await harness.updateProfile(activeMember.id, { status: 'active' });
  await harness.updateProfile(superAdmin.id, { role: 'super_admin', status: 'active' });
  await harness.updateProfile(pendingMember.id, { status: 'pending' });
  await harness.updateProfile(disabledMember.id, { status: 'disabled' });

  const meeting = {
    id: ids.meeting,
    owner_user_id: owner.id,
    name: 'Issue 35 RLS meeting',
    source_language_code: 'zh-Hant',
    target_language_code: 'en',
    status: 'created'
  };
  const segment = {
    id: ids.segment,
    owner_user_id: owner.id,
    meeting_id: ids.meeting,
    sequence: 0,
    status: 'created'
  };
  const session = {
    id: ids.session,
    owner_user_id: owner.id,
    meeting_id: ids.meeting,
    segment_id: ids.segment,
    status: 'created',
    target_language_code: 'en'
  };
  const cue = {
    id: ids.cue,
    owner_user_id: owner.id,
    session_id: ids.session,
    segment_id: ids.segment,
    sequence: 1,
    source_text: 'RLS test source',
    translated_text: 'RLS test translation',
    source_version: 1,
    translation_version: 1
  };
  const glossaryCategory = {
    id: ids.glossaryCategory,
    owner_user_id: owner.id,
    label: 'Issue 35 RLS',
    sort_order: 0
  };
  const glossaryEntry = {
    id: ids.glossaryEntry,
    owner_user_id: owner.id,
    category_id: ids.glossaryCategory,
    source: 'RLS',
    translation: 'RLS',
    source_language_code: 'zh-Hant',
    target_language_code: 'en',
    scope: 'both',
    tags: [],
    enabled: true,
    notes: ''
  };
  const summary = {
    id: ids.summary,
    owner_user_id: owner.id,
    meeting_id: ids.meeting,
    version: 1,
    content: 'RLS test summary'
  };
  const audioArtifact = {
    id: ids.audio,
    owner_user_id: owner.id,
    session_id: ids.session,
    meeting_id: ids.meeting,
    segment_id: ids.segment,
    storage_path: `${owner.id}/${ids.meeting}/${ids.segment}/recording.webm`,
    kind: 'source_webm',
    status: 'ready',
    byte_size: 1,
    mime_type: 'audio/webm',
    file_name: 'recording.webm'
  };
  const exportArtifact = {
    id: ids.exportArtifact,
    owner_user_id: owner.id,
    meeting_id: ids.meeting,
    storage_path: `${owner.id}/${ids.meeting}/export.txt`,
    format: 'txt',
    stream: 'translation',
    source_hash: 'issue35-rls',
    status: 'queued',
    file_name: 'export.txt',
    mime_type: 'text/plain'
  };

  for (const [table, row] of [
    ['meetings', meeting],
    ['meeting_segments', segment],
    ['sessions', session],
    ['subtitle_cues', cue],
    ['glossary_categories', glossaryCategory],
    ['glossary_entries', glossaryEntry],
    ['meeting_glossary_entries', { owner_user_id: owner.id, meeting_id: ids.meeting, glossary_entry_id: ids.glossaryEntry }],
    ['meeting_summaries', summary],
    ['audio_artifacts', audioArtifact],
    ['export_artifacts', exportArtifact],
    ['meeting_members', { owner_user_id: owner.id, meeting_id: ids.meeting, user_id: activeMember.id, can_record: false }],
    ['meeting_members', { owner_user_id: owner.id, meeting_id: ids.meeting, user_id: pendingMember.id, can_record: true }],
    ['meeting_members', { owner_user_id: owner.id, meeting_id: ids.meeting, user_id: disabledMember.id, can_record: true }]
  ]) {
    const inserted = await harness.rest(table, {
      method: 'POST',
      token: config.serviceRoleKey,
      key: config.serviceRoleKey,
      body: [row]
    });
    assertHttpSuccess(inserted, `seed ${table}`);
  }

  async function select(table, token, query) {
    return harness.rest(table, { token, query: `?${query}` });
  }

  for (const table of ['meetings', 'meeting_segments', 'sessions', 'subtitle_cues', 'meeting_glossary_entries', 'meeting_summaries']) {
    const memberRows = await select(table, activeMember.accessToken, `owner_user_id=eq.${owner.id}`);
    assertHttpSuccess(memberRows, `active member select ${table}`);
    assert.ok(Array.isArray(memberRows.body) && memberRows.body.length > 0, `active member could not read ${table}`);
  }

  const ownerRows = await select('meetings', owner.accessToken, `id=eq.${ids.meeting}`);
  assertHttpSuccess(ownerRows, 'owner select meeting');
  assert.equal(ownerRows.body.length, 1);

  for (const user of [pendingMember, disabledMember, nonMember]) {
    const rows = await select('meetings', user.accessToken, `id=eq.${ids.meeting}`);
    assertHttpSuccess(rows, `${user.email} private meeting select`);
    assert.equal(rows.body.length, 0, `${user.email} could read a private meeting`);
  }

  const adminRows = await select('meetings', superAdmin.accessToken, `id=eq.${ids.meeting}`);
  assertHttpSuccess(adminRows, 'super-admin select meeting');
  assert.equal(adminRows.body.length, 1);

  const deniedSegment = await harness.rest('meeting_segments', {
    method: 'POST',
    token: activeMember.accessToken,
    body: [{
      id: ids.deniedSegment,
      owner_user_id: owner.id,
      meeting_id: ids.meeting,
      sequence: 1,
      status: 'created'
    }]
  });
  assertHttpDenied(deniedSegment, 'member recording with can_record=false');

  const ownerPatch = await harness.rest('meetings', {
    method: 'PATCH',
    token: activeMember.accessToken,
    query: `?id=eq.${ids.meeting}`,
    body: { name: 'member must not rename' }
  });
  assertHttpSuccess(ownerPatch, 'member owner-setting patch response');
  const unchanged = await select('meetings', owner.accessToken, `id=eq.${ids.meeting}&select=name`);
  assert.equal(unchanged.body[0].name, meeting.name, 'member changed an owner-only meeting setting');

  const memberAudioRows = await select('audio_artifacts', activeMember.accessToken, `owner_user_id=eq.${owner.id}`);
  assertHttpSuccess(memberAudioRows, 'member audio metadata select');
  assert.equal(memberAudioRows.body.length, 1, 'active member could not read allowed audio metadata');

  const memberExportRows = await select('export_artifacts', activeMember.accessToken, `owner_user_id=eq.${owner.id}`);
  assertHttpSuccess(memberExportRows, 'member owner-only export select');
  assert.equal(memberExportRows.body.length, 0, 'member could read owner-only export metadata');

  const deniedAudio = await harness.rest('audio_artifacts', {
    method: 'POST',
    token: activeMember.accessToken,
    body: [{
      id: randomUUID(),
      owner_user_id: owner.id,
      session_id: ids.session,
      meeting_id: ids.meeting,
      segment_id: ids.segment,
      storage_path: `${owner.id}/${ids.meeting}/${ids.segment}/member.webm`,
      kind: 'source_webm',
      status: 'ready',
      byte_size: 1,
      mime_type: 'audio/webm',
      file_name: 'member.webm'
    }]
  });
  assertHttpDenied(deniedAudio, 'member audio insert with can_record=false');

  const deniedExport = await harness.rest('export_artifacts', {
    method: 'POST',
    token: activeMember.accessToken,
    body: [{
      id: randomUUID(),
      owner_user_id: owner.id,
      meeting_id: ids.meeting,
      storage_path: `${owner.id}/${ids.meeting}/member.txt`,
      format: 'txt',
      stream: 'translation',
      source_hash: 'denied',
      status: 'queued'
    }]
  });
  assertHttpDenied(deniedExport, 'member export insert');

  const enabled = await harness.rest('meeting_members', {
    method: 'PATCH',
    token: config.serviceRoleKey,
    key: config.serviceRoleKey,
    query: `?owner_user_id=eq.${owner.id}&meeting_id=eq.${ids.meeting}&user_id=eq.${activeMember.id}`,
    body: { can_record: true }
  });
  assertHttpSuccess(enabled, 'enable member recording');

  const allowedSegment = await harness.rest('meeting_segments', {
    method: 'POST',
    token: activeMember.accessToken,
    body: [{
      id: ids.allowedSegment,
      owner_user_id: owner.id,
      meeting_id: ids.meeting,
      sequence: 1,
      status: 'created'
    }]
  });
  assertHttpSuccess(allowedSegment, 'member recording with can_record=true');

  const anonymous = await harness.rest('meetings', { key: config.publishableKey, query: `?id=eq.${ids.meeting}` });
  assertHttpDenied(anonymous, 'anonymous private table select');
});
