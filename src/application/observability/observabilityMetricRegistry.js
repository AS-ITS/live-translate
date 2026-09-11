const STATUS_CLASSES = new Set(['none', '200', '401', '403', '429', '5xx', 'other']);
const LABEL_VALUES = Object.freeze({
  provider: new Set(['none', 'gemini']),
  operation: new Set(['none', 'translation', 'polishing', 'token', 'viewer']),
  statusClass: STATUS_CLASSES
});

export const OBSERVABILITY_METRIC_NAMES = Object.freeze({
  QUEUE_DEPTH: 'translation_queue_depth',
  EXECUTION_STARTED: 'translation_execution_started_total',
  EXECUTION_COMPLETED: 'translation_execution_completed_total',
  EXECUTION_SKIPPED: 'translation_execution_skipped_total',
  EXECUTION_CANCELLED: 'translation_execution_cancelled_total',
  EXECUTION_RETRY: 'translation_execution_retry_total',
  EXECUTION_FAILURE: 'translation_execution_failure_total',
  EXECUTION_LATENCY: 'translation_execution_latency_ms',
  RECOVERY_LATENCY: 'translation_execution_recovery_latency_ms',
  LEASE_RECLAIM: 'translation_queue_lease_reclaim_total',
  LEASE_ERROR: 'translation_queue_lease_error_total',
  ACK_ERROR: 'translation_queue_ack_error_total',
  GEMINI_REQUEST: 'gemini_request_total',
  GEMINI_FAILURE: 'gemini_failure_total',
  GEMINI_LATENCY: 'gemini_latency_ms',
  VIEWER_RECONNECT: 'viewer_reconnect_total',
  VIEWER_GAP: 'viewer_event_gap_total',
  VIEWER_DUPLICATE: 'viewer_event_duplicate_total',
  VIEWER_REPLAY: 'viewer_replay_total',
  VIEWER_REPLAY_FAILURE: 'viewer_replay_failure_total',
  METRICS_WRITE_FAILURE: 'observability_metrics_write_failure_total',
  VIEWER_REPLAY_SUCCESS: 'viewer_replay_success_total',
  VIEWER_REPLAY_FAILURE: 'viewer_replay_failure_total'
});

export const OBSERVABILITY_STATUS_CLASSES = Object.freeze([...STATUS_CLASSES]);

export function minuteBucket(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('metric timestamp must be valid.');
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export function normalizeMetricLabels({ provider = 'none', operation = 'none', statusClass = 'none' } = {}) {
  for (const [name, value] of Object.entries({ provider, operation, statusClass })) {
    if (typeof value !== 'string' || !LABEL_VALUES[name]?.has(value)) {
      throw new TypeError(`Invalid observability metric label: ${name}`);
    }
  }
  return Object.freeze({ provider, operation, statusClass });
}

export function providerStatusClass(status) {
  const code = Number(status);
  if (code === 401 || code === 403 || code === 429) return String(code);
  if (code >= 500 && code <= 599) return '5xx';
  return 'other';
}

export function createObservabilityMetricRegistry({ clock = () => new Date(), sink = null } = {}) {
  const values = new Map();
  const record = (metricName, { value = 1, type = 'counter', provider, operation, statusClass, at } = {}) => {
    if (!Object.values(OBSERVABILITY_METRIC_NAMES).includes(metricName)) throw new TypeError(`Unknown observability metric: ${metricName}`);
    if (!Number.isFinite(value) || value < 0) throw new TypeError('metric value must be non-negative.');
    const labels = normalizeMetricLabels({ provider, operation, statusClass });
    const key = JSON.stringify([metricName, ...Object.values(labels)]);
    const current = values.get(key) || { metricName, ...labels, count: 0, sumValue: 0, maxValue: 0, gaugeValue: 0, type };
    if (type === 'gauge') current.gaugeValue = value;
    else { current.count += 1; current.sumValue += value; current.maxValue = Math.max(current.maxValue, value); }
    values.set(key, current);
    if (typeof sink === 'function') Promise.resolve(sink({ ...current, bucketStart: minuteBucket(at || clock()) })).catch(() => {});
  };
  return Object.freeze({
    recordCounter: (metricName, labels) => record(metricName, { ...labels, type: 'counter' }),
    recordLatency: (metricName, value, labels) => record(metricName, { ...labels, value, type: 'latency' }),
    setGauge: (metricName, value, labels) => record(metricName, { ...labels, value, type: 'gauge' }),
    snapshot: () => Object.freeze([...values.values()].map((item) => Object.freeze({ ...item }))),
    reset: () => values.clear()
  });
}
