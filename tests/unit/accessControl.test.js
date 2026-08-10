import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessControl } from '../../server/accessControl.js';

function request(headers = {}) {
  return { headers };
}

test('access control accepts Bearer and legacy headers', () => {
  const access = createAccessControl({ env: { NODE_ENV: 'production', DEMO_ACCESS_TOKEN: 'secret-token' } });

  assert.doesNotThrow(() => access.validateRequest(request({ authorization: 'Bearer secret-token' })));
  assert.doesNotThrow(() => access.validateRequest(request({ 'x-demo-access-token': 'secret-token' })));
  assert.throws(() => access.validateRequest(request()), { code: 'auth_required', status: 401 });
  assert.throws(() => access.validateRequest(request({ authorization: 'Bearer wrong' })), { code: 'auth_invalid', status: 401 });
});

test('access control handles missing production and development configuration', () => {
  assert.throws(
    () => createAccessControl({ env: { NODE_ENV: 'production' } }).validateRequest(request()),
    { code: 'auth_not_configured', status: 503 }
  );
  assert.doesNotThrow(() => createAccessControl({ env: { NODE_ENV: 'test' } }).validateRequest(request()));
});
