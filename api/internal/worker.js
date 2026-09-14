import { getDefaultApplicationDependencies } from '../../server/index.js';
import { runWithRequestUser } from '../../server/requestIdentity.js';

export const config = { maxDuration: 60 };

export default async function workerHandler(req, res) {
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
    res.end(JSON.stringify({ error: 'Unauthorized.' }));
    return;
  }

  const rawLimit = Number(process.env.WORKER_BATCH_SIZE || 3);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 10) : 3;

  try {
    const dependencies = getDefaultApplicationDependencies();
    try {
      await dependencies.observabilityMetrics?.cleanupExpired?.();
    } catch {
      // Cleanup is best effort and must not prevent queue processing.
    }
    const result = await runWithRequestUser({ kind: 'worker' }, () =>
      dependencies.translationExecutionWorkerRuntime.runOnce({ limit })
    );
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Worker execution failed.' }));
  }
}
