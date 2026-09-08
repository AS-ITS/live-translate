import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { buildSmokeSummary, createReconnectPolicy, createTranscriptObserver, formatSmokeDuration, parseGoAwayDelay, pcmChunks, providerDiagnostic, reconnectDelay, readPcmWav, tokenRefreshDue, transcriptEventKey } from '../../scripts/live-smoke-support.js';

test('smoke summary reports timestamps, duration, counters, and safe failures', () => {
  const summary = buildSmokeSummary({
    status: 'failed',
    startedAt: '2026-09-03T00:00:00.000Z',
    endedAt: '2026-09-03T01:02:03.000Z',
    metrics: { providerConnections: 21, providerReconnects: 20, tokenRequests: 21, goAwayReconnectSuccesses: 20, goAwayReconnectFailures: 0, lastGoAwayTimeLeft: '50s', finalTranscriptEvents: 0 },
    goAwayEvents: 20,
    abnormalEvents: [{ type: 'token_limit', message: 'Token request limit exceeded: 21 > 20.' }],
    terminalError: new Error('Token request limit exceeded: 21 > 20.')
  });
  assert.equal(summary.durationMs, 3723000);
  assert.equal(summary.providerReconnects, 20);
  assert.equal(summary.goAwayEvents, 20);
  assert.equal(summary.goAwayReconnectSuccesses, 20);
  assert.equal(summary.goAwayReconnectFailures, 0);
  assert.equal(summary.lastGoAwayTimeLeft, '50s');
  assert.equal(summary.abnormalEvents.length, 1);
  assert.equal(summary.terminalError, 'Token request limit exceeded: 21 > 20.');
  assert.equal(formatSmokeDuration(summary.durationMs), '1 小時 2 分 03 秒');
  assert.doesNotMatch(JSON.stringify(summary), /secret|AIza|Authorization: Bearer/);
});

test('provider diagnostics retain safe close/error context without credentials', () => {
  const diagnostic = providerDiagnostic('close', { status: 429, code: 'quota', message: 'Authorization: Bearer secret token https://example.test/live?key=secret' });
  assert.deepEqual(diagnostic, {
    category: 'provider_error', event: 'close', status: 429, code: 'quota',
    message: 'Authorization=[redacted] [redacted] token [redacted-url]', retryable: true,
    resumptionHandlePresent: false
  });
});

test('reconnect delay uses exponential backoff, jitter, and a hard cap', () => {
  assert.equal(reconnectDelay(1, { random: () => 0 }), 1000);
  assert.equal(reconnectDelay(2, { random: () => 0 }), 2000);
  assert.equal(reconnectDelay(3, { random: () => 0 }), 4000);
  assert.equal(reconnectDelay(99, { random: () => 1 }), 30000);
});

test('reconnect policy stops after five failures and resets on success', () => {
  const policy = createReconnectPolicy({ random: () => 0 });
  for (let attempt = 1; attempt < 5; attempt += 1) assert.equal(policy.recordFailure({ category: 'provider_error' }).fatal, false);
  assert.equal(policy.recordFailure({ category: 'provider_error' }).fatal, true);
  assert.equal(policy.consecutiveFailures, 5);
  policy.recordSuccess();
  assert.equal(policy.consecutiveFailures, 0);
});

test('tokenRefreshDue enters the five-minute safety window', () => {
  const now = Date.parse('2026-09-02T00:00:00.000Z');
  assert.equal(tokenRefreshDue('2026-09-02T00:04:59.000Z', now), true);
  assert.equal(tokenRefreshDue('2026-09-02T00:05:01.000Z', now), false);
});

test('parseGoAwayDelay supports duration units and caps the delay', () => {
  assert.equal(parseGoAwayDelay('2s'), 2000);
  assert.equal(parseGoAwayDelay('1m'), 30000);
  assert.equal(parseGoAwayDelay('invalid'), 0);
});

test('transcriptEventKey prefers provider event identity', () => {
  assert.equal(transcriptEventKey({ eventId: 'event-1' }, 4), 'event-1');
  assert.equal(transcriptEventKey({}, 4), 'message:4');
});

test('transcript observer treats provider input transcription as authoritative final text', () => {
  const observer = createTranscriptObserver();

  assert.deepEqual(observer.observe({ eventId: 'source-1', serverContent: { inputTranscription: { text: 'hello' } } }), [
    { duplicate: false, key: 'source-1', eventId: 'source-1', text: 'hello', isLateTranscript: false }
  ]);
});

test('transcript observer finalizes an interim source after a later boundary', () => {
  const observer = createTranscriptObserver();

  assert.deepEqual(observer.observe({ eventId: 'source-1', serverContent: { interimInputTranscription: { text: 'late hello' } } }), []);
  assert.deepEqual(observer.observe({ eventId: 'boundary-1', serverContent: { turnComplete: true } }), [
    { duplicate: false, key: 'source-1', eventId: 'source-1', text: 'late hello', isLateTranscript: false }
  ]);
});

test('transcript observer handles GoAway plus source transcript without dropping content', () => {
  const observer = createTranscriptObserver();

  assert.deepEqual(observer.observe({ goAway: { timeLeft: '50s' }, eventId: 'source-1', serverContent: {
    inputTranscription: { text: 'during reconnect preparation' }
  } })[0].text, 'during reconnect preparation');
});

test('transcript observer deduplicates repeated finalized provider events', () => {
  const observer = createTranscriptObserver();
  const message = { eventId: 'source-1', serverContent: { inputTranscription: { text: 'repeat' }, turnComplete: true } };

  assert.equal(observer.observe(message).length, 1);
  assert.deepEqual(observer.observe(message), [{ duplicate: true, key: 'source-1' }]);
});

test('readPcmWav validates generated mono 16kHz PCM and chunks it', () => {
  const pcm = Buffer.alloc(6400);
  assert.equal(readPcmWav(makeWav(pcm)).length, pcm.length);
  assert.deepEqual(pcmChunks(pcm, { chunkMs: 100 }).map((chunk) => chunk.length), [3200, 3200]);
});

function makeWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
