import { createSupabaseServiceRoleClient, eq } from './supabaseRestClient.js';
import { createSupabaseRequestClient, requireSupabaseRequestClient } from './supabaseRequestClient.js';

export function createSupabaseMeetingCueService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const clientForRequest = createSupabaseRequestClient({ env, fetchImpl });
  const privileged = createSupabaseServiceRoleClient({ env, fetchImpl });

  return Object.freeze({
    async persist({ meetingId, segmentId, sessionId, sessionRecord = null, cue }) {
      const session = sessionRecord
        ? { id: sessionRecord.id, meeting_id: sessionRecord.meetingId, owner_user_id: sessionRecord.ownerUserId }
        : (await requireSupabaseRequestClient(clientForRequest).request('sessions', {
          query: `?select=owner_user_id,id,meeting_id&${eq('id', sessionId)}&${eq('meeting_id', meetingId)}`
        }))[0];
      if (!session || session.id !== sessionId || session.meeting_id !== meetingId || !session.owner_user_id) {
        const error = new Error('Recorder Session does not match Meeting Segment.');
        error.code = 'recorder_session_mismatch';
        error.status = 403;
        throw error;
      }
      if (!privileged) {
        const error = new Error('Controlled Cue publication is unavailable.');
        error.code = 'cloud_capability_unavailable';
        error.status = 503;
        throw error;
      }
      const row = {
        id: cue.cueId,
        session_id: sessionId,
        sequence: cue.sequence,
        source_text: cue.sourceText || '',
        translated_text: cue.translatedText || null,
        source_status: cue.sourceStatus || (cue.sourceText ? 'finalized' : 'pending'),
        translation_status: cue.translationStatus || (cue.translatedText ? 'finalized' : 'pending'),
        source_version: Number.isInteger(cue.sourceVersion) ? cue.sourceVersion : (cue.sourceText ? 1 : 0),
        translation_version: Number.isInteger(cue.translationVersion) ? cue.translationVersion : (cue.translatedText ? 1 : 0),
        started_at: cue.startTimeMs,
        ended_at: cue.endTimeMs
      };
      try {
        await privileged.rpc('publish_meeting_cue_v2', {
          p_meeting_id: meetingId,
          p_segment_id: segmentId,
          p_cue: row
        });
      } catch (error) {
        if (error?.supabaseCode === 'P0042') {
          error.code = 'subtitle_cue_conflict';
          error.status = 409;
        }
        throw error;
      }
      return row;
    }
  });
}
