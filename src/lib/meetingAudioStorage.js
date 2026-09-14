import { Upload } from 'tus-js-client';
import { authenticatedFetch } from './accessToken.js';
import { supabase } from './supabaseAuth.js';

const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
const TUS_RETRY_DELAYS = Object.freeze([0, 1000, 3000, 5000]);

export function cloudMeetingAudioEnabled() {
  return Boolean(supabase && import.meta.env?.VITE_SUPABASE_URL);
}

export async function uploadMeetingSegmentAudio({ meetingId, segmentId, blob, fetchImpl = globalThis.fetch, UploadImpl = Upload } = {}) {
  if (!meetingId || !segmentId || !blob || !Number.isFinite(blob.size) || blob.size < 1) return null;
  const mimeType = normalizeWebmMimeType(blob.type);
  const request = authenticatedFetch(fetchImpl);
  const startResponse = await request(`/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/audio-uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType, byteSize: blob.size })
  });
  if (!startResponse.ok) throw await responseError(startResponse);
  const upload = await startResponse.json();
  if (upload.status === 'ready') return upload;

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw clientError('auth_required', 401);
  try {
    await runTusUpload({ blob, upload, accessToken, mimeType, UploadImpl });
  } catch (error) {
    await request(`/api/meetings/${encodeURIComponent(meetingId)}/audio-artifacts/${encodeURIComponent(upload.id)}/fail`, {
      method: 'POST'
    }).catch(() => {});
    throw error;
  }

  const completeResponse = await request(`/api/meetings/${encodeURIComponent(meetingId)}/audio-artifacts/${encodeURIComponent(upload.id)}/complete`, { method: 'POST' });
  if (!completeResponse.ok) throw await responseError(completeResponse);
  return completeResponse.json();
}

export async function createMeetingAudioDownload({ meetingId, artifactId, fetchImpl = globalThis.fetch }) {
  const response = await authenticatedFetch(fetchImpl)(`/api/meetings/${encodeURIComponent(meetingId)}/audio-artifacts/${encodeURIComponent(artifactId)}/download-url`, { method: 'POST' });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

function runTusUpload({ blob, upload, accessToken, mimeType, UploadImpl }) {
  return new Promise((resolve, reject) => {
    const uploader = new UploadImpl(blob, {
      endpoint: upload.uploadEndpoint,
      uploadSize: blob.size,
      chunkSize: TUS_CHUNK_SIZE,
      retryDelays: [...TUS_RETRY_DELAYS],
      removeFingerprintOnSuccess: true,
      headers: { authorization: `Bearer ${accessToken}`, 'x-upsert': 'false' },
      metadata: {
        bucketName: upload.bucket,
        objectName: upload.objectPath,
        contentType: mimeType,
        cacheControl: '3600'
      },
      onError: reject,
      onSuccess: resolve
    });
    uploader.findPreviousUploads().then((previousUploads) => {
      if (previousUploads[0]) uploader.resumeFromPreviousUpload(previousUploads[0]);
      uploader.start();
    }).catch(reject);
  });
}

function normalizeWebmMimeType(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'audio/webm' || normalized === 'audio/webm;codecs=opus') return normalized;
  throw clientError('audio_mime_type_unsupported', 400);
}

async function responseError(response) {
  const payload = await response.json().catch(() => ({}));
  return clientError(payload?.error?.code || 'cloud_capability_unavailable', response.status);
}

function clientError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
