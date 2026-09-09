import { createSessionRecord as createSessionRecordModel, createTranscriptItemForSession, finalizeSessionRecord as finalizeSessionRecordModel, summarizeTranscriptItems, updateSessionRecord as updateSessionRecordModel } from '../lib/sessionRecords.js';
import { currentRequestUserId } from '../../server/requestIdentity.js';
import { createSupabaseRestClient, eq } from './supabaseRestClient.js';

export function createSupabaseSessionRepository(options = {}) {
  const client = createSupabaseRestClient(options);
  if (!client) return null;
  const owner = () => currentRequestUserId() || failOwner();
  const repository = {
    // Startup runs outside an authenticated HTTP request. Persisted recovery
    // must not attempt to list owner-scoped records without request identity.
    requiresRequestIdentity: true,
    async createSessionRecord(input = {}) {
      const record = createSessionRecordModel({ ...input, ownerUserId: owner() }, input);
      await client.request('sessions', { method: 'POST', body: [sessionRow(record, owner())] });
      return clone(record);
    },
    async updateSessionRecord(id, patch = {}) {
      const detail = await this.getSessionRecord(id); if (!detail) throw notFound(id);
      const record = updateSessionRecordModel(detail.sessionRecord, patch);
      await client.request('sessions', { method: 'PATCH', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}`, body: sessionRow(record, owner(), detail.transcriptItems) });
      return clone(record);
    },
    async appendTranscriptItem(sessionId, item = {}) {
      const detail = await this.getSessionRecord(sessionId); if (!detail) throw notFound(sessionId);
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
      return rows.map((row) => clone(row.payload || row));
    },
    async getSessionRecord(id) {
      const rows = await client.request('sessions', { query: `?select=*&${eq('id', id)}&${eq('owner_user_id', owner())}` });
      if (!rows[0]) return null;
      return { sessionRecord: clone(rows[0].payload || rows[0]), transcriptItems: clone(rows[0].transcript_items || []) };
    },
    async deleteSessionRecord(id) {
      const existing = await this.getSessionRecord(id); if (!existing) return false;
      await client.request('sessions', { method: 'DELETE', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}` });
      return true;
    }
  };
  return Object.freeze(repository);
}

function sessionRow(record, ownerUserId, transcriptItems = []) {
  return { id: record.id, owner_user_id: ownerUserId, meeting_id: record.meetingId, segment_id: record.segmentId, status: record.status, source_language_code: record.sourceLanguageCode, target_language_code: record.targetLanguageCode, started_at: record.startedAt, ended_at: record.endedAt, created_at: record.createdAt, payload: record, transcript_items: transcriptItems };
}
function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
function failOwner() { const error = new Error('Authenticated owner required.'); error.code = 'auth_required'; error.status = 401; throw error; }
function notFound(id) { const error = new Error(`Session record not found: ${id}`); error.code = 'session_not_found'; error.status = 404; return error; }
