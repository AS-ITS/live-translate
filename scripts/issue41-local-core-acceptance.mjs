#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
const finalGate = args.length === 1 && args[0] === '--final-gate';
if (args.length && !finalGate && (args.length !== 1 || args[0] !== '--plan')) {
  throw new Error('Only --plan or --final-gate is supported.');
}

function loopbackUrl(value, protocol) {
  try {
    const url = new URL(value);
    return url.protocol === protocol && url.hostname === '127.0.0.1'
      && !url.username && !url.password && /^\d+$/u.test(url.port);
  } catch { return false; }
}

function command(name, argv, env = process.env) {
  const result = spawnSync(name, argv, { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${name} ${argv[0]} failed; inspect the local services in Mac Terminal.`);
  return result.stdout.trim();
}

async function freePort(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

function readWorkdir() {
  const input = process.env.LOCAL_SUPABASE_WORKDIR;
  if (!input) throw new Error('LOCAL_SUPABASE_WORKDIR is required.');
  const workdir = realpathSync(input);
  if (workdir === project) throw new Error('Repository Supabase is not an isolated workdir.');
  const config = readFileSync(join(workdir, 'supabase/config.toml'), 'utf8');
  const id = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/mu)?.[1];
  const apiPort = config.match(/^\[api\][\s\S]*?^port\s*=\s*(\d+)/mu)?.[1];
  if (!/^issue41-[a-z0-9-]+$/u.test(id || '') || basename(workdir) !== id || !apiPort) {
    throw new Error('Workdir must be the existing issue41 isolated Supabase project.');
  }
  return { workdir, id, apiPort };
}

function safeEnvironment(base, local, redisUrl, token) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|VITE_SUPABASE_|UPSTASH_|WEBRTC_|ISSUE41_|E2E_|GEMINI_)/u.test(key)
      || ['REDIS_URL', 'APP_ORIGIN', 'VERCEL_ENV'].includes(key)) delete env[key];
  }
  return {
    ...env,
    NODE_ENV: 'test', VERCEL_ENV: '', LOCAL_SUPABASE_MODE: 'true',
    SUPABASE_URL: local.API_URL, SUPABASE_SECRET_KEY: local.SERVICE_ROLE_KEY,
    SUPABASE_PUBLISHABLE_KEY: local.ANON_KEY,
    SUPABASE_JWKS_URL: `${local.API_URL}/auth/v1/.well-known/jwks.json`,
    SUPABASE_REALTIME_SIGNING_PRIVATE_JWK: '', SUPABASE_WORKER_USER_ID: '',
    VITE_SUPABASE_URL: local.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: local.ANON_KEY,
    AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
    APP_ORIGIN: 'http://127.0.0.1:5174', dev_frontend_origin: 'http://127.0.0.1:5174',
    dev_backend_origin: 'http://127.0.0.1:3000',
    WEBRTC_SIGNALING_REDIS_URL: redisUrl, WEBRTC_SIGNALING_REDIS_TOKEN: '',
    REDIS_URL: redisUrl, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    WEBRTC_ICE_SERVERS_JSON: '[]', GEMINI_API_KEY: 'test', ENABLE_REAL_GEMINI_TEST: 'false',
    E2E_LOCAL_ACCESS_TOKEN: token
  };
}

async function createLocalIdentity(local) {
  const email = `issue41-e2e-${randomBytes(8).toString('hex')}@example.com`;
  const password = randomBytes(24).toString('base64url');
  const admin = await fetch(`${local.API_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: {
      apikey: local.SERVICE_ROLE_KEY, Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
      'content-type': 'application/json'
    }, body: JSON.stringify({ email, password, email_confirm: true })
  });
  if (!admin.ok) throw new Error(`Local Auth user creation failed (${admin.status}).`);
  const login = await fetch(`${local.API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: local.ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!login.ok) throw new Error(`Local Auth login failed (${login.status}).`);
  const session = await login.json();
  const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString());
  if (claims.iss !== `${local.API_URL}/auth/v1` || claims.sub !== session.user?.id) {
    throw new Error('Local Auth issuer or user identity mismatch.');
  }
  const user = await fetch(`${local.API_URL}/auth/v1/user`, {
    headers: { apikey: local.ANON_KEY, Authorization: `Bearer ${session.access_token}` }
  });
  if (!user.ok || (await user.json()).id !== session.user.id) {
    throw new Error('Local Auth token validation failed.');
  }
  return { token: session.access_token, userId: session.user.id };
}

function verdict(evidence, testExitCode, localUrl, auditNamespace) {
  const checks = {
    audit: evidence.auditCoverage?.namespace === auditNamespace
      && Array.isArray(evidence.auditCoverage.expectedTables)
      && evidence.auditCoverage.expectedTables.length > 0
      && Array.isArray(evidence.auditCoverage.monitoredTables)
      && evidence.auditCoverage.expectedTables.join(',') === evidence.auditCoverage.monitoredTables.join(',')
      ? 'PASS' : 'UNVERIFIED',
    environment: evidence.environment?.browserSupabaseUrl === localUrl
      && evidence.environment?.apiSupabaseUrl === localUrl
      && evidence.environment?.authIssuer === `${localUrl}/auth/v1` ? 'PASS' : 'UNVERIFIED',
    auth: evidence.profileRows?.length > 0 && evidence.secondDevice?.auth?.status === 200
      && evidence.unauthenticatedProfileStatus === 401 ? 'PASS' : 'UNVERIFIED',
    meeting: evidence.meetingId && evidence.secondDevice?.meeting?.serverStatus === 200 ? 'PASS' : 'UNVERIFIED',
    dictionary: evidence.dictionaryUpdated === true ? 'PASS' : 'UNVERIFIED',
    recorder: evidence.continueReadiness?.ready && evidence.finalStop?.continueAvailable
      && evidence.endBarrier?.recordingState === 'stopped_local'
      ? 'PASS' : 'UNVERIFIED',
    hostViewer: evidence.viewer?.map((row) => row.phase).join(',') === 'join-snapshot,subsequent-cue'
      ? 'PASS' : 'UNVERIFIED',
    reload: evidence.localAfterReload?.state === 'stopped_local'
      && evidence.localAfterReload?.opfs?.pcmBytes > 0 && evidence.localAfterReload?.opfs?.chunkBytes > 0
      ? 'PASS' : 'UNVERIFIED',
    localOnlyDb: evidence.result === 'LOCAL_CORE_E2E_PASS'
    && evidence.cloudZeroWrite?.status === 'PASS'
    && evidence.writeEvents?.filter((row) => !['public.meetings', 'public.observability_metric_buckets'].includes(row.relation_name)).length === 0
      && evidence.recordingHttpWrites?.length === 0 ? 'PASS' : 'UNVERIFIED'
  };
  return { LOCAL_CORE_E2E_VERDICT: testExitCode === 0 && Object.values(checks).every((value) => value === 'PASS')
    ? 'PASS' : 'FAIL', checks };
}

async function main() {
  const { workdir, id, apiPort } = readWorkdir();
  const redisUrl = process.env.LOCAL_REDIS_URL;
  if (!loopbackUrl(redisUrl, 'redis:')) throw new Error('LOCAL_REDIS_URL must be an explicit loopback Redis URL.');
  if (args[0] === '--plan') {
    console.log(`PLAN: ${id}, local Supabase API port ${apiPort}, Redis ${new URL(redisUrl).port}; no services contacted.`);
    return;
  }
  const checkEnv = { ...process.env, LOCAL_SUPABASE_WORKDIR: workdir,
    LOCAL_REDIS_URL: redisUrl, AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com' };
  command('npm', ['run', 'start:local', '--', '--check'], checkEnv);
  let local;
  try {
    local = JSON.parse(command('supabase', ['status', '-o', 'json', '--workdir', workdir], checkEnv));
  } catch {
    throw new Error('Isolated Supabase status could not be parsed.');
  }
  if (!loopbackUrl(local.API_URL, 'http:') || new URL(local.API_URL).port !== apiPort
    || !local.ANON_KEY || !local.SERVICE_ROLE_KEY) {
    throw new Error('Isolated Supabase API URL or local keys do not match the workdir.');
  }
  const container = `supabase_db_${id}`;
  const auditNamespace = `issue41_audit_${randomBytes(12).toString('hex')}`;
  const auditExists = command('docker', ['exec', container, 'psql', '-U', 'postgres', '-At', '-c',
    `select to_regnamespace('${auditNamespace}') is null`]);
  if (auditExists !== 't') throw new Error('This run\'s write audit namespace already exists; preserving DB for read-only RCA.');
  if (command('redis-cli', ['-u', redisUrl, 'PING']) !== 'PONG') throw new Error('Isolated Redis did not respond.');
  for (const port of [3000, 3001, 5174]) {
    if (!await freePort(port)) throw new Error(`Port ${port} is occupied; refusing to reuse another service.`);
  }
  const playwright = join(project, 'node_modules/.bin/playwright');
  if (!existsSync(playwright)) throw new Error('Playwright dependency is missing.');
  const runDir = join(project, 'test-results/issue41-runner', `core-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const identity = await createLocalIdentity(local);
  const env = safeEnvironment(checkEnv, local, redisUrl, identity.token);
  Object.assign(env, {
    ISSUE41_ISOLATED_SUPABASE_URL: local.API_URL,
    ISSUE41_ISOLATED_DB_CONTAINER: container,
    ISSUE41_SIGNALING_URL: 'http://127.0.0.1:3001', ISSUE41_REDIS_URL: redisUrl,
    ISSUE41_SIGNALING_REQUEST_LOG: join(runDir, 'signaling-requests.ndjson'),
    ISSUE41_ZERO_WRITE_AUDIT: 'true', ISSUE41_SHORT_VALIDATION: 'true',
    ISSUE41_CORE_ACCEPTANCE: 'true', ISSUE41_AUDIT_NAMESPACE: auditNamespace,
    ISSUE41_EVIDENCE_FILE: join(runDir, 'evidence.json'),
    ISSUE41_FINAL_GATE: finalGate ? 'true' : 'false'
  });
  console.log(`Isolated identity verified: ${id}; Auth issuer ${local.API_URL}/auth/v1.`);
  console.log(`Starting ${finalGate ? 'B2-L final gate' : 'short Chromium acceptance'}; evidence: ${runDir}`);
  const child = spawn(playwright, [
    'test', ...(finalGate
      ? ['tests/e2e/issue41RealEndRecovery.spec.js', 'tests/e2e/issue41SignalingAuth.spec.js',
        '--grep', 'B2-L real API End|issue41 isolated signaling']
      : ['tests/e2e/issue41RealtimeSoak.spec.js']), '--config=tests/e2e/playwright.config.js',
    '--project=chromium', '--reporter=line', '--retries=0', '--trace=off',
    '--output', join(runDir, 'artifacts')
  ], { cwd: project, env, stdio: 'inherit' });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, finalGate ? 2 * 60_000 : 8 * 60_000);
  const exitCode = await new Promise((done) => {
    child.once('error', () => done(127));
    child.once('exit', (code) => done(code ?? 1));
  });
  clearTimeout(timeout);
  if (finalGate) {
    console.log(`B2_L_FINAL_CHROMIUM: ${exitCode === 0 && !timedOut ? 'PASS' : 'FAIL'}; artifacts: ${runDir}`);
    if (exitCode !== 0 || timedOut) process.exitCode = 1;
    return;
  }
  const evidence = existsSync(env.ISSUE41_EVIDENCE_FILE)
    ? JSON.parse(readFileSync(env.ISSUE41_EVIDENCE_FILE, 'utf8')) : {};
  const files = ['scripts/issue41-local-core-acceptance.mjs', 'scripts/issue41-webrtc-signaling-harness.mjs',
    'tests/e2e/issue41RealtimeSoak.spec.js'];
  const sourceHashes = Object.fromEntries(files.map((file) => [file,
    createHash('sha256').update(readFileSync(join(project, file))).digest('hex')]));
  const summary = { ...verdict(evidence, exitCode, local.API_URL, auditNamespace), gitSha: command('git', ['rev-parse', 'HEAD']),
    sourceHashes,
    auditNamespace,
    isolatedProject: id, localSupabaseUrl: local.API_URL, authIssuer: `${local.API_URL}/auth/v1`,
    browser: 'Chromium', provider: 'mock', testExitCode: exitCode, timedOut };
  if (timedOut) summary.LOCAL_CORE_E2E_VERDICT = 'FAIL';
  writeFileSync(join(runDir, 'verdict.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ verdict: summary.LOCAL_CORE_E2E_VERDICT, checks: summary.checks,
    report: join(runDir, 'verdict.json') }));
  if (summary.LOCAL_CORE_E2E_VERDICT !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`LOCAL_CORE_E2E_VERDICT: BLOCKED — ${error.message}`);
  process.exitCode = 1;
});
