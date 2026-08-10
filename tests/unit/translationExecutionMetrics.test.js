import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTranslationExecutionMetrics,
  TRANSLATION_EXECUTION_METRIC_NAMES
} from '../../src/application/translation/translationExecutionMetrics.js';

test('metrics snapshot contains stable queue counters, gauge, and timestamp', () => {
  const metrics = createTranslationExecutionMetrics({ clock: () => '2026-08-10T00:00:00.000Z' });

  metrics.increment(TRANSLATION_EXECUTION_METRIC_NAMES.PROCESSED_TOTAL, 2);
  metrics.setGauge(TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, 3);
  metrics.markSuccess();

  assert.deepEqual(metrics.snapshot(), {
    metrics: {
      translation_queue_processed_total: 2,
      translation_queue_skipped_total: 0,
      translation_queue_cancelled_total: 0,
      translation_queue_retry_total: 0,
      translation_queue_failed_total: 0,
      translation_queue_dlq_transfer_total: 0,
      translation_queue_recovery_total: 0,
      translation_queue_lease_error_total: 0,
      translation_queue_acknowledgement_error_total: 0,
      translation_queue_depth: 3,
      translation_queue_last_success_at: '2026-08-10T00:00:00.000Z'
    },
    generatedAt: '2026-08-10T00:00:00.000Z'
  });
});

test('metrics validate names and keep snapshots immutable', () => {
  const metrics = createTranslationExecutionMetrics();
  const snapshot = metrics.snapshot();

  assert.throws(() => metrics.increment('unknown_metric'), TypeError);
  assert.throws(() => metrics.setGauge(TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, -1), TypeError);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.metrics), true);
});

test('reset clears process-local metrics', () => {
  const metrics = createTranslationExecutionMetrics();
  metrics.increment(TRANSLATION_EXECUTION_METRIC_NAMES.FAILED_TOTAL);
  metrics.setGauge(TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, 4);
  metrics.reset();

  assert.equal(metrics.snapshot().metrics.translation_queue_failed_total, 0);
  assert.equal(metrics.snapshot().metrics.translation_queue_depth, 0);
  assert.equal(metrics.snapshot().metrics.translation_queue_last_success_at, null);
});
