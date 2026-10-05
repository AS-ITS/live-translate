import { OBSERVABILITY_METRIC_NAMES } from './observability/observabilityMetricRegistry.js';

export function createMeetingPurgeWorker({
  repository,
  storage,
  workerId,
  observabilityMetrics,
  clock = () => Date.now()
} = {}) {
  for (const method of ['claimDue', 'listArtifacts', 'deleteMeeting', 'markFailed']) {
    assertMethod(repository, method, 'repository');
  }
  if (!storage || typeof storage.remove !== 'function') {
    throw new TypeError('storage.remove must be a function.');
  }
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new TypeError('workerId must be a non-empty string.');
  }

  return Object.freeze({
    async runOnce({ limit = 3 } = {}) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError('limit must be a positive integer.');
      }

      const claims = await repository.claimDue({ workerId, limit });
      recordCounter(OBSERVABILITY_METRIC_NAMES.PURGE_CLAIMED, claims.length);
      let purged = 0;
      let failed = 0;

      for (const claim of claims) {
        const startedAt = clock();
        try {
          const artifacts = await repository.listArtifacts(claim);
          await storage.remove({ bucket: 'meeting-audio', paths: artifacts.audioPaths });
          await storage.remove({ bucket: 'meeting-exports', paths: artifacts.exportPaths });
          await repository.deleteMeeting(claim);
          purged += 1;
          recordCounter(OBSERVABILITY_METRIC_NAMES.PURGE_COMPLETED);
          recordLatency(OBSERVABILITY_METRIC_NAMES.PURGE_LATENCY, Math.max(0, clock() - startedAt));
        } catch (error) {
          failed += 1;
          recordCounter(OBSERVABILITY_METRIC_NAMES.PURGE_FAILED);
          try {
            await repository.markFailed({ claim, error });
          } catch {
            // The claim timeout remains the retry safety net if status update fails.
          }
        }
      }

      return { claimed: claims.length, purged, failed };
    }
  });

  function recordCounter(name, amount = 1) {
    try {
      observabilityMetrics?.recordCounter?.(name, amount, { provider: 'none', operation: 'retention', statusClass: 'none' });
    } catch {
      // Retention metrics must never affect purge behavior.
    }
  }

  function recordLatency(name, value) {
    try {
      observabilityMetrics?.recordLatency?.(name, value, { provider: 'none', operation: 'retention', statusClass: 'none' });
    } catch {
      // Retention metrics must never affect purge behavior.
    }
  }
}

function assertMethod(target, method, owner) {
  if (!target || typeof target[method] !== 'function') {
    throw new TypeError(`${owner}.${method} must be a function.`);
  }
}
