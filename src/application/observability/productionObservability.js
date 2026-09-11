import { createObservabilityMetricRegistry } from './observabilityMetricRegistry.js';

export function createProductionObservability({ repository, clock = () => new Date() } = {}) {
  const failures = { count: 0 };
  const registry = createObservabilityMetricRegistry({
    clock,
    sink: async (record) => {
      if (!repository) return;
      try {
        if (record.gaugeValue !== null) await repository.setGauge(record.metricName, record.gaugeValue, record, record.bucketStart);
        else if (record.type === 'latency') await repository.recordLatency(record.metricName, record.sumValue, record, record.bucketStart);
        else await repository.recordCounter(record.metricName, record, record.count, record.bucketStart);
      } catch {
        failures.count += 1;
      }
    }
  });
  return Object.freeze({
    recordCounter: (name, amount = 1, labels) => registry.recordCounter(name, amount, labels),
    recordLatency: (name, value, labels) => registry.recordLatency(name, value, labels),
    setGauge: (name, value, labels) => registry.setGauge(name, value, labels),
    snapshot: registry.snapshot,
    flush: async () => ({ attempted: true, failures: failures.count }),
    cleanupExpired: () => repository?.cleanupExpired?.()
  });
}
