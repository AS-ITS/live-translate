#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from 'vite';

const project = new URL('../', import.meta.url).pathname;
const configured = loadEnv('development', project, '');
const redisUrl = process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379';
export function resolveLocalSupabaseWorkdir(value) {
  if (!String(value || '').trim()) throw new Error('LOCAL_SUPABASE_WORKDIR is required.');
  const workdir = resolve(value);
  if (workdir === resolve(project)) throw new Error('LOCAL_SUPABASE_WORKDIR must be an isolated workdir.');
  return workdir;
}

export function isLoopbackUrl(value, protocol = 'http:') {
  try {
    const url = new URL(value);
    return url.protocol === protocol && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}

export function readConfigPort(config, sectionName, fallback = null) {
  const section = config.split(/(?=^\[)/mu).find((part) => part.startsWith(`[${sectionName}]`));
  return section?.match(/^port\s*=\s*(\d+)/mu)?.[1] || fallback;
}

function command(name, args) {
  const result = spawnSync(name, args, { cwd: project, encoding: 'utf8', env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' } });
  if (result.status !== 0) throw new Error(`${name} ${args[0]} failed; check the local service and CLI permissions.`);
  return result.stdout.trim();
}

function checkLocalServices() {
  const supabaseWorkdir = resolveLocalSupabaseWorkdir(process.env.LOCAL_SUPABASE_WORKDIR);
  if (!isLoopbackUrl(redisUrl, 'redis:')) throw new Error('LOCAL_REDIS_URL must point to loopback Redis.');
  if (!String(configured.AUTH_ALLOWED_EMAIL_DOMAINS || '').trim()) throw new Error('AUTH_ALLOWED_EMAIL_DOMAINS is required.');
  const config = readFileSync(join(supabaseWorkdir, 'supabase/config.toml'), 'utf8');
  const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/mu)?.[1];
  const apiPort = readConfigPort(config, 'api', '54321');
  const dbPort = readConfigPort(config, 'db');
  if (!projectId || !dbPort) throw new Error('Local Supabase project ID or DB port is missing.');
  if (projectId === 'live-translate') {
    throw new Error('An isolated workdir must use a distinct Supabase project ID.');
  }
  const repoMigrations = readdirSync(join(project, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.*\.sql$/u.test(name)).sort();
  const localMigrations = readdirSync(join(supabaseWorkdir, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.*\.sql$/u.test(name)).sort();
  const sameFiles = repoMigrations.length === localMigrations.length
    && repoMigrations.every((name, index) => name === localMigrations[index]
      && createHash('sha256').update(readFileSync(join(project, 'supabase/migrations', name))).digest('hex')
      === createHash('sha256').update(readFileSync(join(supabaseWorkdir, 'supabase/migrations', name))).digest('hex'));
  if (!sameFiles) throw new Error('Isolated Supabase migrations differ from the repository.');
  command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const status = JSON.parse(command('supabase', ['status', '-o', 'json', '--workdir', supabaseWorkdir]));
  const apiUrl = status.API_URL;
  let databaseUrl;
  try { databaseUrl = new URL(status.DB_URL); } catch { /* fail closed below */ }
  if (!isLoopbackUrl(apiUrl) || new URL(apiUrl).port !== apiPort
    || !databaseUrl || !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname)
    || databaseUrl.port !== dbPort || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) {
    throw new Error('Supabase CLI must report matching loopback API/DB endpoints and local keys.');
  }
  const databaseContainer = `supabase_db_${projectId}`;
  const applied = command('docker', ['exec', databaseContainer, 'psql', '-U', 'postgres', '-At', '-c',
    'select version from supabase_migrations.schema_migrations order by version']);
  const expectedVersions = repoMigrations.map((name) => name.slice(0, 14));
  const appliedVersions = applied.split('\n').filter(Boolean);
  if (expectedVersions.length !== appliedVersions.length
    || expectedVersions.some((version, index) => version !== appliedVersions[index])) {
    throw new Error('Local Supabase migration history differs from the repository.');
  }
  const ping = command('redis-cli', ['-u', redisUrl, 'PING']);
  if (ping !== 'PONG') throw new Error('Local Redis did not respond to PING.');
  return { apiUrl, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY };
}

export function buildLocalEnvironment(local, baseEnv = process.env) {
  if (!isLoopbackUrl(local.apiUrl) || !local.anonKey || !local.serviceKey) {
    throw new Error('Local Supabase URL and keys must come from a loopback stack.');
  }
  return {
    ...configured, ...baseEnv,
    NODE_ENV: 'development', LOCAL_SUPABASE_MODE: 'true', SUPABASE_URL: local.apiUrl,
    GEMINI_API_KEY: '', ENABLE_REAL_GEMINI_TEST: 'false',
    SUPABASE_SECRET_KEY: local.serviceKey,
    SUPABASE_PUBLISHABLE_KEY: local.anonKey,
    SUPABASE_REALTIME_SIGNING_PRIVATE_JWK: '', SUPABASE_WORKER_USER_ID: '',
    SUPABASE_JWKS_URL: `${local.apiUrl}/auth/v1/.well-known/jwks.json`,
    VITE_SUPABASE_URL: local.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: local.anonKey,
    AUTH_ALLOWED_EMAIL_DOMAINS: configured.AUTH_ALLOWED_EMAIL_DOMAINS,
    WEBRTC_SIGNALING_REDIS_URL: redisUrl, WEBRTC_SIGNALING_REDIS_TOKEN: '',
    REDIS_URL: redisUrl, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    dev_frontend_origin: 'http://127.0.0.1:5173', dev_backend_origin: 'http://127.0.0.1:3000',
    APP_ORIGIN: 'http://127.0.0.1:5173'
  };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  try {
    const local = checkLocalServices();
    const env = buildLocalEnvironment(local);
    if (process.argv.includes('--check')) {
      console.log('Local Supabase, migrations, Redis, and environment: ready.');
    } else {
      const children = [
        spawn(process.execPath, ['server/index.js'], { cwd: project, env, stdio: 'inherit' }),
        spawn('npm', ['run', 'dev'], { cwd: project, env, stdio: 'inherit' })
      ];
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        for (const child of children) child.kill('SIGTERM');
      };
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
      for (const child of children) {
        child.once('error', (error) => { console.error(error.message); process.exitCode = 1; stop(); });
        child.once('exit', (code) => { if (code) process.exitCode = code; stop(); });
      }
    }
  } catch (error) {
    console.error(`Local startup blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
