import { eq } from './supabaseRestClient.js';
import { createSupabaseContextClient, requireSupabaseContextClient } from './supabaseRequestClient.js';
import { mapMeetingToDetailDTO } from '../readModels/meetingReadModels.js';
import { meetingExportSource } from '../lib/meetingExportSource.js';
import { isMeetingContentExpired, meetingContentExpiredError } from '../lib/meetingRetention.js';

export function createSupabaseMeetingExportSource({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const clientForContext = createSupabaseContextClient({ env, fetchImpl });
  const client = { request: (...args) => requireSupabaseContextClient(clientForContext).request(...args) };

  return Object.freeze({
    async getDeadline({ ownerUserId, meetingId }) {
      const meetings = await client.request('meetings', {
        query: `?select=status,purge_at,lifecycle_contract_version&${eq('id', meetingId)}&${eq('owner_user_id', ownerUserId)}&limit=1`
      });
      if (!meetings[0]) return null;
      if (isMeetingContentExpired(meetings[0])) throw meetingContentExpiredError();
      return meetings[0].status === 'completed' ? meetings[0].purge_at : null;
    },
    async read({ ownerUserId, meetingId }) {
      const meetings = await client.request('meetings', {
        query: `?select=*&${eq('id', meetingId)}&${eq('owner_user_id', ownerUserId)}&limit=1`
      });
    if (!meetings[0]) {
        const error = new Error('Meeting not found.');
        error.code = 'meeting_not_found';
        error.status = 404;
      throw error;
    }
    if (isMeetingContentExpired(meetings[0])) throw meetingContentExpiredError();
    if (Number(meetings[0].lifecycle_contract_version) >= 2) {
      const error = new Error('Meeting content is available only on Host device.');
      error.code = 'meeting_content_local_only';
      error.status = 410;
      throw error;
    }

      const segmentRows = await client.request('meeting_segments', {
        query: `?select=*&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}&order=sequence.asc`
      });
      const segmentIds = segmentRows.map((row) => row.id);
      const cueRows = segmentIds.length === 0
        ? []
        : await client.request('subtitle_cues', {
          query: `?select=*&${eq('owner_user_id', ownerUserId)}&segment_id=in.(${segmentIds.map(encodeURIComponent).join(',')})&order=sequence.asc`
        });
      const cuesBySegment = new Map(segmentIds.map((id) => [id, []]));
      for (const row of cueRows) cuesBySegment.get(row.segment_id)?.push(cueFromRow(row));
      const settings = meetings[0].settings || {};
      const meeting = {
        ...meetings[0],
        id: meetings[0].id,
        name: meetings[0].name,
        sourceLanguageCode: meetings[0].source_language_code,
        targetLanguageCode: meetings[0].target_language_code,
        startedAt: meetings[0].started_at,
        endedAt: meetings[0].ended_at,
        createdAt: meetings[0].created_at,
        updatedAt: meetings[0].updated_at,
        failureInfo: meetings[0].failure_info,
        ...settings
      };
      const segments = segmentRows.map((row) => ({
        ...row,
        id: row.id,
        meetingId,
        sequence: row.sequence,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        liveSessionId: row.live_session_id,
        settingsSnapshot: row.settings_snapshot || {},
        checkpoint: {
          ...(row.checkpoint || {}),
          durableChunks: Array.isArray(row.checkpoint?.durableChunks) ? row.checkpoint.durableChunks : [],
          finalCues: cuesBySegment.get(row.id) || []
        }
      }));
      const detail = mapMeetingToDetailDTO({ meeting, segments });
      const orderedCues = segments.flatMap((segment) => (segment.checkpoint.finalCues || []).map((cue) => ({
        ...cue,
        segmentSequence: segment.sequence
      })));
      return meetingExportSource({ ...detail, cues: orderedCues });
    }
  });
}

function cueFromRow(row) {
  return {
    cueId: row.id,
    sessionId: row.session_id,
    segmentId: row.segment_id,
    sequence: row.sequence,
    sourceText: row.source_text,
    translatedText: row.translated_text || '',
    status: 'final',
    startTimeMs: toMilliseconds(row.started_at),
    endTimeMs: toMilliseconds(row.ended_at),
    sourceVersion: row.source_version || 1,
    translationVersion: row.translation_version || 0,
    sourceLanguageCode: row.source_language_code || null,
    targetLanguageCode: row.target_language_code || null,
    finalizedReason: 'final'
  };
}

function toMilliseconds(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : value;
}
