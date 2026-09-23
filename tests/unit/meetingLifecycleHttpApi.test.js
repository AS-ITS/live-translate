import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

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

function createHandler(meetingLifecycleService) {
  return createRequestHandler({
    meetingLifecycleService,
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
