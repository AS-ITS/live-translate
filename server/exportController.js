const EXPORT_PATH = /^\/api\/meetings\/([^/]+)\/exports(?:\/([^/]+))?(?:\/download-url)?$/u;

export function createExportController({ exportArtifactService } = {}) {
  if (!exportArtifactService) return null;

  return Object.freeze({
    matches(path) {
      return EXPORT_PATH.test(path);
    },

    async handle({ req, res, path, requestId }) {
      const match = path.match(EXPORT_PATH);
      if (!match) return false;
      const meetingId = decode(match[1]);
      const exportId = match[2] ? decode(match[2]) : null;
      const isDownloadUrl = path.endsWith('/download-url');
      try {
        if (req.method === 'POST' && !exportId) {
          const body = await readJson(req);
          const result = await exportArtifactService.create({ meetingId, format: body?.format, stream: body?.stream });
          sendJson(res, result.accepted ? 202 : 200, { export: result.artifact, ...(result.accepted ? { requestId } : {}) }, requestId);
          return true;
        }
        if (req.method === 'GET' && !exportId) {
          const exports = await exportArtifactService.list({ meetingId });
          sendJson(res, 200, { exports }, requestId);
          return true;
        }
        if (req.method === 'GET' && exportId && !isDownloadUrl) {
          const artifact = await exportArtifactService.get({ meetingId, exportId });
          sendJson(res, 200, { export: artifact }, requestId);
          return true;
        }
        if (req.method === 'POST' && exportId && isDownloadUrl) {
          const download = await exportArtifactService.createDownloadUrl({ meetingId, exportId, expiresIn: 60 });
          sendJson(res, 200, download, requestId);
          return true;
        }
        if (req.method === 'DELETE' && exportId && !isDownloadUrl) {
          await exportArtifactService.delete({ meetingId, exportId });
          res.writeHead(204, requestId ? { 'X-Request-Id': requestId } : {});
          res.end();
          return true;
        }
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, requestId);
        return true;
      } catch (error) {
        const code = error?.code || 'cloud_capability_unavailable';
        const status = Number.isInteger(error?.status) ? error.status : statusFor(code);
        sendJson(res, status, { error: { code, message: publicMessage(code), requestId } }, requestId);
        return true;
      }
    }
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON request.');
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
}

function sendJson(res, status, payload, requestId) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(body);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error('Invalid path.');
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
}

function statusFor(code) {
  if (code === 'auth_required' || code === 'auth_forbidden') return 403;
  if (code === 'export_not_found' || code === 'meeting_not_found') return 404;
  if (code === 'export_not_ready') return 409;
  if (code.startsWith('export_invalid')) return 400;
  return 503;
}

function publicMessage(code) {
  const messages = {
    auth_required: 'Authentication required.',
    auth_forbidden: 'You do not have access to this export.',
    export_invalid_format: 'Export format is invalid.',
    export_invalid_stream: 'Export stream is invalid for this format.',
    export_not_found: 'Export not found.',
    export_not_ready: 'Export is not ready.',
    meeting_not_found: 'Meeting not found.',
    invalid_request: 'Invalid export request.',
    cloud_capability_unavailable: 'Cloud export is unavailable.'
  };
  return messages[code] || 'Export request failed.';
}
