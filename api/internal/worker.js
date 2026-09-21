import { getDefaultApplicationDependencies } from '../../server/index.js';
import { runWithRequestUser } from '../../server/requestIdentity.js';
import { createStructuredLogger } from '../../src/infrastructure/structuredLogger.js';

export const config = { maxDuration: 60 };

export function createWorkerHandler({
  getDependencies = getDefaultApplicationDependencies,
  runAsUser = runWithRequestUser,
  logger = createStructuredLogger()
} = {}) {
  return async function workerHandler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, POST');
      res.end();
      return;
    }

    const expectedSecret = process.env.CRON_SECRET;
    const authorization = req.headers?.authorization || '';
    if (!expectedSecret || authorization !== `Bearer ${expectedSecret}`) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unauthorized.' }));
      return;
    }

    const rawLimit = Number(process.env.WORKER_BATCH_SIZE || 3);
    const limit = Number.isInteger(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 10)
      : 3;

    try {
      const dependencies = getDependencies();
      try {
        await dependencies.observabilityMetrics?.cleanupExpired?.();
      } catch {
        // Cleanup is best effort and must not prevent queue processing.
      }
      const result = await runAsUser(
        { kind: 'worker' },
        () => dependencies.translationExecutionWorkerRuntime.runOnce({ limit })
      );
      if (dependencies.exportWorker?.runOnce) {
        let exports;
        try {
          exports = await runAsUser({ kind: 'worker' }, () => dependencies.exportWorker.runOnce({ limit }));
        } catch (error) {
          logger?.log?.({ level: 'error', event: 'export_worker_failed', requestId: getRequestId(req), errorCode: error?.code || 'unknown' });
          exports = { processed: 0, failed: 1 };
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, translation: result, exports }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      logWorkerFailure(logger, req, error);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Worker execution failed.' }));
    }
  };
}

function logWorkerFailure(logger, req, error) {
  try {
    logger?.log?.({
      level: 'error',
      event: 'translation_worker_failed',
      requestId: getRequestId(req),
      errorCode: error?.code || 'unknown',
      errorStatus: Number.isInteger(error?.status) ? error.status : null,
      errorName: error?.name || 'Error',
      errorMessage: sanitizeErrorMessage(error?.message)
    });
  } catch {
    // Diagnostics must never change the worker response.
  }
}

function getRequestId(req) {
  return req?.headers?.['x-request-id']
    || req?.headers?.['x-vercel-id']
    || null;
}

function sanitizeErrorMessage(message) {
  if (typeof message !== 'string') return null;
  return message
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, 'authorization: [REDACTED]')
    .replace(/GEMINI_API_KEY|CRON_SECRET/gi, '[REDACTED_SECRET_NAME]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .slice(0, 240);
}

export default createWorkerHandler();
