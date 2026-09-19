import { randomUUID } from 'node:crypto';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { eq } from './supabaseRestClient.js';
import { createSupabaseContextClient, requireSupabaseContextClient } from './supabaseRequestClient.js';

export function createSupabaseMeetingEventRepository({ env = process.env, fetchImpl = globalThis.fetch, idFactory = randomUUID, clock = () => Date.now() } = {}) {
  const clientForContext = createSupabaseContextClient({ env, fetchImpl });
  const client = { request: (...args) => requireSupabaseContextClient(clientForContext).request(...args) };

  function owner(explicitOwner) {
    const userId = explicitOwner || currentRequestOwnerId();
    if (!userId) {
      const error = new Error('Authenticated owner required.');
      error.code = 'auth_required';
      error.status = 401;
      throw error;
    }
    return userId;
  }

  const repository = {
    async append({ meetingId, segmentId = null, cue, occurredAt = clock(), ownerUserId } = {}) {
      if (!meetingId || !cue?.cueId) throw new TypeError('meetingId and cue.cueId are required.');
      const userId = owner(ownerUserId);
      const payload = sanitizeCuePayload(cue);
      const eventKey = `${cue.cueId}:${Number(cue.translationVersion) || 0}:${Number(cue.sourceVersion) || 1}`;
      const rows = await client.request('meeting_events', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        query: `?on_conflict=owner_user_id,meeting_id,event_key`,
        body: [{ id: idFactory(), owner_user_id: userId, meeting_id: meetingId, segment_id: segmentId || cue.segmentId || null, event_key: eventKey, event_type: 'cue.append', cue_id: cue.cueId, cue_sequence: cue.sequence, occurred_at: new Date(occurredAt).toISOString(), payload }]
      });
      if (rows[0]) return eventFromRow(rows[0]);
      const existing = await client.request('meeting_events', {
        query: `?select=*&${eq('meeting_id', meetingId)}&${eq('owner_user_id', userId)}&${eq('event_key', eventKey)}&limit=1`
      });
      return eventFromRow(existing[0]);
    },
    async listSince(aggregateId, afterEventId = 0, { ownerUserId, limit = 256 } = {}) {
      const userId = owner(ownerUserId);
      const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 256));
      const rows = await client.request('meeting_events', { query: `?select=*&${eq('meeting_id', aggregateId)}&${eq('owner_user_id', userId)}&event_id=gt.${Math.max(0, Number(afterEventId) || 0)}&order=event_id.asc&limit=${safeLimit}` });
      return rows.map(eventFromRow);
    },
    async latestCursor(aggregateId, { ownerUserId } = {}) {
      const userId = owner(ownerUserId);
      const rows = await client.request('meeting_events', { query: `?select=event_id,cue_sequence&${eq('meeting_id', aggregateId)}&${eq('owner_user_id', userId)}&order=event_id.desc&limit=1` });
      const row = rows[0];
      return { eventId: Number(row?.event_id) || 0, cueSequence: Number(row?.cue_sequence) || 0 };
    }
  };
  return Object.freeze(repository);
}

function eventFromRow(row) {
  return { eventId: Number(row.event_id), eventType: row.event_type, type: row.event_type, meetingId: row.meeting_id, segmentId: row.segment_id, cueId: row.cue_id, cueSequence: row.cue_sequence, occurredAt: row.occurred_at, cue: row.payload };
}

function sanitizeCuePayload(cue) {
  return Object.fromEntries(Object.entries({ cueId: cue.cueId, sessionId: cue.sessionId, segmentId: cue.segmentId, sequence: cue.sequence, status: 'final', sourceText: cue.sourceText, translatedText: cue.translatedText || '', sourceVersion: cue.sourceVersion || 1, translationVersion: cue.translationVersion || 0, startTimeMs: cue.startTimeMs, endTimeMs: cue.endTimeMs, sourceLanguageCode: cue.sourceLanguageCode, targetLanguageCode: cue.targetLanguageCode }).filter(([, value]) => value !== undefined));
}
