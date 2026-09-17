import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';
import { createAuditLogService } from '../../server/auditLogService.js';
import { createProfileService } from '../../server/profileService.js';
import { createRequestHandler } from '../../server/index.js';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { Readable } from 'node:stream';

function makeRequest(handler, { method = 'GET', url, headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(statusCode, responseHeaders = {}) { this.statusCode = statusCode; Object.assign(this.headers, responseHeaders); },
      end(payload = '') { this.body = payload; resolve(this); },
      write() {}
    };
    handler(req, res);
  }).then((response) => {
    try { response.json = JSON.parse(response.body); } catch { response.json = null; }
    return response;
  });
}

const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };

test('auth event audit records active and blocked profile outcomes', async () => {
  const entries = [];
  let user = { id: 'active-1', email: 'active@example.com' };
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => user },
    profileService: { getProfile: async () => ({ ...user, status: user.id === 'active-1' ? 'active' : user.id === 'pending-1' ? 'pending' : 'disabled' }) },
    authEventAuditLogService: { record: async (entry) => entries.push(entry) }
  });

  const success = await makeRequest(handler, { method: 'POST', url: '/api/auth-events', headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' }, body: JSON.stringify({ event: 'login' }) });
  assert.equal(success.statusCode, 202);
  assert.equal(entries[0].action, 'auth_login');
  assert.equal(entries[0].result, 'success');

  user = { id: 'pending-1', email: 'pending@example.com' };
  const failure = await makeRequest(handler, { method: 'POST', url: '/api/auth-events', headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' }, body: JSON.stringify({ event: 'login' }) });
  assert.equal(failure.statusCode, 202);
  assert.equal(entries[1].result, 'failure');

  user = { id: 'disabled-1', email: 'disabled@example.com' };
  const disabled = await makeRequest(handler, { method: 'POST', url: '/api/auth-events', headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' }, body: JSON.stringify({ event: 'login' }) });
  assert.equal(disabled.statusCode, 202);
  assert.equal(entries[2].result, 'failure');
});

test('local member membership is required for recording and owner-only management', async () => {
  const profileService = createProfileService({ env: {} });
  const owner = { id: 'owner-1', role: 'member', status: 'active' };
  const member = { id: 'member-1', role: 'member', status: 'active' };
  await profileService.addMeetingMember(owner, 'meeting-1', 'member-1');
  assert.equal(await profileService.canRecordMeeting(member, 'meeting-1'), true);
  assert.equal(await profileService.canRecordMeeting(member, 'missing-meeting'), false);
  await assert.rejects(profileService.listMeetingMembers(member, 'meeting-1'), { code: 'auth_forbidden' });
});

test('pending cloud profiles cannot be invited to a meeting', async () => {
  const service = createProfileService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url) => {
      if (url.includes('/profiles?id=eq.owner-1')) return new Response(JSON.stringify([{ id: 'owner-1', role: 'member', status: 'active' }]));
      if (url.includes('/meetings?id=eq.meeting-1')) return new Response(JSON.stringify([{ owner_user_id: 'owner-1' }]));
      if (url.includes('/profiles?email=eq.pending%40example.com')) return new Response(JSON.stringify([{ id: 'pending-1', email: 'pending@example.com', status: 'pending' }]));
      throw new Error(`unexpected request: ${url}`);
    }
  });
  await assert.rejects(service.addMeetingMember({ id: 'owner-1', role: 'member', status: 'active' }, 'meeting-1', 'pending@example.com'), { code: 'auth_forbidden' });
});

test('admin adapter validates target and writes safe audit records around RPC failure', async () => {
  const entries = [];
  const auditLogService = createAuditLogService({ repository: { append: async (entry) => entries.push(entry) } });
  const service = createAdminService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' },
    auditLogService,
    fetchImpl: async (url) => {
      if (url.includes('profiles?id=in.')) return new Response(JSON.stringify([
        { id: 'source-1', status: 'active' },
        { id: 'target-1', status: 'disabled' }
      ]));
      return new Response(JSON.stringify([]), { status: 200 });
    }
  });
  await assert.rejects(service.disableUser(admin, 'source-1', 'target-1', 'request-1'), { code: 'transfer_target_invalid' });
  assert.equal(entries.at(-1).result, 'failure');
  assert.equal(entries.every((entry) => !Object.hasOwn(entry, 'test-secret')), true);
});

test('HTTP private meeting routes separate actor and resource owner scope', async () => {
  const users = {
    owner: { id: 'owner-1', role: 'member', status: 'active' },
    member: { id: 'member-1', role: 'member', status: 'active' }
  };
  let activeUser = users.owner;
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => activeUser },
    profileService: { getProfile: async () => activeUser, findMeetingMembership: async () => null },
    meetingMembershipService: {
      canManage: async (meetingId, actor) => meetingId === 'meeting-1' && actor.id === 'owner-1',
      canRecord: async () => false,
      getMeetingOwner: async () => 'owner-1',
      getSessionOwner: async () => null
    },
    meetingReadController: {
      getMeeting: async () => ({ ownerUserId: currentRequestOwnerId() })
    }
  });

  const ownerResponse = await makeRequest(handler, { url: '/api/meetings/meeting-1' });
  assert.equal(ownerResponse.statusCode, 200);
  assert.equal(ownerResponse.json.ownerUserId, 'owner-1');

  activeUser = users.member;
  const memberResponse = await makeRequest(handler, { url: '/api/meetings/meeting-1' });
  assert.equal(memberResponse.statusCode, 403);
  assert.equal(memberResponse.json.error.code, 'auth_forbidden');
});

test('member recording permission PATCH is owner-scoped over HTTP', async () => {
  const users = {
    owner: { id: 'owner-1', role: 'member', status: 'active' },
    member: { id: 'member-1', role: 'member', status: 'active' },
    otherOwner: { id: 'owner-2', role: 'member', status: 'active' },
    admin: { id: 'admin-1', role: 'super_admin', status: 'active' }
  };
  let activeUser = users.owner;
  const profileService = createProfileService({ env: {} });
  await profileService.addMeetingMember(users.owner, 'meeting-1', users.member.id);
  const meetingRepository = { getMeeting: async (meetingId) => meetingId === 'meeting-1' ? { id: meetingId, ownerUserId: users.owner.id } : null };
  const meetingMembershipService = {
    canManage: async (meetingId, user) => meetingId === 'meeting-1' && (user.id === users.owner.id || user.role === 'super_admin'),
    canRecord: async () => true,
    getMeetingOwner: async () => users.owner.id,
    getSessionOwner: async () => null
  };
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => activeUser },
    profileService,
    meetingRepository,
    meetingMembershipService
  });

  const disabled = await makeRequest(handler, { method: 'PATCH', url: '/api/meetings/meeting-1/members/member-1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canRecord: false }) });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json.member.canRecord, false);
  assert.equal((await profileService.listMeetingMembers(users.owner, 'meeting-1'))[0].canRecord, false);

  const invalid = await makeRequest(handler, { method: 'PATCH', url: '/api/meetings/meeting-1/members/member-1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canRecord: 'false' }) });
  assert.equal(invalid.statusCode, 400);

  activeUser = users.member;
  const memberDenied = await makeRequest(handler, { method: 'PATCH', url: '/api/meetings/meeting-1/members/member-1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canRecord: true }) });
  assert.equal(memberDenied.statusCode, 403);

  activeUser = users.otherOwner;
  const otherOwnerDenied = await makeRequest(handler, { method: 'PATCH', url: '/api/meetings/meeting-1/members/member-1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canRecord: true }) });
  assert.equal(otherOwnerDenied.statusCode, 403);

  activeUser = users.admin;
  const restored = await makeRequest(handler, { method: 'PATCH', url: '/api/meetings/meeting-1/members/member-1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canRecord: true }) });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json.member.canRecord, true);
});

test('test session reset is test-only and remains behind the API auth gate', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const deleted = [];
  process.env.NODE_ENV = 'test';
  const sessionRepository = {
    async listSessionRecords() { return [{ id: 'session-1', audioArtifacts: [{ id: 'audio-1' }] }]; },
    async deleteSessionRecord(id) { deleted.push(id); },
  };
  const handler = createRequestHandler({
    sessionRepository,
    sessionAudioArtifactRepository: { async deleteMany(artifacts) { deleted.push(...artifacts.map(({ id }) => `audio:${id}`)); } },
    accessControl: { async validateRequest() {} },
  });

  try {
    const resetResponse = await makeRequest(handler, { method: 'DELETE', url: '/api/test/sessions' });
    assert.equal(resetResponse.statusCode, 204);
    assert.deepEqual(deleted, ['audio:audio-1', 'session-1']);

    process.env.NODE_ENV = 'development';
    const protectedHandler = createRequestHandler({
      sessionRepository,
      accessControl: { async validateRequest() { throw Object.assign(new Error('authentication required'), { code: 'auth_required' }); } },
    });
    const protectedResponse = await makeRequest(protectedHandler, { method: 'DELETE', url: '/api/test/sessions' });
    assert.equal(protectedResponse.statusCode, 401);
    assert.equal(protectedResponse.json.error.code, 'auth_required');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
