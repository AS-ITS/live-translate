#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, 'test-results/issue41-runner');
const smokeName = 'long meeting proactively switches through three segments';
const soakName = 'long meeting accelerated 130 minute schedule creates 13 segments without waiting';
const realTimeName = 'issue41 real-time 20-minute local meeting soak';
const soakMs = 20 * 60 * 1000;
const args = process.argv.slice(2);
const command = args[0];
const runId = args[1];
const runDir = runId && /^[a-z0-9-]+$/.test(runId) ? join(root, runId) : null;
const ownPid = process.pid;
let child = null;
let supabaseStarted = false;
let interrupted = false;

function fail(message) { console.error(message); process.exitCode = 1; }
function write(name, value) { writeFileSync(join(runDir, name), String(value)); }
function read(name) { try { return readFileSync(join(runDir, name), 'utf8').trim(); } catch { return ''; } }
function latest() { return runId || (existsSync(join(root, 'latest')) ? readFileSync(join(root, 'latest'), 'utf8').trim() : ''); }
function psIsOurs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes('issue41-local-runner.mjs') && ps.stdout.includes('run');
}
async function freePort(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
  });
}
async function execute(label, bin, argv, env = process.env, cwd = project) {
  if (interrupted) return 143;
  write('state', label);
  const log = openSync(join(runDir, `${label}.log`), 'a');
  child = spawn(bin, argv, { cwd, env, detached: true,
    // Supabase prints local JWT keys on stdout; never put those in the report.
    stdio: label === 'supabase-start' ? ['ignore', 'ignore', log] : ['ignore', log, log] });
  closeSync(log);
  write('child-pid', child.pid);
  console.log(`${new Date().toISOString()} ${label} started pid=${child.pid}`);
  const code = await new Promise((done) => {
    child.once('error', (error) => { console.error(error.message); done(127); });
    child.once('exit', (exitCode, signal) => done(exitCode ?? (signal ? 128 + (signal === 'SIGTERM' ? 15 : 9) : 1)));
  });
  child = null;
  write(`${label}.exit`, code);
  console.log(`${new Date().toISOString()} ${label} exit=${code}`);
  return code;
}
function stopChild() {
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  }
}
function onStop() { interrupted = true; stopChild(); }
function redactReport(secrets) {
  const values = [...new Set([...secrets, 'issue41-test-key'].filter(Boolean))];
  const redactFiles = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { redactFiles(path); continue; }
      if (entry.name === 'trace.zip') {
        const temp = mkdtempSync(join(tmpdir(), 'issue41-trace-'));
        try {
          const unzipped = spawnSync('unzip', ['-qq', path, '-d', temp]);
          if (unzipped.status !== 0) throw new Error('Could not open Playwright trace for redaction.');
          redactFiles(temp);
          const replacement = join(runDir, `.${randomBytes(8).toString('hex')}.zip`);
          const zipped = spawnSync('zip', ['-q', '-r', replacement, '.'], { cwd: temp });
          if (zipped.status !== 0) throw new Error('Could not save redacted Playwright trace.');
          renameSync(replacement, path);
        } finally { rmSync(temp, { recursive: true, force: true }); }
        continue;
      }
      const bytes = readFileSync(path);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes)) continue;
      let redacted = content;
      for (const value of values) redacted = redacted.replaceAll(value, '[REDACTED]');
      redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
        .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gu, '[REDACTED_KEY]');
      if (redacted !== content) writeFileSync(path, redacted);
    }
  };
  redactFiles(runDir);
}
async function run() {
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  write('pid', ownPid);
  write('state', 'preflight');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' });
  if (sha.status === 0) write('git-sha', sha.stdout.trim());
  let exitCode = 1;
  let finalState = 'failed';
  const secrets = [];
  try {
    for (const port of [3000, 5174]) {
      if (!await freePort(port)) throw new Error(`Port ${port} is occupied; refusing to reuse another service.`);
    }
    const options = JSON.parse(read('options.json'));
    if (options.supabase) {
      const base = options.supabasePortBase;
      for (const port of [base, base + 1, base + 2, base + 3, base + 6, base + 7]) {
        if (!await freePort(port)) throw new Error(`Supabase port ${port} is occupied.`);
      }
      mkdirSync(join(runDir, 'supabase'));
      cpSync(join(project, 'supabase/migrations'), join(runDir, 'supabase/migrations'), { recursive: true });
      let config = readFileSync(join(project, 'supabase/config.toml'), 'utf8');
      config = config.replace(/^project_id\s*=.*$/m, `project_id = "issue41-${runId}"`)
        .replace(/\[api\]\nenabled = true/, `[api]\nenabled = true\nport = ${base}`)
        .replace(/\[db\]\nport = \d+/, `[db]\nport = ${base + 1}`)
        .replace(/\[studio\]\nport = \d+/, `[studio]\nport = ${base + 2}`);
      config += `\n[inbucket]\nport = ${base + 3}\n[db.pooler]\nport = ${base + 6}\n[analytics]\nport = ${base + 7}\n`;
      writeFileSync(join(runDir, 'supabase/config.toml'), config);
      supabaseStarted = true; // Also clean up a partially started stack.
      const code = await execute('supabase-start', 'supabase', ['start', '--workdir', runDir, '--yes'], process.env, runDir);
      if (code) throw new Error(`Isolated Supabase startup failed (${code}).`);
      const status = spawnSync('supabase', ['status', '-o', 'json', '--workdir', runDir], { encoding: 'utf8' });
      if (status.status) throw new Error('Isolated Supabase status failed.');
      const localUrl = JSON.parse(status.stdout).API_URL;
      if (new URL(localUrl).port !== String(base)) throw new Error('Isolated Supabase URL mismatch.');
      write('supabase-url', localUrl);
      if (options.realTime) {
        const values = JSON.parse(status.stdout);
        const anonKey = values.ANON_KEY;
        const serviceKey = values.SERVICE_ROLE_KEY;
        if (!anonKey || !serviceKey) throw new Error('Isolated Supabase auth keys are unavailable.');
        const email = `issue41-e2e-${runId}@example.com`;
        const password = randomBytes(24).toString('base64url');
        const created = await fetch(`${localUrl}/auth/v1/admin/users`, { method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, email_confirm: true }) });
        if (!created.ok) throw new Error(`Local Supabase test-user creation failed (${created.status}).`);
        const login = await fetch(`${localUrl}/auth/v1/token?grant_type=password`, { method: 'POST',
          headers: { apikey: anonKey, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }) });
        if (!login.ok) throw new Error(`Local Supabase test-user login failed (${login.status}).`);
        const auth = await login.json();
        if (!auth.access_token) throw new Error('Local Supabase did not issue a user token.');
        secrets.push(auth.access_token, anonKey, serviceKey, password);
        options.auth = { token: auth.access_token, anonKey, serviceKey, url: localUrl };
        write('auth-user-id', auth.user.id);
      }
    }
    const playwright = join(project, 'node_modules/.bin/playwright');
    if (!existsSync(playwright)) throw new Error('Playwright dependency is missing; run npm ci first.');
    const env = { ...process.env, GEMINI_API_KEY: 'test', ENABLE_REAL_GEMINI_TEST: 'false' };
    // The existing E2E fixture aliases @google/genai to its fake browser provider.
    for (const key of ['E2E_LOCAL_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWKS_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) delete env[key];
    const test = (label, name, file = 'tests/e2e/liveTranslate.spec.js', testEnv = env) => execute(label, playwright, [
      'test', file, '--config=tests/e2e/playwright.config.js',
      '--project=chromium', '--grep', name, '--reporter=line,json', '--retries=0',
      '--output', join(runDir, label, 'artifacts')
    ], { ...testEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: join(runDir, `${label}.json`) });
    if (options.realTime) {
      const auth = options.auth;
      const realEnv = { ...env, SUPABASE_URL: auth.url, SUPABASE_SECRET_KEY: auth.serviceKey,
        SUPABASE_JWKS_URL: `${auth.url}/auth/v1/.well-known/jwks.json`,
        VITE_SUPABASE_URL: auth.url, VITE_SUPABASE_PUBLISHABLE_KEY: auth.anonKey,
        E2E_LOCAL_ACCESS_TOKEN: auth.token, AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
        ISSUE41_SHORT_VALIDATION: options.shortValidation ? 'true' : 'false',
        ISSUE41_EVIDENCE_FILE: join(runDir, 'evidence.json') };
      write('soak-started-at', new Date().toISOString());
      const code = await test(options.shortValidation ? 'short-validation' : 'real-time-soak',
        realTimeName, 'tests/e2e/issue41RealtimeSoak.spec.js', realEnv);
      if (code) throw new Error(`Real-time E2E failed (${code}).`);
      write('soak-ended-at', new Date().toISOString());
      exitCode = 0;
      finalState = options.shortValidation ? 'short-validation-passed' : 'passed';
      return;
    }
    if (await test('smoke', smokeName)) throw new Error('Smoke failed; soak was not started.');
    const deadline = Date.now() + soakMs;
    write('soak-started-at', new Date().toISOString());
    let iteration = 0;
    do {
      if (interrupted) throw new Error('Stopped by request.');
      iteration += 1;
      write('soak-iterations', iteration);
      if (await test(`soak-${String(iteration).padStart(3, '0')}`, soakName)) throw new Error(`Soak iteration ${iteration} failed.`);
    } while (Date.now() < deadline);
    write('soak-ended-at', new Date().toISOString());
    exitCode = 0;
    finalState = 'passed';
  } catch (error) {
    console.error(`${new Date().toISOString()} ${error.message}`);
    finalState = interrupted ? 'stopped' : 'failed';
    if (interrupted) exitCode = 143;
  } finally {
    if (supabaseStarted) {
      interrupted = false;
      const code = await execute('supabase-stop', 'supabase', ['stop', '--workdir', runDir], process.env, runDir);
      if (code) { exitCode = 1; finalState = 'cleanup-failed'; }
    }
    try { if (secrets.length) redactReport(secrets); }
    catch (error) { console.error(error.message); exitCode = 1; finalState = 'evidence-redaction-failed'; }
    write('state', finalState);
    write('exit-code', exitCode);
    console.log(`${new Date().toISOString()} finished exit=${exitCode}`);
    process.exitCode = exitCode;
  }
}

if (command === 'start') {
  mkdirSync(root, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase() + `-${process.pid}`;
  const dir = join(root, id);
  mkdirSync(dir);
  const realTime = args.includes('--real-time');
  const shortValidation = args.includes('--short-validation');
  const supabase = realTime || args.includes('--supabase');
  const baseArg = args.find((arg) => arg.startsWith('--supabase-port-base='));
  const supabasePortBase = Number(baseArg?.split('=')[1] || 55421);
  if (shortValidation && !realTime) {
    fail('--short-validation requires --real-time.');
  } else if (supabase && (!Number.isInteger(supabasePortBase) || supabasePortBase < 1024 || supabasePortBase > 65528)) {
    fail('Invalid --supabase-port-base.');
  } else {
    writeFileSync(join(dir, 'options.json'), JSON.stringify({ supabase, supabasePortBase, realTime, shortValidation }));
    writeFileSync(join(root, 'latest'), id);
    const log = openSync(join(dir, 'runner.log'), 'a');
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', id], {
      cwd: project, detached: true, stdio: ['ignore', log, log]
    });
    closeSync(log);
    writeFileSync(join(dir, 'pid'), String(worker.pid));
    writeFileSync(join(dir, 'state'), 'queued');
    worker.unref();
    console.log(`started ${id}\nstatus: node scripts/issue41-local-runner.mjs status ${id}\nreport: ${dir}`);
  }
} else if (command === 'run' && runDir && existsSync(runDir)) {
  await run();
} else if (command === 'status' || command === 'report') {
  const id = latest();
  if (!id) fail('No run found.');
  else {
    const target = join(root, id);
    if (!existsSync(target)) fail('Run ID not found.');
    else {
      const state = readFileSync(join(target, 'state'), 'utf8').trim();
      const pid = Number(readFileSync(join(target, 'pid'), 'utf8').trim());
      console.log(`run: ${id}\nstate: ${state}${psIsOurs(pid) ? ' (worker alive)' : ''}\nexit: ${existsSync(join(target, 'exit-code')) ? readFileSync(join(target, 'exit-code'), 'utf8').trim() : 'pending'}\nreport: ${target}`);
      if (command === 'report') {
        for (const file of readdirSync(target).filter((name) => name.endsWith('.exit'))) {
          console.log(`${file}: ${readFileSync(join(target, file), 'utf8').trim()}`);
        }
        console.log(`log: ${join(target, 'runner.log')}`);
      }
    }
  }
} else if (command === 'stop') {
  const id = latest();
  const target = join(root, id);
  if (!id || !existsSync(target)) fail('Run ID not found.');
  else if (existsSync(join(target, 'exit-code'))) console.log(`Run ${id} already finished.`);
  else {
    const pid = Number(readFileSync(join(target, 'pid'), 'utf8').trim());
    if (!psIsOurs(pid)) fail('Recorded worker PID is no longer this runner; refusing to signal it.');
    else { process.kill(pid, 'SIGTERM'); console.log(`Sent stop to run ${id} (pid ${pid}).`); }
  }
} else {
  fail('Usage: node scripts/issue41-local-runner.mjs start [--real-time] [--short-validation] [--supabase] [--supabase-port-base=55421] | status [id] | report [id] | stop [id]');
}
