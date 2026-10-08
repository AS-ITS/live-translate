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

test('meeting cue API client bounds pending publishes and marks mutation outcome unknown', async () => {
  let timeoutCallback;
  const client = createMeetingCueApiClient({
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    requestTimeoutMs: 5,
    timeoutOptions: {
      setTimeoutFn(callback) { timeoutCallback = callback; return callback; },
      clearTimeoutFn() {}
    }
  });
  const request = client.publish({ meetingId: 'meeting-1', segmentId: 'segment-1', sessionId: 'session-1', cue: { cueId: 'cue-1' } });
  await Promise.resolve();
  timeoutCallback();
  await assert.rejects(request, (error) => error.code === 'request_timeout' && error.outcomeUnknown === true);
});
