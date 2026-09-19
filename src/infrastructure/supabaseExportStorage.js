import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

export const MEETING_EXPORT_BUCKET = 'meeting-exports';

export function createSupabaseExportStorage({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!client || !baseUrl || !secretKey) return null;

  return Object.freeze({
    async put({ path, bytes, contentType }) {
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/${MEETING_EXPORT_BUCKET}/${encodeStoragePath(path)}`, {
        method: 'POST',
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': contentType,
          'x-upsert': 'true'
        },
        body: bytes
      });
      if (!response.ok) throw storageError('export_storage_upload_failed', 503);
      return true;
    },

    async remove({ path, paths } = {}) {
      const prefixes = paths || (path ? [path] : []);
      if (prefixes.length === 0) return true;
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/${MEETING_EXPORT_BUCKET}`, {
        method: 'DELETE',
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prefixes })
      });
      if (!response.ok) throw storageError('export_storage_delete_failed', 503);
      return true;
    },

    async createSignedUrl({ path, expiresIn = 60 }) {
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/sign/${MEETING_EXPORT_BUCKET}/${encodeStoragePath(path)}`, {
        method: 'POST',
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expiresIn })
      });
      if (!response.ok) throw storageError('cloud_capability_unavailable', 503);
      const body = await response.json();
      const signedPath = body?.signedURL || body?.signedUrl;
      if (!signedPath) throw storageError('cloud_capability_unavailable', 503);
      return {
        url: signedPath.startsWith('http') ? signedPath : `${baseUrl}/storage/v1${signedPath}`,
        expiresAt: clock() + expiresIn * 1000
      };
    }
  });
}

function encodeStoragePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function storageError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
