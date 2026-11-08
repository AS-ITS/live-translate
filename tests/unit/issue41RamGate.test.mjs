import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeExportRam, analyzeRamGate, PROVISIONAL_RAM_THRESHOLDS } from '../../scripts/issue41-ram-gate.mjs';

const MIB = 1048576;
const barrier = '2026-11-02T01:00:00.000Z';
const capture = () => Array.from({ length: 81 }, (_, index) => ({
  at: new Date(Date.parse(barrier) - 2_400_000 + index * 30_000).toISOString(),
  phase: 'capture', elapsedMs: index * 30_000, rendererPid: 42, rendererAlive: true,
  chromiumRssBytes: 300 * MIB, jsHeapBytes: 60 * MIB
}));
const residual = () => [0, 30, 60].map((seconds) => ({
  at: new Date(Date.parse(barrier) + seconds * 1000).toISOString(),
  phase: 'post_stop', secondsAfterBarrier: seconds, rendererPid: 42, rendererAlive: true,
  chromiumRssBytes: 290 * MIB, jsHeapBytes: 55 * MIB
}));

test('complete 40-minute same-PID series passes every provisional RAM check', () => {
  const result = analyzeRamGate([...capture(), ...residual()], barrier);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.thresholds.status, 'PROVISIONAL');
  assert.equal(result.thresholds.rssPeakMiB, PROVISIONAL_RAM_THRESHOLDS.rssPeakMiB);
  assert.equal(result.lastThirtyMinuteWindow.complete, true);
  assert.equal(result.lastThirtyMinuteSlopeMiBPerMinute.chromiumRss, 0);
  assert.equal(result.postStopSamples[2].chromiumRssBytes.recoveredBytes, 10 * MIB);
  assert.deepEqual(result.missingPostStopSeconds, []);
  assert.ok(Object.values(result.checks).every((check) => check.result === 'PASS'));
});

test('full OPFS/IndexedDB scans do not count as renderer or memory samples', () => {
  const scans = [300_000, 600_000, 900_000].map((elapsedMs) => ({
    phase: 'capture', elapsedMs, opfs: { files: 1 }, stores: { operations: 1 }
  }));
  const result = analyzeRamGate([...capture(), ...scans, ...residual()], barrier);
  assert.equal(result.stableRendererPid, true);
  assert.equal(result.lastThirtyMinuteWindow.samples, 61);
  assert.equal(result.verdict, 'PASS');
});

test('full scans cannot replace missing memory samples or hide a real PID change', () => {
  const rows = capture();
  const last = rows.pop();
  const scan = { phase: 'capture', elapsedMs: last.elapsedMs, opfs: { files: 1 } };
  const missing = analyzeRamGate([...rows, scan, ...residual()], barrier);
  assert.equal(missing.captureElapsedMs, 2_370_000);
  assert.equal(missing.verdict, 'UNDETERMINED');

  rows[40].rendererPid = 43;
  const changed = analyzeRamGate([...rows, scan, ...residual()], barrier);
  assert.equal(changed.stableRendererPid, false);
  assert.equal(changed.verdict, 'UNDETERMINED');
});

test('last 30-minute ordinary least squares slope fails above the limit', () => {
  const rows = capture().map((row, index) => ({
    ...row, chromiumRssBytes: (300 + index * 0.5) * MIB,
    jsHeapBytes: (60 + index * 0.15) * MIB
  }));
  const result = analyzeRamGate([...rows, ...residual()], barrier);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.lastThirtyMinuteSlopeMiBPerMinute.chromiumRss, 1);
  assert.equal(result.checks.rssSlopeMiBPerMinute.result, 'FAIL');
  assert.equal(result.checks.heapSlopeMiBPerMinute.result, 'FAIL');
});

test('a sample two milliseconds before the 30-minute boundary is included', () => {
  const rows = capture();
  rows[20].elapsedMs -= 2;
  const result = analyzeRamGate([...rows, ...residual()], barrier);
  assert.equal(result.windowBoundaryToleranceMs, 1_000);
  assert.equal(result.lastThirtyMinuteWindow.samples, 61);
  assert.equal(result.lastThirtyMinuteWindow.spanMs, 1_800_002);
  assert.equal(result.verdict, 'PASS');
});

test('boundary tolerance cannot replace a missing window or changed renderer', () => {
  const missing = capture();
  missing.splice(20, 2);
  const noWindow = analyzeRamGate([...missing, ...residual()], barrier);
  assert.equal(noWindow.lastThirtyMinuteWindow.complete, false);
  assert.equal(noWindow.verdict, 'UNDETERMINED');
  const switched = capture();
  switched[20].elapsedMs -= 2;
  switched[20].rendererPid = 43;
  assert.equal(analyzeRamGate([...switched, ...residual()], barrier).verdict, 'UNDETERMINED');
});

test('different renderer PID, missing residual, and short capture stay undetermined', () => {
  const switched = capture();
  switched[40].rendererPid = 43;
  assert.equal(analyzeRamGate([...switched, ...residual()], barrier).verdict, 'UNDETERMINED');
  const missing = residual().slice(0, 2);
  const noSixty = analyzeRamGate([...capture(), ...missing], barrier);
  assert.equal(noSixty.verdict, 'UNDETERMINED');
  assert.deepEqual(noSixty.missingPostStopSeconds, [60]);
  assert.equal(analyzeRamGate([...capture().slice(0, 10), ...residual()], barrier).verdict, 'UNDETERMINED');
});

test('any measured peak or residual violation fails even when another sample is missing', () => {
  const rows = capture();
  rows[20].chromiumRssBytes = 769 * MIB;
  const result = analyzeRamGate([...rows, ...residual().slice(0, 2)], barrier);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.checks.rssPeakMiB.result, 'FAIL');
});

test('old 40-minute evidence cannot pass without PID and post-Stop samples', () => {
  const rows = capture().map(({ rendererPid, rendererAlive, ...row }) => row);
  const result = analyzeRamGate(rows, barrier);
  assert.equal(result.verdict, 'UNDETERMINED');
  assert.equal(result.stableRendererPid, false);
  assert.deepEqual(result.missingPostStopSeconds, [0, 30, 60]);
});

test('export peak and residual stay separate from recording RAM checks', () => {
  const exportRows = [
    { phase: 'export', marker: 'start', at: '2026-11-02T01:02:00.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 300 * MIB, jsHeapBytes: 60 * MIB },
    { phase: 'ram2_stage', sampledAt: '2026-11-02T01:02:01.000Z', rendererPid: 42, chromiumRssBytes: 900 * MIB, jsHeapBytes: 400 * MIB },
    { phase: 'export', marker: 'complete', at: '2026-11-02T01:02:02.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 800 * MIB, jsHeapBytes: 350 * MIB },
    { phase: 'export', marker: 'residual_60s', at: '2026-11-02T01:03:02.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 950 * MIB, jsHeapBytes: 300 * MIB }
  ];
  assert.equal(analyzeRamGate([...capture(), ...residual(), ...exportRows], barrier).verdict, 'PASS');
  const exportRam = analyzeExportRam(exportRows);
  assert.equal(exportRam.verdict, 'UNDETERMINED');
  assert.equal(exportRam.thresholds, 'NOT_SET');
  assert.equal(exportRam.durationMs, 2_000);
  assert.equal(exportRam.peakBytes.chromiumRssBytes, 900 * MIB);
  assert.equal(exportRam.peakBytes.jsHeapBytes, 400 * MIB);
  assert.equal(exportRam.residualAfter60sBytes.chromiumRssBytes, 950 * MIB);
  const wavRows = [
    { phase: 'wav_validation', marker: 'start', at: '2026-11-02T01:04:00.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 950 * MIB },
    { phase: 'wav_validation', marker: 'complete', at: '2026-11-02T01:04:02.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 1200 * MIB },
    { phase: 'wav_validation', marker: 'residual_60s', at: '2026-11-02T01:05:02.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 1000 * MIB }
  ];
  assert.equal(analyzeExportRam([...exportRows, ...wavRows]).peakBytes.chromiumRssBytes, 900 * MIB);
  assert.equal(analyzeExportRam([...exportRows, ...wavRows], { phase: 'wav_validation' }).peakBytes.chromiumRssBytes, 1200 * MIB);
});

test('export PID change makes peak and residual incomparable', () => {
  const rows = [
    { phase: 'export', marker: 'start', at: '2026-11-02T01:02:00.000Z', rendererPid: 42, rendererAlive: true, chromiumRssBytes: 300 * MIB },
    { phase: 'export', marker: 'complete', at: '2026-11-02T01:02:02.000Z', rendererPid: 43, rendererAlive: true, chromiumRssBytes: 310 * MIB }
  ];
  assert.equal(analyzeExportRam(rows).comparable, false);
  assert.equal(analyzeExportRam(rows).peakBytes.chromiumRssBytes, 'NOT_COMPARABLE');
});
