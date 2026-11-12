#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const project = new URL('../', import.meta.url).pathname;
const redisUrl = process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379';
const localOAuthEnvFile = join(project, 'supabase/.env.local');
const hostEnvironment = (env) => Object.fromEntries(Object.entries(env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'CI',
    'DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key)));
export function resolveLocalSupabaseWorkdir(value) {
  if (String(value || '').trim() && resolve(value) !== resolve(project)) {
    throw new Error('Local Supabase must use the main project directory.');
  }
  return resolve(project);
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

export function readLocalGoogleOAuthSecret(path = localOAuthEnvFile) {
  let file;
  try { file = lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
    throw new Error('supabase/.env.local must be a regular file with mode 600.');
  }
  return parseEnv(readFileSync(path, 'utf8')).SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET?.trim() || null;
}

function command(name, args, googleClientSecret = null) {
  const env = { ...hostEnvironment(process.env), SUPABASE_TELEMETRY_DISABLED: '1' };
  if (name === 'supabase' && googleClientSecret) {
    env.SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET = googleClientSecret;
  }
  const result = spawnSync(name, args, { cwd: project, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${name} ${args[0]} failed; check the local service and CLI permissions.`);
  return result.stdout.trim();
}

function checkLocalServices() {
  const supabaseWorkdir = resolveLocalSupabaseWorkdir(process.env.LOCAL_SUPABASE_WORKDIR);
  const googleClientSecret = readLocalGoogleOAuthSecret();
  if (!isLoopbackUrl(redisUrl, 'redis:')) throw new Error('LOCAL_REDIS_URL must point to loopback Redis.');
  const config = readFileSync(join(supabaseWorkdir, 'supabase/config.toml'), 'utf8');
  const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/mu)?.[1];
  const apiPort = readConfigPort(config, 'api', '54321');
  const dbPort = readConfigPort(config, 'db');
  if (!projectId || !dbPort) throw new Error('Local Supabase project ID or DB port is missing.');
  const repoMigrations = readdirSync(join(project, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.*\.sql$/u.test(name)).sort();
  command('docker', ['info', '--format', '{{.ServerVersion}}']);
  let status;
  try {
    status = JSON.parse(command('supabase', ['status', '-o', 'json', '--workdir', supabaseWorkdir], googleClientSecret));
  } catch {
    if (!googleClientSecret) {
      throw new Error('Set SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET in supabase/.env.local before restarting Local Supabase.');
    }
    command('supabase', ['start', '--workdir', supabaseWorkdir], googleClientSecret);
    status = JSON.parse(command('supabase', ['status', '-o', 'json', '--workdir', supabaseWorkdir], googleClientSecret));
  }
  const apiUrl = status.API_URL;
  let databaseUrl;
  try { databaseUrl = new URL(status.DB_URL); } catch { /* fail closed below */ }
  if (!isLoopbackUrl(apiUrl) || new URL(apiUrl).port !== apiPort
    || !databaseUrl || !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname)
    || databaseUrl.port !== dbPort || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) {
    throw new Error('Supabase CLI must report matching loopback API/DB endpoints and local keys.');
  }
  const authSettings = JSON.parse(command('curl', ['-fsS', `${apiUrl}/auth/v1/settings`]));
  if (authSettings.external?.google !== true) throw new Error('Local Supabase Google provider is disabled.');
  const databaseContainer = `supabase_db_${projectId}`;
  const applied = command('docker', ['exec', databaseContainer, 'psql', '-U', 'postgres', '-At', '-c',
    'select version from supabase_migrations.schema_migrations order by version']);
  const expectedVersions = repoMigrations.map((name) => name.slice(0, 14));
  const appliedVersions = applied.split('\n').filter(Boolean);
  if (expectedVersions.length !== appliedVersions.length
    || expectedVersions.some((version, index) => version !== appliedVersions[index])) {
    throw new Error('Local Supabase migration history differs from the repository.');
  }
  let ping;
  try { ping = command('redis-cli', ['-u', redisUrl, 'PING']); } catch {
    const port = new URL(redisUrl).port || '6379';
    command('redis-server', ['--daemonize', 'yes', '--bind', '127.0.0.1', '--port', port,
      '--save', '', '--appendonly', 'no']);
    ping = command('redis-cli', ['-u', redisUrl, 'PING']);
  }
  if (ping !== 'PONG') throw new Error('Local Redis did not respond to PING.');
  return { apiUrl, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY };
}

export function buildLocalEnvironment(local, baseEnv = process.env) {
  if (!isLoopbackUrl(local.apiUrl) || !local.anonKey || !local.serviceKey) {
    throw new Error('Local Supabase URL and keys must come from a loopback stack.');
  }
  return {
    ...hostEnvironment(baseEnv),
    NODE_ENV: 'development', LOCAL_SUPABASE_MODE: 'true', SUPABASE_URL: local.apiUrl,
    GEMINI_API_KEY: '', ENABLE_REAL_GEMINI_TEST: 'false',
    LOCAL_MOCK_PROVIDER: baseEnv.LOCAL_MOCK_PROVIDER === 'true' ? 'true' : 'false',
    SUPABASE_SECRET_KEY: local.serviceKey,
    SUPABASE_PUBLISHABLE_KEY: local.anonKey,
    SUPABASE_REALTIME_SIGNING_PRIVATE_JWK: '', SUPABASE_WORKER_USER_ID: '',
    SUPABASE_JWKS_URL: `${local.apiUrl}/auth/v1/.well-known/jwks.json`,
    VITE_SUPABASE_URL: local.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: local.anonKey,
    AUTH_ALLOWED_EMAIL_DOMAINS: 'as.edu.tw',
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
