#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export function projectDirectoryFromModuleUrl(moduleUrl, windows = process.platform === 'win32') {
  const pathApi = windows ? win32 : posix;
  return pathApi.resolve(pathApi.dirname(fileURLToPath(moduleUrl, { windows })), '..');
}

const project = projectDirectoryFromModuleUrl(import.meta.url);
const redisUrl = process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379';
const localOAuthEnvFile = join(project, 'supabase/.env.local');
const hostEnvironment = (env) => Object.fromEntries(Object.entries(env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'USERNAME', 'USERPROFILE',
    'SHELL', 'LANG', 'LC_ALL', 'TERM', 'CI', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PSMODULEPATH',
    'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT',
    'DOCKER_CONFIG'].includes(key.toUpperCase())));
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

const windowsAclScript = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = Get-Acl -LiteralPath $env:LOCAL_OAUTH_ENV_FILE',
  "$broad = @('S-1-1-0', 'S-1-5-7', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546')",
  'foreach ($ace in $acl.Access) {',
  '  $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
  "  if ($ace.AccessControlType -eq 'Allow' -and ($sid -in $broad -or $sid -match '^S-1-5-21-(?:[0-9]+-){3}513$') -and ($ace.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData)) { 'BROAD'; exit 0 }",
  '}',
  "'COMMON_SAFE'"
].join('; ');

export function assertLocalOAuthFileSecurity(path, file, platform = process.platform, aclRunner = spawnSync) {
  if (!file.isFile()) throw new Error('supabase/.env.local must be a regular file, not a symlink or directory.');
  if (platform !== 'win32') {
    if ((file.mode & 0o777) !== 0o600) throw new Error('supabase/.env.local must be a regular file with mode 600.');
    return;
  }
  const result = aclRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsAclScript], {
    cwd: project, encoding: 'utf8', windowsHide: true,
    env: { ...hostEnvironment(process.env), LOCAL_OAUTH_ENV_FILE: path }
  });
  if (result.error || result.status !== 0 || !['BROAD', 'COMMON_SAFE'].includes(result.stdout?.trim())) {
    throw new Error('Windows ACL could not be verified for supabase/.env.local; inspect it with Get-Acl and restrict access with icacls.');
  }
  if (result.stdout.trim() === 'BROAD') {
    throw new Error('supabase/.env.local grants read access to a broad Windows group; restrict its ACL with icacls.');
  }
  console.warn('Windows ACL check covers common broad groups only; review custom group permissions with Get-Acl.');
}

export function readLocalGoogleOAuthCredentials(path = localOAuthEnvFile, options = {}) {
  let file;
  try { file = (options.lstatSync || lstatSync)(path); } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Create supabase/.env.local from supabase/.env.example and set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Expected path: ${path}`);
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('supabase/.env.local is not readable; check file access permissions.');
    throw error;
  }
  assertLocalOAuthFileSecurity(path, file, options.platform, options.aclRunner);
  let source;
  try { source = (options.readFileSync || readFileSync)(path, 'utf8'); } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('supabase/.env.local is not readable; check file access permissions.');
    throw error;
  }
  let values;
  try { values = parseEnv(source); } catch {
    throw new Error('Invalid dotenv format in supabase/.env.local.');
  }
  const requiredKeys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  const malformedKeys = requiredKeys.filter((key) =>
    !Object.hasOwn(values, key) && new RegExp(`^\\s*${key}\\b`, 'mu').test(source));
  if (malformedKeys.length) {
    throw new Error(`Malformed ${malformedKeys.join(' and ')} assignment in supabase/.env.local.`);
  }
  const clientId = values.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = values.GOOGLE_CLIENT_SECRET?.trim();
  const missingKeys = requiredKeys.filter((key) => !values[key]?.trim());
  if (missingKeys.length) {
    throw new Error(`Missing ${missingKeys.join(' and ')} in supabase/.env.local.`);
  }
  if (clientId === 'YOUR_GOOGLE_CLIENT_ID' || clientSecret === 'YOUR_GOOGLE_CLIENT_SECRET'
    || /\s|[\x00-\x1f\x7f]/u.test(clientId + clientSecret)
    || /^["']|["']$/u.test(clientId) || /^["']|["']$/u.test(clientSecret)) {
    throw new Error('Invalid GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET format in supabase/.env.local.');
  }
  return { clientId, clientSecret };
}

export function localCliInvocation(name, platform = process.platform, env = process.env, fileExists = existsSync) {
  if (platform !== 'win32') return { file: name, shell: false };
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const directory of pathValue.split(win32.delimiter).filter(Boolean)) {
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const file = win32.join(directory, `${name}${extension}`);
      if (fileExists(file)) return { file, shell: extension !== '.exe' };
    }
  }
  return { file: name, shell: false };
}

export function cliSpawnArguments(cli, args) {
  if (!cli.shell) return { file: cli.file, args };
  const quote = (value) => {
    if (/["\r\n]/u.test(value)) throw new Error('Unsupported quote or newline in Windows CLI path or argument.');
    return `"${value.replace(/%/gu, '%%')}"`;
  };
  return { file: quote(cli.file), args: args.map(quote) };
}

function command(name, args, googleOAuth = null) {
  const env = { ...hostEnvironment(process.env), SUPABASE_TELEMETRY_DISABLED: '1' };
  if (name === 'supabase' && googleOAuth) {
    env.GOOGLE_CLIENT_ID = googleOAuth.clientId;
    env.GOOGLE_CLIENT_SECRET = googleOAuth.clientSecret;
  }
  const cli = localCliInvocation(name, process.platform, env);
  const invocation = cliSpawnArguments(cli, args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: project, encoding: 'utf8', env, shell: cli.shell, windowsHide: true
  });
  if (result.error) {
    throw new Error(`${name} ${args[0]} could not run (${result.error.code || result.error.name}); check CLI installation and PATH.`);
  }
  if (result.status !== 0) throw new Error(`${name} ${args[0]} failed; check the local service and CLI permissions.`);
  return result.stdout.trim();
}

export function pingLocalRedis(redisAddress, timeoutMs = 2000) {
  const target = new URL(redisAddress);
  return new Promise((resolve, reject) => {
    const host = target.hostname.replace(/^\[|\]$/gu, '');
    const socket = createConnection({ host, port: Number(target.port || 6379) });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Redis PING timed out.')));
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', (chunk) => finish(chunk.toString('utf8').startsWith('+PONG\r\n')
      ? null : new Error('Local Redis did not respond to PING.')));
    socket.once('error', finish);
  });
}

async function checkLocalServices() {
  const supabaseWorkdir = resolveLocalSupabaseWorkdir(process.env.LOCAL_SUPABASE_WORKDIR);
  const googleOAuth = readLocalGoogleOAuthCredentials();
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
    status = JSON.parse(command('supabase', ['status', '-o', 'json', '--workdir', supabaseWorkdir], googleOAuth));
  } catch {
    command('supabase', ['start', '--workdir', supabaseWorkdir], googleOAuth);
    status = JSON.parse(command('supabase', ['status', '-o', 'json', '--workdir', supabaseWorkdir], googleOAuth));
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
  const authResponse = await fetch(`${apiUrl}/auth/v1/settings`, { signal: AbortSignal.timeout(3000) });
  if (!authResponse.ok) throw new Error('Local Supabase auth settings are unavailable.');
  const authSettings = await authResponse.json();
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
  try { await pingLocalRedis(redisUrl); } catch {
    if (process.platform === 'win32') {
      throw new Error('Local Redis is unavailable; start a loopback Redis Docker container, then retry.');
    }
    const port = new URL(redisUrl).port || '6379';
    command('redis-server', ['--daemonize', 'yes', '--bind', '127.0.0.1', '--port', port,
      '--save', '', '--appendonly', 'no']);
    await pingLocalRedis(redisUrl);
  }
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
    AUTH_ALLOWED_EMAIL_DOMAINS: String(baseEnv.AUTH_ALLOWED_EMAIL_DOMAINS || '').trim(),
    WEBRTC_SIGNALING_REDIS_URL: redisUrl, WEBRTC_SIGNALING_REDIS_TOKEN: '',
    REDIS_URL: redisUrl, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    dev_frontend_origin: 'http://127.0.0.1:5173', dev_backend_origin: 'http://127.0.0.1:3000',
    APP_ORIGIN: 'http://127.0.0.1:5173'
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const local = await checkLocalServices();
    const env = buildLocalEnvironment(local);
    if (process.argv.includes('--check')) {
      console.log('Local Supabase, migrations, Redis, and environment: ready.');
    } else {
      const npm = localCliInvocation('npm', process.platform, env);
      const npmInvocation = cliSpawnArguments(npm, ['run', 'dev']);
      const children = [
        spawn(process.execPath, ['server/index.js'], { cwd: project, env, stdio: 'inherit' }),
        spawn(npmInvocation.file, npmInvocation.args, {
          cwd: project, env, stdio: 'inherit', shell: npm.shell, windowsHide: true
        })
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
