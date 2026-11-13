import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isAllowedEmailDomain } from '../../server/accessControl.js';
import { assertLocalOAuthFileSecurity, buildLocalEnvironment, cliSpawnArguments, isLoopbackUrl, localCliInvocation,
  projectDirectoryFromModuleUrl, readConfigPort, readLocalGoogleOAuthCredentials,
  resolveLocalSupabaseWorkdir } from '../../scripts/start-local.mjs';

test('local OAuth credentials load only from a mode-600 env file', (t) => {
  const directory = mkdtempSync(join(fileURLToPath(new URL('../../test-results/', import.meta.url)), 'local-oauth-'));
  const path = join(directory, '.env.local');
  t.after(() => { unlinkSync(path); rmdirSync(directory); });
  writeFileSync(path, 'GOOGLE_CLIENT_ID=local-test-id\nGOOGLE_CLIENT_SECRET=local-test-secret\n', { mode: 0o600 });
  assert.deepEqual(readLocalGoogleOAuthCredentials(path), {
    clientId: 'local-test-id', clientSecret: 'local-test-secret'
  });
  chmodSync(path, 0o644);
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /mode 600/u);
});
test('local OAuth setup fails clearly when credentials are absent or left as placeholders', (t) => {
  const directory = mkdtempSync(join(fileURLToPath(new URL('../../test-results/', import.meta.url)), 'local-oauth-'));
  const path = join(directory, '.env.local');
  t.after(() => { unlinkSync(path); rmdirSync(directory); });
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /Create supabase\/\.env\.local.*GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/u);
  writeFileSync(path, 'GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID\nGOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET\n', { mode: 0o600 });
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /Invalid GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET format/u);
  writeFileSync(path, 'GOOGLE_CLIENT_SECRET=missing-id\n', { mode: 0o600 });
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /Missing GOOGLE_CLIENT_ID/u);
  writeFileSync(path, 'GOOGLE_CLIENT_ID: malformed\nGOOGLE_CLIENT_SECRET=local-test-secret\n', { mode: 0o600 });
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /Malformed GOOGLE_CLIENT_ID assignment/u);
  writeFileSync(path, 'GOOGLE_CLIENT_ID="unclosed\nGOOGLE_CLIENT_SECRET=local-test-secret\n', { mode: 0o600 });
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /Invalid GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET format/u);
  writeFileSync(path, 'GOOGLE_CLIENT_ID="local test id"\nGOOGLE_CLIENT_SECRET=local-test-secret\n', { mode: 0o600 });
  assert.throws(() => readLocalGoogleOAuthCredentials(path), /Invalid GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET format/u);
  writeFileSync(path, ' GOOGLE_CLIENT_ID = "local-test-id" \r\nGOOGLE_CLIENT_SECRET = "local-test-secret"\r\n', { mode: 0o600 });
  assert.deepEqual(readLocalGoogleOAuthCredentials(path), {
    clientId: 'local-test-id', clientSecret: 'local-test-secret'
  });
});

test('module URL paths decode Windows drives, spaces, Unicode, and Unix roots', () => {
  assert.equal(projectDirectoryFromModuleUrl(
    'file:///C:/Users/admin/Desktop/live-translate/scripts/start-local.mjs', true),
  'C:\\Users\\admin\\Desktop\\live-translate');
  assert.equal(projectDirectoryFromModuleUrl(
    'file:///C:/Users/admin/%E4%B8%AD%E6%96%87%20Folder/live-translate/scripts/start-local.mjs', true),
  'C:\\Users\\admin\\中文 Folder\\live-translate');
  assert.equal(projectDirectoryFromModuleUrl('file:///Users/admin/live-translate/scripts/start-local.mjs', false),
    '/Users/admin/live-translate');
  assert.equal(projectDirectoryFromModuleUrl(
    'file:///Users/admin/%E4%B8%AD%E6%96%87%20Folder/live-translate/scripts/start-local.mjs', false),
  '/Users/admin/中文 Folder/live-translate');
  assert.equal(projectDirectoryFromModuleUrl('file:///home/admin/live-translate/scripts/start-local.mjs', false),
    '/home/admin/live-translate');
});

test('Unix mode and Windows ACL checks use different security rules', () => {
  const file = { isFile: () => true, mode: 0o100644 };
  assert.throws(() => assertLocalOAuthFileSecurity('fixture', file, 'linux'), /mode 600/u);
  assert.throws(() => assertLocalOAuthFileSecurity('fixture', file, 'darwin'), /mode 600/u);
  const aclRunner = (name, args, options) => {
    assert.equal(name, 'powershell.exe');
    assert.equal(options.env.LOCAL_OAUTH_ENV_FILE, 'fixture');
    return { status: 0, stdout: 'COMMON_SAFE\n' };
  };
  assert.doesNotThrow(() => assertLocalOAuthFileSecurity('fixture', file, 'win32', aclRunner));
  assert.throws(() => assertLocalOAuthFileSecurity('fixture', file, 'win32',
    () => ({ status: 0, stdout: 'BROAD\n' })), /broad Windows group/u);
  assert.throws(() => assertLocalOAuthFileSecurity('fixture', file, 'win32',
    () => ({ status: 1, stdout: '' })), /ACL could not be verified/u);
  assert.throws(() => assertLocalOAuthFileSecurity('fixture',
    { isFile: () => false, mode: 0o100600 }, 'win32', aclRunner), /not a symlink or directory/u);
});

test('local OAuth unreadable file has its own error', () => {
  const inaccessible = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  assert.throws(() => readLocalGoogleOAuthCredentials('fixture', {
    lstatSync: () => ({ isFile: () => true, mode: 0o100600 }),
    readFileSync: () => { throw inaccessible; }
  }), /not readable/u);
});

test('CLI selection uses Windows exe or cmd and Unix executables', () => {
  const env = { Path: 'C:\\Program Files\\Supabase;C:\\Program Files\\nodejs' };
  const available = new Set([
    'C:\\Program Files\\Supabase\\supabase.exe',
    'C:\\Program Files\\nodejs\\npm.cmd'
  ]);
  const exists = (path) => available.has(path);
  assert.deepEqual(localCliInvocation('supabase', 'win32', env, exists), {
    file: 'C:\\Program Files\\Supabase\\supabase.exe', shell: false
  });
  assert.deepEqual(localCliInvocation('npm', 'win32', env, exists), {
    file: 'C:\\Program Files\\nodejs\\npm.cmd', shell: true
  });
  assert.deepEqual(cliSpawnArguments(localCliInvocation('npm', 'win32', env, exists), ['run', 'dev']), {
    file: '"C:\\Program Files\\nodejs\\npm.cmd"', args: ['"run"', '"dev"']
  });
  assert.deepEqual(cliSpawnArguments({ file: 'C:\\工具\\supabase.cmd', shell: true },
    ['--workdir', 'C:\\Users\\admin\\中文 Folder\\live-translate']), {
    file: '"C:\\工具\\supabase.cmd"',
    args: ['"--workdir"', '"C:\\Users\\admin\\中文 Folder\\live-translate"']
  });
  assert.deepEqual(localCliInvocation('docker', 'linux', { PATH: '/usr/bin' }, exists), {
    file: 'docker', shell: false
  });
});

test('local child environment retains Windows Path casing and system directories', () => {
  const env = buildLocalEnvironment({
    apiUrl: 'http://127.0.0.1:54321', anonKey: 'local-public', serviceKey: 'local-server'
  }, { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\admin\\AppData' });
  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.APPDATA, 'C:\\Users\\admin\\AppData');
});

test('check and normal startup reject the same missing local OAuth file', (t) => {
  const directory = mkdtempSync(join(fileURLToPath(new URL('../../test-results/', import.meta.url)), 'local start 中文-'));
  const scripts = join(directory, 'scripts');
  mkdirSync(scripts);
  const launcher = join(scripts, 'start-local.mjs');
  copyFileSync(fileURLToPath(new URL('../../scripts/start-local.mjs', import.meta.url)), launcher);
  const supabase = join(directory, 'supabase');
  const envFile = join(supabase, '.env.local');
  t.after(() => { unlinkSync(envFile); rmdirSync(supabase); unlinkSync(launcher); rmdirSync(scripts); rmdirSync(directory); });
  const run = (args) => spawnSync(process.execPath, [launcher, ...args], {
    cwd: directory, encoding: 'utf8'
  });
  const normal = run([]);
  const check = run(['--check']);
  assert.equal(normal.status, 1);
  assert.equal(check.status, 1);
  assert.equal(normal.stderr, check.stderr);
  assert.match(normal.stderr, /Create supabase\/\.env\.local.*Expected path:/u);
  mkdirSync(supabase);
  writeFileSync(envFile, 'GOOGLE_CLIENT_ID=local-test-id\nGOOGLE_CLIENT_SECRET=local-test-secret\n', { mode: 0o600 });
  const withFile = run(['--check']);
  assert.equal(withFile.status, 1);
  assert.doesNotMatch(withFile.stderr, /Create supabase\/\.env\.local/u);
  assert.match(withFile.stderr, /config\.toml/u);
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
  const project = fileURLToPath(new URL('../../', import.meta.url)).replace(/[/\\]$/u, '');
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
  assert.equal(env.GOOGLE_CLIENT_ID, undefined);
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(env.VERCEL_ENV, undefined);
});

test('local startup preserves only an explicitly exported domain allowlist', () => {
  const local = { apiUrl: 'http://127.0.0.1:55421', anonKey: 'local-public', serviceKey: 'local-server' };
  const unrestricted = buildLocalEnvironment(local, {});
  assert.equal(unrestricted.AUTH_ALLOWED_EMAIL_DOMAINS, '');
  assert.equal(isAllowedEmailDomain('member@gmail.com', unrestricted.AUTH_ALLOWED_EMAIL_DOMAINS), true);
  assert.equal(isAllowedEmailDomain('member@another.example', unrestricted.AUTH_ALLOWED_EMAIL_DOMAINS), true);
  assert.equal(isAllowedEmailDomain('invalid-email', unrestricted.AUTH_ALLOWED_EMAIL_DOMAINS), false);
  assert.equal(buildLocalEnvironment(local, { AUTH_ALLOWED_EMAIL_DOMAINS: '  \t ' }).AUTH_ALLOWED_EMAIL_DOMAINS, '');
  const restricted = buildLocalEnvironment(local, { AUTH_ALLOWED_EMAIL_DOMAINS: ' example.com ' });
  assert.equal(restricted.AUTH_ALLOWED_EMAIL_DOMAINS, 'example.com');
  assert.equal(isAllowedEmailDomain('member@example.com', restricted.AUTH_ALLOWED_EMAIL_DOMAINS), true);
  assert.equal(isAllowedEmailDomain('member@gmail.com', restricted.AUTH_ALLOWED_EMAIL_DOMAINS), false);
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
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:55421' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'http://127.0.0.1:55421');
});
