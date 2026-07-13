import http from 'node:http';
import crypto from 'node:crypto';
import { createLiveToken } from './tokenService.js';
import { createApplicationDependencies } from './compositionRoot.js';

const PORT = Number.parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5173';
const rateLimitBuckets = new Map();

const ERROR_RESPONSES = {
  auth_required: { status: 401, message: 'Access token is required.' },
  auth_invalid: { status: 401, message: 'Access token is invalid.' },
  auth_not_configured: { status: 503, message: 'Access gate is not configured.' },
  invalid_json: { status: 400, message: 'Request body must be valid JSON.' },
  invalid_origin: { status: 403, message: 'Request origin is not allowed.' },
  not_found: { status: 404, message: 'Route not found.' },
  provider_unavailable: { status: 502, message: 'Live translation provider is unavailable.' },
  rate_limited: { status: 429, message: 'Too many requests. Please try again later.' },
  request_too_large: { status: 413, message: 'Request body is too large.' },
  server_misconfigured: { status: 500, message: 'Server is not configured for live translation.' },
  session_not_found: { status: 404, message: 'Session not found.' },
  unsupported_language: { status: 400, message: 'Selected target language is not supported.' },
  internal_error: { status: 500, message: 'Unexpected server error.' }
};

function sendJson(res, status, payload, requestId) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

const defaultRequestHandler = createRequestHandler(createApplicationDependencies());

export function createRequestHandler({ sessionReadController } = {}) {
  return async function handleRequestWithDependencies(req, res) {
    return handleRequestWithSessionReadController(req, res, {
      sessionReadController
    });
  };
}

export async function handleRequest(req, res) {
  return defaultRequestHandler(req, res);
}

async function handleRequestWithSessionReadController(req, res, { sessionReadController } = {}) {
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

  if (req.method === 'GET' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      const sessionId = path.slice('/api/sessions/'.length);
      const session = await sessionReadController.getSession(sessionId);

      if (!session) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
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
    targetLanguageCode = body.targetLanguageCode || 'zh-Hant';
    const token = await createLiveToken(body);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log(`Live Translate API listening on http://${HOST}:${PORT}`);
  });
}
