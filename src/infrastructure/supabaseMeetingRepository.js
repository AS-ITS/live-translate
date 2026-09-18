import { Meeting, MeetingSegment } from '../domain/meeting/index.js';
import { MEETING_REPOSITORY_METHODS } from '../domain/meeting/meetingRepository.js';
import { currentRequestOwnerId, currentRequestUserId } from '../../server/requestIdentity.js';
import { eq } from './supabaseRestClient.js';
import { createSupabaseRequestClient } from './supabaseRequestClient.js';

export function createSupabaseMeetingRepository(options = {}) {
  const clientForRequest = createSupabaseRequestClient(options);
  if (!clientForRequest()) return null;
  const client = { request: (...args) => clientForRequest().request(...args) };
  const owner = () => {
    const userId = currentRequestOwnerId();
    if (!userId) { const error = new Error('Authenticated owner required.'); error.code = 'auth_required'; error.status = 401; throw error; }
    return userId;
  };

  const repository = {
    async createMeeting(input) {
      const entity = new Meeting(input);
      const rows = await client.request('meetings', { method: 'POST', body: [meetingRow(entity, owner())] });
      return meetingFromRow(rows[0]);
    },
    async getMeeting(id) {
      const rows = await client.request('meetings', { query: `?select=*&${eq('id', id)}&${eq('owner_user_id', owner())}` });
      return rows[0] ? meetingFromRow(rows[0]) : null;
    },
    async updateMeeting(input) {
      const entity = new Meeting(input);
      const rows = await client.request('meetings', { method: 'PATCH', query: `?${eq('id', entity.id)}&${eq('owner_user_id', owner())}`, body: meetingRow(entity, owner()) });
      return rows[0] ? meetingFromRow(rows[0]) : null;
    },
    async deleteMeeting(id) {
      const existing = await this.getMeeting(id);
      if (!existing) return null;
      await client.request('meetings', { method: 'DELETE', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}` });
      return existing;
    },
    async listMeetings() {
      const ownerUserId = owner();
      const actorUserId = currentRequestUserId() || ownerUserId;
      const memberships = await client.request('meeting_members', {
        query: `?select=meeting_id&${eq('user_id', actorUserId)}`
      });
      const meetingIds = memberships.map((item) => item.meeting_id).filter(Boolean);
      const query = meetingIds.length > 0
        ? `?select=*&or=(owner_user_id.eq.${encodeURIComponent(ownerUserId)},id.in.(${meetingIds.map(encodeURIComponent).join(',')}))&order=created_at.desc`
        : `?select=*&${eq('owner_user_id', ownerUserId)}&order=created_at.desc`;
      const rows = await client.request('meetings', { query });
      return rows.map(meetingFromRow);
    },
    async createMeetingSegment(input) {
      const entity = new MeetingSegment(input);
      const rows = await client.request('meeting_segments', { method: 'POST', body: [segmentRow(entity, owner())] });
      await persistCues(client, entity, owner());
      return hydrateSegment(client, rows[0], owner());
    },
    async getMeetingSegment(id) {
      const rows = await client.request('meeting_segments', { query: `?select=*&${eq('id', id)}&${eq('owner_user_id', owner())}` });
      if (!rows[0]) return null;
      const userId = owner();
      return hydrateSegment(client, rows[0], userId);
    },
    async listMeetingSegments(meetingId) {
      const userId = owner();
      const rows = await client.request('meeting_segments', { query: `?select=*&${eq('meeting_id', meetingId)}&${eq('owner_user_id', userId)}&order=sequence.asc` });
      return Promise.all(rows.map((row) => hydrateSegment(client, row, userId)));
    },
    async updateMeetingSegment(input) {
      const entity = new MeetingSegment(input);
      const userId = owner();
      const rows = await client.request('meeting_segments', { method: 'PATCH', query: `?${eq('id', entity.id)}&${eq('owner_user_id', userId)}`, body: segmentRow(entity, userId) });
      if (rows[0]) await persistCues(client, entity, userId);
      return rows[0] ? hydrateSegment(client, rows[0], userId) : null;
    }
  };
  return Object.freeze(Object.fromEntries(MEETING_REPOSITORY_METHODS.map((method) => [method, repository[method].bind(repository)])));
}

function meetingRow(entity, ownerUserId) {
  return { id: entity.id, owner_user_id: ownerUserId, name: entity.name, source_language_code: entity.sourceLanguageCode, target_language_code: entity.targetLanguageCode, status: entity.status, started_at: toSupabaseTimestamp(entity.startedAt), ended_at: toSupabaseTimestamp(entity.endedAt), created_at: toSupabaseTimestamp(entity.createdAt), updated_at: toSupabaseTimestamp(entity.updatedAt), failure_info: entity.failureInfo, settings: { echoTargetLanguage: entity.echoTargetLanguage, shouldRecordInputAudio: entity.shouldRecordInputAudio, glossaryEntries: entity.glossaryEntries, privateGlossaryEntries: entity.privateGlossaryEntries } };
}

function segmentRow(entity, ownerUserId) {
  return { id: entity.id, owner_user_id: ownerUserId, meeting_id: entity.meetingId, sequence: entity.sequence, status: entity.status, started_at: toSupabaseTimestamp(entity.startedAt), ended_at: toSupabaseTimestamp(entity.endedAt), live_session_id: entity.liveSessionId, settings_snapshot: entity.settingsSnapshot, checkpoint: { ...(entity.checkpoint || {}), finalCues: undefined }, error_info: entity.errorInfo, created_at: toSupabaseTimestamp(entity.createdAt), updated_at: toSupabaseTimestamp(entity.updatedAt) };
}

async function hydrateSegment(client, row, ownerUserId) {
  const cueRows = await client.request('subtitle_cues', { query: `?select=*&${eq('owner_user_id', ownerUserId)}&${eq('segment_id', row.id)}&order=sequence.asc` });
  const storedCheckpoint = isPersistedCheckpoint(row.checkpoint) ? { ...row.checkpoint } : null;
  const settingsSnapshot = row.settings_snapshot || {};
  const finalCues = cueRows
    .filter((cue) => cue.segment_id === row.id)
    .map((cue) => cueFromRow(cue, { settingsSnapshot, mode: storedCheckpoint?.mode }));
  const checkpoint = finalCues.length > 0
    ? { ...(storedCheckpoint || { durableChunks: [], pendingPartial: null }), finalCues }
    : storedCheckpoint;
  return new MeetingSegment({ ...row, checkpoint, meetingId: row.meeting_id, startedAt: row.started_at, endedAt: row.ended_at, liveSessionId: row.live_session_id, settingsSnapshot, errorInfo: row.error_info, createdAt: row.created_at, updatedAt: row.updated_at });
}

function meetingFromRow(row) {
  const settings = row.settings || {};
  return new Meeting({ ...row, ownerUserId: row.owner_user_id, sourceLanguageCode: row.source_language_code, targetLanguageCode: row.target_language_code, startedAt: row.started_at, endedAt: row.ended_at, createdAt: row.created_at, updatedAt: row.updated_at, failureInfo: row.failure_info, ...settings });
}

async function persistCues(client, entity, ownerUserId) {
  const cues = entity.checkpoint?.finalCues || [];
  if (!cues.length) return;
  await client.request('subtitle_cues', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: cues.map((cue) => ({ id: cue.cueId, owner_user_id: ownerUserId, session_id: cue.sessionId, segment_id: entity.id, sequence: cue.sequence, source_text: cue.sourceText, translated_text: cue.translatedText || null, source_version: cue.sourceVersion || 1, translation_version: cue.translationVersion || 0, started_at: cue.startTimeMs, ended_at: cue.endTimeMs }))
  });
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

function cueFromRow(row, { settingsSnapshot = {}, mode = null } = {}) {
  const transcription = mode === 'transcription' || row.mode === 'transcription' || row.target_language_code === null;
  const sourceLanguageCode = row.source_language_code || settingsSnapshot.sourceLanguageCode;
  const targetLanguageCode = transcription ? null : (row.target_language_code || settingsSnapshot.targetLanguageCode);
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
    sourceLanguageCode,
    targetLanguageCode,
    ...(transcription ? { mode: 'transcription' } : {}),
    rawSource: row.source_text,
    rawTranslation: row.translated_text || '',
    finalizedReason: 'final'
  };
}

function toMilliseconds(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? value : milliseconds;
}

function isPersistedCheckpoint(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.durableChunks);
}
