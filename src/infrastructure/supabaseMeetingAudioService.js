import { randomUUID } from 'node:crypto';
import { currentRequestUserId } from '../../server/requestIdentity.js';
import { createSupabaseRestClient, eq } from './supabaseRestClient.js';

export const MEETING_AUDIO_BUCKET = 'meeting-audio';
export const MEETING_AUDIO_KIND = 'source_webm';
export const MP3_AUDIO_KIND = 'mp3';
export const MEETING_AUDIO_MAX_BYTES = 64 * 1024 * 1024;
export const MEETING_AUDIO_MIME_TYPES = Object.freeze([
  'audio/webm',
  'audio/webm;codecs=opus'
]);

export function createSupabaseMeetingAudioService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  idFactory = randomUUID
} = {}) {
  const client = createSupabaseRestClient({ env, fetchImpl });
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!client || !baseUrl || !secretKey || typeof fetchImpl !== 'function') return null;

  const service = {
    requiresRequestIdentity: true,

    async beginUpload({ meetingId, segmentId, mimeType, byteSize }) {
      const ownerUserId = owner();
      validateMimeType(mimeType);
      validateByteSize(byteSize);
      await requireOwnedSegment(client, { ownerUserId, meetingId, segmentId });

      const objectPath = meetingAudioObjectPath({ ownerUserId, meetingId, segmentId });
      const existing = await findArtifact(client, { ownerUserId, meetingId, segmentId });
      if (existing?.status === 'ready') return artifactDTO(existing);

      const row = {
        id: existing?.id || idFactory(),
        owner_user_id: ownerUserId,
        meeting_id: meetingId,
        segment_id: segmentId,
        session_id: null,
        storage_path: objectPath,
        kind: MEETING_AUDIO_KIND,
        file_name: 'recording.webm',
        byte_size: byteSize,
        mime_type: mimeType,
        status: 'uploading',
        updated_at: new Date(clock()).toISOString()
      };

      const rows = existing
        ? await client.request('audio_artifacts', {
          method: 'PATCH',
          query: `?${eq('id', existing.id)}&${eq('owner_user_id', ownerUserId)}`,
          body: row
        })
        : await client.request('audio_artifacts', { method: 'POST', body: [row] });

      return {
        ...artifactDTO(rows[0] || row),
        bucket: MEETING_AUDIO_BUCKET,
        objectPath,
        uploadEndpoint: `${baseUrl}/storage/v1/upload/resumable`,
        maxBytes: MEETING_AUDIO_MAX_BYTES
      };
    },

    async completeUpload({ meetingId, artifactId }) {
      const ownerUserId = owner();
      const artifact = await requireArtifact(client, { ownerUserId, meetingId, artifactId });
      const object = await storageRequest(fetchImpl, {
        baseUrl,
        secretKey,
        method: 'GET',
        path: `/object/info/${MEETING_AUDIO_BUCKET}/${encodeStoragePath(artifact.storage_path)}`
      });
      const byteSize = Number(object?.metadata?.size ?? object?.size ?? artifact.byte_size);
      const mimeType = String(object?.metadata?.mimetype ?? object?.metadata?.contentType ?? artifact.mime_type ?? '');
      validateByteSize(byteSize);
      validateMimeType(mimeType);

      const rows = await client.request('audio_artifacts', {
        method: 'PATCH',
        query: `?${eq('id', artifact.id)}&${eq('owner_user_id', ownerUserId)}`,
        body: {
          byte_size: byteSize,
          mime_type: mimeType,
          status: 'ready',
          updated_at: new Date(clock()).toISOString()
        }
      });
      return artifactDTO(rows[0] || { ...artifact, byte_size: byteSize, mime_type: mimeType, status: 'ready' });
    },

    async failUpload({ meetingId, artifactId }) {
      const ownerUserId = owner();
      const artifact = await requireArtifact(client, { ownerUserId, meetingId, artifactId });
      if (artifact.status === 'ready') return artifactDTO(artifact);
      const rows = await client.request('audio_artifacts', {
        method: 'PATCH',
        query: `?${eq('id', artifact.id)}&${eq('owner_user_id', ownerUserId)}`,
        body: { status: 'failed', updated_at: new Date(clock()).toISOString() }
      });
      return artifactDTO(rows[0] || { ...artifact, status: 'failed' });
    },

    async retryArtifact({ meetingId, artifactId }) {
      const ownerUserId = owner();
      const artifact = await requireArtifact(client, { ownerUserId, meetingId, artifactId });
      if (artifact.kind !== MP3_AUDIO_KIND || artifact.status !== 'failed') {
        throw audioError('audio_artifact_not_retryable', 409);
      }
      const rows = await client.request('audio_artifacts', {
        method: 'PATCH',
        query: `?${eq('id', artifact.id)}&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}`,
        body: { status: 'queued', error_code: null, updated_at: new Date(clock()).toISOString() }
      });
      return artifactDTO(rows[0] || { ...artifact, status: 'queued', error_code: null });
    },

    async createDownloadUrl({ meetingId, artifactId, expiresIn = 60 }) {
      const ownerUserId = owner();
      const artifact = await requireArtifact(client, { ownerUserId, meetingId, artifactId });
      if (artifact.status !== 'ready') throw audioError('audio_artifact_not_ready', 409);
      const signed = await storageRequest(fetchImpl, {
        baseUrl,
        secretKey,
        method: 'POST',
        path: `/object/sign/${MEETING_AUDIO_BUCKET}/${encodeStoragePath(artifact.storage_path)}`,
        body: { expiresIn }
      });
      const signedPath = signed?.signedURL || signed?.signedUrl;
      if (!signedPath) throw audioError('cloud_capability_unavailable', 503);
      return {
        url: signedPath.startsWith('http') ? signedPath : `${baseUrl}/storage/v1${signedPath}`,
        expiresAt: clock() + expiresIn * 1000,
        fileName: artifact.file_name || 'recording.webm',
        mimeType: artifact.mime_type,
        byteSize: artifact.byte_size
      };
    },

    async listMeetingArtifacts(meetingId) {
      const ownerUserId = owner();
      const rows = await client.request('audio_artifacts', {
        query: `?select=*&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}&order=created_at.asc`
      });
      return rows.map(artifactDTO);
    },

    async deleteMeetingArtifacts(meetingId) {
      const ownerUserId = owner();
      const rows = await client.request('audio_artifacts', {
        query: `?select=*&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}`
      });
      if (rows.length > 0) {
        await storageRequest(fetchImpl, {
          baseUrl,
          secretKey,
          method: 'DELETE',
          path: `/object/${MEETING_AUDIO_BUCKET}`,
          body: { prefixes: rows.map((row) => row.storage_path) }
        });
      }
      return rows.length;
    }
  };

  return Object.freeze(service);
}

export function meetingAudioObjectPath({ ownerUserId, meetingId, segmentId }) {
  for (const [name, value] of Object.entries({ ownerUserId, meetingId, segmentId })) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]+$/u.test(value)) {
      throw new TypeError(`${name} must contain only letters, digits, and hyphens.`);
    }
  }
  return `${ownerUserId}/${meetingId}/${segmentId}/recording.webm`;
}

function owner() {
  const userId = currentRequestUserId();
  if (!userId) throw audioError('auth_required', 401);
  return userId;
}

async function requireOwnedSegment(client, { ownerUserId, meetingId, segmentId }) {
  const rows = await client.request('meeting_segments', {
    query: `?select=id&${eq('id', segmentId)}&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}`
  });
  if (!rows[0]) throw audioError('meeting_segment_not_found', 404);
}

async function findArtifact(client, { ownerUserId, meetingId, segmentId }) {
  const rows = await client.request('audio_artifacts', {
    query: `?select=*&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}&${eq('segment_id', segmentId)}&${eq('kind', MEETING_AUDIO_KIND)}`
  });
  return rows[0] || null;
}

async function requireArtifact(client, { ownerUserId, meetingId, artifactId }) {
  const rows = await client.request('audio_artifacts', {
    query: `?select=*&${eq('id', artifactId)}&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}`
  });
  if (!rows[0]) throw audioError('audio_artifact_not_found', 404);
  return rows[0];
}

function artifactDTO(row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    segmentId: row.segment_id,
    kind: row.kind,
    status: row.status,
    fileName: row.file_name,
    byteSize: Number(row.byte_size) || 0,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(Object.hasOwn(row, 'attempt') ? { attempt: Number(row.attempt) || 0 } : {}),
    ...(Object.hasOwn(row, 'error_code') ? { errorCode: row.error_code || null } : {})
  };
}

function validateMimeType(value) {
  if (!MEETING_AUDIO_MIME_TYPES.includes(value)) throw audioError('audio_mime_type_unsupported', 400);
}

function validateByteSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > MEETING_AUDIO_MAX_BYTES) {
    throw audioError(value > MEETING_AUDIO_MAX_BYTES ? 'request_too_large' : 'invalid_request', value > MEETING_AUDIO_MAX_BYTES ? 413 : 400);
  }
}

async function storageRequest(fetchImpl, { baseUrl, secretKey, method, path, body }) {
  const response = await fetchImpl(`${baseUrl}/storage/v1${path}`, {
    method,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) throw audioError(response.status === 404 ? 'audio_artifact_not_found' : 'cloud_capability_unavailable', response.status === 404 ? 404 : 503);
  return response.status === 204 ? {} : response.json();
}

function encodeStoragePath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function audioError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
