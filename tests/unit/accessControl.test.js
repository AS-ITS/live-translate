import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessControl } from '../../server/accessControl.js';

function request(headers = {}) {
  return { headers };
}

test('access control accepts Bearer and demo headers', async () => {
  const access = createAccessControl({ env: { NODE_ENV: 'production', DEMO_ACCESS_TOKEN: 'secret-token' } });
  await assert.doesNotReject(access.validateRequest(request({ authorization: 'Bearer secret-token' })));
  await assert.doesNotReject(access.validateRequest(request({ 'x-demo-access-token': 'secret-token' })));
  await assert.rejects(access.validateRequest(request()), { code: 'auth_required', status: 401 });
  await assert.rejects(access.validateRequest(request({ authorization: 'Bearer wrong' })), { code: 'auth_invalid', status: 401 });
});

test('access control handles missing production configuration', async () => {
  await assert.rejects(
    createAccessControl({ env: { NODE_ENV: 'production' } }).validateRequest(request()),
    { code: 'auth_not_configured', status: 503 },
  );
  await assert.doesNotReject(createAccessControl({ env: { NODE_ENV: 'test' } }).validateRequest(request()));
});
