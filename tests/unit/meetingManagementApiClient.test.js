import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMeetingManagementApiClient,
  meetingManagementErrorMessage
} from '../../src/lib/meetingManagementApiClient.js';

test('meeting management errors expose API code and request ID', async () => {
  const client = createMeetingManagementApiClient({
    fetchImpl: async () => jsonResponse({
      error: {
        code: 'meeting_checkpoint_unavailable',
        message: 'Meeting checkpoint persistence is not configured.',
        requestId: 'request-123'
      }
    }, { status: 503 })
  });

  await assert.rejects(
    client.create({ name: '產品會議' }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'meeting_checkpoint_unavailable');
      assert.equal(error.requestId, 'request-123');
      return true;
    }
  );
});

test('meeting management client manages invited members', async () => {
  const calls = [];
  const client = createMeetingManagementApiClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'POST') return jsonResponse({ members: [{ userId: 'member-1', email: 'member@example.com' }] }, { status: 201 });
      return jsonResponse({ members: [{ userId: 'member-1', email: 'member@example.com' }] });
    }
  });

  assert.deepEqual(await client.listMembers('meeting-1'), [{ userId: 'member-1', email: 'member@example.com' }]);
  assert.deepEqual(await client.addMember('meeting-1', 'member@example.com'), { userId: 'member-1', email: 'member@example.com' });
  await client.removeMember('meeting-1', 'member-1');
  assert.equal(calls[0].url, '/api/meetings/meeting-1/members');
  assert.equal(JSON.parse(calls[1].options.body).email, 'member@example.com');
  assert.equal(calls[2].options.method, 'DELETE');
});

test('meeting management error messages distinguish authentication and persistence failures', () => {
  assert.equal(
    meetingManagementErrorMessage({ code: 'auth_invalid', requestId: 'request-auth' }),
    '登入狀態已失效，請重新登入。（識別碼：request-auth）'
  );
  assert.equal(
    meetingManagementErrorMessage({ code: 'meeting_checkpoint_unavailable' }),
    '會議儲存服務目前未配置。'
  );
  assert.equal(
    meetingManagementErrorMessage({ status: 500 }, '自訂錯誤。'),
    '自訂錯誤。'
  );
  assert.equal(
    meetingManagementErrorMessage({ status: 404 }),
    '分享連結服務找不到，請確認部署的 API 版本。'
  );
  assert.equal(
    meetingManagementErrorMessage({ code: 'meeting_share_invalid', status: 404 }),
    '分享連結服務找不到，請確認部署的 API 版本。'
  );
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
