import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMeetingReadController } from '../../server/meetingReadController.js';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createMeetingDeletionService } from '../../src/application/meetingDeletionService.js';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';
import { createSessionShareService } from '../../src/application/sessionShareService.js';

test('local-only cutover rejects legacy content routes without calling writers', async () => {
  const handler = createHandler();
  for (const { method, url } of [
    { method: 'POST', url: '/api/meetings/meeting-1/segments/segment-1/cues' },
    { method: 'PUT', url: '/api/meetings/meeting-1/segments/segment-1/checkpoint' },
    { method: 'POST', url: '/api/meetings/meeting-1/segments/segment-1/audio-uploads' },
    { method: 'POST', url: '/api/meetings/meeting-1/segments/segment-1/rollover' },
    { method: 'POST', url: '/api/meetings/meeting-1/recording/legacy-resume' },
    { method: 'POST', url: '/api/meetings/meeting-1/exports' },
    { method: 'POST', url: '/api/meetings/meeting-1/exports/export-1/download-url' },
    { method: 'GET', url: '/api/sessions/session-1' },
    { method: 'PUT', url: '/api/sessions/session-1' },
    { method: 'POST', url: '/api/translation-outputs' },
    { method: 'POST', url: '/api/saved-transcripts/session-1/translations' },
    { method: 'GET', url: '/api/shared-sessions/legacy-token' }
  ]) {
    const response = await request(handler, { method, url, body: '{"sourceText":"secret"}' });
    assert.equal(response.status, 410, `${method} ${url}`);
    assert.equal(response.json().error.code, 'meeting_content_local_only');
    assert.equal(JSON.stringify(response.json()).includes('secret'), false);
  }
  const sessionCreate = await request(handler, {
    method: 'POST', url: '/api/sessions', body: '{"meetingId":"meeting-1","sourceText":"secret"}'
  });
  assert.equal(sessionCreate.status, 410);
  assert.equal(sessionCreate.json().error.code, 'meeting_content_local_only');
});

test('POST /api/meetings creates a v2 draft without a Segment', async () => {
  const response = await request(createHandler(), { method: 'POST', url: '/api/meetings' });
  const body = response.json();

  assert.equal(response.status, 201);
  assert.equal(body.meeting.status, 'created');
  assert.equal(body.meeting.lifecycleContractVersion, 2);
  assert.equal(body.meeting.lifecycleVersion, 0);
  assert.equal(body.segment, null);
});

test('Meeting Management creates a v2 draft and updates settings before Start', async () => {
  const handler = createHandler();
  const createResponse = await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({
      draft: true,
      name: '產品會議',
      sourceLanguageCode: 'zh-Hant',
      targetLanguageCode: 'en',
      echoTargetLanguage: false,
      shouldRecordInputAudio: true,
      glossaryEntries: [{ source: '產品', target: 'Product', replacementAliases: [] }],
      privateGlossaryEntries: [{ source: '專案代號', translations: { en: 'Project Codename' } }]
    })
  });
  const created = createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.equal(created.meeting.status, 'created');
  assert.equal(created.segment, null);
  assert.equal(created.meeting.echoTargetLanguage, false);
  assert.equal(created.meeting.shouldRecordInputAudio, true);
  assert.deepEqual(created.meeting.privateGlossaryEntries, [{ source: '專案代號', translations: { en: 'Project Codename' }, replacementAliases: {} }]);

  const updateResponse = await request(handler, {
    method: 'PATCH',
    url: `/api/meetings/${created.meeting.id}`,
    body: JSON.stringify({ name: '更新後產品會議', targetLanguageCode: 'ja', echoTargetLanguage: true, shouldRecordInputAudio: false, glossaryEntries: [], privateGlossaryEntries: [{ source: '專案代號', translations: { ja: 'プロジェクトコード' }, replacementAliases: [] }] })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.json().meeting.targetLanguageCode, 'ja');
  assert.equal(updateResponse.json().meeting.echoTargetLanguage, true);
  assert.equal(updateResponse.json().meeting.shouldRecordInputAudio, false);
  assert.deepEqual(updateResponse.json().meeting.privateGlossaryEntries, [{ source: '專案代號', translations: { ja: 'プロジェクトコード' }, replacementAliases: {} }]);

  const detail = await request(handler, { method: 'GET', url: `/api/meetings/${created.meeting.id}` });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json().timeline, []);
});

test('completed Meeting locks settings and new shares but permits Viewer share revocation', async () => {
  const repository = createMemoryMeetingRepository();
  const shareService = createSessionShareService();
  const handler = createHandler({ meetingRepository: repository, sessionShareService: shareService });
  const created = (await request(handler, { method: 'POST', url: '/api/meetings', body: JSON.stringify({ draft: true }) })).json();
  const share = shareService.createMeetingShare(created.meeting.id, { role: 'viewer' });
  repository.updateMeeting(repository.getMeeting(created.meeting.id).complete(2000));
  const detail = await request(handler, { method: 'GET', url: `/api/meetings/${created.meeting.id}` });
  assert.equal(detail.status, 200);
  assert.equal(detail.json().meeting.status, 'completed');
  const update = await request(handler, { method: 'PATCH', url: `/api/meetings/${created.meeting.id}`, body: JSON.stringify({ name: 'locked' }) });
  assert.equal(update.status, 409);
  assert.equal(update.json().error.code, 'meeting_settings_locked');
  const createShare = await request(handler, { method: 'POST', url: `/api/meetings/${created.meeting.id}/shares`, body: '{}' });
  assert.equal(createShare.status, 409);
  assert.equal(createShare.json().error.code, 'meeting_share_locked');
  const revokeShare = await request(handler, { method: 'DELETE', url: `/api/meetings/${created.meeting.id}/shares/${share.id}` });
  assert.equal(revokeShare.status, 204);
});
test('v2 Meeting Viewer legacy detail routes reject cloud content by token and short code', async () => {
  const shareService = createSessionShareService();
  const handler = createHandler({ sessionShareService: shareService });
  const created = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({
      draft: true,
      name: '公開字幕會議',
      glossaryEntries: [{ source: '內部詞', target: 'Internal Term' }],
      privateGlossaryEntries: [{ source: '私有詞', translations: { en: 'Private Term' } }]
    })
  })).json();

  const createdShare = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/shares`,
    body: JSON.stringify({ role: 'viewer' })
  });
  const shareBody = createdShare.json();
  assert.equal(createdShare.status, 201);
  assert.equal(shareBody.share.role, 'viewer');
  assert.match(shareBody.url, /^#viewer\?token=/);
  assert.match(shareBody.codeUrl, /^#viewer\?code=/);

  const byToken = await request(handler, { method: 'GET', url: `/api/shared-meetings/${shareBody.share.token}` });
  const byCode = await request(handler, { method: 'GET', url: `/api/shared-meetings/code/${shareBody.share.shortCode}` });
  for (const response of [byToken, byCode]) {
    assert.equal(response.status, 410);
    assert.equal(response.json().error.code, 'meeting_content_local_only');
  }
});

test('legacy content routes return stable local-only errors before content writers run', async () => {
  let writes = 0;
  const handler = createHandler({ meetingAudioService: {
    async startUpload() { writes += 1; },
    async createDownloadUrl() { writes += 1; }
  } });
  const routes = [
    ['POST', '/api/meetings/meeting-1/segments/segment-1/cues'],
    ['PUT', '/api/meetings/meeting-1/segments/segment-1/checkpoint'],
    ['GET', '/api/meetings/meeting-1/segments/segment-1/checkpoint'],
    ['POST', '/api/meetings/meeting-1/segments/segment-1/rollover'],
    ['POST', '/api/meetings/meeting-1/segments/segment-1/recover'],
    ['POST', '/api/meetings/meeting-1/segments/segment-1/audio-uploads'],
    ['POST', '/api/meetings/meeting-1/audio-artifacts/artifact-1/complete'],
    ['POST', '/api/meetings/meeting-1/exports'],
    ['GET', '/api/meetings/meeting-1/audio/original']
  ];
  for (const [method, url] of routes) {
    const response = await request(handler, { method, url, body: '{}' });
    assert.equal(response.status, 410, `${method} ${url}`);
    assert.equal(response.json().error.code, 'meeting_content_local_only');
    assert.ok(response.json().error.requestId);
  }
  assert.equal(writes, 0);
});
test('Meeting Settings share ensure route returns a reusable Viewer link', async () => {
  const shareService = createSessionShareService();
  const handler = createHandler({ sessionShareService: shareService });
  const created = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ draft: true, name: '可重用分享會議' })
  })).json();

  const first = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/shares`,
    body: JSON.stringify({ role: 'viewer', expiresAt: null, ensureExisting: true })
  });
  const second = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/shares`,
    body: JSON.stringify({ role: 'viewer', expiresAt: null, ensureExisting: true })
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.json().share.id, second.json().share.id);
  assert.match(first.json().codeUrl, /^#viewer\?code=/);
});

test('Meeting Viewer exchanges an active viewer share for scoped Realtime authorization', async () => {
  const shareService = createSessionShareService();
  const viewerRealtimeTokenService = {
    async issue(share) {
      return { accessToken: `jwt:${share.id}`, expiresAt: 301_000, channel: `meeting:${share.meetingId}` };
    }
  };
  const handler = createHandler({ sessionShareService: shareService, viewerRealtimeTokenService });
  const created = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const share = (await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/shares`,
    body: JSON.stringify({ role: 'viewer' })
  })).json().share;

  const response = await request(handler, { method: 'POST', url: `/api/shared-meetings/${share.token}/realtime-token` });

  assert.equal(response.status, 200, response.body);
  assert.equal(response.json().channel, `meeting:${created.meeting.id}`);
  assert.equal(response.json().accessToken, `jwt:${share.id}`);
});

test('Meeting share management list rebuilds a stable code URL after the share service is reloaded', async () => {
  const directory = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'live-translate-meeting-share-list-'));
  const fileSystem = await import('node:fs/promises');
  const filePath = (await import('node:path')).join(directory, 'shares.json');
  const created = (await request(createHandler(), { method: 'POST', url: '/api/meetings', body: JSON.stringify({ draft: true }) })).json();
  const firstHandler = createHandler({ sessionShareService: (await import('../../src/infrastructure/fileSessionShareService.js')).createFileSessionShareService({ filePath, fileSystem, clock: () => 1000 }) });
  const createdShare = (await request(firstHandler, { method: 'POST', url: `/api/meetings/${created.meeting.id}/shares`, body: JSON.stringify({ role: 'viewer' }) })).json();
  const secondHandler = createHandler({ sessionShareService: (await import('../../src/infrastructure/fileSessionShareService.js')).createFileSessionShareService({ filePath, fileSystem, clock: () => 1000 }) });

  const listed = await request(secondHandler, { method: 'GET', url: `/api/meetings/${created.meeting.id}/shares` });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json().shares[0], {
    id: createdShare.share.id,
    sessionId: created.meeting.id,
    role: 'viewer',
    resourceType: 'meeting',
    meetingId: created.meeting.id,
    createdAt: 1000,
    expiresAt: null,
    shortCode: createdShare.share.shortCode,
    codeUrl: `#viewer?code=${createdShare.share.shortCode}`
  });
});

test('DELETE /api/meetings/:meetingId deletes an unstarted draft and rejects started meetings', async () => {
  const repository = createMemoryMeetingRepository();
  const handler = createHandler({ meetingRepository: repository });
  const draft = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ draft: true, name: '可刪除草稿' })
  })).json();

  const deleted = await request(handler, { method: 'DELETE', url: `/api/meetings/${draft.meeting.id}` });
  assert.equal(deleted.status, 204);
  assert.equal((await request(handler, { method: 'GET', url: `/api/meetings/${draft.meeting.id}` })).status, 404);

  const active = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  repository.updateMeeting(repository.getMeeting(active.meeting.id).activate(2000));
  const rejected = await request(handler, { method: 'DELETE', url: `/api/meetings/${active.meeting.id}` });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json().error.code, 'meeting_delete_active_not_allowed');
});

test('GET /api/meetings/:meetingId/segments returns no Segment before v2 Start', async () => {
  const handler = createHandler();
  const createResponse = await request(handler, { method: 'POST', url: '/api/meetings' });
  const { meeting } = createResponse.json();

  const response = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments` });

  assert.equal(response.status, 200);
  assert.equal(response.json().meetingId, meeting.id);
  assert.deepEqual(response.json().segments, []);
});

test('GET /api/meetings returns metadata history without cloud transcript summaries', async () => {
  const handler = createHandler();
  const { meeting } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const response = await request(handler, { method: 'GET', url: '/api/meetings' });
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, meeting.id);
  assert.equal(body[0].recordKind, 'meeting');
  assert.equal(body[0].transcriptSummary.hasTranscript, false);
  assert.equal(body[0].transcriptSummary.totalItems, 0);
});
test('GET /api/meetings/:meetingId returns metadata detail without cloud content', async () => {
  const handler = createHandler();
  const { meeting } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const rollover = await request(handler, { method: 'POST', url: `/api/meetings/${meeting.id}/segments/unstarted/rollover`, body: '{}' });
  assert.equal(rollover.status, 410);
  const response = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}` });
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.meeting.id, meeting.id);
  assert.deepEqual(body.timeline, []);
  assert.deepEqual(body.transcriptItems, []);
  assert.deepEqual(body.cues, []);
  assert.deepEqual(body.audioArtifacts, {});
});
test('Meeting read requests log safe diagnostic fields for missing resources', async () => {
  const logs = [];
  const handler = createHandler({ requestLogger: (event) => logs.push(event) });
  const response = await request(handler, {
    method: 'GET',
    url: '/api/meetings/missing-meeting'
  });

  assert.equal(response.status, 404);
  assert.deepEqual(logs.at(-1), {
    level: 'info',
    event: 'meeting_request',
    operation: 'GET /api/meetings/missing-meeting',
    requestId: response.headers['X-Request-Id'],
    method: 'GET',
    path: '/api/meetings/missing-meeting',
    durationMs: logs.at(-1).durationMs,
    clientIp: '127.0.0.1',
    origin: '',
    actorUserId: null,
    resourceOwnerUserId: null,
    resourceOwnerId: null,
    meetingId: 'missing-meeting',
    statusCode: 404,
    errorCode: 'meeting_not_found',
    supabaseStatus: null,
    supabaseProjectRef: null
  });
});

test('Meeting authorization rejection logs diagnostic fields before route handling', async () => {
  const logs = [];
  const handler = createHandler({
    accessControl: { validateRequest: async () => ({ id: 'actor-1', role: 'member', status: 'active' }) },
    profileService: {
      getProfile: async (user) => ({ id: user.id, status: 'active', role: 'member' }),
      findMeetingMembership: async () => null
    },
    meetingMembershipService: {
      canAccessMeeting: async () => false,
      getMeetingOwner: async () => 'owner-1'
    },
    requestLogger: (event) => logs.push(event)
  });

  const response = await request(handler, {
    method: 'GET',
    url: '/api/meetings/meeting-1'
  });

  assert.equal(response.status, 403);
  assert.deepEqual(logs.at(-1), {
    level: 'warn',
    event: 'meeting_request',
    operation: 'GET /api/meetings/meeting-1',
    requestId: response.headers['X-Request-Id'],
    method: 'GET',
    path: '/api/meetings/meeting-1',
    statusCode: 403,
    durationMs: logs.at(-1).durationMs,
    clientIp: '127.0.0.1',
    origin: '',
    authStage: 'private_resource',
    actorUserId: 'actor-1',
    resourceOwnerUserId: 'owner-1',
    resourceOwnerId: 'owner-1',
    meetingId: 'meeting-1',
    errorCode: 'auth_forbidden',
    supabaseStatus: null,
    supabaseProjectRef: null,
    ownerLookup: 'found',
    ownerMatchesActor: false,
    actorProfileLookup: 'found',
    actorProfileStatus: 'active',
    actorProfileRole: 'member',
    membership: 'absent'
  });
});

test('Meeting authorization diagnostics keep an unknown owner distinct from the actor', async () => {
  const logs = [];
  const handler = createHandler({
    accessControl: { validateRequest: async () => ({ id: 'actor-1', role: 'member', status: 'active' }) },
    profileService: {
      getProfile: async (user) => ({ id: user.id, status: 'active', role: 'member' }),
      findMeetingMembership: async () => null
    },
    meetingMembershipService: {
      canAccessMeeting: async () => false,
      getMeetingOwner: async () => null
    },
    requestLogger: (event) => logs.push(event)
  });

  const response = await request(handler, {
    method: 'GET',
    url: '/api/meetings/meeting-1'
  });

  assert.equal(response.status, 403);
  assert.equal(logs.at(-1).resourceOwnerId, null);
  assert.equal(logs.at(-1).ownerLookup, 'missing');
  assert.equal(logs.at(-1).ownerMatchesActor, null);
});

test('Super admins receive meeting_not_found when the owner lookup is missing', async () => {
  const logs = [];
  const handler = createHandler({
    accessControl: { validateRequest: async () => ({ id: 'admin-1', role: 'super_admin', status: 'active' }) },
    profileService: {
      getProfile: async (user) => ({ id: user.id, status: 'active', role: 'super_admin' }),
      findMeetingMembership: async () => null
    },
    meetingMembershipService: {
      canAccessMeeting: async () => true,
      getMeetingOwner: async () => null
    },
    requestLogger: (event) => logs.push(event)
  });

  const response = await request(handler, {
    method: 'GET',
    url: '/api/meetings/missing-meeting'
  });

  assert.equal(response.status, 404);
  const body = response.json();
  assert.equal(body.error.code, 'meeting_not_found');
  assert.equal(body.error.requestId, response.headers['X-Request-Id']);
  assert.equal(logs.at(-1).authStage, 'private_resource');
  assert.equal(logs.at(-1).ownerLookup, 'missing');
  assert.equal(logs.at(-1).supabaseProjectRef, null);
});

test('checkpoint routes enforce the Preview immutable Origin before auth/capability checks', async () => {
  const previous = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL
  };
  Object.assign(process.env, {
    VERCEL_ENV: 'preview',
    APP_ORIGIN: 'https://app.example/',
    VERCEL_URL: 'immutable.vercel.app',
    VERCEL_BRANCH_URL: 'branch.vercel.app'
  });
  try {
    const handler = createHandler();
    const allowed = await request(handler, {
      method: 'GET',
      url: '/api/meetings/meeting-1/segments/segment-1/checkpoint',
      headers: { origin: 'https://immutable.vercel.app' }
    });
    assert.notEqual(allowed.status, 403);
    assert.notEqual(allowed.json().error?.code, 'invalid_origin');

    const rejected = await request(handler, {
      method: 'GET',
      url: '/api/meetings/meeting-1/segments/segment-1/checkpoint',
      headers: { origin: 'https://unrelated.vercel.app' }
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.json().error.code, 'invalid_origin');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('metadata-only Viewer share route preserves token, code, and expiry checks without Cue reads', async () => {
  const baseRepository = createMemoryMeetingRepository();
  const repository = {
    ...baseRepository,
    listMeetingSegmentMetadata: baseRepository.listMeetingSegmentMetadata,
    listMeetingSegments() { throw new Error('content read forbidden'); },
    getMeetingViewerPage() { throw new Error('subtitle_cues forbidden'); }
  };
  let now = Date.now();
  const shareService = createSessionShareService({ clock: () => now });
  const handler = createHandler({ meetingRepository: repository, sessionShareService: shareService });
  const created = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const share = shareService.createMeetingShare(created.meeting.id, { role: 'viewer', expiresAt: now + 60_000 });
  const strictHandler = createHandler({
    meetingRepository: repository,
    sessionShareService: shareService,
    accessControl: {
      async validateRequest() {
        const error = new Error('Access token is required.');
        error.code = 'auth_required';
        throw error;
      }
    }
  });
  assert.equal((await request(strictHandler, { url: `/api/shared-meetings/code/${share.shortCode}/metadata` })).status, 200);
  assert.equal((await request(strictHandler, { url: '/api/shared-meetings/code/invalid/metadata' })).status, 404);
  assert.equal((await request(strictHandler, { url: '/api/meetings' })).status, 401);
  const tokenPath = `/api/shared-meetings/${share.token}/metadata`;
  const codePath = `/api/shared-meetings/code/${share.shortCode}/metadata`;
  for (const url of [tokenPath, codePath]) {
    const result = await request(handler, { url });
    assert.equal(result.status, 200);
    assert.equal(result.json().recordKind, 'meetingViewerMetadata');
    assert.equal(result.json().capability.meetingId, created.meeting.id);
    assert.equal(result.json().recordingState, 'waiting');
    assert.deepEqual(result.json().segments, []);
    assert.equal(Object.hasOwn(result.json(), 'cues'), false);
  }
  const recorderShare = shareService.createMeetingShare(created.meeting.id, { role: 'recorder' });
  assert.equal((await request(handler, { url: `/api/shared-meetings/${recorderShare.token}/metadata` })).status, 404);
  assert.equal((await request(handler, { url: `/api/shared-meetings/code/${recorderShare.shortCode}/metadata` })).status, 404);
  assert.equal((await request(handler, { url: '/api/shared-meetings/invalid/metadata' })).status, 404);
  const stored = baseRepository.getMeeting(created.meeting.id);
  baseRepository.updateMeeting({ ...stored, status: 'completed', startedAt: stored.createdAt, endedAt: Date.now(), retentionPolicyVersion: 2, purgeAt: '2030-01-01T00:00:00.000Z', lifecycleVersion: stored.lifecycleVersion + 1 });
  const ended = await request(handler, { url: tokenPath });
  assert.equal(ended.status, 200);
  assert.equal(ended.json().recordingState, 'ended');
  assert.equal(ended.json().meeting.lifecycleVersion, stored.lifecycleVersion + 1);
  baseRepository.updateMeeting({ ...baseRepository.getMeeting(created.meeting.id), purgeAt: '2000-01-01T00:00:00.000Z' });
  const expiredContent = await request(handler, { url: tokenPath });
  assert.equal(expiredContent.status, 410);
  assert.equal(expiredContent.json().error.code, 'meeting_content_expired');
  assert.equal(shareService.revokeShare(created.meeting.id, share.id), true);
  assert.equal((await request(handler, { url: tokenPath })).status, 404);
  assert.equal((await request(handler, { url: codePath })).status, 404);
  baseRepository.updateMeeting({ ...baseRepository.getMeeting(created.meeting.id), purgeAt: '2030-01-01T00:00:00.000Z' });
  const expiringShare = shareService.createMeetingShare(created.meeting.id, { role: 'viewer', expiresAt: now + 60_000 });
  const expiringTokenPath = `/api/shared-meetings/${expiringShare.token}/metadata`;
  const expiringCodePath = `/api/shared-meetings/code/${expiringShare.shortCode}/metadata`;
  assert.equal((await request(handler, { url: expiringTokenPath })).status, 200);
  now += 60_001;
  assert.equal((await request(handler, { url: expiringTokenPath })).status, 404);
  assert.equal((await request(handler, { url: expiringCodePath })).status, 404);
});

test('Meeting dictionary PATCH logs safe failure stage without exposing entry contents', async () => {
  const events = [];
  const repository = {
    ...createMemoryMeetingRepository(),
    updateMeeting() {
      const error = new Error('private dictionary content must stay out of logs');
      error.name = 'DatabaseError';
      error.supabaseCode = 'P0043';
      error.supabaseStatus = 400;
      error.meetingPatchStage = 'database_write';
      error.meetingPatchWriteStatus = 'not_committed';
      throw error;
    }
  };
  const handler = createHandler({ meetingRepository: repository, requestLogger: (event) => events.push(event) });
  const created = (await request(handler, { method: 'POST', url: '/api/meetings', body: '{}' })).json();
  const response = await request(handler, {
    method: 'PATCH', url: `/api/meetings/${created.meeting.id}`,
    body: JSON.stringify({ glossaryEntries: [{ source: 'private dictionary content', target: 'private target' }] })
  });
  const diagnostic = events.find((event) => event.event === 'meeting_dictionary_patch_failure');
  assert.equal(response.status, 500);
  assert.equal(response.json().error.code, 'internal_error');
  assert.equal(diagnostic.requestId, response.json().error.requestId);
  assert.equal(diagnostic.stage, 'database_write');
  assert.equal(diagnostic.postgresSqlstate, 'P0043');
  assert.equal(diagnostic.databaseWriteStatus, 'not_committed');
  assert.equal(diagnostic.mappingStatus, 'not_reached');
  assert.deepEqual(diagnostic.requestShape, [{ field: 'glossaryEntries', type: 'array' }]);
  assert.equal(JSON.stringify({ response: response.json(), diagnostic }).includes('private dictionary content'), false);
});

function createHandler({ meetingCheckpointMaxBytes, sessionShareService, sessionRepository, meetingEventBroadcaster, meetingAudioService, viewerRealtimeTokenService, meetingRepository, meetingMembershipService, meetingDeletionService: injectedMeetingDeletionService, accessControl, profileService, strictCheckpointPathIds = false, requestLogger } = {}) {
  const repository = meetingRepository || createMemoryMeetingRepository();
  let meetingId = 0;
  let segmentId = 0;
  const meetingCheckpointService = createMeetingCheckpointService({
    meetingRepository: repository,
    sessionRepository,
    idGenerator(prefix) {
      if (prefix === 'meeting') return `meeting-${++meetingId}`;
      if (prefix === 'segment') return `segment-${++segmentId}`;
      return `${prefix}-1`;
    },
    clock: () => 1000
  });
  const meetingReadController = createMeetingReadController({
    meetingReadQueryService: createMeetingReadQueryService({ meetingRepository: repository })
  });
  const meetingDeletionService = injectedMeetingDeletionService || createMeetingDeletionService({
    meetingRepository: repository,
    sessionRepository: {
      async listSessionRecords() { return []; },
      async deleteSessionRecord() { return true; }
    }
  });

  return createRequestHandler({
    sessionReadController: sessionReadController(),
    ...(sessionRepository ? { sessionRepository } : {}),
    meetingRepository: repository,
    meetingReadController,
    meetingCheckpointService,
    meetingDeletionService,
    ...(sessionShareService ? { sessionShareService } : {}),
    ...(meetingEventBroadcaster ? { meetingEventBroadcaster } : {}),
    ...(meetingAudioService ? { meetingAudioService } : {}),
    ...(viewerRealtimeTokenService ? { viewerRealtimeTokenService } : {}),
    ...(meetingMembershipService ? { meetingMembershipService } : {}),
    ...(accessControl ? { accessControl } : {}),
    ...(profileService ? { profileService } : {}),
    ...(meetingCheckpointMaxBytes === undefined ? {} : { meetingCheckpointMaxBytes }),
    ...(requestLogger ? { requestLogger } : {}),
    strictCheckpointPathIds
  });
}

function sessionReadController() {
  return {
    listSessions() {
      return [];
    },
    getSession() {
      return null;
    }
  };
}

function checkpoint({ meetingId, segmentId, idempotencyKey = 'checkpoint-1', durableChunks = [], finalCues = [] }) {
  return {
    idempotencyKey,
    durableChunks,
    ...(finalCues.length > 0 ? { finalCues } : {}),
    pendingPartial: null,
    meetingId,
    segmentId
  };
}

function finalCue(overrides = {}) {
  return {
    cueId: 'cue:session-1:segment-1:1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    sequence: 1,
    startTimeMs: 0,
    endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    sourceText: '你好',
    translatedText: 'hello',
    status: 'final',
    finalizedReason: 'final',
    ...overrides
  };
}

function chunk(overrides = {}) {
  const stream = overrides.stream ?? 'source';
  const sequence = overrides.sequence ?? 1;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `chunk-${stream}-${sequence}`,
    meetingId: overrides.meetingId,
    segmentId: overrides.segmentId,
    stream,
    sequence,
    text: overrides.text ?? 'text',
    timestamp: 1000
  };
}

async function request(handler, { method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const req = new Readable({ read() {} });
  req.url = url;
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  if (body) req.push(body);
  req.push(null);

  const chunks = [];
  const res = {
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = responseHeaders;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await handler(req, res);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return {
    status: res.statusCode,
    headers: res.headers,
    body: rawBody,
    json() {
      return rawBody ? JSON.parse(rawBody) : {};
    }
  };
}

test('another authenticated user cannot complete a Meeting they cannot manage', async () => {
  let checkedManagement = false;
  const handler = createHandler({
    accessControl: { validateRequest: async () => ({ id: 'other-user', role: 'member', status: 'active' }) },
    profileService: {
      getProfile: async () => ({ id: 'other-user', role: 'member', status: 'active' }),
      findMeetingMembership: async () => null
    },
    meetingMembershipService: {
      canManage: async () => { checkedManagement = true; return false; },
      getMeetingOwner: async () => 'meeting-owner'
    }
  });
  const response = await request(handler, { method: 'POST', url: '/api/meetings/other-meeting/complete' });
  assert.equal(response.status, 403);
  assert.equal(response.json().error.code, 'auth_forbidden');
  assert.equal(checkedManagement, true);
});
