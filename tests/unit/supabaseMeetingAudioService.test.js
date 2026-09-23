import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseMeetingAudioService, meetingAudioObjectPath } from '../../src/infrastructure/supabaseMeetingAudioService.js';
import { setRequestUser } from '../../server/requestIdentity.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('private meeting audio service scopes metadata and signed URLs to the request owner', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.includes('/rest/v1/meeting_segments')) return response([{ id: 'segment-1' }]);
    if (url.includes('/rest/v1/audio_artifacts') && options.method === 'POST') return response([{ id: 'artifact-1', meeting_id: 'meeting-1', segment_id: 'segment-1', kind: 'source_webm', status: 'uploading', file_name: 'recording.webm', byte_size: 123, mime_type: 'audio/webm' }]);
    if (url.includes('/object/sign/')) return response({ signedURL: '/object/sign/meeting-audio/user-1/meeting-1/segment-1/recording.webm?token=x' });
    if (url.includes('/rest/v1/audio_artifacts')) return response([{ id: 'artifact-1', meeting_id: 'meeting-1', segment_id: 'segment-1', storage_path: 'user-1/meeting-1/segment-1/recording.webm', kind: 'source_webm', status: 'ready', file_name: 'recording.webm', byte_size: 123, mime_type: 'audio/webm' }]);
    return response({ size: 123, metadata: { mimetype: 'audio/webm' } });
  };
  const service = createSupabaseMeetingAudioService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl,
    idFactory: () => 'artifact-1',
    clock: () => 1_000
  });
  setRequestUser({ id: 'user-1' });

  const started = await service.beginUpload({ meetingId: 'meeting-1', segmentId: 'segment-1', mimeType: 'audio/webm', byteSize: 123 });
  const download = await service.createDownloadUrl({ meetingId: 'meeting-1', artifactId: 'artifact-1' });

  assert.equal(started.id, 'artifact-1');
  assert.equal(download.url, 'https://project.supabase.co/storage/v1/object/sign/meeting-audio/user-1/meeting-1/segment-1/recording.webm?token=x');
  assert.match(calls.find(([url]) => url.includes('/rest/v1/meeting_segments'))[0], /owner_user_id=eq\.user-1/);
  assert.match(calls.find(([url]) => url.includes('/rest/v1/audio_artifacts') && url.includes('artifact-1'))[0], /owner_user_id=eq\.user-1/);
});

test('meeting audio object paths reject traversal and preserve canonical layout', () => {
  assert.equal(meetingAudioObjectPath({ ownerUserId: 'user-1', meetingId: 'meeting-1', segmentId: 'segment-1' }), 'user-1/meeting-1/segment-1/recording.webm');
  assert.throws(() => meetingAudioObjectPath({ ownerUserId: '../user', meetingId: 'meeting-1', segmentId: 'segment-1' }), /ownerUserId/);
});

test('private meeting audio service rejects calls without a request owner', async () => {
  const service = createSupabaseMeetingAudioService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async () => response([])
  });
  setRequestUser(null);

  await assert.rejects(
    () => service.listMeetingArtifacts('meeting-1'),
    (error) => error.code === 'auth_required' && error.status === 401
  );
});

test('v2 terminal meeting audio artifacts may complete or fail before the purge deadline', async () => {
  const calls = [];
  const artifact = sampleArtifact();
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.includes('/rest/v1/meetings')) return response([{
      lifecycle_contract_version: 2,
      status: 'completed',
      purge_at: new Date(2_000).toISOString()
    }]);
    if (url.includes('/object/info/')) return response({ size: 123, metadata: { mimetype: 'audio/webm' } });
    if (url.includes('/rest/v1/audio_artifacts') && options.method === 'PATCH') {
      return response([{ ...artifact, status: options.body.includes('ready') ? 'ready' : 'failed' }]);
    }
    if (url.includes('/rest/v1/audio_artifacts')) return response([artifact]);
    return response([]);
  };
  const service = createAudioService(fetchImpl, () => 1_000);
  setRequestUser({ id: 'user-1' });

  const completed = await service.completeUpload({ meetingId: 'meeting-1', artifactId: 'artifact-1' });
  const failed = await service.failUpload({ meetingId: 'meeting-1', artifactId: 'artifact-1' });

  assert.equal(completed.status, 'ready');
  assert.equal(failed.status, 'failed');
  assert.equal(calls.filter(([url]) => url.includes('/rest/v1/meetings')).length, 2);
});

test('v2 terminal meeting audio artifact writes reject after the purge deadline', async () => {
  const calls = [];
  const artifact = sampleArtifact();
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.includes('/rest/v1/meetings')) return response([{
      lifecycle_contract_version: 2,
      status: 'completed',
      purge_at: new Date(1_000).toISOString()
    }]);
    if (url.includes('/rest/v1/audio_artifacts')) return response([artifact]);
    return response({ size: 123, metadata: { mimetype: 'audio/webm' } });
  };
  const service = createAudioService(fetchImpl, () => 1_000);
  setRequestUser({ id: 'user-1' });

  for (const action of ['completeUpload', 'failUpload']) {
    await assert.rejects(
      () => service[action]({ meetingId: 'meeting-1', artifactId: 'artifact-1' }),
      (error) => error.code === 'meeting_terminal' && error.status === 409
    );
  }

  assert.equal(calls.some(([url]) => url.includes('/object/info/')), false);
  assert.equal(calls.some(([url, options]) => url.includes('/rest/v1/audio_artifacts') && options.method === 'PATCH'), false);
});

test('legacy meeting audio artifact completion ignores absent v2 lifecycle fields', async () => {
  const artifact = sampleArtifact();
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/rest/v1/meetings')) return response([{ status: 'completed', purge_at: new Date(1_000).toISOString() }]);
    if (url.includes('/object/info/')) return response({ size: 123, metadata: { mimetype: 'audio/webm' } });
    if (url.includes('/rest/v1/audio_artifacts') && options.method === 'PATCH') return response([{ ...artifact, status: 'ready' }]);
    if (url.includes('/rest/v1/audio_artifacts')) return response([artifact]);
    return response([]);
  };
  const service = createAudioService(fetchImpl, () => 2_000);
  setRequestUser({ id: 'user-1' });

  const completed = await service.completeUpload({ meetingId: 'meeting-1', artifactId: 'artifact-1' });

  assert.equal(completed.status, 'ready');
});

function createAudioService(fetchImpl, clock) {
  return createSupabaseMeetingAudioService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl,
    clock
  });
}

function sampleArtifact() {
  return {
    id: 'artifact-1',
    meeting_id: 'meeting-1',
    segment_id: 'segment-1',
    storage_path: 'user-1/meeting-1/segment-1/recording.webm',
    kind: 'source_webm',
    status: 'uploading',
    file_name: 'recording.webm',
    byte_size: 123,
    mime_type: 'audio/webm'
  };
}
