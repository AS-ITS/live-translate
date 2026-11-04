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

test('lifecycle v2 live-token binds the validated authoritative Resume Segment', async () => {
  const validations = [];
  let tokenOptions;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: {
      async canRecord() { return true; },
      async getMeetingOwner() { return 'owner-1'; }
    },
    meetingRepository: {
      async getMeeting() {
        return { id: 'meeting-1', lifecycleContractVersion: 2, lifecycleVersion: 8 };
      },
      async listMeetingSegments() {
        return [{
          id: 'segment-resumed',
          status: 'active',
          settingsSnapshot: {
            glossaryEntries: [],
            privateGlossaryEntries: [{ source: '你好', target: 'B', replacementAliases: [] }]
          }
        }];
      }
    },
    meetingLifecycleService: {
      async validateWrite(input) {
        validations.push(input);
        return { valid: true };
      }
    },
    sessionRepository: {
      async getSessionRecord() {
        return {
          sessionRecord: {
            id: 'session-1',
            meetingId: 'meeting-1',
            segmentId: 'segment-before-resume',
            targetLanguageCode: 'en',
            sourceLanguageCode: 'zh-Hant'
          },
          transcriptItems: []
        };
      }
    },
    liveTokenCreator: async (_body, options) => {
      tokenOptions = options;
      return {
        token: 'ephemeral-token',
        expiresAt: '2026-09-24T10:00:00.000Z',
        liveGlossaryEntries: [{ source: '你好', target: 'B', replacementAliases: [] }],
        effectiveGlossaryRevision: 'revision-b',
        glossaryEntryCount: 1,
        authoritativeSegment: options.authoritativeBinding
      };
    }
  });
  const req = liveTokenRequest({
    body: {
      meetingId: 'meeting-1',
      sessionId: 'session-1',
      segmentId: 'segment-resumed',
      geminiApiKey: 'request-only-secret',
      targetLanguageCode: 'en',
      sourceLanguageCode: 'zh-Hant'
    },
    headers: {
      'x-meeting-session-id': 'session-1',
      'x-meeting-segment-id': 'segment-resumed',
      'x-meeting-lease-id': 'lease-1',
      'x-meeting-fence-token': '3',
      'x-meeting-lifecycle-version': '8'
    }
  });
  const res = responseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(validations, [{
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-resumed',
    leaseId: 'lease-1',
    fenceToken: 3
  }]);
  assert.equal(tokenOptions.authoritativeSegment.id, 'segment-resumed');
  assert.deepEqual(JSON.parse(res.body).authoritativeSegment, {
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-resumed',
    lifecycleVersion: 8
  });
});

test('lifecycle v2 live-token rejects stale Segment identity before token creation', async () => {
  let tokenCreates = 0;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: {
      async canRecord() { return true; },
      async getMeetingOwner() { return 'owner-1'; }
    },
    meetingRepository: {
      async getMeeting() { return { id: 'meeting-1', lifecycleContractVersion: 2, lifecycleVersion: 8 }; }
    },
    meetingLifecycleService: { async validateWrite() { throw new Error('must not validate stale identity'); } },
    sessionRepository: {
      async getSessionRecord() {
        return { sessionRecord: { id: 'session-1', meetingId: 'meeting-1', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant' } };
      }
    },
    liveTokenCreator: async () => { tokenCreates += 1; return { token: 'unexpected' }; }
  });
  const req = liveTokenRequest({
    body: {
      meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-stale',
      geminiApiKey: 'request-only-secret', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant'
    },
    headers: {
      'x-meeting-session-id': 'session-1',
      'x-meeting-segment-id': 'segment-authoritative',
      'x-meeting-lease-id': 'lease-1',
      'x-meeting-fence-token': '3',
      'x-meeting-lifecycle-version': '8'
    }
  });
  const res = responseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, 'recorder_session_mismatch');
  assert.equal(tokenCreates, 0);
});

test('lifecycle v2 live-token rejects recorder capability before token creation', async () => {
  let tokenCreates = 0;
  const capabilityError = Object.assign(new Error('Recorder capability is no longer valid.'), {
    statusCode: 409,
    code: 'recorder_lease_invalid'
  });
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: {
      async canRecord() { return true; },
      async getMeetingOwner() { return 'owner-1'; }
    },
    meetingRepository: {
      async getMeeting() {
        return { id: 'meeting-1', lifecycleContractVersion: 2, lifecycleVersion: 8 };
      },
      async listMeetingSegments() {
        return [{
          id: 'segment-resumed', sessionId: 'session-1', status: 'active', sequence: 2,
          settingsSnapshot: { privateGlossaryEntries: [] }
        }];
      }
    },
    sessionRepository: {
      async getSessionRecord() {
        return {
          sessionRecord: {
            id: 'session-1', meetingId: 'meeting-1', segmentId: 'segment-resumed',
            targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant'
          },
          transcriptItems: []
        };
      }
    },
    meetingLifecycleService: {
      async validateWrite() { throw capabilityError; }
    },
    liveTokenCreator: async () => {
      tokenCreates += 1;
      return { token: 'must-not-be-created' };
    }
  });
  const req = liveTokenRequest({
    body: {
      meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-resumed',
      geminiApiKey: 'request-only-secret', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant'
    },
    headers: {
      'x-meeting-session-id': 'session-1',
      'x-meeting-segment-id': 'segment-resumed',
      'x-meeting-lease-id': 'expired-lease',
      'x-meeting-fence-token': '2',
      'x-meeting-lifecycle-version': '8'
    }
  });
  const res = responseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error.code, 'recorder_lease_invalid');
  assert.equal(tokenCreates, 0);
});

test('Host local-only token uses Meeting authorization and settings without a cloud Session or Segment', async () => {
  let tokenInput = null;
  let tokenOptions = null;
  let sessionLookups = 0;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: {
      async canRecord(meetingId, userId) { return meetingId === 'meeting-1' && userId === 'recorder-1'; },
      async getMeetingOwner() { return 'owner-1'; }
    },
    sessionRepository: { async getSessionRecord() { sessionLookups += 1; return null; } },
    meetingRepository: { async getMeeting() {
      return { id: 'meeting-1', status: 'created', lifecycleContractVersion: 2,
        targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant', glossaryEntries: [] };
    } },
    liveTokenCreator: async (input, options) => {
      tokenInput = input;
      tokenOptions = options;
      return { token: 'ephemeral-token', expiresAt: '2026-11-02T10:00:00.000Z' };
    }
  });
  const body = { meetingId: 'meeting-1', sessionId: 'local-session-1', segmentId: 'local-segment-1',
    geminiApiKey: 'request-only-secret', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant' };
  const headers = { 'x-host-local-recording': '1', 'x-meeting-session-id': body.sessionId,
    'x-meeting-segment-id': body.segmentId };
  const allowed = responseRecorder();
  await handler(liveTokenRequest({ body, headers }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(sessionLookups, 0);
  assert.equal(tokenInput.sessionId, body.sessionId);
  assert.equal(tokenOptions.authoritativeSegment.settingsSnapshot.id, body.meetingId);

  const denied = responseRecorder();
  await handler(liveTokenRequest({ body, headers: { ...headers, 'x-meeting-segment-id': 'other-segment' } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(sessionLookups, 0);
});

function liveTokenRequest({ body, headers = {} }) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/live-token';
  req.headers = { authorization: 'Bearer signed-token', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

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
