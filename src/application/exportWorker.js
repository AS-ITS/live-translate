import { BACKGROUND_JOB_MAX_ATTEMPTS, BACKGROUND_JOB_VISIBILITY_TIMEOUT_SECONDS } from './backgroundJobs.js';

export function createExportWorker({
  exportArtifactService,
  queue,
  leaseSeconds = BACKGROUND_JOB_VISIBILITY_TIMEOUT_SECONDS
} = {}) {
  if (!exportArtifactService || typeof exportArtifactService.process !== 'function') throw new TypeError('exportArtifactService.process must be a function.');
  if (!queue || typeof queue.claim !== 'function' || typeof queue.acknowledge !== 'function' || typeof queue.retry !== 'function') throw new TypeError('queue must implement claim, acknowledge, and retry.');

  return Object.freeze({
    async runOnce({ limit = 3 } = {}) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer.');
      const claims = await queue.claim({ limit, leaseSeconds });
      let processed = 0;
      let failed = 0;
      for (const claim of claims) {
        try {
          await exportArtifactService.process(claim.message);
          await queue.acknowledge({ messageId: claim.messageId, readCt: claim.readCt });
          processed += 1;
        } catch (error) {
          failed += 1;
          await queue.retry({
            messageId: claim.messageId,
            readCt: claim.readCt,
            attempt: claim.readCt || 1,
            errorCode: error?.code || 'export_failed',
            message: claim.message
          });
          if ((claim.readCt || 1) >= BACKGROUND_JOB_MAX_ATTEMPTS) {
            // The queue archives the message; the artifact service owns the
            // terminal failed state so no transcript content enters the log.
          }
        }
      }
      return { processed, failed };
    }
  });
}
