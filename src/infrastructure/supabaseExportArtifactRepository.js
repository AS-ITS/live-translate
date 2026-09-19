import { eq } from './supabaseRestClient.js';
import { createSupabaseContextClient, requireSupabaseContextClient } from './supabaseRequestClient.js';

export function createSupabaseExportArtifactRepository({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const clientForContext = createSupabaseContextClient({ env, fetchImpl });
  const client = { request: (...args) => requireSupabaseContextClient(clientForContext).request(...args) };

  return Object.freeze({
    async findByKey({ ownerUserId, meetingId, sourceHash, format, stream }) {
      const rows = await client.request('export_artifacts', {
        query: `?select=*&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}&${eq('source_hash', sourceHash)}&${eq('format', format)}&${eq('stream', stream)}&limit=1`
      });
      return rows[0] ? fromRow(rows[0]) : null;
    },

    async create(input) {
      const rows = await client.request('export_artifacts', { method: 'POST', body: [toRow(input)] });
      return fromRow(rows[0] || input);
    },

    async getById(id, ownerUserId, meetingId) {
      const rows = await client.request('export_artifacts', {
        query: `?select=*&${eq('id', id)}&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}&limit=1`
      });
      return rows[0] ? fromRow(rows[0]) : null;
    },

    async listByMeeting({ ownerUserId, meetingId }) {
      const rows = await client.request('export_artifacts', {
        query: `?select=*&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}&order=created_at.desc`
      });
      return rows.map(fromRow);
    },

    async update(id, ownerUserId, patch) {
      const rows = await client.request('export_artifacts', {
        method: 'PATCH',
        query: `?${eq('id', id)}&${eq('owner_user_id', ownerUserId)}`,
        body: toPatch(patch)
      });
      return fromRow(rows[0] || { id, owner_user_id: ownerUserId, ...toPatch(patch) });
    },

    async remove(id, ownerUserId, meetingId) {
      await client.request('export_artifacts', {
        method: 'DELETE',
        query: `?${eq('id', id)}&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}`
      });
      return true;
    },

    async removeByMeeting({ ownerUserId, meetingId }) {
      await client.request('export_artifacts', {
        method: 'DELETE',
        query: `?${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}`
      });
      return true;
    }
  });
}

function toRow(value = {}) {
  return {
    id: value.id,
    owner_user_id: value.ownerUserId,
    meeting_id: value.meetingId,
    storage_path: value.storagePath,
    format: value.format,
    stream: value.stream,
    source_hash: value.sourceHash,
    status: value.status,
    file_name: value.fileName,
    mime_type: value.mimeType,
    byte_size: value.byteSize ?? null,
    error_code: value.errorCode ?? null,
    attempt: value.attempt ?? 0,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    completed_at: value.completedAt ?? null
  };
}

function toPatch(value = {}) {
  const result = {};
  const fields = {
    sourceHash: 'source_hash',
    status: 'status',
    fileName: 'file_name',
    mimeType: 'mime_type',
    byteSize: 'byte_size',
    errorCode: 'error_code',
    attempt: 'attempt',
    updatedAt: 'updated_at',
    completedAt: 'completed_at'
  };
  for (const [name, column] of Object.entries(fields)) {
    if (Object.hasOwn(value, name)) result[column] = value[name];
  }
  return result;
}

function fromRow(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    meetingId: row.meeting_id,
    storagePath: row.storage_path,
    format: row.format,
    stream: row.stream,
    sourceHash: row.source_hash,
    status: row.status,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    errorCode: row.error_code,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}
