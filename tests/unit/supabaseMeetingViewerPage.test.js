import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestUser } from '../../server/requestIdentity.js';
import { createSupabaseMeetingRepository } from '../../src/infrastructure/supabaseMeetingRepository.js';

test('Supabase viewer page uses a bounded joined cue query instead of segment hydration', async () => {
  const calls = [];
  const repository = createSupabaseMeetingRepository({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/rest/v1/meetings?')) {
        return response([{ id: 'meeting-1', owner_user_id: 'user-a', status: 'completed', settings: {} }]);
      }
      return response([
        { id: 'cue-2', session_id: 'session-1', segment_id: 'segment-1', sequence: 2, source_text: 'two', translated_text: 'two', started_at: 2, ended_at: 3, meeting_segments: { sequence: 0, settings_snapshot: {} } },
        { id: 'cue-1', session_id: 'session-1', segment_id: 'segment-1', sequence: 1, source_text: 'one', translated_text: 'one', started_at: 1, ended_at: 2, meeting_segments: { sequence: 0, settings_snapshot: {} } }
      ]);
    }
  });

  setRequestUser({ id: 'user-a' });
  try {
    const page = await repository.getMeetingViewerPage('meeting-1', { limit: 1 });
    assert.equal(page.cues.length, 1);
    assert.equal(page.cues[0].cueId, 'cue-2');
    assert.equal(page.hasMore, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /meeting_segments!inner\(sequence,settings_snapshot\)/u);
    assert.match(calls[1].url, /limit=2/u);
    assert.equal(calls.some(({ url }) => url.includes('/rest/v1/meeting_segments?')), false);
  } finally {
    setRequestUser(null);
  }
});

function response(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
