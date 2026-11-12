const MIB = 1048576;
const WINDOW_BOUNDARY_TOLERANCE_MS = 1_000;
const measured = (value) => typeof value === 'number' && Number.isFinite(value);

export const PROVISIONAL_RAM_THRESHOLDS = Object.freeze({
  status: 'PROVISIONAL',
  rssPeakMiB: 768,
  jsHeapPeakMiB: 384,
  lastThirtyMinuteRssSlopeMiBPerMinute: 0.5,
  lastThirtyMinuteHeapSlopeMiBPerMinute: 0.25,
  rssResidualAboveBaselineMiB: 128,
  heapResidualAboveBaselineMiB: 64
});

function regressionSlope(rows, key) {
  const points = rows.filter((row) => measured(row[key]));
  if (points.length < 55) return 'NOT_MEASURED';
  const xs = points.map((row) => row.elapsedMs / 60_000);
  const ys = points.map((row) => row[key] / MIB);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const denominator = xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  return denominator > 0
    ? xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0) / denominator
    : 'NOT_MEASURED';
}

export function analyzeRamGate(rows, barrierCompletedAt, { minimumCaptureMs = 40 * 60_000 } = {}) {
  const capture = rows.filter((row) => row.phase === 'capture' && measured(row.elapsedMs)
    && ('rendererPid' in row || 'rendererAlive' in row || 'chromiumRssBytes' in row || 'jsHeapBytes' in row));
  const captureEnd = capture.at(-1)?.elapsedMs ?? null;
  const expectedPid = capture.at(-1)?.rendererPid ?? null;
  const stablePid = expectedPid !== null && capture.every((row) => row.rendererPid === expectedPid && row.rendererAlive === true);
  const baseline = capture.find((row) => row.elapsedMs <= 60_000 && row.rendererPid === expectedPid) ?? null;
  const lastThirtyMinutes = captureEnd === null ? [] : capture.filter((row) => row.elapsedMs >= captureEnd - 1_800_000 - WINDOW_BOUNDARY_TOLERANCE_MS);
  const windowSpanMs = lastThirtyMinutes.length > 1
    ? lastThirtyMinutes.at(-1).elapsedMs - lastThirtyMinutes[0].elapsedMs : 0;
  const largestGapMs = lastThirtyMinutes.reduce((largest, row, index) => index
    ? Math.max(largest, row.elapsedMs - lastThirtyMinutes[index - 1].elapsedMs) : largest, 0);
  const completeWindow = lastThirtyMinutes.length >= 55 && windowSpanMs >= 1_770_000 && largestGapMs <= 90_000;
  const slopes = {
    chromiumRss: completeWindow && stablePid ? regressionSlope(lastThirtyMinutes, 'chromiumRssBytes') : 'NOT_MEASURED',
    jsHeap: completeWindow && stablePid ? regressionSlope(lastThirtyMinutes, 'jsHeapBytes') : 'NOT_MEASURED'
  };
  const peak = {
    chromiumRssBytes: Math.max(0, ...capture.filter((row) => measured(row.chromiumRssBytes)).map((row) => row.chromiumRssBytes)),
    jsHeapBytes: Math.max(0, ...capture.filter((row) => measured(row.jsHeapBytes)).map((row) => row.jsHeapBytes))
  };
  for (const key of Object.keys(peak)) if (peak[key] === 0) peak[key] = 'NOT_MEASURED';
  const postStop = rows.filter((row) => row.phase === 'post_stop').map((row) => {
    const comparable = expectedPid !== null && row.rendererPid === expectedPid && row.rendererAlive === true;
    const fields = {};
    for (const key of Object.keys(peak)) {
      const residual = comparable && measured(row[key]) ? row[key] : 'NOT_COMPARABLE';
      fields[key] = {
        residualBytes: residual,
        recoveredBytes: measured(peak[key]) && measured(residual) ? peak[key] - residual : 'NOT_COMPARABLE',
        recoveredFraction: measured(peak[key]) && measured(residual) && peak[key] > 0
          ? (peak[key] - residual) / peak[key] : 'NOT_COMPARABLE'
      };
    }
    return { at: row.at, secondsAfterBarrier: row.secondsAfterBarrier,
      rendererPid: row.rendererPid ?? null, rendererAlive: row.rendererAlive === true,
      comparable, ...fields };
  });
  const sixty = postStop.find((row) => row.secondsAfterBarrier === 60) ?? null;
  const sixtyElapsedMs = sixty && barrierCompletedAt ? Date.parse(sixty.at) - Date.parse(barrierCompletedAt) : NaN;
  const validSixty = sixty?.comparable && measured(sixtyElapsedMs) && sixtyElapsedMs >= 59_000;
  const limits = {
    rssPeakMiB: [measured(peak.chromiumRssBytes) ? peak.chromiumRssBytes / MIB : null, PROVISIONAL_RAM_THRESHOLDS.rssPeakMiB],
    jsHeapPeakMiB: [measured(peak.jsHeapBytes) ? peak.jsHeapBytes / MIB : null, PROVISIONAL_RAM_THRESHOLDS.jsHeapPeakMiB],
    rssSlopeMiBPerMinute: [slopes.chromiumRss, PROVISIONAL_RAM_THRESHOLDS.lastThirtyMinuteRssSlopeMiBPerMinute],
    heapSlopeMiBPerMinute: [slopes.jsHeap, PROVISIONAL_RAM_THRESHOLDS.lastThirtyMinuteHeapSlopeMiBPerMinute],
    rssResidualMiB: [validSixty && measured(baseline?.chromiumRssBytes) && measured(sixty.chromiumRssBytes.residualBytes)
      ? sixty.chromiumRssBytes.residualBytes / MIB : null,
    measured(baseline?.chromiumRssBytes) ? baseline.chromiumRssBytes / MIB + PROVISIONAL_RAM_THRESHOLDS.rssResidualAboveBaselineMiB : null],
    heapResidualMiB: [validSixty && measured(baseline?.jsHeapBytes) && measured(sixty.jsHeapBytes.residualBytes)
      ? sixty.jsHeapBytes.residualBytes / MIB : null,
    measured(baseline?.jsHeapBytes) ? baseline.jsHeapBytes / MIB + PROVISIONAL_RAM_THRESHOLDS.heapResidualAboveBaselineMiB : null]
  };
  const checks = Object.fromEntries(Object.entries(limits).map(([name, [value, limit]]) => [name, {
    value: measured(value) ? value : 'NOT_MEASURED', limit: measured(limit) ? limit : 'NOT_MEASURED',
    result: measured(value) && measured(limit) ? (value <= limit ? 'PASS' : 'FAIL') : 'UNDETERMINED'
  }]));
  const anyFailure = Object.values(checks).some((check) => check.result === 'FAIL');
  const complete = captureEnd >= minimumCaptureMs && stablePid && completeWindow && validSixty
    && Object.values(checks).every((check) => check.result === 'PASS');
  return {
    verdict: anyFailure ? 'FAIL' : complete ? 'PASS' : 'UNDETERMINED',
    thresholds: PROVISIONAL_RAM_THRESHOLDS,
    method: 'ordinary_least_squares_last_30_minutes_mib_per_minute',
    windowBoundaryToleranceMs: WINDOW_BOUNDARY_TOLERANCE_MS,
    minimumCaptureMs, captureElapsedMs: captureEnd, stableRendererPid: stablePid,
    rendererPidBeforeStop: expectedPid,
    baseline: baseline ? { at: baseline.at, elapsedMs: baseline.elapsedMs, rendererPid: baseline.rendererPid,
      chromiumRssBytes: baseline.chromiumRssBytes, jsHeapBytes: baseline.jsHeapBytes } : 'NOT_MEASURED',
    preStopPeakBytes: peak, lastThirtyMinuteWindow: {
      samples: lastThirtyMinutes.length, spanMs: windowSpanMs, largestGapMs, complete: completeWindow
    },
    lastThirtyMinuteSlopeMiBPerMinute: slopes, checks, barrierCompletedAt: barrierCompletedAt ?? null,
    postStopSamples: postStop,
    missingPostStopSeconds: [0, 30, 60].filter((second) => !postStop.some((row) => row.secondsAfterBarrier === second))
  };
}

export function analyzeExportRam(rows, { phase = 'export' } = {}) {
  const samples = rows.filter((row) => row.phase === phase);
  const start = samples.find((row) => row.marker === 'start') ?? null;
  const complete = samples.find((row) => row.marker === 'complete') ?? null;
  const residual = samples.find((row) => row.marker === 'residual_60s') ?? null;
  const stageSamples = start && complete ? rows.filter((row) => row.phase === 'ram2_stage'
    && row.sampledAt >= start.at && row.sampledAt <= complete.at) : [];
  const activeSamples = [...samples.filter((row) => row.marker !== 'residual_60s'), ...stageSamples];
  const pid = start?.rendererPid ?? null;
  const comparable = pid !== null && samples.length > 0
    && samples.every((row) => row.rendererPid === pid && row.rendererAlive === true)
    && stageSamples.every((row) => row.rendererPid === pid);
  const peak = (key) => comparable && activeSamples.some((row) => measured(row[key]))
    ? Math.max(...activeSamples.filter((row) => measured(row[key])).map((row) => row[key])) : 'NOT_COMPARABLE';
  return {
    verdict: 'UNDETERMINED', thresholds: 'NOT_SET',
    rendererPid: pid, comparable, samples: samples.length, stageSamples: stageSamples.length,
    durationMs: start && complete ? Date.parse(complete.at) - Date.parse(start.at) : 'NOT_MEASURED',
    peakBytes: { chromiumRssBytes: peak('chromiumRssBytes'), jsHeapBytes: peak('jsHeapBytes') },
    residualAfter60sBytes: comparable && residual
      ? { chromiumRssBytes: residual.chromiumRssBytes, jsHeapBytes: residual.jsHeapBytes }
      : 'NOT_COMPARABLE'
  };
}
