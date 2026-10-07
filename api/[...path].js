import { handleRequest } from '../server/index.js';
import { waitUntil } from '@vercel/functions';
import { createSupabaseMeetingCleanupWorker } from '../src/infrastructure/supabaseMeetingCleanupWorker.js';

export const config = { maxDuration: 60 };

export default async function vercelApiHandler(req, res) {
  await handleRequest(req, res);
  if (req.method !== 'GET' || res.statusCode < 200 || res.statusCode >= 300 ||
      !/^\/api\/meetings(?:\/[^/?]+)?(?:\?|$)/u.test(req.url || '')) return;
  const worker = createSupabaseMeetingCleanupWorker();
  if (worker) waitUntil(worker.runOnce());
}
