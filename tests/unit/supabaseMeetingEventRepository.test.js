import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseMeetingEventRepository } from '../../src/infrastructure/supabaseMeetingEventRepository.js';

test('appends a sanitized cue event and maps its durable cursor', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify([{
      event_id: 7,
      event_type: 'cue.append',
      meeting_id: 'meeting-1',
      segment_id: 'segment-1',
      cue_id: 'cue-1',
      cue_sequence: 3,
      occurred_at: '2026-09-11T00:00:00.000Z',
      payload: { cueId: 'cue-1', sequence: 3, sourceText: '原文', translatedText: 'translated' }
    }]), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const repository = createSupabaseMeetingEventRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'secret' },
    fetchImpl,
    idFactory: () => 'event-id',
    clock: () => Date.parse('2026-09-11T00:00:00.000Z')
  });
  const event = await repository.append({
    ownerUserId: 'owner-1', meetingId: 'meeting-1', segmentId: 'segment-1',
    cue: { cueId: 'cue-1', sequence: 3, sourceText: '原文', translatedText: 'translated', rawAudio: 'must-not-persist' }
  });
  assert.deepEqual(event, {
    eventId: 7, eventType: 'cue.append', type: 'cue.append', meetingId: 'meeting-1', segmentId: 'segment-1',
    cueId: 'cue-1', cueSequence: 3, occurredAt: '2026-09-11T00:00:00.000Z',
    cue: { cueId: 'cue-1', sequence: 3, sourceText: '原文', translatedText: 'translated' }
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body[0].owner_user_id, 'owner-1');
  assert.equal(body[0].payload.rawAudio, undefined);
  assert.match(calls[0].url, /on_conflict=owner_user_id,meeting_id,event_key/);
});

test('lists events after a cursor and returns the latest cursor', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    const rows = call === 1
      ? [{ event_id: 8, event_type: 'cue.append', meeting_id: 'meeting-1', cue_id: 'cue-2', cue_sequence: 4, payload: {} }]
      : [{ event_id: 8, cue_sequence: 4 }];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const repository = createSupabaseMeetingEventRepository({ env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'secret' }, fetchImpl });
  assert.equal((await repository.listSince('meeting-1', 7, { ownerUserId: 'owner-1' }))[0].eventId, 8);
  assert.deepEqual(await repository.latestCursor('meeting-1', { ownerUserId: 'owner-1' }), { eventId: 8, cueSequence: 4 });
});
