import { eq } from './supabaseRestClient.js';
import { createSupabaseRequestClient, requireSupabaseRequestClient } from './supabaseRequestClient.js';

export function createSupabaseMeetingCueService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const clientForRequest = createSupabaseRequestClient({ env, fetchImpl });
  const client = { request: (...args) => requireSupabaseRequestClient(clientForRequest).request(...args) };

  return Object.freeze({
    async persist({ meetingId, segmentId, sessionId, sessionRecord = null, cue }) {
      const session = sessionRecord
        ? {
            id: sessionRecord.id,
            meeting_id: sessionRecord.meetingId,
            segment_id: sessionRecord.segmentId,
            owner_user_id: sessionRecord.ownerUserId
          }
        : (await client.request('sessions', {
            query: `?select=owner_user_id,id,meeting_id,segment_id&${eq('id', sessionId)}&${eq('meeting_id', meetingId)}&${eq('segment_id', segmentId)}`
          }))[0];
      if (!session) {
        const error = new Error('Recorder Session does not match the Meeting Segment.');
        error.code = 'recorder_session_mismatch';
        error.status = 403;
        throw error;
      }
      const row = {
        id: cue.cueId,
        owner_user_id: session.owner_user_id,
        session_id: sessionId,
        segment_id: segmentId,
        sequence: cue.sequence,
        source_text: cue.sourceText,
        translated_text: cue.translatedText || null,
        source_version: cue.sourceVersion || 1,
        translation_version: cue.translationVersion || 0,
        started_at: cue.startTimeMs,
        ended_at: cue.endTimeMs
      };
      const rows = await client.request('subtitle_cues', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        query: '?on_conflict=id',
        body: [row]
      });
      return rows[0] || row;
    }
  });
}
