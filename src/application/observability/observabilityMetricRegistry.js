const STATUS_CLASSES = new Set(['none', '200', '401', '403', '429', '5xx', 'other']);
const LABEL_VALUES = Object.freeze({
  provider: new Set(['none', 'gemini']),
  operation: new Set(['none', 'translation', 'polishing', 'token', 'viewer', 'retention']),
  statusClass: STATUS_CLASSES
});

export const OBSERVABILITY_METRIC_NAMES = Object.freeze({
  QUEUE_DEPTH: 'translation_queue_depth', EXECUTION_STARTED: 'translation_execution_started_total',
  EXECUTION_COMPLETED: 'translation_execution_completed_total', EXECUTION_SKIPPED: 'translation_execution_skipped_total',
  EXECUTION_CANCELLED: 'translation_execution_cancelled_total', EXECUTION_RETRY: 'translation_execution_retry_total',
  EXECUTION_FAILURE: 'translation_execution_failure_total', EXECUTION_LATENCY: 'translation_execution_latency_ms',
  RECOVERY_TOTAL: 'translation_execution_recovery_total',
  RECOVERY_LATENCY: 'translation_execution_recovery_latency_ms', LEASE_RECLAIM: 'translation_queue_lease_reclaim_total',
  LEASE_ERROR: 'translation_queue_lease_error_total', ACK_ERROR: 'translation_queue_ack_error_total',
  GEMINI_REQUEST: 'gemini_request_total', GEMINI_FAILURE: 'gemini_failure_total', GEMINI_LATENCY: 'gemini_latency_ms',
  VIEWER_RECONNECT: 'viewer_reconnect_total', VIEWER_GAP: 'viewer_event_gap_total',
  VIEWER_DUPLICATE: 'viewer_event_duplicate_total', VIEWER_REPLAY: 'viewer_replay_total',
  VIEWER_REPLAY_SUCCESS: 'viewer_replay_success_total', VIEWER_REPLAY_FAILURE: 'viewer_replay_failure_total',
  PURGE_CLAIMED: 'meeting_purge_claimed_total', PURGE_COMPLETED: 'meeting_purge_completed_total',
  PURGE_FAILED: 'meeting_purge_failed_total', PURGE_LATENCY: 'meeting_purge_latency_ms',
  METRICS_WRITE_FAILURE: 'observability_metrics_write_failure_total', WORKER_RUNTIME_STARTED: 'worker_runtime_started_total',
  WORKER_RUNTIME_STOPPED: 'worker_runtime_stopped_total', WORKER_RUNTIME_POLL_ERROR: 'worker_runtime_poll_error_total'
});

export const OBSERVABILITY_STATUS_CLASSES = Object.freeze([...STATUS_CLASSES]);

export function minuteBucket(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('metric date must be valid.');
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export function normalizeMetricLabels(labels = {}) {
  const normalized = { provider: labels.provider ?? 'none', operation: labels.operation ?? 'none', statusClass: labels.statusClass ?? 'none' };
  for (const [name, value] of Object.entries(normalized)) {
    if (!LABEL_VALUES[name]?.has(value)) throw new TypeError(`Invalid observability metric label: ${name}`);
  }
  return Object.freeze(normalized);
}

export function providerStatusClass(status) {
  const numeric = Number(status);
  if (numeric === 401 || numeric === 403 || numeric === 429) return String(numeric);
  if (numeric >= 500 && numeric <= 599) return '5xx';
  if (numeric >= 200 && numeric <= 299) return '200';
  return 'other';
}

export function createObservabilityMetricRegistry({ clock = () => new Date(), sink } = {}) {
  const values = new Map();
  function record(metricName, { value, type, ...labels }, at = clock()) {
    if (!Object.values(OBSERVABILITY_METRIC_NAMES).includes(metricName)) throw new TypeError(`Unknown observability metric: ${metricName}`);
    if (!Number.isFinite(value) || value < 0 || (type === 'counter' && !Number.isInteger(value))) throw new TypeError('metric value must be a non-negative number.');
    const normalized = normalizeMetricLabels(labels);
    const key = JSON.stringify([metricName, ...Object.values(normalized)]);
    const current = values.get(key) || { metricName, ...normalized, type, count: 0, sumValue: 0, maxValue: 0, gaugeValue: 0 };
    if (type === 'gauge') current.gaugeValue = value;
    else if (type === 'counter') current.count += value;
    else { current.count += 1; current.sumValue += value; current.maxValue = Math.max(current.maxValue, value); }
    values.set(key, current);
    if (typeof sink === 'function') Promise.resolve(sink({
      metricName, type, ...normalized, bucketStart: minuteBucket(at),
      count: type === 'gauge' ? 0 : type === 'counter' ? value : 1,
      sumValue: type === 'latency' ? value : 0, maxValue: type === 'latency' ? value : 0,
      gaugeValue: type === 'gauge' ? value : null
    })).catch(() => {});
  }
  return Object.freeze({
    recordCounter: (name, amount = 1, labels = {}, at) => record(name, { ...labels, value: amount, type: 'counter' }, at),
    recordLatency: (name, value, labels = {}, at) => record(name, { ...labels, value, type: 'latency' }, at),
    setGauge: (name, value, labels = {}, at) => record(name, { ...labels, value, type: 'gauge' }, at),
    snapshot: () => Object.freeze([...values.values()].map((item) => Object.freeze({ ...item }))),
    reset: () => values.clear()
  });
}
