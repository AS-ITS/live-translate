import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeViewerLatency, viewerLatencySample } from '../../src/lib/meetingViewerLatency.js';

test('viewer latency sample separates publish and display latency', () => {
  const sample = viewerLatencySample({ cue: { cueId: 'cue-1' }, timing: { producedAt: 100, publishedAt: 110 } }, { receivedAt: 120, renderedAt: 180 });
  assert.deepEqual(sample, {
    cueId: 'cue-1', producedAt: 100, publishedAt: 110, receivedAt: 120, renderedAt: 180,
    publishLatencyMs: 10, viewerLatencyMs: 80
  });
});

test('viewer latency summary reports p95 and maximum deterministically', () => {
  const samples = [20, 40, 80, 120].map((viewerLatencyMs) => ({ viewerLatencyMs }));
  assert.deepEqual(summarizeViewerLatency(samples), { count: 4, p95Ms: 120, maxMs: 120 });
  assert.deepEqual(summarizeViewerLatency([]), { count: 0, p95Ms: null, maxMs: null });
});
