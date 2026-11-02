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

test('legacy lifecycle content routes reject before RPC and audio persistence', async () => {
  let lifecycleCalls = 0;
  let audioCalls = 0;
  const handler = createHandler({
    async execute() { lifecycleCalls += 1; return lifecycleResult(); }
  }, { meetingAudioService: {
    async startUpload() { audioCalls += 1; },
    async completeArtifact() { audioCalls += 1; }
  } });
  const routes = [
    ['/api/meetings/meeting-1/recording/legacy-resume', 'POST'],
    ['/api/meetings/meeting-1/segments/segment-1/checkpoint', 'PUT'],
    ['/api/meetings/meeting-1/segments/segment-1/audio-uploads', 'POST'],
    ['/api/meetings/meeting-1/audio-artifacts/artifact-1/complete', 'POST']
  ];
  for (const [url, method] of routes) {
    const response = await request(handler, { url, method, body: {} });
    assert.equal(response.status, 410, `${method} ${url}`);
    assert.equal(response.json().error.code, 'meeting_content_local_only');
    assert.ok(response.json().error.requestId);
  }
  assert.equal(lifecycleCalls, 0);
  assert.equal(audioCalls, 0);
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

test('lifecycle RPC response projects nested records to metadata only', async () => {
  const service = createSupabaseMeetingLifecycleService({
    env: { SUPABASE_URL: 'https://supabase.example', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async () => ({
      ok: true, status: 200,
      async json() { return [{
        operationId: 'operation-1', targetSessionId: 'session-1', targetSegmentId: 'segment-1',
        meeting: { id: 'meeting-1', status: 'active', lifecycle_version: 1, settings: { checkpoint: 'secret' } },
        session: { id: 'session-1', meeting_id: 'meeting-1', status: 'active', current_segment_id: 'segment-1', payload: { transcript: 'secret' } },
        segment: { id: 'segment-1', session_id: 'session-1', status: 'active', sequence: 0, checkpoint: { cue: 'secret' } },
        lease: { leaseId: 'lease-1', fenceToken: 1, expiresAt: '2026-09-22T00:00:10Z', audio: 'secret' }
      }]; }
    })
  });
  const result = await service.execute({
    ownerUserId: 'owner-1', meetingId: 'meeting-1', command: 'start', operationId: 'operation-1',
    expectedLifecycleVersion: 0, principalType: 'user', principalId: 'owner-1'
  });
  assert.deepEqual(Object.keys(result.meeting).sort(), ['id', 'lifecycle_version', 'status']);
  assert.deepEqual(Object.keys(result.session).sort(), ['current_segment_id', 'id', 'meeting_id', 'status']);
  assert.deepEqual(Object.keys(result.segment).sort(), ['id', 'live_session_id', 'sequence', 'session_id', 'status']);
  assert.deepEqual(Object.keys(result.lease).sort(), ['expiresAt', 'fenceToken', 'leaseId']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
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

function createHandler(meetingLifecycleService, { meetingAudioService, ...extra } = {}) {
  return createRequestHandler({
    meetingLifecycleService,
    meetingCheckpointService: {
      async updateCheckpoint({ checkpoint }) { return { checkpoint }; }
    },
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

test('operation lookup returns only authorized metadata and derives owner scope', async () => {
  const calls = [];
  const handler = createHandler({
    async lookupOperation(input) {
      calls.push(input);
      return { status: 'committed', command: 'stop', operationId: input.operationId,
        resultingLifecycleVersion: 2, sessionId: 'session-1', segmentId: null };
    }
  });
  const response = await request(handler, {
    method: 'GET', url: '/api/meetings/meeting-1/recording/operations/operation-1'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], {
    ownerUserId: 'owner-1', principalType: 'user', principalId: 'member-1',
    forceAllowed: false, meetingId: 'meeting-1', operationId: 'operation-1'
  });
  assert.deepEqual(Object.keys(response.json()).sort(),
    ['command', 'operationId', 'resultingLifecycleVersion', 'segmentId', 'sessionId', 'status'].sort());
});

test('lease recovery rejects content payload before RPC and preserves principal scope', async () => {
  const calls = [];
  const handler = createHandler({
    async recoverLease(input) {
      calls.push(input);
      return { status: 'ready', attemptOperationId: 'attempt-1', leaseId: 'lease-2', fenceToken: 2 };
    }
  });
  const url = '/api/meetings/meeting-1/recording/lease/recover';
  const body = {
    originalOperationId: 'operation-1', recoveryOperationId: 'recovery-1',
    command: 'stop', expectedLifecycleVersion: 1,
    sessionId: 'session-1', segmentId: 'segment-1',
    priorLeaseId: 'lease-1', priorFenceToken: 1
  };
  const rejected = await request(handler, { url, body: { ...body, checkpoint: { finalCues: [] } } });
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 0);
  const response = await request(handler, { url, body });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], {
    ownerUserId: 'owner-1', principalType: 'user', principalId: 'member-1',
    forceAllowed: false, meetingId: 'meeting-1', ...body
  });
});
