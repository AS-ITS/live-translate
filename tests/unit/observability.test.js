import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservabilityMetricRegistry, minuteBucket, providerStatusClass } from '../../src/application/observability/observabilityMetricRegistry.js';
import { createObservedTranslationExecutionProvider } from '../../src/application/observability/observedTranslationExecutionProvider.js';
import { redactLogValue } from '../../src/infrastructure/structuredLogger.js';
import { validateViewerTelemetry } from '../../src/application/observability/telemetry.js';

test('observability registry aggregates counter and latency values', () => {
  const registry = createObservabilityMetricRegistry();
  registry.recordCounter('gemini_request_total', 3, { provider: 'gemini', operation: 'translation', statusClass: 'none' });
  registry.recordLatency('gemini_latency_ms', 12, { provider: 'gemini', operation: 'translation', statusClass: '200' });
  registry.recordLatency('gemini_latency_ms', 20, { provider: 'gemini', operation: 'translation', statusClass: '200' });
  assert.equal(registry.snapshot().find((item) => item.metricName === 'gemini_request_total').count, 3);
  assert.deepEqual(registry.snapshot().find((item) => item.metricName === 'gemini_latency_ms' && item.statusClass === '200'), { metricName: 'gemini_latency_ms', provider: 'gemini', operation: 'translation', statusClass: '200', count: 2, sumValue: 32, maxValue: 20, gaugeValue: 0, type: 'latency' });
});

test('observability validates buckets, provider statuses, telemetry and redacts secrets', () => {
  assert.equal(minuteBucket('2026-09-11T12:34:59Z'), '2026-09-11T12:34:00.000Z');
  assert.equal(providerStatusClass(503), '5xx');
  assert.deepEqual(validateViewerTelemetry({ eventType: 'event_gap', count: 2 }), { eventType: 'event_gap', count: 2 });
  assert.throws(() => validateViewerTelemetry({ eventType: 'unknown' }));
assert.deepEqual(redactLogValue({ apiKey: 'secret', meetingId: 'meeting-1', signedUrl: 'https://signed.example', audio: 'bytes', transcriptText: 'secret text', nested: { token: 'secret' } }), { apiKey: '[REDACTED]', meetingId: 'meeting-1', signedUrl: '[REDACTED]', audio: '[REDACTED]', transcriptText: '[REDACTED]', nested: { token: '[REDACTED]' } });
});

test('structured logs preserve non-sensitive auth stage diagnostics', () => {
  assert.deepEqual(redactLogValue({ authStage: 'private_resource', authorization: 'Bearer secret' }), {
    authStage: 'private_resource',
    authorization: '[REDACTED]'
  });
});

test('structured logs redact JWT and credential-shaped values by key', () => {
  assert.deepEqual(redactLogValue({
    jwt: 'header.payload.signature',
    apiKey: 'AIza-secret',
    shareToken: 'share-secret',
    signedUrl: 'https://storage.example/signed'
  }), {
    jwt: '[REDACTED]',
    apiKey: '[REDACTED]',
    shareToken: '[REDACTED]',
    signedUrl: '[REDACTED]'
  });
});

test('observed provider records safe success and failure metrics while preserving errors', async () => {
  const records = [];
  const metrics = { recordCounter: (...args) => records.push(['counter', ...args]), recordLatency: (...args) => records.push(['latency', ...args]) };
  const provider = createObservedTranslationExecutionProvider({ provider: { async execute() { const error = new Error('noisy'); error.status = 429; throw error; } }, observabilityMetrics: metrics, clock: (() => { let i = 0; return () => new Date(`2026-09-11T12:34:0${i++}.000Z`); })() });
  await assert.rejects(provider.execute({ operation: 'translation' }), /noisy/);
  assert.equal(records.find((item) => item[0] === 'counter' && item[1] === 'gemini_failure_total')[3].statusClass, '429');
});
