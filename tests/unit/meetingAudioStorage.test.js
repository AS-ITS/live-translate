import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordingDiagnostics } from '../../src/lib/recordingDiagnostics.js';
import { uploadMeetingSegmentAudio } from '../../src/lib/meetingAudioStorage.js';
import { clearMeetingLifecycleWriteFence, setMeetingLifecycleWriteFence } from '../../src/lib/meetingLifecycleWriteFence.js';

test('meeting audio upload records TUS progress without changing the direct upload path', async () => {
  const calls = [];
  const diagnostics = createRecordingDiagnostics({ enabled: true, now: () => 100 });
  const supabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'test-token' } } };
      }
    }
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/audio-uploads')) {
      return response({
        id: 'artifact-1',
        status: 'uploading',
        uploadEndpoint: 'https://storage.example/tus',
        bucket: 'meeting-audio',
        objectPath: 'owner-1/meeting-1/segment-1/recording.webm'
      }, 201);
    }
    return response({ id: 'artifact-1', status: 'ready' });
  };
  class FakeUpload {
    constructor(blob, options) {
      this.blob = blob;
      this.options = options;
    }

    async findPreviousUploads() {
      return [];
    }

    start() {
      this.options.onProgress?.(2, this.blob.size);
      this.options.onSuccess?.();
    }
  }

  const artifact = await uploadMeetingSegmentAudio({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    blob: new Blob(['audio'], { type: 'audio/webm' }),
    fetchImpl,
    UploadImpl: FakeUpload,
    diagnostics,
    supabaseClient
  });

  assert.equal(artifact.status, 'ready');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(diagnostics.snapshot().upload, {
    status: 'ready',
    startedAt: 100,
    durationMs: 0,
    byteSize: 5,
    uploadedBytes: 2,
    retryCount: 0,
    errorCode: null
  });
});

test('meeting audio upload-start includes the active lifecycle fence', async () => {
  setMeetingLifecycleWriteFence({
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    leaseId: 'lease-1',
    fenceToken: 7
  });
  try {
    const calls = [];
    const artifact = await uploadMeetingSegmentAudio({
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      blob: new Blob(['RIFF-audio'], { type: 'audio/wav' }),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return response({ id: 'artifact-1', status: 'ready' }, 201);
      },
      supabaseClient: { auth: { async getSession() { return { data: { session: null } }; } } }
    });

    assert.equal(artifact.status, 'ready');
    assert.deepEqual(calls[0].options.headers, {
      'Content-Type': 'application/json',
      'x-meeting-session-id': 'session-1',
      'x-meeting-segment-id': 'segment-1',
      'x-meeting-lease-id': 'lease-1',
      'x-meeting-fence-token': '7'
    });
    assert.deepEqual(JSON.parse(calls[0].options.body), { mimeType: 'audio/wav', byteSize: 10 });
  } finally {
    clearMeetingLifecycleWriteFence('meeting-1');
  }
});

test('delayed TUS completion yields while realtime work can continue', async () => {
  let resolveUpload;
  let realtimeTicks = 0;
  const diagnostics = createRecordingDiagnostics({ enabled: true, now: () => 100 });
  const supabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'test-token' } } };
      }
    }
  };
  const fetchImpl = async (url) => response(url.endsWith('/audio-uploads')
    ? {
      id: 'artifact-delayed',
      status: 'uploading',
      uploadEndpoint: 'https://storage.example/tus',
      bucket: 'meeting-audio',
      objectPath: 'owner-1/meeting-1/segment-1/recording.webm'
    }
    : { id: 'artifact-delayed', status: 'ready' });
  class DelayedUpload {
    constructor(blob, options) {
      this.blob = blob;
      this.options = options;
    }

    async findPreviousUploads() {
      return [];
    }

    start() {
      resolveUpload = () => {
        this.options.onProgress?.(this.blob.size, this.blob.size);
        this.options.onSuccess?.();
      };
    }
  }

  const uploadPromise = uploadMeetingSegmentAudio({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    blob: new Blob(['audio'], { type: 'audio/webm' }),
    fetchImpl,
    UploadImpl: DelayedUpload,
    diagnostics,
    supabaseClient
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  realtimeTicks += 1;
  assert.equal(realtimeTicks, 1);
  assert.equal(diagnostics.snapshot().upload.status, 'uploading');

  assert.equal(typeof resolveUpload, 'function');
  resolveUpload();
  await uploadPromise;
  assert.equal(diagnostics.snapshot().upload.status, 'ready');
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
