import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMeetingDeletionService } from '../../src/application/meetingDeletionService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

test('DELETE missing meeting logs owner lookup and Supabase diagnostics', async () => {
  const logs = [];
  const repository = createMemoryMeetingRepository();
  const handler = createRequestHandler({
    meetingRepository: repository,
    meetingDeletionService: createDeletionService(repository),
    meetingMembershipService: {
      async canManage() { return true; },
      async canAccessMeeting() { return true; },
      async getMeetingOwner() { return null; }
    },
    requestLogger: (event) => logs.push(event)
  });

  const response = await request(handler, {
    method: 'DELETE',
    url: '/api/meetings/missing-meeting'
  });

  assert.equal(response.status, 404);
  assert.equal(response.json().error.code, 'meeting_not_found');
  assert.equal(response.json().error.requestId, response.headers['X-Request-Id']);
  assert.equal(logs.at(-1).requestId, response.headers['X-Request-Id']);
  assert.equal(logs.at(-1).authStage, 'private_resource');
  assert.equal(logs.at(-1).ownerLookup, 'missing');
  assert.equal(logs.at(-1).resourceOwnerId, null);
  assert.equal(logs.at(-1).supabaseProjectRef, null);
  assert.equal(logs.at(-1).errorCode, 'meeting_not_found');
});

test('DELETE meeting rejects a non-owner before the deletion service runs', async () => {
  const repository = createMemoryMeetingRepository();
  await repository.createMeeting({ id: 'meeting-1', status: 'created', createdAt: 1000 });
  const handler = createRequestHandler({
    meetingRepository: repository,
    meetingDeletionService: createDeletionService(repository),
    accessControl: {
      async validateRequest() {
        return { id: 'member-1', role: 'member', status: 'active' };
      }
    },
    profileService: {
      async getProfile() { return { id: 'member-1', role: 'member', status: 'active' }; },
      async findMeetingMembership() { return null; }
    },
    meetingMembershipService: {
      async canManage() { return false; },
      async canAccessMeeting() { return false; },
      async getMeetingOwner() { return 'owner-1'; }
    }
  });

  const response = await request(handler, {
    method: 'DELETE',
    url: '/api/meetings/meeting-1'
  });

  assert.equal(response.status, 403);
  assert.equal(response.json().error.code, 'auth_forbidden');
  assert.ok(await repository.getMeeting('meeting-1'));
});

function createDeletionService(meetingRepository) {
  return createMeetingDeletionService({
    meetingRepository,
    sessionRepository: {
      async listSessionRecords() { return []; },
      async deleteSessionRecord() { return true; }
    }
  });
}

async function request(handler, { method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const req = new Readable({ read() {} });
  req.url = url;
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  if (body) req.push(body);
  req.push(null);

  const chunks = [];
  const res = {
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = responseHeaders;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };
  await handler(req, res);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return {
    status: res.statusCode,
    headers: res.headers,
    body: rawBody,
    json() { return rawBody ? JSON.parse(rawBody) : {}; }
  };
}
