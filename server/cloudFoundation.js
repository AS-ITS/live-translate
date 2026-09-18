import crypto from 'node:crypto';
import { createAccessControl } from './accessControl.js';
import { createProfileService } from './profileService.js';
import { cloudEnvironmentError } from './cloudEnvironment.js';

const CLOUD_CAPABILITY_ERROR = 'cloud_capability_unavailable';

export function createCloudFoundationHandler({ env = process.env, accessControl = createAccessControl({ env }), profileService = createProfileService({ env }), readinessCheck } = {}) {
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
      const environmentError = cloudEnvironmentError({ env });
      let ready = !environmentError;
      let dependencyCode = environmentError?.code || null;
      if (ready && typeof readinessCheck === 'function') {
        try { ready = Boolean(await readinessCheck()); }
        catch (error) { ready = false; dependencyCode = error?.code || 'supabase_unavailable'; }
      }
      sendJson(res, ready ? 200 : 503, ready ? { ok: true, requestId, runtime: 'vercel' } : { ok: false, error: { code: dependencyCode || 'supabase_unavailable' }, requestId }, requestId);
      return;
    }

    if (req.method === 'GET' && normalizedPath === '/profile') {
      try {
        const user = await accessControl.validateRequest(req);
        sendJson(res, 200, { profile: await profileService.getProfile(user), requestId }, requestId);
      } catch (error) {
        const code = error.code || 'cloud_capability_unavailable';
        sendJson(res, error.status || 503, { error: { code, message: error.message }, requestId }, requestId);
      }
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
