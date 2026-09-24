import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

test('live-token authorizes against the authoritative session record', async () => {
  let readModelCalls = 0;
  const handler = createRequestHandler({
    accessControl: {
      validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' })
    },
    profileService: {
      async getProfile() {
        return { role: 'member', status: 'active' };
      }
    },
    meetingMembershipService: {
      async canRecord(meetingId, userId) {
        return meetingId === 'meeting-1' && userId === 'recorder-1';
      },
      async getMeetingOwner(meetingId) {
        return meetingId === 'meeting-1' ? 'owner-1' : null;
      }
    },
    sessionRepository: {
      async getSessionRecord(sessionId) {
        return {
          sessionRecord: {
            id: sessionId,
            meetingId: 'meeting-1',
            segmentId: 'segment-1',
            targetLanguageCode: 'en',
            sourceLanguageCode: 'zh-Hant'
          },
          transcriptItems: []
        };
      }
    },
    sessionReadController: {
      async getSession(sessionId) {
        readModelCalls += 1;
        return { session: { id: sessionId } };
      }
    },
    liveTokenCreator: async () => ({
      token: 'ephemeral-token',
      expiresAt: '2026-09-24T10:00:00.000Z'
    })
  });

  const req = Readable.from([JSON.stringify({
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    geminiApiKey: 'request-only-secret',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant'
  })]);
  req.method = 'POST';
  req.url = '/api/live-token';
  req.headers = { authorization: 'Bearer signed-token' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = responseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).token, 'ephemeral-token');
  assert.equal(readModelCalls, 0);
});

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    }
  };
}
