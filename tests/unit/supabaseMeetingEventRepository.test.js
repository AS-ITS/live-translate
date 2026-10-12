import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseMeetingEventRepository } from '../../src/infrastructure/supabaseMeetingEventRepository.js';

test('appends a sanitized cue event and maps its durable cursor', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/meeting_segments?')) return new Response(JSON.stringify([{ sequence: 1 }]), { status: 200 });
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
  const eventPost = calls.find((call) => call.options.method === 'POST');
  const body = JSON.parse(eventPost.options.body);
  assert.equal(body[0].owner_user_id, 'owner-1');
  assert.equal(body[0].payload.rawAudio, undefined);
  assert.match(eventPost.url, /on_conflict=owner_user_id,meeting_id,event_key/);
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

test('delayed translation creates a new durable event for the same Cue ID', async () => {
  const eventKeys = [];
  const fetchImpl = async (_url, options) => {
    const row = JSON.parse(options.body)[0];
    eventKeys.push(row.event_key);
    return new Response(JSON.stringify([{
      ...row,
      event_id: eventKeys.length,
      occurred_at: '2026-09-30T00:00:00.000Z'
    }]), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const repository = createSupabaseMeetingEventRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'secret' },
    fetchImpl,
    idFactory: () => 'event-id',
    clock: () => Date.parse('2026-09-30T00:00:00.000Z')
  });
  const sourceOnly = {
    cueId: 'cue-1', sequence: 1, sourceText: '你好', translatedText: '',
    sourceStatus: 'finalized', translationStatus: 'pending', sourceVersion: 1, translationVersion: 0
  };

  await repository.append({ ownerUserId: 'owner-1', meetingId: 'meeting-1', cue: sourceOnly });
  await repository.append({
    ownerUserId: 'owner-1',
    meetingId: 'meeting-1',
    cue: { ...sourceOnly, translatedText: 'hello', translationStatus: 'finalized', translationVersion: 1 }
  });

  assert.deepEqual(eventKeys, ['cue-1:0:1', 'cue-1:1:1']);
});

test('published event carries the validated Meeting Segment order', async () => {
  let payload;
  const repository = createSupabaseMeetingEventRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'secret' },
    fetchImpl: async (url, options = {}) => {
      if (url.includes('/meeting_segments?')) return new Response(JSON.stringify([{ sequence: 2 }]), { status: 200 });
      payload = JSON.parse(options.body)[0].payload;
      return new Response(JSON.stringify([{ event_id: 1, event_type: 'cue.append', meeting_id: 'meeting-1',
        segment_id: 'segment-2', cue_id: 'cue-1', cue_sequence: 1, payload }]), { status: 201 });
    },
  });
  await repository.append({ ownerUserId: 'owner-1', meetingId: 'meeting-1', segmentId: 'segment-2',
    cue: { cueId: 'cue-1', sequence: 1, sourceText: 'latest' } });
  assert.equal(payload.segmentSequence, 2);
});
