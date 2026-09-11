import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;
const CHECKS = Object.freeze([
  { name: 'health', method: 'GET', path: '/healthz', expectedStatus: 200, requireOk: true },
  { name: 'readiness', method: 'GET', path: '/readyz', expectedStatus: 200, requireOk: true },
  { name: 'private API auth gate', method: 'GET', path: '/api/meetings', expectedStatus: 401 },
  { name: 'metrics auth gate', method: 'GET', path: '/api/metrics', expectedStatus: 401 },
  { name: 'worker auth gate', method: 'POST', path: '/api/internal/worker', expectedStatus: 401 }
]);

export function normalizeSmokeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('SMOKE_BASE_URL is required.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SMOKE_BASE_URL must use http or https.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function runDeploymentPreflight({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalizedBaseUrl = normalizeSmokeBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required.');
  const results = [];
  for (const check of CHECKS) results.push(await runCheck({ check, baseUrl: normalizedBaseUrl, fetchImpl, timeoutMs }));
  return Object.freeze({ baseUrl: normalizedBaseUrl, passed: results.every((result) => result.ok), results: Object.freeze(results) });
}

export function formatPreflightResult(result) {
  const lines = [`Deployment preflight: ${result.passed ? 'PASS' : 'FAIL'}`];
  for (const item of result.results) lines.push(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}: ${item.status === null ? item.error : `HTTP ${item.status}`}`);
  return lines.join('\n');
}

async function runCheck({ check, baseUrl, fetchImpl, timeoutMs }) {
  try {
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}${check.path}`, { method: check.method }, timeoutMs);
    let validBody = true;
    if (check.requireOk) validBody = (await response.json())?.ok === true;
    return { name: check.name, ok: response.status === check.expectedStatus && validBody, status: response.status, ...(validBody ? {} : { error: 'response did not contain ok=true' }) };
  } catch (error) {
    return { name: check.name, ok: false, status: null, error: safeErrorMessage(error) };
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, options),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : 'request failed';
  return message.replace(/https?:\/\/\S+/gi, '[redacted-url]').slice(0, 160);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = await runDeploymentPreflight({ baseUrl: process.env.SMOKE_BASE_URL });
    console.log(formatPreflightResult(result));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Deployment preflight: FAIL\n${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
