import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildLocalEnvironment, isLoopbackUrl, readConfigPort, resolveLocalSupabaseWorkdir } from '../../scripts/start-local.mjs';

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

test('local startup fails closed without an isolated Supabase workdir', () => {
  assert.throws(() => resolveLocalSupabaseWorkdir(), /LOCAL_SUPABASE_WORKDIR is required/u);
  assert.throws(() => resolveLocalSupabaseWorkdir('  '), /LOCAL_SUPABASE_WORKDIR is required/u);
  assert.throws(() => resolveLocalSupabaseWorkdir('.'), /isolated workdir/u);
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
    VITE_SUPABASE_PUBLISHABLE_KEY: 'production-public'
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
});

test('local startup rejects a cloud Supabase endpoint even with local keys', () => {
  assert.throws(() => buildLocalEnvironment({
    apiUrl: 'https://production.supabase.co', anonKey: 'local-public', serviceKey: 'local-server'
  }), /loopback stack/u);
});

test('Vite uses the local child-process URL ahead of cloud .env values', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { loadEnv } from "vite"; process.stdout.write(loadEnv("development", process.cwd()).VITE_SUPABASE_URL);'
  ], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:55421' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'http://127.0.0.1:55421');
});
