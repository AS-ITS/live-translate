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

test('local member membership is required for recording and owner-only management', async () => {
  const profileService = createProfileService({ env: {} });
  const owner = { id: 'owner-1', role: 'member', status: 'active' };
  const member = { id: 'member-1', role: 'member', status: 'active' };
  await profileService.addMeetingMember(owner, 'meeting-1', 'member-1');
  assert.equal(await profileService.canRecordMeeting(member, 'meeting-1'), true);
  assert.equal(await profileService.canRecordMeeting(member, 'missing-meeting'), false);
  await assert.rejects(profileService.listMeetingMembers(member, 'meeting-1'), { code: 'auth_forbidden' });
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
