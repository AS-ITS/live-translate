export const LATENCY_BUCKETS = Object.freeze([
  Object.freeze({ key: 'lt50', upperBoundMs: 50 }),
  Object.freeze({ key: 'lt100', upperBoundMs: 100 }),
  Object.freeze({ key: 'lt250', upperBoundMs: 250 }),
  Object.freeze({ key: 'lt500', upperBoundMs: 500 }),
  Object.freeze({ key: 'lt1000', upperBoundMs: 1000 }),
  Object.freeze({ key: 'lt3000', upperBoundMs: 3000 }),
  Object.freeze({ key: 'gte3000', upperBoundMs: 3000 })
]);

export function createLatencyHistogram() {
  return Object.fromEntries(LATENCY_BUCKETS.map(({ key }) => [key, 0]));
}

export function recordLatency(histogram, durationMs) {
  if (!histogram || !Number.isFinite(durationMs) || durationMs < 0) return;
  const bucket = LATENCY_BUCKETS.find(({ upperBoundMs, key }) => {
    if (key === 'gte3000') return durationMs >= upperBoundMs;
    return durationMs < upperBoundMs;
  });
  if (bucket) histogram[bucket.key] += 1;
}

export function percentileFromLatencyHistogram(histogram, percentile = 0.95) {
  const total = LATENCY_BUCKETS.reduce((sum, { key }) => sum + (histogram?.[key] || 0), 0);
  if (total < 1) return 0;
  const target = Math.max(1, Math.ceil(total * percentile));
  let cumulative = 0;
  for (const { key, upperBoundMs } of LATENCY_BUCKETS) {
    cumulative += histogram?.[key] || 0;
    if (cumulative >= target) return upperBoundMs;
  }
  return LATENCY_BUCKETS.at(-1).upperBoundMs;
}
