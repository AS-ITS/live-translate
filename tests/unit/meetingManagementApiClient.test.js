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
