import http from 'node:http';
import https from 'node:https';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FIXTURE_VERSION = 1;
const MAX_BODY_BYTES = 256 * 1024;

export function normalizeAllowedOrigins(input, { allowHttpFixture = false } = {}) {
  const values = Array.isArray(input) ? input : String(input || '').split(',');
  const origins = new Set();
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    if (raw === '*') throw new TypeError('Wildcard origins are forbidden.');
    let parsed;
    try { parsed = new URL(raw); } catch { throw new TypeError(`Invalid allowed origin: ${raw}`); }
    const isLocalHttpFixture = allowHttpFixture && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !isLocalHttpFixture) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new TypeError(`Allowed origin must be HTTPS, except an explicit loopback HTTP fixture origin: ${raw}`);
    }
    origins.add(parsed.origin);
  }
  if (!origins.size) throw new TypeError('At least one explicit allowed origin is required.');
  return origins;
}

export async function readLocalDevicePocFixture(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    if (parsed.version !== FIXTURE_VERSION || !isPlainObject(parsed.meetings)) throw new TypeError('Unsupported local device fixture.');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: FIXTURE_VERSION, meetings: {} };
    throw error;
  }
}

export async function createLocalDevicePocService({ stateFile, allowedOrigins, host = '127.0.0.1', port = 0, tlsCertFile, tlsKeyFile, failPostAfterPendingAt = 0 } = {}) {
  if (!stateFile) throw new TypeError('stateFile is required.');
  const tlsOptions = await loadTlsOptions(tlsCertFile, tlsKeyFile);
  if (!tlsOptions && !isLoopbackHost(host)) throw new TypeError('HTTP mode is limited to a loopback fixture host. Configure TLS for a network-reachable device.');
  const allowedOriginSet = normalizeAllowedOrigins(allowedOrigins, { allowHttpFixture: !tlsOptions });
  if (!tlsOptions && [...allowedOriginSet].some((origin) => !isLoopbackHttpOrigin(origin))) {
    throw new TypeError('HTTP mode is limited to explicit loopback fixture origins. Configure TLS for Preview or Production origins.');
  }
  let fixture = await readLocalDevicePocFixture(stateFile);
  let writeQueue = Promise.resolve();
  let acceptedPostCount = 0;
  const failAt = Number(failPostAfterPendingAt);

  async function persist() {
    const temporary = `${stateFile}.tmp`;
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, stateFile);
  }
  function serialise(task) {
    const result = writeQueue.then(task);
    writeQueue = result.catch(() => {});
    return result;
  }
  function processOperation(packet) {
    const meeting = fixture.meetings[packet.meetingId] || createMeeting();
    const packetFingerprint = fingerprint(packet);
    const existingOperation = meeting.operations[packet.operation.operationId];
    if (existingOperation && existingOperation.packetFingerprint !== packetFingerprint) return conflict('operation_conflict', packet.operation.operationId);
    if (!existingOperation && meeting.status === 'stopped') return conflict('meeting_stopped', packet.meetingId);
    for (const [resourceName, resource] of packetResources(packet)) {
      const existing = meeting[resourceName][resource.id];
      if (existing && existing.fingerprint !== fingerprint(resource.value)) return conflict('immutable_resource_conflict', `${resourceName}:${resource.id}`);
    }
    if (!fixture.meetings[packet.meetingId]) fixture.meetings[packet.meetingId] = meeting;
    const replayed = Boolean(existingOperation);
    if (!existingOperation) {
      meeting.operations[packet.operation.operationId] = { packetFingerprint, operation: packet.operation, status: 'pending' };
      for (const [resourceName, resource] of packetResources(packet)) {
        if (!meeting[resourceName][resource.id]) meeting[resourceName][resource.id] = { fingerprint: fingerprint(resource.value), value: resource.value };
      }
      meeting.journal.push(journalEntry(packet.operation.operationId, 'pending'));
      acceptedPostCount += 1;
      return persist().then(() => {
        if (failAt > 0 && acceptedPostCount === failAt) return { statusCode: 503, body: { error: { code: 'simulated_channel_disconnect' } } };
        return acknowledge(meeting, packet.operation, replayed);
      });
    }
    if (existingOperation.status === 'pending') return acknowledge(meeting, packet.operation, true);
    return { statusCode: 200, body: acknowledgement(packet.operation.operationId, true) };
  }
  function acknowledge(meeting, operation, replayed) {
    meeting.operations[operation.operationId].status = 'acknowledged';
    meeting.journal.push(journalEntry(operation.operationId, 'acknowledged'));
    if (operation.kind === 'stop') meeting.status = 'stopped';
    return persist().then(() => ({ statusCode: 200, body: acknowledgement(operation.operationId, replayed) }));
  }
  const protocol = tlsOptions ? 'https' : 'http';
  const requestHandler = async (request, response) => {
    const requestUrl = new URL(request.url || '/', `${protocol}://${request.headers.host || host}`);
    const origin = request.headers.origin;
    if (requestUrl.pathname === '/healthz') return sendJson(response, 200, { ok: true });
    if (!origin || !allowedOriginSet.has(origin)) return sendJson(response, 403, { error: { code: 'origin_forbidden' } });
    setCorsHeaders(response, origin);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return response.end();
    }
    try {
      if (request.method === 'POST' && requestUrl.pathname === '/device/operations') {
        const result = await serialise(async () => processOperation(validatePacket(await readJsonBody(request))));
        return sendJson(response, result.statusCode, result.body);
      }
      const viewerMatch = requestUrl.pathname.match(/^\/device\/viewer\/([^/]+)$/);
      if (request.method === 'GET' && viewerMatch) {
        const meeting = fixture.meetings[decodeURIComponent(viewerMatch[1])];
        if (!meeting) return sendJson(response, 404, { error: { code: 'meeting_not_found' } });
        if (meeting.status === 'stopped') return sendJson(response, 409, { error: { code: 'meeting_stopped' } });
        return sendJson(response, 200, viewerSnapshot(meeting));
      }
      return sendJson(response, 404, { error: { code: 'not_found' } });
    } catch (error) {
      return sendJson(response, Number.isInteger(error.statusCode) ? error.statusCode : 400, { error: { code: error.code || 'invalid_request' } });
    }
  };
  const server = tlsOptions ? https.createServer(tlsOptions, requestHandler) : http.createServer(requestHandler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  return Object.freeze({
    origin: `${protocol}://${host}:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  });
}

function createMeeting() { return { status: 'active', operations: {}, chunks: {}, cues: {}, checkpoints: {}, journal: [] }; }
async function loadTlsOptions(certFile, keyFile) {
  if (Boolean(certFile) !== Boolean(keyFile)) throw new TypeError('TLS certificate and key must be configured together.');
  if (!certFile) return null;
  return { cert: await readFile(certFile), key: await readFile(keyFile) };
}
function isLoopbackHost(host) { return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase()); }
function isLoopbackHttpOrigin(origin) {
  const parsed = new URL(origin);
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
}
function validatePacket(input) {
  if (!isPlainObject(input)) throw invalid('packet_invalid');
  return {
    meetingId: requiredId(input.meetingId, 'meetingId'),
    operation: immutableResource(input.operation, 'operation', 'operationId'),
    chunk: immutableResource(input.chunk, 'chunk', 'chunkId'),
    cue: immutableResource(input.cue, 'cue', 'cueId'),
    checkpoint: immutableResource(input.checkpoint, 'checkpoint', 'checkpointId')
  };
}
function immutableResource(value, name, idField) {
  if (!isPlainObject(value)) throw invalid(`${name}_invalid`);
  const id = requiredId(value[idField], idField);
  return Object.freeze({ ...deepClone(value), [idField]: id });
}
function packetResources(packet) {
  return [['chunks', { id: packet.chunk.chunkId, value: packet.chunk }], ['cues', { id: packet.cue.cueId, value: packet.cue }], ['checkpoints', { id: packet.checkpoint.checkpointId, value: packet.checkpoint }]];
}
function viewerSnapshot(meeting) {
  return { status: meeting.status, cues: Object.values(meeting.cues).map((entry) => deepClone(entry.value)).sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0) || String(left.cueId).localeCompare(String(right.cueId))) };
}
function acknowledgement(operationId, replayed) { return { acknowledgement: { operationId, status: 'acknowledged', replayed } }; }
function conflict(code, resource) { return { statusCode: 409, body: { error: { code, resource } } }; }
function journalEntry(operationId, status) { return { operationId, status, at: new Date().toISOString() }; }
function setCorsHeaders(response, origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
function sendJson(response, statusCode, body) { response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); }
async function readJsonBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request_too_large'), { statusCode: 413, code: 'request_too_large' }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('json_invalid'); }
}
function fingerprint(value) { return JSON.stringify(canonicalize(value)); }
function canonicalize(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  throw invalid('immutable_value_invalid');
}
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function requiredId(value, name) { const normalized = String(value || '').trim(); if (!normalized) throw invalid(`${name}_required`); return normalized; }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function invalid(code) { return Object.assign(new Error(code), { statusCode: 400, code }); }

if (process.argv[1] && process.argv[1].endsWith('local-device-poc-service.js')) {
  createLocalDevicePocService({
    stateFile: process.env.LOCAL_DEVICE_POC_STATE_FILE,
    allowedOrigins: process.env.LOCAL_DEVICE_POC_ALLOWED_ORIGINS,
    host: process.env.LOCAL_DEVICE_POC_HOST || '127.0.0.1',
    port: Number(process.env.LOCAL_DEVICE_POC_PORT || 4100),
    tlsCertFile: process.env.LOCAL_DEVICE_POC_TLS_CERT_FILE,
    tlsKeyFile: process.env.LOCAL_DEVICE_POC_TLS_KEY_FILE,
    failPostAfterPendingAt: Number(process.env.LOCAL_DEVICE_POC_FAIL_POST_AFTER_PENDING_AT || 0)
  }).then((service) => process.stdout.write(`local-device-poc listening at ${service.origin}\n`)).catch((error) => {
    process.stderr.write(`local-device-poc failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
