import http from 'node:http';
import crypto from 'node:crypto';
import { isSupportedLanguage } from './languages.js';
import { createLiveToken } from './tokenService.js';
import { createApplicationDependencies, createProductionApplicationDependencies } from './compositionRoot.js';
import { createSessionSnapshotSyncService } from '../src/application/sessionSnapshotSyncService.js';

const PORT = Number.parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5173';
const rateLimitBuckets = new Map();

const ERROR_RESPONSES = {
  auth_required: { status: 401, message: 'Access token is required.' },
  auth_invalid: { status: 401, message: 'Access token is invalid.' },
  auth_not_configured: { status: 503, message: 'Access gate is not configured.' },
  invalid_json: { status: 400, message: 'Request body must be valid JSON.' },
  invalid_request: { status: 400, message: 'Request body or path parameters are invalid.' },
  invalid_origin: { status: 403, message: 'Request origin is not allowed.' },
  not_found: { status: 404, message: 'Route not found.' },
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
  translation_request_not_found: { status: 404, message: 'Translation request not found.' },
  execution_invalid_state: { status: 409, message: 'Translation execution is not in a valid state for this operation.' },
  internal_error: { status: 500, message: 'Unexpected server error.' }
};

function sendJson(res, status, payload, requestId) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Demo-Access-Token',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(body);
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

  if (error.message === 'Unsupported targetLanguageCode') {
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

const createDefaultApplicationDependencies =
  process.env.NODE_ENV === 'production' ? createProductionApplicationDependencies : createApplicationDependencies;
const { requestHandler: defaultRequestHandler } = createDefaultApplicationDependencies({
  requestHandlerFactory: createRequestHandler,
  includeSessionRetranslationCommandController: true
});

export function createRequestHandler(options = {}) {
  const {
    sessionReadController,
    sessionRepository,
    translationCommandController,
    executionControlController,
    translationHistoryController,
    savedTranscriptRetranslationController,
    sessionRetranslationCommandController,
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
      translationCommandController,
      executionControlController,
      translationHistoryController,
      savedTranscriptRetranslationController,
      sessionRetranslationCommandController,
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
  { sessionReadController, sessionRepository, translationCommandController, executionControlController, translationHistoryController, savedTranscriptRetranslationController, sessionRetranslationCommandController, liveTokenCreator = createLiveToken } = {}
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
          const outputs = formalHistory?.outputs || [];
          session.translationHistory = {
            outputs: outputs.length > 0 ? outputs : legacyTranslationFallback(session.translationOutputs),
            executions: formalHistory?.executions || []
          };
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

function isSessionRetranslationPath(path) {
  return path.startsWith('/api/sessions/') && path.endsWith('/retranslations') && path.length > '/api/sessions//retranslations'.length;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log(`Live Translate API listening on http://${HOST}:${PORT}`);
  });
}
