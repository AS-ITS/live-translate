#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeExportRam, analyzeRamGate } from './issue41-ram-gate.mjs';

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
const isolatedEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'CI', 'PLAYWRIGHT_BROWSERS_PATH',
    'DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key)));
let child = null;
let supabaseStarted = false;
let interrupted = false;

function fail(message) { console.error(message); process.exitCode = 1; }
function write(name, value) { writeFileSync(join(runDir, name), String(value)); }
function read(name) { try { return readFileSync(join(runDir, name), 'utf8').trim(); } catch { return ''; } }
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
let startedAt = null;
let phase = 'queued';
function status(state = 'RUNNING', exitCode = null) {
  const evidence = readJson(join(runDir, 'evidence.json')) || {};
  const currentPhase = state !== 'RUNNING' || phase === 'supabase-stop' ? phase
    : evidence.barrierCompletedAt ? 'reload-export-cloud-inventory'
    : evidence.captureElapsedMs ? 'stop-finalize' : evidence.captureStartedAt ? 'recording-capture' : phase;
  atomicJson(join(runDir, 'status.json'), {
    runId, state, startedAt, phase: currentPhase, lastHeartbeat: new Date().toISOString(),
    completedRollovers: evidence.rolloverObservations?.length ?? 0,
    workerPid: ownPid, exitCode
  });
}
function setPhase(value) { phase = value; write('state', value); status(); }
function summarize(finalState, exitCode) {
  const evidencePath = join(runDir, 'evidence.json');
  const options = readJson(join(runDir, 'options.json')) || {};
  if (!existsSync(evidencePath)) atomicJson(evidencePath, { result: finalState, phase });
  const evidence = readJson(evidencePath) || {};
  const virtualMic = readJson(join(runDir, 'virtual-mic.json'));
  const migrationEvidence = readJson(join(runDir, 'verified-migrations.json'));
  const checkExit = (label) => read(`${label}.exit`) === '0' ? 'PASS'
    : existsSync(join(runDir, `${label}.exit`)) ? 'FAIL' : 'NOT_RUN';
  const resourcesPath = join(runDir, 'resources.ndjson');
  const rows = existsSync(resourcesPath) ? readFileSync(resourcesPath, 'utf8').trim().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  const measured = (key) => rows.map((row) => key === 'opfsBytes' ? row.opfs?.bytes
    : key === 'opfsFiles' ? row.opfs?.files : row[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const range = (key) => {
    const values = measured(key);
    return values.length ? { min: Math.min(...values), max: Math.max(...values), last: values.at(-1) } : 'NOT_MEASURED';
  };
  const ramGate = analyzeRamGate(rows, evidence.barrierCompletedAt, {
    minimumCaptureMs: (options.ramGateMinutes || 40) * 60_000
  });
  const gateExitCode = options.ramGateMinutes && exitCode === 0 && ramGate.verdict !== 'PASS' ? 1 : exitCode;
  const gateFinalState = gateExitCode !== exitCode ? `ram-gate-${ramGate.verdict.toLowerCase()}` : finalState;
  const allowedCheckStates = new Set(['PASS', 'FAIL', 'UNVERIFIED', 'NOT_RUN', 'BLOCKED']);
  const evidenceChecks = Object.fromEntries(Object.entries(evidence.evidenceChecks || {})
    .map(([name, state]) => [name, allowedCheckStates.has(state) ? state : 'UNVERIFIED']));
  const evidenceVerdict = ['precheck-blocked', 'environment-blocked'].includes(finalState) ? 'BLOCKED'
    : gateExitCode !== 0 ? 'FAIL'
      : !options.ramGateMinutes ? 'NOT_RUN'
        : !Object.keys(evidenceChecks).length ? 'UNVERIFIED'
          : Object.values(evidenceChecks).some((state) => state === 'FAIL') ? 'FAIL'
            : Object.values(evidenceChecks).some((state) => state !== 'PASS') ? 'UNVERIFIED' : 'PASS';
  const fullScans = evidence.fullScans || [];
  atomicJson(join(runDir, 'summary.json'), {
    runId, state: gateFinalState === 'environment-blocked' ? 'BLOCKED' : gateExitCode === 0 ? 'PASS' : 'FAIL',
    LOCAL_SMOKE_ENV_VERDICT: options.localAudioMode
      ? (finalState.includes('blocked') ? 'BLOCKED'
        : ['supabase-start', 'unified-lifecycle', 'b2l-post-migration', 'signaling-preflight',
          ...(options.signalingPreflight ? [] : ['virtual-mic'])].every((label) => checkExit(label) === 'PASS')
          ? 'PASS' : 'FAIL') : 'NOT_RUN',
    VIRTUAL_MIC_VERDICT: options.localAudioMode ? (virtualMic?.VIRTUAL_MIC_VERDICT || 'NOT_RUN') : 'NOT_RUN',
    migrationCount: migrationEvidence?.count ?? null,
    schemaContracts: { unifiedLifecycle: checkExit('unified-lifecycle'),
      b2lPostMigration: checkExit('b2l-post-migration') },
    b2Contracts: { writer: checkExit('b2-targeted-contracts'),
      recovery: checkExit('b2-targeted-contracts'), viewer: checkExit('b2-targeted-contracts'),
      hostViewerSmoke: checkExit('short-validation') },
    REAL_GEMINI_AUDIO_SMOKE_VERDICT: options.realGeminiAudio
      ? (evidence.REAL_GEMINI_AUDIO_SMOKE_VERDICT || 'FAIL') : 'NOT_RUN',
    lateFinal: evidence.lateFinal || 'NOT_OBSERVED',
    nonPrefixRevision: evidence.nonPrefixRevision || 'NOT_OBSERVED',
    finalState: gateFinalState, exitCode: gateExitCode,
    startedAt, finishedAt: new Date().toISOString(), result: evidence.result || null,
    captureElapsedMs: evidence.captureElapsedMs ?? null, pcm: evidence.pcm ?? null,
    rollovers: evidence.rolloverObservations?.length ?? 0,
    segments: evidence.preStopSegments?.length ?? null,
    journal: evidence.journalClaims?.map((recording) => ({
      recordingId: recording.recordingId, hashesValid: recording.hashesValid, epochs: recording.epochs
    })) ?? null,
    stopBarrierCompletedAt: evidence.barrierCompletedAt ?? null,
    reloadedState: evidence.restored?.recordingState ?? null,
    exported: evidence.exported ? { audio: evidence.exported.audio, perSegment: evidence.exported.perSegment } : null,
    cloudBefore: evidence.cloudBefore ?? null, cloudAfter: evidence.cloudAfter ?? null,
    cloudZeroWrite: evidence.cloudZeroWrite ?? { status: 'NOT_RUN' },
    evidenceChecks, EVIDENCE_VERDICT: evidenceVerdict,
    observerConfiguration: evidence.ramConfiguration ?? { observer: 'UNVERIFIED' },
    ramComparisonPolicy: 'Compare only runs with the same observer configuration; profile changes do not prove a product memory fix.',
    fullScanOverhead: { count: fullScans.length,
      intervalMs: evidence.ramConfiguration?.fullScanIntervalMs ?? null,
      actualIntervalsMs: fullScans.slice(1).map((scan, index) =>
        Date.parse(scan.at) - Date.parse(fullScans[index].at)),
      durationsMs: fullScans.map((scan) => scan.durationMs),
      phases: fullScans.map((scan) => scan.phase) },
    RECORDING_SOAK_VERDICT: evidence.result ?? (exitCode === 0 ? 'UNDETERMINED' : 'FAIL'),
    RAM_GATE_VERDICT: ramGate.verdict,
    ramGate,
    EXPORT_RAM_VERDICT: 'UNDETERMINED',
    exportRam: analyzeExportRam(rows),
    wavValidationRam: analyzeExportRam(rows, { phase: 'wav_validation' }),
    segmentValidationRam: analyzeExportRam(rows, { phase: 'segment_validation' }),
    resources: { samples: rows.length, chromiumRssBytes: range('chromiumRssBytes'),
      jsHeapBytes: range('jsHeapBytes'), opfsBytes: range('opfsBytes'),
      opfsFiles: range('opfsFiles'), audioChunks: range('audioChunks'),
      pcmJournalPendingWrites: range('pcmJournalPendingWrites'),
      pcmJournalPendingScope: 'worker_requests_only' }
  });
  return { exitCode: gateExitCode, finalState: gateFinalState };
}
function latest() { return runId || (existsSync(join(root, 'latest')) ? readFileSync(join(root, 'latest'), 'utf8').trim() : ''); }
function psIsOurs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes('issue41-local-runner.mjs') && ps.stdout.includes('run');
}
async function freePort(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', (error) => resolvePort(error.code || 'LISTEN_FAILED'));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
  });
}
async function execute(label, bin, argv, env = process.env, cwd = project) {
  if (interrupted) return 143;
  setPhase(label);
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
  startedAt = new Date().toISOString();
  writeFileSync(join(runDir, 'resources.ndjson'), '');
  setPhase('preflight');
  const heartbeat = setInterval(() => status(), 30_000);
  heartbeat.unref();
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' });
  if (sha.status === 0) write('git-sha', sha.stdout.trim());
  let exitCode = 1;
  let finalState = 'failed';
  const secrets = [];
  try {
    const options = JSON.parse(read('options.json'));
    let testGeminiKey = null;
    if (options.realGeminiAudio) {
      testGeminiKey = process.env.ISSUE41_TEST_GEMINI_KEY?.trim();
      if (!testGeminiKey) throw new Error('PRECHECK_BLOCKED: ISSUE41_TEST_GEMINI_KEY required in process environment.');
      if (!/^AIza[\w-]{20,}$/u.test(testGeminiKey)) throw new Error('PRECHECK_BLOCKED: invalid test Key format.');
      secrets.push(testGeminiKey);
    }
    if (options.localAudioMode) {
      const aiff = join(runDir, 'fixed-speech.aiff');
      const wav = join(runDir, 'fixed-speech.wav');
      const speech = spawnSync('/usr/bin/say', ['-v', 'Samantha', '-o', aiff,
        'The weather is clear today. This is a live translation audio test. Please translate this sentence.'],
      { encoding: 'utf8' });
      if (speech.status !== 0) throw new Error('PRECHECK_BLOCKED: fixed speech synthesis failed.');
      const conversion = spawnSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav],
        { encoding: 'utf8' });
      if (conversion.status !== 0) throw new Error('PRECHECK_BLOCKED: fixed speech WAV conversion failed.');
      const bytes = readFileSync(wav);
      const durationMs = Math.round((bytes.length - 44) / 32000 * 1000);
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
        || durationMs < 4000 || durationMs > 30000) throw new Error('PRECHECK_BLOCKED: fixed WAV duration/format invalid.');
      atomicJson(join(runDir, 'audio-fixture.json'), { path: wav, durationMs,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const apiPort = options.localAudioMode ? 31041 : 3000;
    const frontendPort = options.localAudioMode ? 5175 : 5174;
    const signalingPort = options.localAudioMode ? 31042 : 3001;
    for (const port of options.recordingOnly ? [apiPort, frontendPort] : [apiPort, signalingPort, frontendPort]) {
      const availability = await freePort(port);
      if (availability !== true) throw new Error(`${availability === 'EPERM' ? 'ENVIRONMENT_BLOCKED' : 'PRECHECK_BLOCKED'}: Port ${port} unavailable (${availability}).`);
    }
    let databaseContainer = null;
    if (options.supabase) {
      const base = options.supabasePortBase;
      for (const port of [base, base + 1, base + 2, base + 3, base + 6, base + 7]) {
        const availability = await freePort(port);
        if (availability !== true) throw new Error(`${availability === 'EPERM' ? 'ENVIRONMENT_BLOCKED' : 'PRECHECK_BLOCKED'}: Supabase port ${port} unavailable (${availability}).`);
      }
      mkdirSync(join(runDir, 'supabase'));
      cpSync(join(project, 'supabase/migrations'), join(runDir, 'supabase/migrations'), { recursive: true });
      let config = readFileSync(join(project, 'supabase/config.toml'), 'utf8');
      config = config.replace(/^project_id\s*=.*$/m, `project_id = "issue41-${runId}"`)
        .replace(/\[api\]\nenabled = true/, `[api]\nenabled = true\nport = ${base}`)
        .replace(/\[db\]\nport = \d+/, `[db]\nport = ${base + 1}`)
        .replace(/\[studio\]\nport = \d+/, `[studio]\nport = ${base + 2}`);
      config = config.replace(/http:\/\/127\.0\.0\.1:5173/g, `http://127.0.0.1:${frontendPort}`)
        .replace(/^\[auth\.external\.google\]\n[\s\S]*?(?=^\[|$)/mu, '[auth.external.google]\nenabled = false\n');
      config += `\n[local_smtp]\nport = ${base + 3}\n[db.pooler]\nport = ${base + 6}\n[analytics]\nport = ${base + 7}\n`;
      writeFileSync(join(runDir, 'supabase/config.toml'), config);
      const loopbackNetwork = `issue41-loopback-${runId}`;
      if (options.localAudioMode) {
        const network = spawnSync('docker', ['network', 'create',
          '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', loopbackNetwork],
        { encoding: 'utf8' });
        if (network.status !== 0) throw new Error('ENVIRONMENT_BLOCKED: isolated loopback Docker network could not be created.');
        write('docker-network', loopbackNetwork);
      }
      supabaseStarted = true; // Also clean up a partially started stack.
      const code = await execute('supabase-start', 'supabase', ['start', '--workdir', runDir, '--yes',
        ...(options.localAudioMode ? ['--network-id', loopbackNetwork] : [])],
        options.localAudioMode ? isolatedEnvironment() : process.env, runDir);
      if (code) throw new Error(`Isolated Supabase startup failed (${code}).`);
      const status = spawnSync('supabase', ['status', '-o', 'json', '--workdir', runDir], { encoding: 'utf8' });
      if (status.status) throw new Error('Isolated Supabase status failed.');
      const localUrl = JSON.parse(status.stdout).API_URL;
      if (!localUrl || new URL(localUrl).hostname !== '127.0.0.1' || new URL(localUrl).port !== String(base)) {
        throw new Error('PRECHECK_BLOCKED: isolated Supabase URL mismatch.');
      }
      write('supabase-url', localUrl);
      const containers = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
      databaseContainer = `supabase_db_issue41-${runId}`;
      if (containers.status !== 0 || !containers.stdout.split('\n').includes(databaseContainer)) {
        throw new Error('Isolated Supabase database container was not found.');
      }
      if (options.localAudioMode) {
    const stackContainers = containers.stdout.split('\n').filter((name) =>
      name.startsWith('supabase_') && name.endsWith(`_issue41-${runId}`));
        const bindings = spawnSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}',
      ...stackContainers],
        { encoding: 'utf8' });
        const mapped = bindings.status === 0 ? bindings.stdout.trim().split('\n').flatMap((line) =>
          Object.values(JSON.parse(line)).flatMap((value) => value || [])) : [];
        atomicJson(join(runDir, 'observed-port-bindings.json'),
          mapped.map(({ HostIp, HostPort }) => ({ HostIp, HostPort })));
    if (bindings.status !== 0 || mapped.length < 3 || mapped.some((entry) => !['127.0.0.1', '::1'].includes(entry.HostIp))) {
          throw new Error('ENVIRONMENT_BLOCKED: local Supabase exposes a non-loopback Docker port.');
        }
    const publishedPorts = [...new Set(mapped.map((entry) => entry.HostPort))];
    const listeners = publishedPorts.map((port) => {
      const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      return { port, exitCode: result.status, lines: result.stdout.trim().split('\n').slice(1) };
    });
    atomicJson(join(runDir, 'observed-host-listeners.json'), listeners);
    if (listeners.some(({ port, exitCode, lines }) => exitCode !== 0 || lines.length === 0
      || lines.some((line) => !line.includes(`TCP 127.0.0.1:${port} (LISTEN)`)
        && !line.includes(`TCP [::1]:${port} (LISTEN)`)))) {
      throw new Error('ENVIRONMENT_BLOCKED: local Supabase has a non-loopback or unverifiable host listener.');
    }
    atomicJson(join(runDir, 'verified-port-bindings.json'), mapped.map(({ HostIp, HostPort }) => ({ HostIp, HostPort })));
      }
      const requiredMigrations = ['20261031000000', '20261101000000', '20261102000000',
        '20261103000000', '20261104000000', '20261105000000'];
      const migrationCheck = spawnSync('docker', ['exec', databaseContainer, 'psql', '-U', 'postgres', '-At', '-c',
        `select version from supabase_migrations.schema_migrations where version in (${requiredMigrations.map((version) => `'${version}'`).join(',')}) order by version`],
      { encoding: 'utf8' });
      const applied = migrationCheck.stdout.trim().split('\n').filter(Boolean);
      if (migrationCheck.status !== 0 || applied.join(',') !== requiredMigrations.join(',')) {
        throw new Error(`Isolated Supabase migrations incomplete: ${applied.join(',') || 'none'}.`);
      }
      write('verified-migrations', applied.join('\n'));
      const migrationNames = readdirSync(join(project, 'supabase/migrations'))
        .filter((name) => /^\d{14}_.+\.sql$/u.test(name)).sort();
      const expectedVersions = migrationNames.map((name) => name.slice(0, 14));
      const completeHistory = spawnSync('docker', ['exec', databaseContainer, 'psql', '-U', 'postgres', '-At', '-c',
        'select version from supabase_migrations.schema_migrations order by version'], { encoding: 'utf8' });
      const appliedVersions = completeHistory.stdout.trim().split('\n').filter(Boolean);
      if (completeHistory.status !== 0 || new Set(expectedVersions).size !== expectedVersions.length
        || appliedVersions.join(',') !== expectedVersions.join(',')) {
        throw new Error(`PRECHECK_BLOCKED: full migration history differs: expected ${expectedVersions.length}, applied ${appliedVersions.length}.`);
      }
      const manifest = migrationNames.map((name) => ({
        name, sha256: createHash('sha256').update(readFileSync(join(project, 'supabase/migrations', name))).digest('hex')
      }));
      for (const { name, sha256 } of manifest) {
        if (createHash('sha256').update(readFileSync(join(runDir, 'supabase/migrations', name))).digest('hex') !== sha256) {
          throw new Error(`PRECHECK_BLOCKED: isolated migration copy differs: ${name}`);
        }
      }
      atomicJson(join(runDir, 'verified-migrations.json'), { count: appliedVersions.length, migrations: manifest });
    if (options.realTime && !options.recordingOnly && !options.localAudioMode) {
        const redisPidFile = join(root, 'redis-local-16379/redis.pid');
        const redisPid = existsSync(redisPidFile) ? Number(readFileSync(redisPidFile, 'utf8').trim()) : 0;
        const listener = spawnSync('lsof', ['-nP', '-t', '-iTCP:16379', '-sTCP:LISTEN'], { encoding: 'utf8' });
        const ping = spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', '16379', 'PING'], { encoding: 'utf8' });
        const redisConfig = spawnSync('redis-cli', ['--raw', '-h', '127.0.0.1', '-p', '16379',
          'CONFIG', 'GET', 'bind', 'protected-mode', 'appendonly'], { encoding: 'utf8' });
        if (!Number.isSafeInteger(redisPid) || redisPid <= 0 || listener.status !== 0
          || listener.stdout.trim() !== String(redisPid) || ping.status !== 0 || ping.stdout.trim() !== 'PONG'
          || redisConfig.status !== 0 || !redisConfig.stdout.includes('127.0.0.1')
          || !redisConfig.stdout.includes('protected-mode\nyes')
          || !redisConfig.stdout.includes('appendonly\nno')) {
          throw new Error('Isolated loopback Redis on port 16379 is unavailable or not the test-owned instance.');
        }
        write('verified-redis-pid', redisPid);
      }
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
        const authCheck = await fetch(`${localUrl}/auth/v1/user`, {
          headers: { apikey: anonKey, Authorization: `Bearer ${auth.access_token}` }
        });
        if (!authCheck.ok || (await authCheck.json()).id !== auth.user.id) {
          throw new Error(`PRECHECK_BLOCKED: isolated Auth JWT validation failed (${authCheck.status}).`);
        }
        options.auth = { token: auth.access_token, anonKey, serviceKey, url: localUrl };
        write('auth-user-id', auth.user.id);
        write('verified-auth-url', localUrl);
        if (options.localAudioMode) {
          for (const [label, filename] of [
            ['unified-lifecycle', 'issue41UnifiedLifecycle.sql'],
            ['b2l-post-migration', 'issue41B2LPostMigration.sql']
          ]) {
            const contract = spawnSync('docker', ['exec', '-i', databaseContainer, 'psql', '-X',
              '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], {
              input: readFileSync(join(project, 'tests/integration', filename)), encoding: 'utf8'
            });
            write(`${label}.log`, contract.stdout + contract.stderr);
            write(`${label}.exit`, contract.status);
            if (contract.status !== 0) throw new Error(`PRECHECK_BLOCKED: ${label} schema contract failed.`);
          }
        }
      }
    }
    const playwright = join(project, 'node_modules/.bin/playwright');
    if (!existsSync(playwright)) throw new Error('Playwright dependency is missing; run npm ci first.');
    const env = { ...(options.localAudioMode ? isolatedEnvironment() : process.env),
      GEMINI_API_KEY: options.realGeminiAudio ? '' : 'test',
      ENABLE_REAL_GEMINI_TEST: options.realGeminiAudio ? 'true' : 'false',
      ...(options.localAudioMode ? {
        ISSUE41_E2E_API_PORT: String(apiPort), ISSUE41_E2E_FRONTEND_PORT: String(frontendPort),
        ISSUE41_SIGNALING_PORT: String(signalingPort), ISSUE41_LOCAL_SMOKE: 'true', ISSUE41_RUN_DIR: runDir,
        ISSUE41_REAL_GEMINI_AUDIO: options.realGeminiAudio ? 'true' : 'false'
      } : {}) };
    // The existing E2E fixture aliases @google/genai to its fake browser provider.
    for (const key of ['E2E_LOCAL_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWKS_URL',
      'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'REDIS_URL', 'WEBRTC_SIGNALING_REDIS_URL',
      'WEBRTC_SIGNALING_REDIS_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'WEBRTC_ICE_SERVERS_JSON', 'ISSUE41_SIGNALING_URL', 'ISSUE41_REDIS_URL',
    'ISSUE41_SIGNALING_REQUEST_LOG']) delete env[key];
    const test = (label, name, file = 'tests/e2e/liveTranslate.spec.js', testEnv = env) => execute(label, playwright, [
      'test', file, '--config=tests/e2e/playwright.config.js',
      '--project=chromium', '--grep', name, '--reporter=line,json', '--retries=0',
      '--output', join(runDir, label, 'artifacts')
    ], { ...testEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: join(runDir, `${label}-playwright.json`) });
    if (options.localAudioMode) {
      const listener = spawnSync('lsof', ['-nP', '-t', '-iTCP:16379', '-sTCP:LISTEN'], { encoding: 'utf8' });
      const ping = spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', '16379', 'PING'], { encoding: 'utf8' });
      const redisConfig = spawnSync('redis-cli', ['--raw', '-h', '127.0.0.1', '-p', '16379',
        'CONFIG', 'GET', 'bind', 'protected-mode', 'appendonly'], { encoding: 'utf8' });
      const database = spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', '16379', '-n', '15', 'DBSIZE'],
        { encoding: 'utf8' });
      if (listener.status !== 0 || !/^\d+$/u.test(listener.stdout.trim())
        || ping.status !== 0 || ping.stdout.trim() !== 'PONG'
        || redisConfig.status !== 0 || !redisConfig.stdout.includes('bind\n127.0.0.1')
        || !redisConfig.stdout.includes('protected-mode\nyes')
        || !redisConfig.stdout.includes('appendonly\nno')
        || database.status !== 0 || database.stdout.trim() !== '0') {
        throw new Error('ENVIRONMENT_BLOCKED: loopback Redis 16379 DB 15 is unavailable or occupied.');
      }
      write('verified-redis-pid', listener.stdout.trim());
      write('verified-redis-db', 15);
    }
    if (options.realTime) {
      const auth = options.auth;
      if (!auth?.token || !auth.anonKey || !auth.serviceKey || auth.url !== read('verified-auth-url')) {
        throw new Error('PRECHECK_BLOCKED: isolated Auth fixture is incomplete.');
      }
      const auditNamespace = `issue41_audit_${randomBytes(12).toString('hex')}`;
      const auditCheck = spawnSync('docker', ['exec', databaseContainer, 'psql', '-U', 'postgres', '-At', '-c',
        `select to_regnamespace('${auditNamespace}') is null`], { cwd: project, encoding: 'utf8' });
      if (auditCheck.status !== 0 || auditCheck.stdout.trim() !== 't') {
        throw new Error('PRECHECK_BLOCKED: this run\'s audit namespace already exists or could not be checked.');
      }
      write('audit-namespace', auditNamespace);
      const realEnv = { ...env, SUPABASE_URL: auth.url, SUPABASE_SECRET_KEY: auth.serviceKey,
        ...(options.localAudioMode ? { ISSUE41_LOCAL_AUDIO_WAV: join(runDir, 'fixed-speech.wav') } : {}),
        ...(options.realGeminiAudio ? { ISSUE41_TEST_GEMINI_KEY: testGeminiKey } : {}),
        SUPABASE_JWKS_URL: `${auth.url}/auth/v1/.well-known/jwks.json`,
        VITE_SUPABASE_URL: auth.url, VITE_SUPABASE_PUBLISHABLE_KEY: auth.anonKey,
        ISSUE41_ISOLATED_SUPABASE_URL: auth.url,
        ISSUE41_ISOLATED_DB_CONTAINER: databaseContainer,
        ISSUE41_AUDIT_NAMESPACE: auditNamespace,
        ISSUE41_ZERO_WRITE_AUDIT: options.zeroWriteAudit ? 'true' : 'false',
      ...(options.recordingOnly ? { ISSUE41_RECORDING_ONLY: 'true' } : {
        ISSUE41_SIGNALING_URL: `http://127.0.0.1:${signalingPort}`,
        ISSUE41_REDIS_URL: `redis://127.0.0.1:16379${options.localAudioMode ? '/15' : ''}`,
        ISSUE41_SIGNALING_REQUEST_LOG: join(runDir, 'signaling-requests.ndjson'),
        WEBRTC_ICE_SERVERS_JSON: '[]'
      }),
        E2E_LOCAL_ACCESS_TOKEN: auth.token, AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
        ISSUE41_SHORT_VALIDATION: options.shortValidation ? 'true' : 'false',
        ISSUE41_ROLLOVER_CONTRACT: options.recordingContract ? 'true' : 'false',
        ISSUE41_RAM2_DIAGNOSTIC: options.ram2Diagnostic ? 'true' : 'false',
      ISSUE41_RAM10_DIAGNOSTIC: options.ram10Diagnostic ? 'true' : 'false',
        ISSUE41_RAM_ATTRIBUTION_SMOKE: options.ramAttributionSmoke ? 'true' : 'false',
        ISSUE41_RAM_ABC_SMOKE: options.ramAbcSmoke ? 'true' : 'false',
        ISSUE41_RAM_ABC_MODE: options.ramAbcMode || '',
        ISSUE41_RAM_3C_PROFILE: options.ramProfileC ? 'true' : 'false',
        ISSUE41_EVIDENCE_FILE: join(runDir, 'evidence.json'),
        ISSUE41_VIRTUAL_MIC_EVIDENCE_FILE: join(runDir, 'virtual-mic.json'),
        ISSUE41_RESOURCE_FILE: join(runDir, 'resources.ndjson'),
        ISSUE41_RECORDING_SOAK_MINUTES: String(options.soakMinutes || 20) };
      if (!options.recordingOnly && await test('signaling-preflight', 'issue41 isolated signaling authorizes independent Host and Viewer through real Redis',
        'tests/e2e/issue41SignalingAuth.spec.js', realEnv)) {
        throw new Error('Isolated signaling authorization preflight failed; short smoke was not started.');
      }
  if (options.signalingPreflight) {
    exitCode = 0;
    finalState = 'signaling-preflight-passed';
    return;
  }
      if (options.localAudioMode) {
        if (await test('virtual-mic', 'issue41 virtual microphone produces timed non-silent PCM',
          'tests/e2e/issue41AudioSmoke.spec.js', realEnv)) {
          throw new Error('Virtual microphone PCM preflight failed.');
        }
    if (options.localPreflight) {
      exitCode = 0;
      finalState = 'local-preflight-passed';
      return;
    }
    if (options.realGeminiAudio) {
      if (await test('real-gemini-audio', 'issue41 real Gemini audio reaches local Cue and Viewer',
            'tests/e2e/issue41AudioSmoke.spec.js', realEnv)) {
            throw new Error('Real Gemini audio smoke failed.');
          }
          exitCode = 0;
          finalState = 'real-gemini-audio-smoke-passed';
          return;
        }
      }
      write('soak-started-at', new Date().toISOString());
    const code = await test(options.ramProfileC ? 'ram-3c-profile' : options.ramAbcSmoke ? 'ram-abc-smoke' : options.ramAbcMode ? `ram-abc-${options.ramAbcMode}` : options.ramAttributionSmoke ? 'ram-attribution-smoke' : options.zeroWriteAudit ? 'zero-write-audit' : options.recordingOnly ? (options.recordingContract ? 'recording-rollover-contract' : options.shortValidation ? 'recording-smoke' : `recording-${options.soakMinutes || 20}min-soak`) : options.shortValidation ? 'short-validation' : 'real-time-soak',
      options.ramProfileC ? 'issue41 RAM-3C isolated profile' : options.ramAbcSmoke ? 'issue41 A/B/C RAM mode smoke' : options.ramAbcMode ? `issue41 RAM diagnostic ${options.ramAbcMode}` : options.ramAttributionSmoke ? 'issue41 Host RAM attribution smoke' : options.zeroWriteAudit ? 'issue41 isolated zero recording write audit' : options.recordingOnly ? (options.recordingContract ? 'issue41 recording-only controlled rollover contract' : options.shortValidation ? 'issue41 recording-only local smoke' : `issue41 recording-only ${options.soakMinutes || 20}-minute real-time soak`) : realTimeName,
        'tests/e2e/issue41RealtimeSoak.spec.js', realEnv);
      if (code) throw new Error(`Real-time E2E failed (${code}).`);
      if (options.localPreflight) {
        const contractCode = await execute('b2-targeted-contracts', process.execPath, ['--test',
          'tests/unit/cueB2Writer.test.js', 'tests/unit/issue41CueRecoveryAuthority.test.js',
          'tests/unit/meetingViewerState.test.js'], realEnv);
        if (contractCode) throw new Error(`B2 Writer/Recovery/Viewer contracts failed (${contractCode}).`);
      }
      write('soak-ended-at', new Date().toISOString());
      exitCode = 0;
      finalState = options.localPreflight ? 'local-preflight-passed' : options.ramProfileC ? 'ram-3c-profile-passed' : options.ramAbcSmoke ? 'ram-abc-smoke-passed' : options.ramAbcMode ? `ram-abc-${options.ramAbcMode}-passed` : options.ramAttributionSmoke ? 'ram-attribution-smoke-passed' : options.recordingOnly ? (options.recordingContract ? 'recording-rollover-contract-passed' : options.shortValidation ? 'recording-smoke-passed' : `recording-${options.soakMinutes || 20}min-soak-passed`) : options.shortValidation ? 'short-validation-passed' : 'passed';
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
    finalState = interrupted ? 'stopped' : error.message.startsWith('ENVIRONMENT_BLOCKED:') ? 'environment-blocked'
      : error.message.startsWith('PRECHECK_BLOCKED:') ? 'precheck-blocked' : 'failed';
    if (interrupted) exitCode = 143;
  } finally {
    if (supabaseStarted) {
      interrupted = false;
      const code = await execute('supabase-stop', 'supabase', ['stop', '--workdir', runDir], process.env, runDir);
      if (code) { exitCode = 1; finalState = 'cleanup-failed'; }
    }
    try { if (secrets.length) redactReport(secrets); }
    catch (error) { console.error(error.message); exitCode = 1; finalState = 'evidence-redaction-failed'; }
    try { ({ exitCode, finalState } = summarize(finalState, exitCode)); }
    catch (error) { console.error(`Could not write summary: ${error.message}`); exitCode = 1; finalState = 'summary-failed'; }
    clearInterval(heartbeat);
    write('state', finalState);
    write('exit-code', exitCode);
    phase = finalState;
    status(finalState === 'environment-blocked' ? 'BLOCKED' : exitCode === 0 ? 'PASS' : 'FAIL', exitCode);
    console.log(`${new Date().toISOString()} finished exit=${exitCode}`);
    process.exitCode = exitCode;
  }
}

if (command === 'start') {
  mkdirSync(root, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase() + `-${process.pid}`;
  const dir = join(root, id);
  mkdirSync(dir);
  const recordingContract = args.includes('--recording-contract');
  const ram2Diagnostic = args.includes('--ram2-diagnostic');
  const ram10Diagnostic = args.includes('--ram10-diagnostic');
  const ramAttributionSmoke = args.includes('--ram-attribution-smoke');
    const ramAbcSmoke = args.includes('--ram-abc-smoke');
    const ramProfileC = args.includes('--ram-3c-profile');
    const ramAbcArg = args.find((arg) => arg.startsWith('--ram-abc='));
    const ramAbcMode = ramAbcArg?.slice('--ram-abc='.length) || null;
    if (ramAbcMode && !['A', 'B', 'C'].includes(ramAbcMode)) fail('RAM ABC mode must be A, B, or C.');
  const ramGateMinutes = args.includes('--ram-gate-40') ? 40 : args.includes('--ram-gate-130') ? 130 : null;
  const naturalRollover21 = args.includes('--natural-rollover-21');
  const localPreflight = args.includes('--local-preflight');
  const signalingPreflight = args.includes('--signaling-preflight');
  const realGeminiAudio = args.includes('--real-gemini-audio-smoke');
  const localAudioMode = localPreflight || signalingPreflight || realGeminiAudio;
    const zeroWriteAudit = args.includes('--zero-write-audit');
  const recordingOnly = zeroWriteAudit || recordingContract || ram2Diagnostic || ram10Diagnostic || ramAttributionSmoke || ramAbcSmoke || ramProfileC || Boolean(ramAbcMode) || args.includes('--recording-only') || args.includes('--recording-soak') || naturalRollover21 || ramGateMinutes !== null;
  const realTime = recordingOnly || localAudioMode || args.includes('--real-time');
  const shortValidation = args.includes('--recording-soak') || naturalRollover21 || ram10Diagnostic || ramAbcMode || ramGateMinutes !== null ? false : localAudioMode || recordingOnly || args.includes('--short-validation');
  const supabase = realTime || args.includes('--supabase');
  const baseArg = args.find((arg) => arg.startsWith('--supabase-port-base='));
  const supabasePortBase = Number(baseArg?.split('=')[1] || 55421);
  if (Number(localPreflight) + Number(signalingPreflight) + Number(realGeminiAudio) > 1) {
    fail('Choose one local audio mode.');
  } else if (localAudioMode && (recordingOnly || args.includes('--real-time')
    || args.includes('--short-validation') || args.includes('--supabase'))) {
    fail('Local audio modes cannot be combined with soak or legacy run flags.');
  } else if (shortValidation && !realTime) {
    fail('--short-validation requires --real-time.');
  } else if (supabase && (!Number.isInteger(supabasePortBase) || supabasePortBase < 1024 || supabasePortBase > 65528)) {
    fail('Invalid --supabase-port-base.');
  } else {
      writeFileSync(join(dir, 'options.json'), JSON.stringify({ supabase, supabasePortBase, realTime,
    localAudioMode, localPreflight, signalingPreflight, realGeminiAudio, shortValidation, recordingOnly, zeroWriteAudit,
        recordingContract: recordingContract || ram2Diagnostic || zeroWriteAudit, ram2Diagnostic,
        ram10Diagnostic, ramAttributionSmoke, ramAbcSmoke, ramAbcMode, ramProfileC,
        soakMinutes: ram10Diagnostic || ramAbcMode ? 10 : naturalRollover21 ? 21 : ramGateMinutes || 20, ramGateMinutes }));
    writeFileSync(join(root, 'latest'), id);
    writeFileSync(join(dir, 'state'), 'queued');
    atomicJson(join(dir, 'status.json'), { runId: id, state: 'RUNNING', startedAt: new Date().toISOString(), phase: 'queued', lastHeartbeat: new Date().toISOString(), workerPid: null, exitCode: null });
    const log = openSync(join(dir, 'runner.log'), 'a');
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', id], {
      cwd: project, detached: true, stdio: ['ignore', log, log]
    });
    closeSync(log);
    writeFileSync(join(dir, 'pid'), String(worker.pid));
    worker.unref();
    console.log(`started ${id}\nstatus: node scripts/issue41-local-runner.mjs status ${id}\nreport: ${dir}`);
  }
} else if (command === 'run' && runDir && existsSync(runDir)) {
  await run();
} else if (command === 'status' || command === 'report' || command === 'analyze') {
  const id = latest();
  if (!id) fail('No run found.');
  else {
    const target = join(root, id);
    if (!existsSync(target)) fail('Run ID not found.');
    else {
      const state = readFileSync(join(target, 'state'), 'utf8').trim();
      const pid = Number(readFileSync(join(target, 'pid'), 'utf8').trim());
      console.log(`run: ${id}\nstate: ${state}${psIsOurs(pid) ? ' (worker alive)' : ''}\nexit: ${existsSync(join(target, 'exit-code')) ? readFileSync(join(target, 'exit-code'), 'utf8').trim() : 'pending'}\nreport: ${target}`);
      if (command === 'analyze') console.log(JSON.stringify(readJson(join(target, 'summary.json')) || { state: 'RUNNING', statusFile: join(target, 'status.json') }, null, 2));
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
  fail('Usage: node scripts/issue41-local-runner.mjs start [--signaling-preflight | --local-preflight | --real-gemini-audio-smoke | --ram-attribution-smoke | --recording-only | --recording-soak | --ram10-diagnostic | --ram-gate-40 | --ram-gate-130] [--supabase-port-base=55421] | status [id] | report [id] | analyze [id] | stop [id]');
}
