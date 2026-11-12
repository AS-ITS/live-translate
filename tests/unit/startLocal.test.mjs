import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildLocalEnvironment, isLoopbackUrl, readConfigPort, readLocalGoogleOAuthSecret, resolveLocalSupabaseWorkdir } from '../../scripts/start-local.mjs';

test('local OAuth secret loads only from a mode-600 env file', (t) => {
  const directory = mkdtempSync(join(new URL('../../test-results/', import.meta.url).pathname, 'local-oauth-'));
  const path = join(directory, '.env.local');
  t.after(() => { unlinkSync(path); rmdirSync(directory); });
  writeFileSync(path, 'SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=local-test-only\n', { mode: 0o600 });
  assert.equal(readLocalGoogleOAuthSecret(path), 'local-test-only');
  chmodSync(path, 0o644);
  assert.throws(() => readLocalGoogleOAuthSecret(path), /mode 600/u);
});

test('local startup accepts only loopback service URLs', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:54321'), true);
  assert.equal(isLoopbackUrl('http://localhost:54321'), true);
  assert.equal(isLoopbackUrl('https://project.supabase.co'), false);
  assert.equal(isLoopbackUrl('http://192.168.1.10:54321'), false);
  assert.equal(isLoopbackUrl('redis://127.0.0.1:6379', 'redis:'), true);
  assert.equal(isLoopbackUrl('rediss://redis.example.com', 'redis:'), false);
});

test('local startup reads only the requested Supabase config section', () => {
  const config = 'project_id = "local"\n[api]\nenabled = true\n[db]\nport = 54322\n';
  assert.equal(readConfigPort(config, 'api', '54321'), '54321');
  assert.equal(readConfigPort(config, 'db'), '54322');
});

test('local startup uses only the main project directory', () => {
  const project = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '');
  assert.equal(resolveLocalSupabaseWorkdir(), project);
  assert.equal(resolveLocalSupabaseWorkdir(project), project);
  assert.throws(() => resolveLocalSupabaseWorkdir('/tmp/other-project'), /main project directory/u);
});

test('local frontend and API override cloud Supabase configuration together', () => {
  const env = buildLocalEnvironment({
    apiUrl: 'http://127.0.0.1:55421', anonKey: 'local-public', serviceKey: 'local-server'
  }, {
    SUPABASE_URL: 'https://production.supabase.co',
    SUPABASE_SECRET_KEY: 'production-server',
    SUPABASE_PUBLISHABLE_KEY: 'production-public',
    SUPABASE_REALTIME_SIGNING_PRIVATE_JWK: 'production-signing-key',
    SUPABASE_WORKER_USER_ID: 'production-worker',
    SUPABASE_JWKS_URL: 'https://production.supabase.co/auth/v1/.well-known/jwks.json',
    VITE_SUPABASE_URL: 'https://production.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'production-public',
    SUPABASE_ACCESS_TOKEN: 'production-access-token',
    VERCEL_ENV: 'production'
  });
  assert.equal(env.SUPABASE_URL, env.VITE_SUPABASE_URL);
  assert.equal(env.SUPABASE_URL, 'http://127.0.0.1:55421');
  assert.equal(env.SUPABASE_SECRET_KEY, 'local-server');
  assert.equal(env.SUPABASE_PUBLISHABLE_KEY, 'local-public');
  assert.equal(env.SUPABASE_REALTIME_SIGNING_PRIVATE_JWK, '');
  assert.equal(env.SUPABASE_WORKER_USER_ID, '');
  assert.equal(env.VITE_SUPABASE_PUBLISHABLE_KEY, 'local-public');
  assert.equal(env.SUPABASE_JWKS_URL, `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  assert.equal(env.LOCAL_SUPABASE_MODE, 'true');
  assert.equal(env.AUTH_ALLOWED_EMAIL_DOMAINS, '');
  assert.equal(env.SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(env.VERCEL_ENV, undefined);
});

test('local startup preserves only an explicitly exported domain allowlist', () => {
  const local = { apiUrl: 'http://127.0.0.1:55421', anonKey: 'local-public', serviceKey: 'local-server' };
  assert.equal(buildLocalEnvironment(local, { AUTH_ALLOWED_EMAIL_DOMAINS: ' as.edu.tw,gmail.com ' }).AUTH_ALLOWED_EMAIL_DOMAINS, 'as.edu.tw,gmail.com');
  assert.equal(buildLocalEnvironment(local, {}).AUTH_ALLOWED_EMAIL_DOMAINS, '');
});

test('local startup rejects a cloud Supabase endpoint even with local keys', () => {
  assert.throws(() => buildLocalEnvironment({
    apiUrl: 'https://production.supabase.co', anonKey: 'local-public', serviceKey: 'local-server'
  }), /loopback stack/u);
});

test('Vite uses the local child-process URL with env-file loading disabled', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { loadEnv } from "vite"; process.stdout.write(loadEnv("development", false).VITE_SUPABASE_URL);'
  ], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:55421' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'http://127.0.0.1:55421');
});
