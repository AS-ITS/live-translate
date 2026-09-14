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
