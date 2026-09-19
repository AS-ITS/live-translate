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

test('POST /api/meetings creates an active meeting and first segment', async () => {
  const response = await request(createHandler(), { method: 'POST', url: '/api/meetings' });
  const body = response.json();

  assert.equal(response.status, 201);
  assert.equal(body.meeting.status, 'active');
  assert.equal(body.segment.status, 'active');
  assert.equal(body.segment.meetingId, body.meeting.id);
});

test('Meeting Management creates a draft, updates settings, and starts its first segment', async () => {
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
  assert.equal(created.segment.status, 'created');
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

  const startResponse = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/segments/${created.segment.id}/start`,
    body: JSON.stringify({ liveSessionId: 'live-session-management-1' })
  });
  const started = startResponse.json();
  assert.equal(startResponse.status, 201);
  assert.equal(started.meeting.status, 'active');
  assert.equal(started.segment.status, 'active');
  assert.equal(started.segment.liveSessionId, 'live-session-management-1');
});

test('completed meetings reject settings changes and new shares but allow revoking existing Viewer shares', async () => {
  const shareService = createSessionShareService();
  const handler = createHandler({ sessionShareService: shareService });
  const created = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ draft: true })
  })).json();
  const share = shareService.createMeetingShare(created.meeting.id, { role: 'viewer' });

  const completed = await request(handler, { method: 'POST', url: `/api/meetings/${created.meeting.id}/complete` });
  assert.equal(completed.status, 200);

  const update = await request(handler, {
    method: 'PATCH',
    url: `/api/meetings/${created.meeting.id}`,
    body: JSON.stringify({ name: '不應修改' })
  });
  assert.equal(update.status, 409);
  assert.equal(update.json().error.code, 'meeting_settings_locked');

  const createShare = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/shares`,
    body: JSON.stringify({})
  });
  assert.equal(createShare.status, 409);
  assert.equal(createShare.json().error.code, 'meeting_share_locked');

  const revokeShare = await request(handler, {
    method: 'DELETE',
    url: `/api/meetings/${created.meeting.id}/shares/${share.id}`
  });
  assert.equal(revokeShare.status, 204);
});

test('Meeting Viewer shares expose sanitized historical detail by token and short code', async () => {
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
    assert.equal(response.status, 200);
    assert.equal(response.json().capability.role, 'viewer');
    assert.equal(response.json().meeting.glossaryEntries, undefined);
    assert.equal(response.json().meeting.privateGlossaryEntries, undefined);
    assert.equal(response.json().audioArtifacts, undefined);
  }
});

test('meeting audio upload endpoints delegate metadata only and issue signed downloads', async () => {
  const calls = [];
  const meetingAudioService = {
    async beginUpload(input) {
      calls.push(['begin', input]);
      return { id: 'artifact-1', status: 'uploading', bucket: 'meeting-audio', objectPath: 'user/meeting/segment/recording.webm', uploadEndpoint: 'https://storage.example/upload/resumable' };
    },
    async completeUpload(input) { calls.push(['complete', input]); return { id: input.artifactId, status: 'ready' }; },
    async createDownloadUrl(input) { calls.push(['download', input]); return { url: 'https://storage.example/signed', expiresAt: 61_000, fileName: 'recording.webm' }; }
  };
  const handler = createHandler({ meetingAudioService });

  const started = await request(handler, {
    method: 'POST',
    url: '/api/meetings/meeting-1/segments/segment-1/audio-uploads',
    body: JSON.stringify({ mimeType: 'audio/webm', byteSize: 4096 })
  });
  const completed = await request(handler, { method: 'POST', url: '/api/meetings/meeting-1/audio-artifacts/artifact-1/complete' });
  const download = await request(handler, { method: 'POST', url: '/api/meetings/meeting-1/audio-artifacts/artifact-1/download-url' });

  assert.equal(started.status, 201, started.body);
  assert.equal(completed.status, 200, completed.body);
  assert.equal(download.status, 200, download.body);
  assert.deepEqual(calls, [
    ['begin', { meetingId: 'meeting-1', segmentId: 'segment-1', mimeType: 'audio/webm', byteSize: 4096 }],
    ['complete', { meetingId: 'meeting-1', artifactId: 'artifact-1' }],
    ['download', { meetingId: 'meeting-1', artifactId: 'artifact-1', expiresIn: 60 }]
  ]);
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

test('Meeting Cue publish API emits a Viewer SSE event without checkpoint persistence', async () => {
  let meetingId = null;
  const sessionRepository = {
    async getSessionRecord() {
      return { sessionRecord: { id: 'session-live', meetingId, segmentId: 'segment-1' } };
    }
  };
  const meetingEventBroadcaster = (await import('../../src/infrastructure/meetingEventBroadcaster.js')).createMeetingEventBroadcaster();
  const shareService = createSessionShareService();
  const handler = createHandler({ sessionShareService: shareService, sessionRepository, meetingEventBroadcaster });
  const created = (await request(handler, { method: 'POST', url: '/api/meetings', body: JSON.stringify({ draft: true }) })).json();
  meetingId = created.meeting.id;
  const share = (await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meetingId}/shares`,
    body: JSON.stringify({ role: 'viewer' })
  })).json().share;
  const published = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meetingId}/segments/segment-1/cues`,
    body: JSON.stringify({ sessionId: 'session-live', producedAt: 10, cue: finalCue({ sessionId: 'session-live', segmentId: 'segment-1' }) })
  });
  assert.equal(published.status, 202);
  assert.deepEqual(published.json(), { eventId: 1, cueSequence: 1 });

  const events = await request(handler, { method: 'GET', url: `/api/shared-meetings/${share.token}/events?after=0` });
  assert.equal(events.status, 200);
  assert.match(events.body, /event: cue\.append/);
  assert.match(events.body, /"translatedText":"hello"/);
});

test('POST /api/meetings/:meetingId/complete completes an active segment', async () => {
  const handler = createHandler();
  const created = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/complete`
  });
  const body = response.json();
  const segments = (await request(handler, {
    method: 'GET',
    url: `/api/meetings/${created.meeting.id}/segments`
  })).json();

  assert.equal(response.status, 200);
  assert.equal(body.meeting.status, 'completed');
  assert.equal(segments.segments[0].status, 'completed');
});

test('DELETE /api/meetings/:meetingId deletes an unstarted draft and rejects started meetings', async () => {
  const handler = createHandler();
  const draft = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ draft: true, name: '可刪除草稿' })
  })).json();

  const deleted = await request(handler, { method: 'DELETE', url: `/api/meetings/${draft.meeting.id}` });
  assert.equal(deleted.status, 204);
  assert.equal((await request(handler, { method: 'GET', url: `/api/meetings/${draft.meeting.id}` })).status, 404);

  const active = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const rejected = await request(handler, { method: 'DELETE', url: `/api/meetings/${active.meeting.id}` });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json().error.code, 'meeting_delete_active_not_allowed');
});

test('GET /api/meetings/:meetingId/segments returns ordered segments', async () => {
  const handler = createHandler();
  const createResponse = await request(handler, { method: 'POST', url: '/api/meetings' });
  const { meeting } = createResponse.json();

  const response = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments` });

  assert.equal(response.status, 200);
  assert.equal(response.json().meetingId, meeting.id);
  assert.deepEqual(response.json().segments.map((segment) => segment.sequence), [0]);
});

test('GET /api/meetings returns meeting history summaries', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      durableChunks: [
        chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'source', sequence: 1, text: 'hello' }),
        chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'translation', sequence: 2, text: 'world' })
      ]
    }))
  });

  const response = await request(handler, { method: 'GET', url: '/api/meetings' });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, meeting.id);
  assert.equal(body[0].recordKind, 'meeting');
  assert.deepEqual(body[0].segmentSummary, {
    totalSegments: 1,
    countsByStatus: { active: 1 },
    hasInterruptedSegments: false,
    hasFailedSegments: false
  });
  assert.deepEqual(body[0].transcriptSummary, {
    totalItems: 2,
    sourceFinalCount: 1,
    translationFinalCount: 1,
    hasTranscript: true
  });
});

test('GET /api/meetings/:meetingId returns composed meeting detail with transcript items and timeline', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/rollover`,
    body: JSON.stringify({
      idempotencyKey: 'rollover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        finalCues: [finalCue({
          cueId: 'cue:meeting:segment-1:1',
          segmentId: segment.id,
          sessionId: 'session-meeting-1',
          sourceText: 'segment one source',
          translatedText: 'segment one translation',
          startTimeMs: 100,
          endTimeMs: 800
        })],
        durableChunks: [
          chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'source', sequence: 1, text: 'segment one source' }),
          chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'translation', sequence: 2, text: 'segment one translation' })
        ]
      }),
      nextLiveSessionId: 'live-session-2'
    })
  });
  await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/segment-2/recover`,
    body: JSON.stringify({
      idempotencyKey: 'recover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: 'segment-2',
        durableChunks: [
          chunk({ meetingId: meeting.id, segmentId: 'segment-2', stream: 'source', sequence: 3, text: 'segment two source' }),
          chunk({ meetingId: meeting.id, segmentId: 'segment-2', stream: 'translation', sequence: 4, text: 'segment two translation' })
        ]
      }),
      nextLiveSessionId: 'live-session-3',
      failureReason: 'token_expired',
      failureCategory: 'token',
      outcome: 'interrupted'
    })
  });

  const response = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}` });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.meeting.id, meeting.id);
  assert.deepEqual(body.timeline.map(({ id, status }) => ({ id, status })), [
    { id: 'segment-1', status: 'completed' },
    { id: 'segment-2', status: 'interrupted' },
    { id: 'segment-3', status: 'active' }
  ]);
  assert.deepEqual(
    body.transcriptItems.map(({ segmentId, segmentStatus, stream, sequence, text }) => ({
      segmentId,
      segmentStatus,
      stream,
      sequence,
      text
    })),
    [
      { segmentId: 'segment-1', segmentStatus: 'completed', stream: 'source', sequence: 1, text: 'segment one source' },
      { segmentId: 'segment-1', segmentStatus: 'completed', stream: 'translation', sequence: 2, text: 'segment one translation' },
      { segmentId: 'segment-2', segmentStatus: 'interrupted', stream: 'source', sequence: 3, text: 'segment two source' },
      { segmentId: 'segment-2', segmentStatus: 'interrupted', stream: 'translation', sequence: 4, text: 'segment two translation' }
    ]
  );
  assert.equal(body.readingContent.sourceTranscript.status, 'available');
  assert.equal(body.readingContent.translationArticle.status, 'available');
  assert.deepEqual(body.cues.map(({ cueId, segmentId, translatedText }) => ({ cueId, segmentId, translatedText })), [
    { cueId: 'cue:meeting:segment-1:1', segmentId: 'segment-1', translatedText: 'segment one translation' }
  ]);
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
    requestId: response.headers['X-Request-Id'],
    method: 'GET',
    path: '/api/meetings/missing-meeting',
    durationMs: logs.at(-1).durationMs,
    clientIp: '127.0.0.1',
    origin: '',
    actorUserId: null,
    resourceOwnerId: null,
    meetingId: 'missing-meeting',
    statusCode: 404,
    errorCode: 'meeting_not_found',
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
    requestId: response.headers['X-Request-Id'],
    method: 'GET',
    path: '/api/meetings/meeting-1',
    statusCode: 403,
    durationMs: logs.at(-1).durationMs,
    clientIp: '127.0.0.1',
    origin: '',
    authStage: 'private_resource',
    actorUserId: 'actor-1',
    resourceOwnerId: 'owner-1',
    meetingId: 'meeting-1',
    errorCode: 'auth_forbidden',
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

test('PUT and GET checkpoint persist durable chunks idempotently', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const body = checkpoint({
    meetingId: meeting.id,
    segmentId: segment.id,
    durableChunks: [
      chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'translation', sequence: 2, text: 'world' }),
      chunk({ meetingId: meeting.id, segmentId: segment.id, stream: 'source', sequence: 1, text: 'hello' })
    ]
  });

  const first = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(body)
  });
  const duplicate = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(body)
  });
  const read = await request(handler, {
    method: 'GET',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`
  });

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(read.status, 200);
  assert.deepEqual(
    read.json().checkpoint.durableChunks.map(({ stream, sequence, text }) => ({ stream, sequence, text })),
    [
      { stream: 'source', sequence: 1, text: 'hello' },
      { stream: 'translation', sequence: 2, text: 'world' }
    ]
  );
});

test('checkpoint accepts long payloads above the general JSON request limit', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const durableChunks = Array.from({ length: 24 }, (_, index) => chunk({
    meetingId: meeting.id,
    segmentId: segment.id,
    sequence: index + 1,
    text: 'long meeting transcript '.repeat(30)
  }));

  const response = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, durableChunks }))
  });

  assert.ok(response.body.length > 10_000);
  assert.equal(response.status, 200);
  assert.equal(response.json().checkpoint.durableChunks.length, durableChunks.length);
});

test('checkpoint rejects payloads above the configured Meeting limit', async () => {
  const handler = createHandler({ meetingCheckpointMaxBytes: 1_000 });
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const response = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, text: 'x'.repeat(2_000) })]
    }))
  });

  assert.equal(response.status, 413);
  assert.equal(response.json().error.code, 'request_too_large');
});

test('checkpoint conflict returns HTTP 409', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const url = `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`;

  await request(handler, {
    method: 'PUT',
    url,
    body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })] }))
  });
  const response = await request(handler, {
    method: 'PUT',
    url,
    body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'changed' })] }))
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'checkpoint_conflict');
});

test('checkpoint accepts a monotonic merged Cue update', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const url = `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`;
  const cue = finalCue({ segmentId: segment.id });

  await request(handler, { method: 'PUT', url, body: JSON.stringify(checkpoint({ meetingId: meeting.id, segmentId: segment.id, finalCues: [cue] })) });
  const response = await request(handler, {
    method: 'PUT',
    url,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      finalCues: [{ ...cue, sourceText: '你好世界', translatedText: 'hello world', endTimeMs: 200, finalizedReason: 'merged' }]
    }))
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().checkpoint.finalCues[0].sourceText, '你好世界');
});

test('checkpoint rejects an invalid final Cue with a structured error code', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const response = await request(handler, {
    method: 'PUT',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`,
    body: JSON.stringify(checkpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      finalCues: [{ cueId: 'cue-1' }]
    }))
  });

  assert.equal(response.status, 400);
  assert.equal(response.json().error.code, 'subtitle_cue_invalid');
  assert.match(response.json().error.requestId, /[0-9a-f-]{36}/);
});

test('POST /api/meetings/:meetingId/segments/:segmentId/rollover creates next segment', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/rollover`,
    body: JSON.stringify({
      idempotencyKey: 'rollover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })]
      }),
      nextLiveSessionId: 'live-session-2'
    })
  });

  assert.equal(response.status, 201);
  assert.equal(response.json().completedSegment.status, 'completed');
  assert.equal(response.json().completedSegment.liveSessionId, 'live-session-1');
  assert.equal(response.json().segment.sequence, 1);
  assert.equal(response.json().segment.status, 'active');
  assert.equal(response.json().segment.liveSessionId, 'live-session-2');
});

test('POST /api/meetings/:meetingId/segments/:segmentId/recover interrupts current segment and creates next segment', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/recover`,
    body: JSON.stringify({
      idempotencyKey: 'recover-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })]
      }),
      nextLiveSessionId: 'live-session-2',
      failureReason: 'token_expired',
      failureCategory: 'token',
      outcome: 'interrupted'
    })
  });

  assert.equal(response.status, 201);
  assert.equal(response.json().interruptedSegment.status, 'interrupted');
  assert.equal(response.json().interruptedSegment.checkpoint.idempotencyKey, 'recover-1');
  assert.deepEqual(response.json().interruptedSegment.errorInfo, { reason: 'token_expired', category: 'token' });
  assert.equal(response.json().segment.sequence, 1);
  assert.equal(response.json().segment.status, 'active');
  assert.equal(response.json().segment.liveSessionId, 'live-session-2');
});

test('POST /api/meetings/:meetingId/segments/:segmentId/recover fails current segment without next segment', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, {
    method: 'POST',
    url: '/api/meetings',
    body: JSON.stringify({ liveSessionId: 'live-session-1' })
  })).json();

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/recover`,
    body: JSON.stringify({
      idempotencyKey: 'recover-failed-1',
      checkpoint: checkpoint({
        meetingId: meeting.id,
        segmentId: segment.id,
        durableChunks: [chunk({ meetingId: meeting.id, segmentId: segment.id, sequence: 1, text: 'hello' })]
      }),
      nextLiveSessionId: 'live-session-2',
      failureReason: 'auth_failed',
      failureCategory: 'token',
      outcome: 'failed'
    })
  });
  const segments = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments` });

  assert.equal(response.status, 201);
  assert.equal(response.json().failedSegment.status, 'failed');
  assert.deepEqual(response.json().failedSegment.errorInfo, { reason: 'auth_failed', category: 'token' });
  assert.deepEqual(segments.json().segments.map((stored) => stored.id), ['segment-1']);
});

test('POST recovery conflict returns HTTP 409', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const url = `/api/meetings/${meeting.id}/segments/${segment.id}/recover`;
  const body = {
    idempotencyKey: 'recover-1',
    checkpoint: checkpoint({ meetingId: meeting.id, segmentId: segment.id }),
    nextLiveSessionId: 'live-session-2',
    failureReason: 'unexpected_close',
    failureCategory: 'provider',
    outcome: 'interrupted'
  };

  await request(handler, { method: 'POST', url, body: JSON.stringify(body) });
  const response = await request(handler, {
    method: 'POST',
    url,
    body: JSON.stringify({ ...body, nextLiveSessionId: 'live-session-3' })
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'checkpoint_conflict');
});

test('missing meeting or segment returns HTTP 404', async () => {
  const handler = createHandler();
  const { meeting } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();

  const missingMeeting = await request(handler, { method: 'GET', url: '/api/meetings/missing/segments' });
  const missingMeetingDetail = await request(handler, { method: 'GET', url: '/api/meetings/missing' });
  const missingSegment = await request(handler, { method: 'GET', url: `/api/meetings/${meeting.id}/segments/missing/checkpoint` });

  assert.equal(missingMeeting.status, 404);
  assert.equal(missingMeeting.json().error.code, 'meeting_not_found');
  assert.equal(missingMeetingDetail.status, 404);
  assert.equal(missingMeetingDetail.json().error.code, 'meeting_not_found');
  assert.equal(missingSegment.status, 404);
  assert.equal(missingSegment.json().error.code, 'meeting_segment_not_found');
});

test('GET checkpoint returns existing hydrated Cues with numeric offsets', async () => {
  const repository = createMemoryMeetingRepository();
  repository.createMeeting({ id: 'meeting-1', status: 'active', startedAt: 1000, createdAt: 1000 });
  repository.createMeetingSegment({
    id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'completed',
    startedAt: 1000, endedAt: 3000, createdAt: 1000,
    checkpoint: checkpoint({
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      finalCues: [finalCue({ startTimeMs: 1200, endTimeMs: 2500 })]
    })
  });
  const response = await request(createHandler({ meetingRepository: repository }), {
    method: 'GET',
    url: '/api/meetings/meeting-1/segments/segment-1/checkpoint'
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().checkpoint.finalCues[0].startTimeMs, 1200);
  assert.equal(response.json().checkpoint.finalCues[0].sourceLanguageCode, 'zh-Hant');
});

test('checkpoint route accepts UUID paths and identifies invalid UUID fields', async () => {
  const handler = createHandler({ strictCheckpointPathIds: true });
  const valid = await request(handler, {
    method: 'GET',
    url: '/api/meetings/0897cdf1-4726-4362-81d4-75f0c695be30/segments/c5347c33-9eb1-4a2a-b562-892c9d8749db/checkpoint'
  });
  assert.notEqual(valid.status, 400);

  const invalid = await request(handler, {
    method: 'GET',
    url: '/api/meetings/not-a-uuid/segments/c5347c33-9eb1-4a2a-b562-892c9d8749db/checkpoint'
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.json().error.details, ['meetingId must be a valid UUID.']);
});

test('GET checkpoint identifies a segment without a stored checkpoint', async () => {
  const handler = createHandler();
  const { meeting, segment } = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const response = await request(handler, {
    method: 'GET',
    url: `/api/meetings/${meeting.id}/segments/${segment.id}/checkpoint`
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().checkpoint, null);
});

test('completes an interrupted meeting through the HTTP API', async () => {
  const handler = createHandler();
  const created = (await request(handler, { method: 'POST', url: '/api/meetings' })).json();
  const recovered = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/segments/${created.segment.id}/recover`,
    body: JSON.stringify({
      idempotencyKey: 'http-interrupt-1',
      checkpoint: { idempotencyKey: 'http-checkpoint-1', durableChunks: [], pendingPartial: null },
      nextLiveSessionId: null,
      failureReason: 'unexpected_close',
      failureCategory: 'provider',
      outcome: 'interrupted'
    })
  });
  assert.equal(recovered.status, 201);

  const response = await request(handler, {
    method: 'POST',
    url: `/api/meetings/${created.meeting.id}/complete`
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().meeting.status, 'completed');
});

test('checkpoint route reports invalid segment UUID details and request id', async () => {
  const handler = createHandler({ strictCheckpointPathIds: true });
  const response = await request(handler, {
    method: 'GET',
    url: '/api/meetings/0897cdf1-4726-4362-81d4-75f0c695be30/segments/c5347c3-9eb1-4a2a-b562-892c9d8749db/checkpoint'
  });
  assert.equal(response.status, 400);
  const body = response.json();
  assert.deepEqual(body.error.details, ['segmentId must be a valid UUID.']);
  assert.equal(body.error.requestId, response.headers['X-Request-Id']);
});

function createHandler({ meetingCheckpointMaxBytes, sessionShareService, sessionRepository, meetingEventBroadcaster, meetingAudioService, viewerRealtimeTokenService, meetingRepository, meetingMembershipService, meetingDeletionService: injectedMeetingDeletionService, accessControl, profileService, strictCheckpointPathIds = false, requestLogger } = {}) {
  const repository = meetingRepository || createMemoryMeetingRepository();
  let meetingId = 0;
  let segmentId = 0;
  const meetingCheckpointService = createMeetingCheckpointService({
    meetingRepository: repository,
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

function checkpoint({ meetingId, segmentId, durableChunks = [], finalCues = [] }) {
  return {
    idempotencyKey: 'checkpoint-1',
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
