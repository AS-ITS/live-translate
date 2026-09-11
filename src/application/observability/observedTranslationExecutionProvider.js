import { OBSERVABILITY_METRIC_NAMES, providerStatusClass } from './observabilityMetricRegistry.js';

export function createObservedTranslationExecutionProvider({ provider, observabilityMetrics, clock = () => Date.now() } = {}) {
  if (!provider || typeof provider.execute !== 'function') throw new TypeError('provider.execute is required.');
  return Object.freeze({
    ...(provider.idempotency ? { idempotency: provider.idempotency } : {}),
    async execute(input) {
      const startedAt = clock();
      const labels = { provider: 'gemini', operation: input?.operation === 'transcript_polishing' ? 'polishing' : 'translation', statusClass: 'none' };
      safeCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.GEMINI_REQUEST, labels);
      try {
        const result = await provider.execute(input);
        safeLatency(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.GEMINI_LATENCY, elapsedMs(clock(), startedAt), { ...labels, statusClass: '200' });
        return result;
      } catch (error) {
        const statusClass = providerStatusClass(error?.status || error?.providerCode);
        safeCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.GEMINI_FAILURE, { ...labels, statusClass });
        safeLatency(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.GEMINI_LATENCY, elapsedMs(clock(), startedAt), { ...labels, statusClass });
        throw error;
      }
    }
  });
}

function elapsedMs(now, startedAt) {
  const value = new Date(now).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeCounter(metrics, name, labels) {
  try { metrics?.recordCounter?.(name, 1, labels); } catch { /* best effort */ }
}

function safeLatency(metrics, name, value, labels) {
  try { metrics?.recordLatency?.(name, value, labels); } catch { /* best effort */ }
}
