import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudEnvironmentError, inspectCloudEnvironment } from '../../server/cloudEnvironment.js';

const validEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'service-key',
  SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
};

test('cloud environment validator accepts one Supabase project', () => {
  const result = inspectCloudEnvironment({ env: validEnv, requireBrowserConfig: true });
  assert.equal(result.ok, true);
  assert.equal(result.projectRef, 'project');
  assert.deepEqual(result.issues, []);
});

test('cloud environment validator identifies project mismatches without exposing values', () => {
  const result = inspectCloudEnvironment({
    env: { ...validEnv, VITE_SUPABASE_URL: 'https://other.supabase.co' },
    requireBrowserConfig: true
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, [{ code: 'supabase_browser_project_mismatch', variable: 'VITE_SUPABASE_URL' }]);
  const error = cloudEnvironmentError({ env: { ...validEnv, VITE_SUPABASE_URL: 'https://other.supabase.co' } });
  assert.equal(error.code, 'supabase_browser_project_mismatch');
  assert.doesNotMatch(JSON.stringify(error), /service-key|publishable-key|other\.supabase/);
});

test('cloud environment validator reports missing server configuration safely', () => {
  const result = inspectCloudEnvironment({ env: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.variable), [
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_JWKS_URL',
    'AUTH_ALLOWED_EMAIL_DOMAINS'
  ]);
});
