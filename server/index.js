import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from './languages.js';
import { createLiveToken } from './tokenService.js';
import { createApplicationDependencies, createProductionApplicationDependencies } from './compositionRoot.js';
import { createSessionSnapshotSyncService } from '../src/application/sessionSnapshotSyncService.js';
import { resolveSavedRetranslationModel } from '../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import {
  sanitizeAudioArtifactsForDTO,
  validateAudioArtifactKind
} from '../src/infrastructure/sessionAudioArtifacts.js';

const IS_MAIN = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (IS_MAIN && process.argv.includes('--production')) {
  process.env.NODE_ENV ??= 'production';
}

if (IS_MAIN) {
  loadDotenv();
}

if (IS_MAIN && process.argv.includes('--production')) {
  process.env.HOST ??= '0.0.0.0';
}

const PORT = Number.parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5173';
const DIST_DIR = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const INDEX_HTML_PATH = join(DIST_DIR, 'index.html');
const rateLimitBuckets = new Map();

const ERROR_RESPONSES = {
  auth_required: { status: 401, message: 'Access token is required.' },
  auth_invalid: { status: 401, message: 'Access token is invalid.' },
  auth_not_configured: { status: 503, message: 'Access gate is not configured.' },
  invalid_json: { status: 400, message: 'Request body must be valid JSON.' },
  invalid_request: { status: 400, message: 'Request body or path parameters are invalid.' },
  invalid_origin: { status: 403, message: 'Request origin is not allowed.' },
  not_found: { status: 404, message: 'Route not found.' },
  glossary_entry_not_found: { status: 404, message: 'Glossary entry not found.' },
  glossary_not_configured: { status: 503, message: 'Translation glossary is not configured.' },
  meeting_read_unavailable: { status: 503, message: 'Meeting read API is not configured.' },
  provider_unavailable: { status: 502, message: 'Live translation provider is unavailable.' },
  rate_limited: { status: 429, message: 'Too many requests. Please try again later.' },
  request_too_large: { status: 413, message: 'Request body is too large.' },
  server_misconfigured: { status: 500, message: 'Server is not configured for live translation.' },
  session_not_found: { status: 404, message: 'Session not found.' },
  saved_transcript_retranslation_unavailable: {
    status: 503,
    message: 'Saved transcript re-translation is not configured.'
  },
  unsupported_language: { status: 400, message: 'Selected target language is not supported.' },
  translation_execution_not_found: { status: 404, message: 'Translation execution not found.' },
  translation_output_not_found: { status: 404, message: 'Translation output not found.' },
  translation_request_not_found: { status: 404, message: 'Translation request not found.' },
  execution_invalid_state: { status: 409, message: 'Translation execution is not in a valid state for this operation.' },
  checkpoint_conflict: { status: 409, message: 'Meeting checkpoint conflicts with previously persisted content.' },
  meeting_checkpoint_unavailable: { status: 503, message: 'Meeting checkpoint persistence is not configured.' },
  meeting_not_found: { status: 404, message: 'Meeting not found.' },
  meeting_segment_not_found: { status: 404, message: 'Meeting segment not found.' },
  meeting_segment_invalid_state: { status: 409, message: 'Meeting segment is not in a valid state for this operation.' },
  internal_error: { status: 500, message: 'Unexpected server error.' }
};
const DELETABLE_SESSION_STATUSES = new Set(['completed', 'stopped', 'failed', 'expired']);
const MAX_AUDIO_ARTIFACT_BYTES = 50 * 1024 * 1024;

function safeTranslationProvidersFor(env = process.env) {
  return [
    {
      key: 'gemini',
      label: 'Gemini',
      provider: 'gemini',
      model: resolveSavedRetranslationModel(env)
    }
  ];
}

function sendJson(res, status, payload, requestId) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Demo-Access-Token, X-File-Name',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(body);
}

function sendBinary(res, status, bytes, { contentType = 'application/octet-stream', fileName = 'download.bin', requestId } = {}) {
  const buffer = Buffer.from(bytes);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.byteLength,
    'Content-Disposition': `attachment; filename="${String(fileName).replace(/["\\]/g, '')}"`,
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Demo-Access-Token, X-File-Name',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(buffer);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) {
      const error = new Error('Request body too large');
      error.status = 413;
      error.code = 'request_too_large';
      throw error;
    }
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

async function readBinary(req, { maxBytes = MAX_AUDIO_ARTIFACT_BYTES } = {}) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      const error = new Error('Request body too large');
      error.status = 413;
      error.code = 'request_too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength);
}

function getRequestPath(req) {
  return req.url?.split('?')[0] || '/';
}

function getClientIp(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function isAllowedOrigin(req) {
  const origin = req.headers?.origin;
  return !origin || origin === ALLOWED_ORIGIN;
}

function isAuthConfigured() {
  return Boolean(process.env.DEMO_ACCESS_TOKEN);
}

function validateAccessToken(req) {
  if (!isAuthConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw createHttpError('auth_not_configured');
    }
    return;
  }

  const authorization = req.headers?.authorization || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const headerToken = req.headers?.['x-demo-access-token'] || '';
  const candidate = bearerToken || headerToken;

  if (!candidate) {
    throw createHttpError('auth_required');
  }

  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(process.env.DEMO_ACCESS_TOKEN);
  if (candidateBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(candidateBuffer, expectedBuffer)) {
    throw createHttpError('auth_invalid');
  }
}

function enforceRateLimit(clientIp) {
  const now = Date.now();
  const windowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
  const maxRequests = Number.parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
  const bucket = rateLimitBuckets.get(clientIp);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(clientIp, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    throw createHttpError('rate_limited');
  }
}

function createHttpError(code) {
  const template = ERROR_RESPONSES[code] || ERROR_RESPONSES.internal_error;
  const error = new Error(template.message);
  error.status = template.status;
  error.code = code;
  return error;
}

function errorCodeFor(error) {
  if (error.code && ERROR_RESPONSES[error.code]) {
    return error.code;
  }

  if (error.message === 'Unsupported targetLanguageCode' || error.message === 'Unsupported sourceLanguageCode') {
    return 'unsupported_language';
  }
  if (error.message === 'GEMINI_API_KEY is not configured') {
    return 'server_misconfigured';
  }
  if (error.message === 'Failed to create Gemini ephemeral token') {
    return 'provider_unavailable';
  }

  return 'internal_error';
}

function errorPayload(code, requestId) {
  const template = ERROR_RESPONSES[code] || ERROR_RESPONSES.internal_error;
  return {
    error: {
      code,
      message: template.message,
      requestId
    }
  };
}

function logEvent(event) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}

function logProviderError(requestId, error) {
  const cause = error.cause || error;
  logEvent({
    level: 'error',
    event: 'provider_error',
    requestId,
    provider: 'gemini',
    errorName: cause?.name || 'Error',
    safeSummary: 'Gemini token creation failed'
  });
}

function loadDotenv({ cwd = process.cwd(), env = process.env } = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const originalKeys = new Set(Object.keys(env));
  for (const fileName of ['.env', `.env.${nodeEnv}`]) {
    loadDotenvFile(join(cwd, fileName), env, originalKeys);
  }
}

function loadDotenvFile(filePath, env, originalKeys) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const [key, value] of parseDotenv(readFileSync(filePath, 'utf8'))) {
    if (!originalKeys.has(key)) {
      env[key] = value;
    }
  }
}

function parseDotenv(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    entries.push([key, parseDotenvValue(trimmed.slice(separatorIndex + 1).trim())]);
  }

  return entries;
}

function parseDotenvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s#/);
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

const createDefaultApplicationDependencies = selectDefaultApplicationDependenciesFactory({
  env: process.env
});
const defaultApplicationDependencies = createDefaultApplicationDependencies({
  requestHandlerFactory: createRequestHandler,
  includeSessionRetranslationCommandController: true
});
const { requestHandler: defaultRequestHandler } = defaultApplicationDependencies;

export function selectDefaultApplicationDependenciesFactory({ env = process.env } = {}) {
  return env.NODE_ENV === 'production' || hasConfiguredGeminiApiKey(env)
    ? createProductionApplicationDependencies
    : createApplicationDependencies;
}

function hasConfiguredGeminiApiKey(env) {
  return typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
}

export function startTranslationExecutionWorkerRuntime({
  translationExecutionWorkerRuntime = defaultApplicationDependencies.translationExecutionWorkerRuntime,
  sessionRepository = defaultApplicationDependencies.sessionRepository,
  translationExecutionQueue = defaultApplicationDependencies.translationExecutionQueue,
  logger = logEvent
} = {}) {
  if (!translationExecutionWorkerRuntime || typeof translationExecutionWorkerRuntime.start !== 'function') {
    return () => undefined;
  }

  let isStopped = false;
  startRuntimeAfterPersistedQueueRecovery({
    translationExecutionWorkerRuntime,
    sessionRepository,
    translationExecutionQueue,
    logger
  }).catch((error) => {
    logWorkerRuntimeError(logger, 'translation_execution_worker_runtime_start_failed', error);
  });

  return function stopTranslationExecutionWorkerRuntime() {
    if (isStopped || typeof translationExecutionWorkerRuntime.stop !== 'function') {
      return undefined;
    }

    isStopped = true;
    try {
      return translationExecutionWorkerRuntime.stop();
    } catch (error) {
      logWorkerRuntimeError(logger, 'translation_execution_worker_runtime_stop_failed', error);
      return undefined;
    }
  };
}

async function startRuntimeAfterPersistedQueueRecovery({
  translationExecutionWorkerRuntime,
  sessionRepository,
  translationExecutionQueue,
  logger
}) {
  try {
    await enqueuePersistedQueuedTranslationExecutions({
      sessionRepository,
      translationExecutionQueue
    });
  } catch (error) {
    logWorkerRuntimeError(logger, 'translation_execution_queue_recovery_failed', error);
  }

  await translationExecutionWorkerRuntime.start();
}

export async function enqueuePersistedQueuedTranslationExecutions({
  sessionRepository,
  translationExecutionQueue
} = {}) {
  if (
    !sessionRepository ||
    typeof sessionRepository.listSessionRecords !== 'function' ||
    !translationExecutionQueue ||
    typeof translationExecutionQueue.enqueue !== 'function'
  ) {
    return 0;
  }

  const records = await sessionRepository.listSessionRecords();
  let recoveredCount = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const state = record?.translationCommandState;
    const requests = Array.isArray(state?.requests) ? state.requests : [];
    const executions = Array.isArray(state?.executions) ? state.executions : [];
    const outputs = Array.isArray(state?.outputs) ? state.outputs : [];

    for (const execution of executions) {
      if (execution?.status !== 'queued' || outputs.some((output) => output?.executionId === execution.id)) {
        continue;
      }

      const request = requests.find((candidate) => candidate?.id === execution.translationRequestId);
      if (!request) {
        continue;
      }

      await translationExecutionQueue.enqueue({
        executionId: execution.id,
        requestId: request.id
      });
      recoveredCount += 1;
    }
  }

  return recoveredCount;
}

function logWorkerRuntimeError(logger, event, error) {
  if (typeof logger !== 'function') {
    return;
  }

  logger({
    level: 'error',
    event,
    errorName: error?.name || 'Error',
    safeSummary: 'Translation execution worker runtime failed'
  });
}

export function createRequestHandler(options = {}) {
  const {
    sessionReadController,
    sessionRepository,
    translationRepository,
    translationCommandController,
    executionControlController,
    translationHistoryController,
    meetingReadController,
    meetingCheckpointService,
    sessionAudioArtifactRepository,
    translationProviderOptionsController,
    glossaryController,
    savedTranscriptRetranslationController,
    sessionRetranslationCommandController,
    translationExecutionWorkerRuntime,
    liveTokenCreator = createLiveToken
  } = options;

  if (Object.prototype.hasOwnProperty.call(options, 'translationCommandController')) {
    assertTranslationCommandController(translationCommandController);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'executionControlController')) {
    assertExecutionControlController(executionControlController);
  }

  return async function handleRequestWithDependencies(req, res) {
    return handleRequestWithSessionReadController(req, res, {
      sessionReadController,
      sessionRepository,
      translationRepository,
      translationCommandController,
      executionControlController,
      translationHistoryController,
      meetingReadController,
      meetingCheckpointService,
      sessionAudioArtifactRepository,
      translationProviderOptionsController,
      glossaryController,
      savedTranscriptRetranslationController,
      sessionRetranslationCommandController,
      translationExecutionWorkerRuntime,
      liveTokenCreator
    });
  };
}

export async function handleRequest(req, res) {
  return defaultRequestHandler(req, res);
}

async function handleRequestWithSessionReadController(
  req,
  res,
  { sessionReadController, sessionRepository, translationRepository, translationCommandController, executionControlController, translationHistoryController, meetingReadController, meetingCheckpointService, sessionAudioArtifactRepository, translationProviderOptionsController, glossaryController, savedTranscriptRetranslationController, sessionRetranslationCommandController, translationExecutionWorkerRuntime, liveTokenCreator = createLiveToken } = {}
) {
  const requestId = req.headers?.['x-request-id'] || crypto.randomUUID();
  const startedAt = performance.now();
  const path = getRequestPath(req);
  const clientIp = getClientIp(req);
  const origin = req.headers?.origin || '';
  let statusCode = 500;
  let targetLanguageCode;

  if (req.method === 'OPTIONS') {
    statusCode = 204;
    sendJson(res, statusCode, {}, requestId);
    return;
  }

  if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
    statusCode = 200;
    sendJson(res, statusCode, { ok: true, requestId }, requestId);
    return;
  }

  if (req.method === 'GET' && path === '/readyz') {
    const ready = Boolean(process.env.GEMINI_API_KEY) && (process.env.NODE_ENV !== 'production' || isAuthConfigured());
    statusCode = ready ? 200 : 503;
    sendJson(res, statusCode, { ok: ready, requestId }, requestId);
    return;
  }

  if (req.method === 'DELETE' && path === '/api/test/sessions' && process.env.NODE_ENV === 'test') {
    try {
      for (const record of await sessionRepository.listSessionRecords()) {
        await sessionAudioArtifactRepository?.deleteMany?.(record.audioArtifacts);
        await sessionRepository.deleteSessionRecord(record.id);
      }
      statusCode = 204;
      sendJson(res, statusCode, {}, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/sessions') {
    try {
      const sessions = await sessionReadController.listSessions();
      statusCode = 200;
      sendJson(res, statusCode, sessions, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/translation-providers') {
    try {
      const providers = translationProviderOptionsController
        ? await translationProviderOptionsController.listTranslationProviders()
        : safeTranslationProvidersFor();
      statusCode = 200;
      sendJson(res, statusCode, { providers }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/meetings') {
    try {
      if (!meetingReadController) throw createHttpError('meeting_read_unavailable');
      const meetings = await meetingReadController.listMeetings();
      statusCode = 200;
      sendJson(res, statusCode, meetings, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isMeetingDetailPath(path)) {
    try {
      if (!meetingReadController) throw createHttpError('meeting_read_unavailable');
      const { meetingId } = parseMeetingDetailPath(path);
      const meeting = await meetingReadController.getMeeting(meetingId);

      if (!meeting) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('meeting_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendJson(res, statusCode, meeting, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isMeetingAudioPath(path)) {
    try {
      const { meetingId, kind } = parseMeetingAudioPath(path);
      const artifact = await readMeetingAudioArtifact({ sessionRepository, sessionAudioArtifactRepository, meetingId, kind });
      if (!artifact) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendBinary(res, statusCode, artifact.bytes, {
        contentType: artifact.metadata.mimeType,
        fileName: artifact.metadata.fileName,
        requestId
      });
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/meetings') {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const result = await meetingCheckpointService.createMeeting(await readJson(req));
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && isMeetingSegmentRolloverPath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingSegmentRolloverPath(path);
      const result = await meetingCheckpointService.rolloverSegment({
        meetingId,
        segmentId,
        rollover: await readJson(req)
      });
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && isMeetingSegmentRecoverPath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingSegmentRecoverPath(path);
      const result = await meetingCheckpointService.recoverSegment({
        meetingId,
        segmentId,
        recovery: await readJson(req)
      });
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isMeetingSegmentsPath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId } = parseMeetingSegmentsPath(path);
      const segments = await meetingCheckpointService.listMeetingSegments(meetingId);
      statusCode = 200;
      sendJson(res, statusCode, { meetingId, segments }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if ((req.method === 'GET' || req.method === 'PUT') && isMeetingSegmentCheckpointPath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingSegmentCheckpointPath(path);
      const result = req.method === 'GET'
        ? await meetingCheckpointService.getCheckpoint({ meetingId, segmentId })
        : await meetingCheckpointService.updateCheckpoint({
            meetingId,
            segmentId,
            checkpoint: await readJson(req)
          });
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'DELETE' && isSessionTranslationOutputPath(path)) {
    try {
      if (!translationRepository) throw createHttpError('saved_transcript_retranslation_unavailable');
      const { sessionId, outputId } = parseSessionTranslationOutputPath(path);
      const output = await translationRepository.getTranslationOutput(outputId);

      if (!isDeletableRetranslationOutput(output, sessionId)) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('translation_output_not_found', requestId), requestId);
        return;
      }

      const deleted = await translationRepository.deleteTranslationOutput(outputId);

      if (!deleted) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('translation_output_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendJson(res, statusCode, { deleted: true, sessionId, outputId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && isSessionAudioPath(path)) {
    try {
      const { sessionId, kind } = parseSessionAudioPath(path);
      if (req.headers?.['content-type']?.split(';')[0] !== 'audio/wav') throw createHttpError('invalid_request');
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }
      const bytes = await readBinary(req);
      if (bytes.byteLength === 0) throw createHttpError('invalid_request');
      const metadata = await sessionAudioArtifactRepository.save({
        sessionId,
        kind,
        bytes,
        fileName: String(req.headers?.['x-file-name'] || '')
      });
      const audioArtifacts = {
        ...(existing.sessionRecord.audioArtifacts || {}),
        [kind]: metadata
      };
      const updated = await sessionRepository.updateSessionRecord(sessionId, { audioArtifacts });
      statusCode = 201;
      sendJson(res, statusCode, {
        artifact: sanitizeAudioArtifactsForDTO(updated.audioArtifacts, { sessionId })[kind]
      }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isSessionAudioPath(path)) {
    try {
      const { sessionId, kind } = parseSessionAudioPath(path);
      const detail = await sessionRepository.getSessionRecord(sessionId);
      const metadata = detail?.sessionRecord?.audioArtifacts?.[kind];
      if (!metadata) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }
      const artifact = await sessionAudioArtifactRepository.read(metadata);
      statusCode = 200;
      sendBinary(res, statusCode, artifact.bytes, {
        contentType: artifact.metadata.mimeType,
        fileName: artifact.metadata.fileName,
        requestId
      });
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'DELETE' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      let sessionId;
      try {
        sessionId = decodeURIComponent(path.slice('/api/sessions/'.length));
      } catch {
        throw createHttpError('invalid_request');
      }
      if (!sessionId.trim()) throw createHttpError('invalid_request');
      const existing = await sessionRepository.getSessionRecord(sessionId);

      if (!existing?.sessionRecord || !DELETABLE_SESSION_STATUSES.has(existing.sessionRecord.status)) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      await sessionAudioArtifactRepository?.deleteMany?.(existing.sessionRecord.audioArtifacts);
      const deleted = await sessionRepository.deleteSessionRecord(sessionId);

      if (!deleted) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendJson(res, statusCode, { deleted: true, sessionId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (isGlossaryRoute(req.method, path)) {
    try {
      if (!glossaryController) throw createHttpError('glossary_not_configured');
      const { status, result } = await handleGlossaryCommand(req.method, path, req, glossaryController);
      statusCode = status;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'PUT' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      const sessionId = decodeURIComponent(path.slice('/api/sessions/'.length));
      const body = await readJson(req);
      if (body?.session?.id !== sessionId) throw createHttpError('invalid_request');
      const result = await createSessionSnapshotSyncService({ sessionRepository }).sync(body);
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isSessionTranslationHistoryPath(path)) {
    try {
      const { sessionId, targetLanguageCode } = parseSessionTranslationHistoryPath(req.url || path);
      if (targetLanguageCode !== undefined && !isSupportedLanguage(targetLanguageCode)) throw createHttpError('unsupported_language');
      const result = await translationHistoryController.listSessionTranslations({ sessionId, targetLanguageCode, includeReadModel: true });
      if (!result) { statusCode = 404; sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId); return; }
      statusCode = 200; sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error); statusCode = ERROR_RESPONSES[code]?.status || error.status || 500; sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'POST' && isSessionRetranslationPath(path)) {
    try {
      if (!sessionRetranslationCommandController) throw createHttpError('saved_transcript_retranslation_unavailable');
      const body = await readJson(req);
      const result = await sessionRetranslationCommandController.submitRetranslation(
        validateSessionRetranslationRequest({ sessionId: extractSessionRetranslationSessionId(path), body })
      );
      translationExecutionWorkerRuntime?.wake?.();
      statusCode = 202;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      const sessionId = path.slice('/api/sessions/'.length);
      const session = await sessionReadController.getSession(sessionId);

      if (!session) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      if (translationHistoryController) {
        try {
          const history = await translationHistoryController.listSessionTranslations({ sessionId, includeReadModel: true });
          const formalHistory = history?.translationHistory;
          const historyOutputs = Array.isArray(formalHistory?.outputs) ? formalHistory.outputs : [];
          const primaryOutputs = historyOutputs.filter(isLiveSessionTranslationOutput);
          session.translationHistory = {
            outputs: legacyTranslationFallback(session.translationOutputs),
            executions: formalHistory?.executions || []
          };
          applyFormalOutputReadModel(session, primaryOutputs);
        } catch {
          // Translation history is an isolated read enhancement; preserve detail.
        }
      }

      statusCode = 200;
      sendJson(res, statusCode, session, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (isTranslationCommandRoute(req.method, path)) {
    try {
      assertTranslationCommandController(translationCommandController);

      const body = await readJson(req);
      const { status, result } = handleTranslationCommand(req.method, path, body, translationCommandController);

      statusCode = status;
      sendJson(res, statusCode, await result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (isExecutionControlRoute(req.method, path)) {
    try {
      assertExecutionControlController(executionControlController);
      const { status, result } = handleExecutionControlCommand(req.method, path, executionControlController);
      statusCode = status;
      sendJson(res, statusCode, serializeExecutionControlResponse(await result), requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (isSavedTranscriptRetranslationRoute(req.method, path)) {
    try {
      if (!savedTranscriptRetranslationController) {
        throw createHttpError('saved_transcript_retranslation_unavailable');
      }

      const body = await readJson(req);
      const sessionId = extractSavedTranscriptRetranslationSessionId(path);
      const result = await savedTranscriptRetranslationController.translateSavedTranscript(
        validateSavedTranscriptRetranslationRequest({ sessionId, body })
      );

      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = savedTranscriptRetranslationErrorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (process.env.NODE_ENV === 'production' && req.method === 'GET' && !path.startsWith('/api/')) {
    const served = await serveProductionStatic(req, res, path);
    if (served) {
      return;
    }
  }

  if (req.method !== 'POST' || path !== '/api/live-token') {
    statusCode = 404;
    sendJson(res, statusCode, errorPayload('not_found', requestId), requestId);
    return;
  }

  try {
    if (!isAllowedOrigin(req)) {
      throw createHttpError('invalid_origin');
    }
    validateAccessToken(req);
    enforceRateLimit(clientIp);

    const body = await readJson(req);
    targetLanguageCode = body.targetLanguageCode || 'en';
    const token = await liveTokenCreator(body);
    statusCode = 200;
    sendJson(res, statusCode, token, requestId);
    logEvent({
      level: 'info',
      event: 'token_issued',
      requestId,
      clientIp,
      origin,
      targetLanguageCode
    });
  } catch (error) {
    const code = errorCodeFor(error);
    statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
    if (code === 'provider_unavailable') {
      logProviderError(requestId, error);
    }
    sendJson(res, statusCode, errorPayload(code, requestId), requestId);
  } finally {
    logEvent({
      level: statusCode >= 500 ? 'error' : 'info',
      event: 'request',
      requestId,
      method: req.method,
      path,
      statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      clientIp,
      origin,
      targetLanguageCode
    });
  }
}

function assertTranslationCommandController(translationCommandController) {
  if (!translationCommandController) {
    throw new TypeError('translationCommandController is required.');
  }

  assertMethod(translationCommandController, 'createTranslationRequest');
  assertMethod(translationCommandController, 'createTranslationExecution');
  assertMethod(translationCommandController, 'updateTranslationExecution');
  assertMethod(translationCommandController, 'createTranslationOutput');
}

function assertExecutionControlController(executionControlController) {
  if (!executionControlController) {
    throw new TypeError('executionControlController is required.');
  }
  for (const methodName of ['cancelExecution', 'retryExecution']) {
    if (typeof executionControlController[methodName] !== 'function') {
      throw new TypeError(`executionControlController.${methodName} must be a function.`);
    }
  }
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`translationCommandController.${methodName} must be a function.`);
  }
}

function isTranslationCommandRoute(method, path) {
  return (
    (method === 'POST' && path === '/api/translation-requests') ||
    (method === 'POST' && path === '/api/translation-executions') ||
    (method === 'PATCH' &&
      path.startsWith('/api/translation-executions/') &&
      path.length > '/api/translation-executions/'.length) ||
    (method === 'POST' && path === '/api/translation-outputs')
  );
}

function isExecutionControlRoute(method, path) {
  return method === 'POST'
    && path.startsWith('/api/translation-executions/')
    && (path.endsWith('/cancel') || path.endsWith('/retry'));
}

function isSavedTranscriptRetranslationRoute(method, path) {
  return method === 'POST' && path.startsWith('/api/saved-transcripts/') && path.endsWith('/translations');
}

function isSessionTranslationHistoryPath(path) {
  return path.startsWith('/api/sessions/') && path.endsWith('/translations') && path.length > '/api/sessions//translations'.length;
}

function isSessionTranslationOutputPath(path) {
  return path.startsWith('/api/sessions/') && path.includes('/translations/') && path.length > '/api/sessions//translations/'.length;
}

function isSessionRetranslationPath(path) {
  return path.startsWith('/api/sessions/') && path.endsWith('/retranslations') && path.length > '/api/sessions//retranslations'.length;
}

function isSessionAudioPath(path) {
  return path.startsWith('/api/sessions/') && path.includes('/audio/') && path.length > '/api/sessions//audio/'.length;
}

function parseSessionAudioPath(path) {
  const prefix = '/api/sessions/';
  const separator = path.indexOf('/audio/', prefix.length);
  if (separator <= prefix.length) throw createHttpError('invalid_request');
  return {
    sessionId: safeDecodePathComponent(path.slice(prefix.length, separator)),
    kind: validateAudioArtifactKind(path.slice(separator + '/audio/'.length))
  };
}

function isMeetingAudioPath(path) {
  return path.startsWith('/api/meetings/') && path.includes('/audio/') && path.length > '/api/meetings//audio/'.length;
}

function parseMeetingAudioPath(path) {
  const prefix = '/api/meetings/';
  const separator = path.indexOf('/audio/', prefix.length);
  if (separator <= prefix.length) throw createHttpError('invalid_request');
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length, separator)),
    kind: validateAudioArtifactKind(path.slice(separator + '/audio/'.length))
  };
}

function isMeetingDetailPath(path) {
  const prefix = '/api/meetings/';
  if (!path.startsWith(prefix) || path.length <= prefix.length) {
    return false;
  }

  return !path.slice(prefix.length).includes('/');
}

async function readMeetingAudioArtifact({ sessionRepository, sessionAudioArtifactRepository, meetingId, kind }) {
  const records = await sessionRepository.listSessionRecords();
  const record = [...records]
    .filter((sessionRecord) => sessionRecord?.meetingId === meetingId && sessionRecord.audioArtifacts?.[kind])
    .sort((left, right) => timestampValue(left.startedAt) - timestampValue(right.startedAt))[0];
  const metadata = record?.audioArtifacts?.[kind];
  if (!metadata) return null;
  return sessionAudioArtifactRepository.read(metadata);
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMeetingSegmentsPath(path) {
  return path.startsWith('/api/meetings/') && path.endsWith('/segments') && path.length > '/api/meetings//segments'.length;
}

function isMeetingSegmentCheckpointPath(path) {
  return path.startsWith('/api/meetings/') &&
    path.includes('/segments/') &&
    path.endsWith('/checkpoint') &&
    path.length > '/api/meetings//segments//checkpoint'.length;
}

function isMeetingSegmentRolloverPath(path) {
  return path.startsWith('/api/meetings/') &&
    path.includes('/segments/') &&
    path.endsWith('/rollover') &&
    path.length > '/api/meetings//segments//rollover'.length;
}

function isMeetingSegmentRecoverPath(path) {
  return path.startsWith('/api/meetings/') &&
    path.includes('/segments/') &&
    path.endsWith('/recover') &&
    path.length > '/api/meetings//segments//recover'.length;
}

function parseMeetingSegmentsPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/segments';
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length, -suffix.length))
  };
}

function parseMeetingDetailPath(path) {
  const prefix = '/api/meetings/';
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length))
  };
}

function parseMeetingSegmentCheckpointPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/checkpoint';
  const body = path.slice(prefix.length, -suffix.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');

  return {
    meetingId: safeDecodePathComponent(body.slice(0, separator)),
    segmentId: safeDecodePathComponent(body.slice(separator + '/segments/'.length))
  };
}

function parseMeetingSegmentRolloverPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/rollover';
  const body = path.slice(prefix.length, -suffix.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');

  return {
    meetingId: safeDecodePathComponent(body.slice(0, separator)),
    segmentId: safeDecodePathComponent(body.slice(separator + '/segments/'.length))
  };
}

function parseMeetingSegmentRecoverPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/recover';
  const body = path.slice(prefix.length, -suffix.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');

  return {
    meetingId: safeDecodePathComponent(body.slice(0, separator)),
    segmentId: safeDecodePathComponent(body.slice(separator + '/segments/'.length))
  };
}

function safeDecodePathComponent(value) {
  try {
    return validateRequiredString(decodeURIComponent(value));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function isGlossaryRoute(method, path) {
  return (
    (method === 'GET' && path === '/api/glossary') ||
    (method === 'POST' && path === '/api/glossary/entries') ||
    ((method === 'PUT' || method === 'DELETE') &&
      path.startsWith('/api/glossary/entries/') &&
      path.length > '/api/glossary/entries/'.length)
  );
}

async function handleGlossaryCommand(method, path, req, glossaryController) {
  if (method === 'GET' && path === '/api/glossary') {
    return { status: 200, result: { entries: await glossaryController.listEntries() } };
  }

  if (method === 'POST' && path === '/api/glossary/entries') {
    return { status: 201, result: { entry: await glossaryController.createEntry(validateGlossaryEntryBody(await readJson(req))) } };
  }

  if (method === 'PUT' && path.startsWith('/api/glossary/entries/')) {
    const id = extractGlossaryEntryId(path);
    return { status: 200, result: { entry: await glossaryController.updateEntry({ id, ...validateGlossaryEntryBody(await readJson(req)) }) } };
  }

  if (method === 'DELETE' && path.startsWith('/api/glossary/entries/')) {
    const id = extractGlossaryEntryId(path);
    return { status: 200, result: { entry: await glossaryController.deleteEntry({ id }) } };
  }

  throw createHttpError('not_found');
}

function extractGlossaryEntryId(path) {
  try {
    return validateRequiredString(decodeURIComponent(path.slice('/api/glossary/entries/'.length)));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function validateGlossaryEntryBody(body) {
  if (!isPlainRequestObject(body) || !isPlainRequestObject(body.translations)) throw createHttpError('invalid_request');
  validateRequiredString(body.source);
  const scope = body.scope === undefined ? 'history' : body.scope;
  if (!['live', 'history', 'both'].includes(scope)) throw createHttpError('invalid_request');
  for (const [languageCode, translation] of Object.entries(body.translations)) {
    if (!isSupportedLanguage(languageCode)) throw createHttpError('unsupported_language');
    validateRequiredString(translation);
  }
  if (Object.keys(body.translations).length === 0) throw createHttpError('invalid_request');
  const replacementAliases = validateGlossaryReplacementAliases(body.replacementAliases);
  return {
    source: body.source,
    translations: body.translations,
    ...(hasReplacementAliases(replacementAliases) ? { replacementAliases } : {}),
    scope
  };
}

function validateGlossaryReplacementAliases(value) {
  if (value === undefined) return {};
  if (!isPlainRequestObject(value)) throw createHttpError('invalid_request');

  const replacementAliases = {};
  for (const [languageCode, aliases] of Object.entries(value)) {
    if (!isSupportedLanguage(languageCode)) throw createHttpError('unsupported_language');
    if (!Array.isArray(aliases)) throw createHttpError('invalid_request');
    replacementAliases[languageCode] = aliases.map((alias) => validateRequiredString(alias));
  }
  return replacementAliases;
}

function hasReplacementAliases(replacementAliases) {
  return Object.values(replacementAliases)
    .some((aliases) => Array.isArray(aliases) && aliases.length > 0);
}

function extractSessionRetranslationSessionId(path) {
  try { return decodeURIComponent(path.slice('/api/sessions/'.length, -'/retranslations'.length)); }
  catch { throw createHttpError('invalid_request'); }
}

function validateSessionRetranslationRequest({ sessionId, body }) {
  if (!isPlainRequestObject(body) || ['sourceText', 'sourceLanguageCode', 'transcriptItems', 'sessionId'].some((key) => Object.hasOwn(body, key))) {
    throw createHttpError('invalid_request');
  }
  return {
    sessionId: validateRequiredString(sessionId),
    targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode),
    providerKey: body.providerKey
  };
}

function legacyTranslationFallback(outputs) {
  return (Array.isArray(outputs) ? outputs : []).map((output) => ({
    id: output.id,
    targetLanguageCode: output.targetLanguageCode,
    version: null,
    source: 'legacy',
    translatedText: Array.isArray(output.items) ? output.items.map((item) => item?.text).filter(Boolean).join('\n') : null,
    completedAt: output.completedAt ?? output.createdAt ?? null
  }));
}

function isLiveSessionTranslationOutput(output) {
  return typeof output?.id === 'string' && output.id.startsWith('live-output:');
}

function applyFormalOutputReadModel(session, outputs) {
  const formalOutput = (Array.isArray(outputs) ? outputs : []).find((output) => output?.source === 'formal' || Number.isInteger(output?.version));
  if (!formalOutput || typeof formalOutput.translatedText !== 'string' || formalOutput.translatedText.trim().length === 0) {
    return;
  }

  const selectedTranslationOutput = {
    id: formalOutput.id,
    executionId: formalOutput.executionId,
    translationRequestId: formalOutput.requestId,
    requestId: formalOutput.requestId,
    sessionId: session?.session?.id ?? null,
    targetLanguageCode: formalOutput.targetLanguageCode ?? null,
    targetLanguageLabel: targetLanguageLabelFor(formalOutput.targetLanguageCode),
    status: 'completed',
    translatedText: formalOutput.translatedText,
    version: formalOutput.version ?? null,
    source: 'formal',
    items: [],
    provider: null,
    model: null,
    providerMetadataAvailable: false,
    createdAt: formalOutput.createdAt ?? formalOutput.completedAt ?? null,
    completedAt: formalOutput.completedAt ?? formalOutput.createdAt ?? null,
    legacy: false
  };

  session.translationOutputs = [
    selectedTranslationOutput,
    ...(Array.isArray(session.translationOutputs) ? session.translationOutputs : [])
  ];
  session.selectedTranslationOutput = selectedTranslationOutput;
  session.readingContent = {
    ...(session.readingContent || {}),
    translationArticle: {
      kind: 'translationArticle',
      status: 'available',
      targetLanguageCode: selectedTranslationOutput.targetLanguageCode,
      targetLanguageLabel: selectedTranslationOutput.targetLanguageLabel,
      version: selectedTranslationOutput.version,
      text: formalOutput.translatedText,
      paragraphs: paragraphsForArticleText(formalOutput.translatedText),
      createdAt: selectedTranslationOutput.createdAt,
      completedAt: selectedTranslationOutput.completedAt,
      emptyReason: null
    }
  };
}

function paragraphsForArticleText(text) {
  return String(text)
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function targetLanguageLabelFor(code) {
  return SUPPORTED_LANGUAGES.find((language) => language.code === code)?.label || null;
}

function parseSessionTranslationHistoryPath(url) {
  const parsed = new URL(url, 'http://localhost');
  const prefix = '/api/sessions/';
  const suffix = '/translations';
  const encodedSessionId = parsed.pathname.slice(prefix.length, -suffix.length);
  if (!encodedSessionId) throw createHttpError('invalid_request');
  let sessionId;
  try { sessionId = decodeURIComponent(encodedSessionId); } catch { throw createHttpError('invalid_request'); }
  const targetLanguageCode = parsed.searchParams.get('targetLanguageCode');
  if (targetLanguageCode === null) return { sessionId, targetLanguageCode: undefined };
  if (targetLanguageCode.trim().length === 0) throw createHttpError('invalid_request');
  return { sessionId, targetLanguageCode };
}

function parseSessionTranslationOutputPath(path) {
  const prefix = '/api/sessions/';
  const separator = '/translations/';
  const separatorIndex = path.indexOf(separator, prefix.length);

  if (separatorIndex === -1) throw createHttpError('invalid_request');

  const encodedSessionId = path.slice(prefix.length, separatorIndex);
  const encodedOutputId = path.slice(separatorIndex + separator.length);

  if (!encodedSessionId || !encodedOutputId || encodedOutputId.includes('/')) throw createHttpError('invalid_request');

  try {
    const sessionId = decodeURIComponent(encodedSessionId);
    const outputId = decodeURIComponent(encodedOutputId);
    if (!sessionId.trim() || !outputId.trim()) throw createHttpError('invalid_request');
    return { sessionId, outputId };
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function isDeletableRetranslationOutput(output, sessionId) {
  return Boolean(
    output &&
      output.sessionId === sessionId &&
      typeof output.requestId === 'string' &&
      Number.isInteger(output.version) &&
      !String(output.id).startsWith('live-output:')
  );
}

function savedTranscriptRetranslationErrorCodeFor(error) {
  if (typeof error.message === 'string' && error.message.startsWith('Session record not found:')) {
    return 'session_not_found';
  }

  return errorCodeFor(error);
}

function extractSavedTranscriptRetranslationSessionId(path) {
  const prefix = '/api/saved-transcripts/';
  const suffix = '/translations';
  const encodedSessionId = path.slice(prefix.length, -suffix.length);

  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    throw createHttpError('invalid_request');
  }
}

function validateSavedTranscriptRetranslationRequest({ sessionId, body }) {
  const validatedSessionId = validateRequiredString(sessionId);

  if (!isPlainRequestObject(body)) {
    throw createHttpError('invalid_request');
  }

  return {
    sessionId: validatedSessionId,
    sourceLanguageCode: validateRequiredString(body.sourceLanguageCode),
    targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode),
    providerKey: body.providerKey
  };
}

function validateSupportedTargetLanguageCode(value) {
  validateRequiredString(value);

  if (!isSupportedLanguage(value)) {
    throw createHttpError('unsupported_language');
  }

  return value;
}

function validateRequiredString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createHttpError('invalid_request');
  }

  return value;
}

function isPlainRequestObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function handleTranslationCommand(method, path, body, translationCommandController) {
  if (method === 'POST' && path === '/api/translation-requests') {
    return {
      status: 201,
      result: translationCommandController.createTranslationRequest({
        ...body,
        targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode)
      })
    };
  }

  if (method === 'POST' && path === '/api/translation-executions') {
    return {
      status: 202,
      result: translationCommandController.createTranslationExecution(body)
    };
  }

  if (
    method === 'PATCH' &&
    path.startsWith('/api/translation-executions/') &&
    path.length > '/api/translation-executions/'.length
  ) {
    const executionId = decodeURIComponent(path.slice('/api/translation-executions/'.length));
    return {
      status: 200,
      result: translationCommandController.updateTranslationExecution({
        ...body,
        id: executionId,
        executionId
      })
    };
  }

  if (method === 'POST' && path === '/api/translation-outputs') {
    return {
      status: 201,
      result: translationCommandController.createTranslationOutput({
        ...body,
        targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode)
      })
    };
  }

  throw createHttpError('not_found');
}

function handleExecutionControlCommand(method, path, executionControlController) {
  const operation = path.endsWith('/cancel') ? 'cancel' : 'retry';
  const executionId = extractExecutionControlExecutionId(path, operation);
  return operation === 'cancel'
    ? { status: 200, result: executionControlController.cancelExecution({ executionId }) }
    : { status: 202, result: executionControlController.retryExecution({ executionId }) };
}

function extractExecutionControlExecutionId(path, operation) {
  const prefix = '/api/translation-executions/';
  const suffix = `/${operation}`;
  const encodedExecutionId = path.slice(prefix.length, -suffix.length);
  try {
    return validateRequiredString(decodeURIComponent(encodedExecutionId));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function serializeExecutionControlResponse(execution) {
  return {
    id: execution.id,
    translationRequestId: execution.translationRequestId,
    requestId: execution.translationRequestId,
    status: execution.status,
    ...(execution.providerKey === undefined ? {} : { providerKey: execution.providerKey }),
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    failureInfo: execution.failureInfo
  };
}

async function serveProductionStatic(req, res, requestPath) {
  const filePath = resolveStaticPath(requestPath);
  const staticPath = filePath && await existingFilePath(filePath);
  const responsePath = staticPath || INDEX_HTML_PATH;

  try {
    const body = await readFile(responsePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(responsePath),
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logEvent({
        level: 'error',
        event: 'static_file_error',
        path: requestPath,
        errorName: error?.name || 'Error',
        safeSummary: 'Production static file serving failed'
      });
    }
    return false;
  }
}

function resolveStaticPath(requestPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const relativePath = normalize(decodedPath).replace(/^[/\\]+/, '');
  const filePath = resolve(DIST_DIR, relativePath || 'index.html');
  if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${sep}`)) {
    return null;
  }

  return filePath;
}

async function existingFilePath(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? filePath : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.webp':
      return 'image/webp';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

if (IS_MAIN) {
  const server = http.createServer(handleRequest);
  const stopTranslationExecutionWorkerRuntime = startTranslationExecutionWorkerRuntime();

  server.listen(PORT, HOST, () => {
    console.log(`Live Translate API listening on http://${HOST}:${PORT}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopTranslationExecutionWorkerRuntime();
      server.close(() => {
        process.exit(0);
      });
    });
  }
}
