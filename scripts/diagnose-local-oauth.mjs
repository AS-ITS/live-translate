#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { cliSpawnArguments, localCliInvocation } from './start-local.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const fingerprint = (value) => value === undefined ? null :
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
const pair = (values, idKey, secretKey) => ({
  clientId: fingerprint(values[idKey]),
  clientSecret: fingerprint(values[secretKey])
});

function run(file, args, env = process.env) {
  return spawnSync(file, args, { cwd: project, env, encoding: 'utf8', windowsHide: true });
}

function inspectAuthContainer(projectId) {
  const result = run('docker', ['inspect', '--format', '{{json .}}', `supabase_auth_${projectId}`]);
  if (result.error || result.status !== 0) return { available: false };
  const inspected = JSON.parse(result.stdout);
  const values = Object.fromEntries(inspected.Config.Env.map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  return { available: true, createdAt: inspected.Created,
    ...pair(values, 'GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID', 'GOTRUE_EXTERNAL_GOOGLE_SECRET') };
}

const envFile = join(project, 'supabase/.env.local');
const source = readFileSync(envFile);
const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
const secretAssignment = text.match(/^\s*GOOGLE_CLIENT_SECRET\s*=([^\n]*)/mu)?.[1]?.replace(/\r$/u, '');
const parsed = parseEnv(text);
const loaded = {
  GOOGLE_CLIENT_ID: parsed.GOOGLE_CLIENT_ID?.trim(),
  GOOGLE_CLIENT_SECRET: parsed.GOOGLE_CLIENT_SECRET?.trim()
};
const config = readFileSync(join(project, 'supabase/config.toml'), 'utf8');
const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/mu)?.[1];
if (!projectId || !loaded.GOOGLE_CLIENT_ID || !loaded.GOOGLE_CLIENT_SECRET) {
  throw new Error('Local project ID or OAuth variables are missing.');
}
const env = { ...process.env, ...loaded };
const child = run(process.execPath, ['--input-type=module', '-e',
  'import { createHash } from "node:crypto"; const hash = value => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16); process.stdout.write(JSON.stringify({ clientId: hash(process.env.GOOGLE_CLIENT_ID), clientSecret: hash(process.env.GOOGLE_CLIENT_SECRET) }));'
], env);
if (child.error || child.status !== 0) throw new Error('Node child environment probe failed.');
const cli = localCliInvocation('supabase', process.platform, env);
const invocation = cliSpawnArguments(cli, ['--version']);
const version = run(invocation.file, invocation.args, env);
const container = inspectAuthContainer(projectId);
const output = {
  platform: process.platform,
  nodeVersion: process.version,
  supabaseCliVersion: version.status === 0 ? version.stdout.trim() : 'unavailable',
  configUsesEnv: /client_id\s*=\s*"env\(GOOGLE_CLIENT_ID\)"/u.test(config)
    && /secret\s*=\s*"env\(GOOGLE_CLIENT_SECRET\)"/u.test(config),
  fileFormat: {
    modifiedAt: statSync(envFile).mtime.toISOString(),
    utf8Bom: source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    crlf: text.includes('\r\n'),
    bareCr: /\r(?!\n)/u.test(text),
    finalNewline: /\r?\n$/u.test(text),
    secretQuoted: /^\s*["']/u.test(secretAssignment || ''),
    secretAssignmentTrailingWhitespace: /[ \t]$/u.test(secretAssignment || ''),
    parserChangedSecret: parsed.GOOGLE_CLIENT_SECRET !== loaded.GOOGLE_CLIENT_SECRET
  },
  dotenvParsed: pair(parsed, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
  launcherValue: pair(loaded, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
  nodeSpawnChild: JSON.parse(child.stdout),
  authContainer: container
};
console.log(JSON.stringify(output, null, 2));
