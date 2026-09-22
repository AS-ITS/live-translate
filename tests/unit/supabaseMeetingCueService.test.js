import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequestScope } from '../../server/requestIdentity.js';
import { createSupabaseMeetingCueService } from '../../src/infrastructure/supabaseMeetingCueService.js';

test('meeting cue persistence uses the already validated session record', async () => {
  const requests = [];
  const service = createSupabaseMeetingCueService({
    env: {
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SECRET_KEY: 'service-key',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 201,
        async json() {
          return [{ id: 'cue-1' }];
        }
      };
    }
  });

  setRequestScope({ actorUserId: 'owner-1', resourceOwnerUserId: 'owner-1', accessToken: 'user-token', capability: 'user' });
  try {
    const result = await service.persist({
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      sessionId: 'session-1',
      sessionRecord: { id: 'session-1', meetingId: 'meeting-1', segmentId: 'segment-1', ownerUserId: 'owner-1' },
      cue: {
        cueId: 'cue-1',
        sequence: 1,
        sourceText: '你好。',
        translatedText: 'Hello.',
        sourceVersion: 1,
        translationVersion: 0,
        startTimeMs: 0,
        endTimeMs: 500
      }
    });

    assert.deepEqual(result, { id: 'cue-1' });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/rest\/v1\/subtitle_cues/u);
  } finally {
    setRequestScope(null);
  }
});
