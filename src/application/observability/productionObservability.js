import { createObservabilityMetricRegistry, OBSERVABILITY_METRIC_NAMES } from './observabilityMetricRegistry.js';

export function createProductionObservability({ repository, clock = () => new Date(), logger = () => {} } = {}) {
  const failures = { count: 0, recording: false };
  const registry = createObservabilityMetricRegistry({
    clock,
    sink: async (record) => {
      if (!repository) return;
      try {
        const labels = { provider: record.provider, operation: record.operation, statusClass: record.statusClass };
        if (record.type === 'gauge') await repository.setGauge(record.metricName, record.gaugeValue, labels, record.bucketStart);
        else if (record.type === 'latency') await repository.recordLatency(record.metricName, record.sumValue, labels, record.bucketStart);
        else await repository.recordCounter(record.metricName, labels, record.count, record.bucketStart);
      } catch (error) {
        failures.count += 1;
        logger({ event: 'observability_metrics_write_failed', safeSummary: 'Metrics persistence failed', error });
        if (!failures.recording && record.metricName !== OBSERVABILITY_METRIC_NAMES.METRICS_WRITE_FAILURE) {
          failures.recording = true;
          try {
            await repository.recordCounter(OBSERVABILITY_METRIC_NAMES.METRICS_WRITE_FAILURE, { provider: 'none', operation: 'none', statusClass: 'other' }, 1, record.bucketStart);
          } catch { /* Metrics persistence never affects core work. */ }
          failures.recording = false;
        }
      }
    }
  });
  return Object.freeze({
    recordCounter: (name, amount = 1, labels, at) => registry.recordCounter(name, amount, labels, at),
    recordLatency: (name, value, labels, at) => registry.recordLatency(name, value, labels, at),
    setGauge: (name, value, labels, at) => registry.setGauge(name, value, labels, at),
    snapshot: registry.snapshot,
    flush: async () => ({ attempted: true, failures: failures.count }),
    cleanupExpired: async () => {
      if (!repository?.cleanupExpired) return undefined;
      try {
        return await repository.cleanupExpired();
      } catch (error) {
        failures.count += 1;
        logger({ event: 'observability_metrics_cleanup_failed', safeSummary: 'Metrics cleanup failed', error });
        registry.recordCounter(OBSERVABILITY_METRIC_NAMES.METRICS_WRITE_FAILURE, 1, { provider: 'none', operation: 'none', statusClass: 'other' });
        return undefined;
      }
    }
  });
}
