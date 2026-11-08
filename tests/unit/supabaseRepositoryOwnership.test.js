import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestScope, setRequestUser } from '../../server/requestIdentity.js';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';
import { createSupabaseSessionRepository } from '../../src/infrastructure/supabaseSessionRepository.js';

test('Session owner lookup uses a PostgREST equality filter', async () => {
  const calls = [];
  const repository = createSupabaseSessionRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key', VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return [{ meeting_id: 'meeting-a', owner_user_id: 'user-a' }]; } };
    }
  });
  setRequestUser({ id: 'user-a' });
  setRequestScope({ actorUserId: 'user-a', resourceOwnerUserId: 'user-a', accessToken: 'user-jwt', capability: 'user' });
  try {
    assert.deepEqual(await repository.getSessionOwner('session-a'), { meetingId: 'meeting-a', ownerUserId: 'user-a' });
    assert.match(calls[0].url, /[?&]id=eq\.session-a(?:&|$)/u);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer user-jwt');
  } finally {
    setRequestUser(null);
  }
});

test('Supabase meeting repository scopes reads and writes to request owner', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return [{ id: 'meeting-a', owner_user_id: 'user-a', status: 'created', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }]; } };
    }
  });

  setRequestUser({ id: 'user-a' });
  const meeting = await repository.createMeeting({ id: 'meeting-a', createdAt: '2026-01-01T00:00:00.000Z', purgeAt: '2026-01-01T00:30:00.000Z' });
  assert.equal(meeting.id, 'meeting-a');
  assert.equal(meeting.ownerUserId, 'user-a');
  assert.equal(Object.keys(meeting).includes('ownerUserId'), false);
  assert.match(calls[0].init.body, /user-a/);
  assert.equal(JSON.parse(calls[0].init.body)[0].purge_at, '2026-01-01T00:30:00.000Z');

  await repository.getMeeting('meeting-a');
  assert.match(calls[1].url, /owner_user_id=eq\.user-a/);
  setRequestUser(null);
});

test('owner meeting CRUD uses the authenticated user client when available', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'service-key',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return [{ id: 'meeting-a', owner_user_id: 'user-a', status: 'created', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }]; } };
    }
  });

  setRequestUser({ id: 'user-a' });
  setRequestScope({ actorUserId: 'user-a', resourceOwnerUserId: 'user-a', accessToken: 'user-jwt' });
  await repository.getMeeting('meeting-a');
  assert.equal(calls[0].init.headers.apikey, 'publishable-key');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer user-jwt');
  setRequestScope(null);
  setRequestUser(null);
});

test('Supabase meeting repository serializes numeric timestamps for Postgres', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return [{ id: 'meeting-a', owner_user_id: 'user-a', status: 'created', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }]; } };
    }
  });

  setRequestUser({ id: 'user-a' });
  await repository.createMeeting({ id: 'meeting-a', createdAt: 1789098906814 });
  setRequestUser(null);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body[0].created_at, '2026-09-11T03:55:06.814Z');
  assert.equal(body[0].updated_at, '2026-09-11T03:55:06.814Z');
});

test('Supabase session repository serializes timestamps and preserves owner-scoped user access', async () => {
  const calls = [];
  const repository = createSupabaseSessionRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    idFactory: () => 'session-a',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if ((init?.method || 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{
              payload: {
                id: 'session-a',
                meetingId: 'meeting-a',
                status: 'created',
                targetLanguageCode: 'en',
                startedAt: null,
                endedAt: null,
                createdAt: 1789098906814
              },
              transcript_items: []
            }];
          }
        };
      }
      return { ok: true, status: 200, async json() { return []; } };
    }
  });
  const originalDateNow = Date.now;
  Date.now = () => 1789098906814;

  try {
    setRequestUser({ id: 'user-a' });
    setRequestScope({ actorUserId: 'user-a', resourceOwnerUserId: 'user-a', accessToken: 'user-jwt' });

    await repository.createSessionRecord({ targetLanguageCode: 'en', startedAt: 1789098906814 });
    const createBody = JSON.parse(calls[0].init.body);
    assert.equal(createBody[0].created_at, '2026-09-11T03:55:06.814Z');
    assert.equal(createBody[0].started_at, '2026-09-11T03:55:06.814Z');
    assert.equal(createBody[0].owner_user_id, 'user-a');
    assert.equal(createBody[0].payload.createdAt, '2026-09-11T03:55:06.814Z');
    assert.equal(calls[0].init.headers.apikey, 'publishable-key');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer user-jwt');

    await repository.updateSessionRecord('session-a', { startedAt: 1789098906814, endedAt: 1789098907814 });
    const updateCall = calls.find((call) => call.url.endsWith('/rpc/patch_session_metadata'));
    assert.ok(updateCall);
    const updateBody = JSON.parse(updateCall.init.body);
    assert.equal(updateBody.p_owner_user_id, 'user-a');
    assert.equal(updateBody.p_meeting_id, 'meeting-a');
    assert.equal(updateBody.p_session_id, 'session-a');
    assert.deepEqual(updateBody.p_patch, { startedAt: 1789098906814, endedAt: 1789098907814 });
    assert.equal(updateCall.init.headers.Authorization, 'Bearer user-jwt');
  } finally {
    Date.now = originalDateNow;
    setRequestScope(null);
    setRequestUser(null);
  }
});

test('session reads restore authoritative meeting binding from outer columns', async () => {
  const repository = createSupabaseSessionRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return [{
          id: 'session-a',
          meeting_id: 'meeting-a',
          owner_user_id: 'user-a',
          payload: {
            id: 'session-a',
            status: 'created'
          },
          transcript_items: []
        }];
      }
    })
  });

  setRequestUser({ id: 'user-a' });
  setRequestScope({ actorUserId: 'user-a', resourceOwnerUserId: 'user-a', accessToken: 'user-jwt' });
  try {
    const detail = await repository.getSessionRecord('session-a');
    assert.equal(detail.sessionRecord.meetingId, 'meeting-a');
    assert.equal(detail.sessionRecord.ownerUserId, 'user-a');
  } finally {
    setRequestScope(null);
    setRequestUser(null);
  }
});

test('Supabase meeting repository returns segment metadata without hydrating cloud Cues', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.includes('/subtitle_cues?')) return [{
            id: 'cue-1', session_id: 'session-1', segment_id: 'segment-1', sequence: 1,
            source_text: '你好', translated_text: 'hello', started_at: '1200', ended_at: 2500
          }];
          return [{
            id: 'segment-1', meeting_id: 'meeting-1', sequence: 0, status: 'completed',
            started_at: '2026-09-11T00:00:00.000Z', ended_at: '2026-09-11T00:01:00.000Z',
            created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:01:00.000Z',
            settings_snapshot: { sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
            checkpoint: {}
          }];
        }
      };
    }
  });

  setRequestUser({ id: 'user-a' });
  const segment = await repository.getMeetingSegment('segment-1');
  setRequestUser(null);

  assert.equal(segment.id, 'segment-1');
  assert.equal(segment.meetingId, 'meeting-1');
  assert.equal(segment.status, 'completed');
  assert.equal(segment.startedAt, '2026-09-11T00:00:00.000Z');
  assert.equal(segment.endedAt, '2026-09-11T00:01:00.000Z');
  assert.deepEqual(segment.settingsSnapshot, {});
  assert.equal(segment.checkpoint, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/meeting_segments\?/);
});

test('Supabase meeting repository treats an empty checkpoint row as no checkpoint', async () => {
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (url.includes('/subtitle_cues?')) return [];
        return [{
          id: 'segment-1', meeting_id: 'meeting-1', sequence: 0, status: 'active',
          started_at: '2026-09-11T00:00:00.000Z', checkpoint: {}, settings_snapshot: {},
          created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:00:00.000Z'
        }];
      }
    })
  });

  setRequestUser({ id: 'user-a' });
  const segment = await repository.getMeetingSegment('segment-1');
  setRequestUser(null);

  assert.equal(segment.checkpoint, null);
});

test('Supabase meeting repository exposes atomic completion and settings-only updates', async () => {
  const calls = [];
  const timestamp = '2026-11-05T00:00:00.000Z';
  const repository = createSupabaseMeetingRepository({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'service-key',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return url.includes('/rpc/')
            ? { id: 'meeting-a', owner_user_id: 'user-a', status: 'completed', lifecycle_contract_version: 2, lifecycle_version: 1, created_at: timestamp, updated_at: timestamp, started_at: timestamp, ended_at: timestamp, settings: {} }
            : [{ id: 'meeting-a', owner_user_id: 'user-a', status: 'created', lifecycle_contract_version: 2, lifecycle_version: 0, created_at: timestamp, updated_at: timestamp, settings: {} }];
        }
      };
    }
  });
  setRequestUser({ id: 'user-a' });
  setRequestScope({ actorUserId: 'user-a', resourceOwnerUserId: 'user-a', accessToken: 'user-jwt', capability: 'user' });
  try {
    const settings = await repository.updateMeetingSettings({ id: 'meeting-a', createdAt: timestamp, updatedAt: timestamp, name: 'Updated' });
    assert.equal(settings.name, null);
    const settingsCall = calls[0];
    assert.match(settingsCall.url, /status=neq\.completed/u);
    assert.equal(settingsCall.init.headers.Authorization, 'Bearer user-jwt');
    const settingsBody = JSON.parse(settingsCall.init.body);
    for (const field of ['status', 'ended_at', 'purge_at', 'lifecycle_version']) {
      assert.equal(Object.hasOwn(settingsBody, field), false);
    }

    const completed = await repository.completeLocalMeeting('meeting-a');
    assert.equal(completed.lifecycleVersion, 1);
    const rpcCall = calls[1];
    assert.match(rpcCall.url, /\/rpc\/complete_local_only_meeting$/u);
    assert.equal(rpcCall.init.headers.Authorization, 'Bearer service-key');
    assert.deepEqual(JSON.parse(rpcCall.init.body), { p_owner_user_id: 'user-a', p_meeting_id: 'meeting-a' });
  } finally {
    setRequestUser(null);
    setRequestScope(null);
  }
});
