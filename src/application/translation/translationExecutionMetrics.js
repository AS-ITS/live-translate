export const TRANSLATION_EXECUTION_METRIC_NAMES = Object.freeze({
  QUEUE_DEPTH: 'translation_queue_depth',
  PROCESSED_TOTAL: 'translation_queue_processed_total',
  SKIPPED_TOTAL: 'translation_queue_skipped_total',
  CANCELLED_TOTAL: 'translation_queue_cancelled_total',
  RETRY_TOTAL: 'translation_queue_retry_total',
  FAILED_TOTAL: 'translation_queue_failed_total',
  DLQ_TRANSFER_TOTAL: 'translation_queue_dlq_transfer_total',
  RECOVERY_TOTAL: 'translation_queue_recovery_total',
  LEASE_ERROR_TOTAL: 'translation_queue_lease_error_total',
  ACKNOWLEDGEMENT_ERROR_TOTAL: 'translation_queue_acknowledgement_error_total',
  LAST_SUCCESS_AT: 'translation_queue_last_success_at'
});

const COUNTER_NAMES = Object.freeze([
  TRANSLATION_EXECUTION_METRIC_NAMES.PROCESSED_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.SKIPPED_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.CANCELLED_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.RETRY_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.FAILED_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.DLQ_TRANSFER_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.RECOVERY_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.LEASE_ERROR_TOTAL,
  TRANSLATION_EXECUTION_METRIC_NAMES.ACKNOWLEDGEMENT_ERROR_TOTAL
]);

const GAUGE_NAMES = Object.freeze([
  TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH
]);

export function createTranslationExecutionMetrics({ clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== 'function') throw new TypeError('metrics clock must be a function.');

  const values = Object.fromEntries([
    ...COUNTER_NAMES.map((name) => [name, 0]),
    ...GAUGE_NAMES.map((name) => [name, 0]),
    [TRANSLATION_EXECUTION_METRIC_NAMES.LAST_SUCCESS_AT, null]
  ]);

  function increment(name, amount = 1) {
    assertCounterName(name);
    if (!Number.isInteger(amount) || amount < 0) throw new TypeError('metric increment amount must be a non-negative integer.');
    values[name] += amount;
  }

  function setGauge(name, value) {
    if (!GAUGE_NAMES.includes(name)) throw new TypeError(`Unknown metric gauge: ${name}`);
    if (!Number.isFinite(value) || value < 0) throw new TypeError('metric gauge value must be a non-negative number.');
    values[name] = value;
  }

  function markSuccess() {
    values[TRANSLATION_EXECUTION_METRIC_NAMES.LAST_SUCCESS_AT] = clock();
  }

  function snapshot() {
    return Object.freeze({
      metrics: Object.freeze({ ...values }),
      generatedAt: clock()
    });
  }

  function reset() {
    for (const name of [...COUNTER_NAMES, ...GAUGE_NAMES]) values[name] = 0;
    values[TRANSLATION_EXECUTION_METRIC_NAMES.LAST_SUCCESS_AT] = null;
  }

  return Object.freeze({ increment, setGauge, markSuccess, snapshot, reset });
}

export function createNoopTranslationExecutionMetrics() {
  return Object.freeze({
    increment() {},
    setGauge() {},
    markSuccess() {},
    snapshot: createTranslationExecutionMetrics().snapshot,
    reset() {}
  });
}

export function assertTranslationExecutionMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') throw new TypeError('translationExecutionMetrics is required.');
  for (const methodName of ['increment', 'setGauge', 'markSuccess', 'snapshot']) {
    if (typeof metrics[methodName] !== 'function') {
      throw new TypeError(`translationExecutionMetrics.${methodName} must be a function.`);
    }
  }
}

function assertCounterName(name) {
  if (!COUNTER_NAMES.includes(name)) throw new TypeError(`Unknown metric counter: ${name}`);
}
