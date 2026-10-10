import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createSupabaseMeetingLifecycleService } from '../../src/infrastructure/supabaseMeetingLifecycleService.js';

test('recording start forwards authenticated principal to lifecycle service', async () => {
  const calls = [];
  const handler = createHandler({
    async execute(input) {
      calls.push(input);
      return lifecycleResult();
    }
  });

  const response = await request(handler, {
    url: '/api/meetings/meeting-1/recording/start',
    body: { operationId: 'operation-1', expectedLifecycleVersion: 0 }
  });

  assert.equal(response.status, 201);
  assert.equal(response.json().session.id, 'session-1');
  assert.deepEqual(calls[0], {
    ownerUserId: 'owner-1',
    principalType: 'user',
    principalId: 'member-1',
    forceAllowed: false,
    meetingId: 'meeting-1',
    command: 'start',
    operationId: 'operation-1',
    expectedLifecycleVersion: 0,
    leaseId: undefined,
    fenceToken: undefined,
    payload: {}
  });
});

test('legacy resume route binds latest repository glossary into successor snapshot', async () => {
  const calls = [];
  const payload = {
    meetingId: 'meeting-1', sourceSegmentId: 'segment-1', nextLiveSessionId: 'live-2',
    expectedSessionId: 'session-1',
    checkpoint: { lastFinalCueSequence: 0, finalCues: [], durableChunks: [], cueCheckpoint: null }
  };
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const handler = createHandler(undefined, {
    legacyResumeService: {
      async execute(input) {
        calls.push(input);
        return {
          meeting: { id: 'meeting-1' },
          interruptedSegment: { id: 'segment-1' },
          segment: {
            id: 'segment-2', sequence: 2, session_id: 'session-1',
            settings_snapshot: {
              sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
              globalGlossaryEntries: input.globalGlossaryEntries,
              glossaryEntries: [{ source: '你好', target: 'su3cl3' }],
              privateGlossaryEntries: []
            }
          },
          operation: { operationId: 'continue-1', payloadHash, sourceSegmentId: 'segment-1' }
        };
      }
    },
    meetingRepository: {
      async getMeeting() { return { id: 'meeting-1', targetLanguageCode: 'en' }; }
    },
    glossaryController: {
      async listEntries() { return [{ id: 'global-1', source: '你好', target: 'global', scope: 'live' }]; }
    }
  });
  const response = await request(handler, {
    url: '/api/meetings/meeting-1/recording/legacy-resume',
    body: { ...payload, operationId: 'continue-1', payloadHash }
  });
  assert.equal(response.status, 201);
  assert.equal(response.json().segment.id, 'segment-2');
  assert.deepEqual(response.json().liveGlossaryEntries, [
    { source: '你好', target: 'su3cl3', replacementAliases: [] }
  ]);
  assert.equal(calls[0].payloadHash, payloadHash);
  assert.equal(calls[0].ownerUserId, 'owner-1');
});

test('recording lifecycle conflict returns stable HTTP 409 code', async () => {
  const handler = createHandler({
    async execute() {
      const error = new Error('conflict');
      error.code = 'meeting_lifecycle_conflict';
      error.status = 409;
      throw error;
    }
  });

  const response = await request(handler, {
    url: '/api/meetings/meeting-1/recording/rollover',
    body: {
      operationId: 'operation-2',
      expectedLifecycleVersion: 4,
      leaseId: 'lease-1',
      fenceToken: 3
    }
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'meeting_lifecycle_conflict');
});

test('terminal Meeting lifecycle write returns stable HTTP 409 code', async () => {
  const handler = createHandler({
    async execute() {
      const error = new Error('terminal');
      error.code = 'meeting_terminal';
      error.status = 409;
      throw error;
    }
  });

  const response = await request(handler, {
    url: '/api/meetings/meeting-1/recording/start',
    body: { operationId: 'operation-terminal', expectedLifecycleVersion: 3 }
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'meeting_terminal');
});

test('stale Meeting expiration invokes the bounded lifecycle RPC', async () => {
  const requests = [];
  const service = createSupabaseMeetingLifecycleService({
    env: { SUPABASE_URL: 'https://supabase.example', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() { return [{ expired: 2 }]; } };
    }
  });

  const result = await service.expireStaleMeetings({ limit: 3 });

  assert.deepEqual(result, { expired: 2 });
  assert.match(requests[0].url, /\/rpc\/expire_stale_meetings$/u);
  assert.deepEqual(JSON.parse(requests[0].options.body), { p_limit: 3 });
  assert.throws(() => service.expireStaleMeetings({ limit: 11 }), /limit must be an integer from 1 to 10/u);
});

test('recording lease heartbeat does not execute a lifecycle transition', async () => {
  const calls = [];
  const handler = createHandler({
    async execute() { throw new Error('unexpected command'); },
    async renewLease(input) {
      calls.push(input);
      return { leaseId: input.leaseId, fenceToken: input.fenceToken, expiresAt: '2026-09-22T00:00:10Z' };
    }
  });

  const response = await request(handler, {
    url: '/api/meetings/meeting-1/recording/lease/heartbeat',
    body: { leaseId: 'lease-1', fenceToken: 3 }
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meetingId, 'meeting-1');
});

test('lifecycle v2 recording writes reject a stale fence before persistence', async () => {
  const calls = [];
  const handler = createHandler({
    async validateWrite(input) {
      calls.push(input);
      const error = new Error('recorder_lease_invalid');
      error.code = 'recorder_lease_invalid';
      error.status = 409;
      throw error;
    }
  });

  const response = await request(handler, {
    method: 'PUT',
    url: '/api/meetings/meeting-1/segments/segment-1/checkpoint',
    headers: {
      'x-meeting-session-id': 'session-1',
      'x-meeting-segment-id': 'segment-1',
      'x-meeting-lease-id': 'stale-lease',
      'x-meeting-fence-token': '1'
    },
    body: {}
  });

  assert.equal(response.status, 409);
  assert.equal(response.json().error.code, 'recorder_lease_invalid');
  assert.equal(calls[0].segmentId, 'segment-1');
  assert.equal(calls[0].fenceToken, 1);
});

test('audio upload-start validates the lifecycle fence before creating an artifact', async () => {
  const validations = [];
  const uploads = [];
  const handler = createHandler({
    async validateWrite(input) {
      validations.push(input);
    }
  }, {
    meetingAudioService: {
      async beginUpload(input) {
        uploads.push(input);
        return { id: 'artifact-1', status: 'uploading' };
      }
    }
  });

  const response = await request(handler, {
    url: '/api/meetings/meeting-1/segments/segment-1/audio-uploads',
    headers: {
      'x-meeting-session-id': 'session-1',
      'x-meeting-segment-id': 'segment-1',
      'x-meeting-lease-id': 'lease-1',
      'x-meeting-fence-token': '2'
    },
    body: { mimeType: 'audio/webm', byteSize: 64 }
  });

  assert.equal(response.status, 201);
  assert.deepEqual(validations, [{
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    leaseId: 'lease-1',
    fenceToken: 2
  }]);
  assert.deepEqual(uploads, [{
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    mimeType: 'audio/webm',
    byteSize: 64
  }]);
});

test('audio artifact completion bypasses an expired recorder lease', async () => {
  const handler = createHandler({
    async validateWrite() {
      throw new Error('must not validate terminal artifact completion');
    }
  }, {
    meetingAudioService: {
      async completeUpload({ meetingId, artifactId }) {
        return { id: artifactId, meetingId, status: 'ready' };
      }
    }
  });

  const response = await request(handler, {
    url: '/api/meetings/meeting-1/audio-artifacts/artifact-1/complete',
    body: {}
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().status, 'ready');
});

function createHandler(meetingLifecycleService, { meetingAudioService, ...extra } = {}) {
  return createRequestHandler({
    meetingLifecycleService,
    ...extra,
    ...(meetingAudioService ? { meetingAudioService } : {}),
    accessControl: {
      async validateRequest() { return { id: 'member-1', role: 'member', status: 'active' }; }
    },
    profileService: {
      async getProfile() { return { id: 'member-1', role: 'member', status: 'active' }; },
      async findMeetingMembership() { return { meetingId: 'meeting-1', userId: 'member-1', canRecord: true }; }
    },
    meetingMembershipService: {
      async canRecord() { return true; },
      async canManage() { return false; },
      async getMeetingOwner() { return 'owner-1'; }
    }
  });
}

function lifecycleResult() {
  return {
    operationId: 'operation-1',
    replayed: false,
    meeting: { id: 'meeting-1', lifecycle_version: 1 },
    session: { id: 'session-1' },
    segment: { id: 'segment-1' },
    lease: { leaseId: 'lease-1', fenceToken: 1, expiresAt: '2026-09-22T00:00:10Z' }
  };
}

async function request(handler, { url, body, method = 'POST', headers = {} }) {
  const req = new Readable({ read() {} });
  req.url = url;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.push(JSON.stringify(body));
  req.push(null);
  const chunks = [];
  const res = {
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); }
  };
  await handler(req, res);
  const raw = Buffer.concat(chunks).toString('utf8');
  return { status: res.statusCode, json: () => JSON.parse(raw) };
}
