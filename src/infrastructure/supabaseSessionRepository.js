import { createSessionRecord as createSessionRecordModel, createTranscriptItemForSession, finalizeSessionRecord as finalizeSessionRecordModel, summarizeTranscriptItems, updateSessionRecord as updateSessionRecordModel } from '../lib/sessionRecords.js';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { createSupabaseServiceRoleClient, eq } from './supabaseRestClient.js';
import { createSupabaseRequestClient, requireSupabaseRequestClient } from './supabaseRequestClient.js';

export function createSupabaseSessionRepository(options = {}) {
  const clientForRequest = createSupabaseRequestClient(options);
  const privileged = createSupabaseServiceRoleClient(options);
  const client = { request: (...args) => requireSupabaseRequestClient(clientForRequest).request(...args) };
  const idFactory = options.idFactory;
  const owner = () => currentRequestOwnerId() || failOwner();
  const repository = {
    // Startup runs outside an authenticated HTTP request. Persisted recovery
    // must not attempt to list owner-scoped records without request identity.
    requiresRequestIdentity: true,
    async createSessionRecord(input = {}) {
      const record = createSessionRecordModel({ ...input, ownerUserId: owner() }, { ...input, idFactory });
      if (Number(input.lifecycleContractVersion ?? input.lifecycle_contract_version) === 2) record.lifecycleContractVersion = 2;
      const rows = await client.request('sessions', { method: 'POST', body: [sessionRow(record, owner())] });
      return { ...clone(record), recordingId: rows[0]?.recording_id || null };
    },
    async updateSessionRecord(id, patch = {}) {
      const detail = await this.getSessionRecord(id); if (!detail) throw notFound(id);
      const record = updateSessionRecordModel(detail.sessionRecord, patch);
      await client.request('sessions', { method: 'PATCH', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}`, body: sessionRow(record, owner(), detail.transcriptItems) });
      return clone(record);
    },
    async appendTranscriptItem(sessionId, item = {}) {
      const detail = await this.getSessionRecord(sessionId); if (!detail) throw notFound(sessionId);
      if (isLifecycleV2Session(detail.sessionRecord)) {
        return clone(createTranscriptItemForSession(sessionId, item));
      }
      const next = [...detail.transcriptItems, createTranscriptItemForSession(sessionId, item)];
      const record = updateSessionRecordModel(detail.sessionRecord, { transcriptSummary: summarizeTranscriptItems(next) });
      await client.request('sessions', { method: 'PATCH', query: `?${eq('id', sessionId)}&${eq('owner_user_id', owner())}`, body: sessionRow(record, owner(), next) });
      return clone(next[next.length - 1]);
    },
    async finalizeSessionRecord(id, patch = {}) {
      const detail = await this.getSessionRecord(id); if (!detail) throw notFound(id);
      const record = finalizeSessionRecordModel(detail.sessionRecord, { ...patch, transcriptSummary: patch.transcriptSummary || summarizeTranscriptItems(detail.transcriptItems) });
      await client.request('sessions', { method: 'PATCH', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}`, body: sessionRow(record, owner(), detail.transcriptItems) });
      return clone(record);
    },
    async listSessionRecords() {
      const rows = await client.request('sessions', { query: `?select=*&${eq('owner_user_id', owner())}&order=created_at.desc` });
      return rows.map(sessionRecordFromRow);
    },
    async getSessionOwner(id) {
      const rows = await client.request('sessions', { query: `?select=meeting_id,owner_user_id&id=${encodeURIComponent(id)}` });
      if (!rows[0]) return null;
      return { meetingId: rows[0].meeting_id, ownerUserId: rows[0].owner_user_id };
    },
    async getSessionRecord(id) {
      const rows = await client.request('sessions', { query: `?select=*&${eq('id', id)}&${eq('owner_user_id', owner())}` });
      if (!rows[0]) return null;
      return { sessionRecord: sessionRecordFromRow(rows[0]), transcriptItems: clone(rows[0].transcript_items || []) };
    },
    async deleteSessionRecord(id) {
      const existing = await this.getSessionRecord(id); if (!existing) return false;
      if (!privileged) {
        const error = new Error('Controlled session deletion is unavailable.');
        error.code = 'cloud_capability_unavailable';
        error.status = 503;
        throw error;
      }
      await privileged.request('sessions', { method: 'DELETE', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}` });
      return true;
    }
  };
  return Object.freeze(repository);
}

function sessionRecordFromRow(row) {
  const payload = clone(row.payload || row);
  const databaseSegmentId = row.current_segment_id || row.segment_id || null;
  const record = {
    ...payload,
    id: row.id || payload.id,
    meetingId: row.meeting_id || payload.meetingId,
    // Lifecycle v2 moves the active Segment atomically in SQL. The JSON payload
    // is only a snapshot and can still contain the previous Segment after a
    // rollover, so it must never override the relational ownership columns.
    segmentId: databaseSegmentId || payload.segmentId || null,
    recordingId: row.recording_id || payload.recordingId || null,
    ownerUserId: row.owner_user_id || payload.ownerUserId
  };

  return Number(row.lifecycle_contract_version) === 2
    ? { ...record, lifecycleContractVersion: 2 }
    : record;
}

function isLifecycleV2Session(record) {
  return Number(record?.lifecycleContractVersion) === 2;
}

function sessionRow(record, ownerUserId, transcriptItems = []) {
  return {
    id: record.id,
    owner_user_id: ownerUserId,
    meeting_id: record.meetingId,
    ...(record.recordingId ? { recording_id: record.recordingId } : {}),
    ...(isLifecycleV2Session(record)
      ? { lifecycle_contract_version: 2, segment_id: null }
      : { segment_id: record.segmentId }),
    status: record.status,
    source_language_code: record.sourceLanguageCode,
    target_language_code: record.targetLanguageCode,
    started_at: toSupabaseTimestamp(record.startedAt),
    ended_at: toSupabaseTimestamp(record.endedAt),
    created_at: toSupabaseTimestamp(record.createdAt),
    payload: record,
    transcript_items: isLifecycleV2Session(record) ? [] : transcriptItems
  };
}
function toSupabaseTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const milliseconds = Date.parse(value);
    if (!Number.isNaN(milliseconds)) return new Date(milliseconds).toISOString();
  }
  return value;
}
function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
function failOwner() { const error = new Error('Authenticated owner required.'); error.code = 'auth_required'; error.status = 401; throw error; }
function notFound(id) { const error = new Error(`Session record not found: ${id}`); error.code = 'session_not_found'; error.status = 404; return error; }
