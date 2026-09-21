import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCueApiClient } from '../../src/lib/meetingCueApiClient.js';

test('meeting cue API client preserves safe error status, code, and request ID', async () => {
  const client = createMeetingCueApiClient({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() {
        return {
          error: {
            code: 'recorder_session_mismatch',
            requestId: 'request-1'
          }
        };
      }
    })
  });

  await assert.rejects(
    client.publish({
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      sessionId: 'session-1',
      cue: { cueId: 'cue-1' }
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'recorder_session_mismatch');
      assert.equal(error.requestId, 'request-1');
      return true;
    }
  );
});

test('meeting cue API client keeps status when error response is not JSON', async () => {
  const client = createMeetingCueApiClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() {
        throw new SyntaxError('invalid json');
      }
    })
  });

  await assert.rejects(
    client.publish({
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      sessionId: 'session-1',
      cue: { cueId: 'cue-1' }
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, undefined);
      return true;
    }
  );
});
