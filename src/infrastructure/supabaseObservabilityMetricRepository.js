import { createSupabaseRestClient } from './supabaseRestClient.js';
import { minuteBucket, normalizeMetricLabels } from '../application/observability/observabilityMetricRegistry.js';

export function createSupabaseObservabilityMetricRepository({ env = process.env, fetchImpl = globalThis.fetch, clock = () => new Date(), instanceId = env.OBSERVABILITY_INSTANCE_ID || `instance-${process.pid}` } = {}) {
  const client = createSupabaseRestClient({ env, fetchImpl });
  if (!client) return null;
  async function recordCounter(metricName, labels = {}, amount = 1, at = clock()) {
    return record(metricName, labels, { count: amount }, at);
  }
  async function recordLatency(metricName, value, labels = {}, at = clock()) {
    return record(metricName, labels, { count: 1, sumValue: value, maxValue: value }, at);
  }
  async function setGauge(metricName, value, labels = {}, at = clock()) {
    return record(metricName, labels, { gaugeValue: value }, at);
  }
  async function record(metricName, labels, values, at) {
    const normalized = normalizeMetricLabels(labels);
    return client.rpc('record_observability_metric', {
      p_bucket_start: minuteBucket(at), p_instance_id: instanceId, p_metric_name: metricName,
      p_operation: normalized.operation,
      p_provider: normalized.provider,
      p_status_class: normalized.statusClass, p_count: values.count || 0,
      p_sum_value: values.sumValue || 0, p_max_value: values.maxValue || 0,
      p_gauge_value: values.gaugeValue ?? null
    });
  }
  return Object.freeze({ recordCounter, recordLatency, setGauge,
    flush: async (records = []) => Promise.all(records.map((item) => record(item.metricName, item, {
      count: item.count || 0,
      sumValue: item.sumValue || 0,
      maxValue: item.maxValue || 0,
      gaugeValue: item.gaugeValue ?? null
    }, item.bucketStart))),
    cleanupExpired: () => client.rpc('cleanup_observability_metric_buckets') });
}
