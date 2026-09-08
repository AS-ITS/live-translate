import crypto from 'node:crypto';

const CLOUD_CAPABILITY_ERROR = 'cloud_capability_unavailable';

export function createCloudFoundationHandler({ env = process.env } = {}) {
  return async function cloudFoundationHandler(req, res) {
    const requestId = req.headers?.['x-request-id'] || crypto.randomUUID();
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const normalizedPath = path.startsWith('/api/') ? path.slice('/api'.length) : path;

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {}, requestId);
      return;
    }

    if (req.method === 'GET' && (normalizedPath === '/health' || normalizedPath === '/healthz')) {
      sendJson(res, 200, { ok: true, requestId, runtime: 'vercel' }, requestId);
      return;
    }

    if (req.method === 'GET' && normalizedPath === '/readyz') {
      const ready = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
      sendJson(res, ready ? 200 : 503, { ok: ready, requestId, runtime: 'vercel' }, requestId);
      return;
    }

    sendJson(res, 503, {
      error: { code: CLOUD_CAPABILITY_ERROR, message: 'This cloud capability is not enabled yet.' },
      requestId
    }, requestId);
  };
}

function sendJson(res, status, payload, requestId) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id',
    'X-Content-Type-Options': 'nosniff',
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(body);
}

