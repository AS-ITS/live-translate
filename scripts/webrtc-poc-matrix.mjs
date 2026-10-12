#!/usr/bin/env node

// Local-only protocol fanout evidence. This intentionally does not create an
// RTCPeerConnection, open a socket, or call a model/API.

const VIEWER_STAGES = [10, 50, 100];
const EVENTS_PER_VIEWER = 120;
const EVENT_TYPES = ['cue.append', 'snapshot', 'cue.update', 'replay.request', 'replay.response'];
const DROP_EVERY = 0;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function syntheticLatencyMs(viewerCount, eventIndex, viewerIndex) {
  // A stable queueing model, not a network measurement. It makes stage
  // comparisons reproducible while exercising the same fanout shape.
  return Number((0.35 + viewerCount * 0.006 + (eventIndex % 11) * 0.017 + (viewerIndex % 7) * 0.003).toFixed(3));
}

function runStage(viewerCount) {
  const latencies = [];
  let delivered = 0;
  let dropped = 0;
  let gapCount = 0;
  let lastSequence = 0;
  const started = process.hrtime.bigint();

  for (let eventIndex = 0; eventIndex < EVENTS_PER_VIEWER; eventIndex += 1) {
    const type = EVENT_TYPES[eventIndex % EVENT_TYPES.length];
    const sequence = eventIndex + 1;
    const envelope = {
      protocol: 'subtitle-webrtc/v1',
      type,
      meetingId: 'local-synthetic-meeting',
      sequence,
      payload: { cueId: `cue-${sequence}`, text: `synthetic-${type}-${sequence}` },
    };

    for (let viewerIndex = 0; viewerIndex < viewerCount; viewerIndex += 1) {
      // JSON round-trip is the process-time proxy for encode/decode and fanout.
      const encoded = JSON.stringify(envelope);
      const decoded = JSON.parse(encoded);
      if (decoded.sequence !== sequence) throw new Error('synthetic protocol sequence mismatch');
      const isDrop = DROP_EVERY > 0 && (sequence + viewerIndex) % DROP_EVERY === 0;
      if (isDrop) {
        dropped += 1;
        gapCount += 1;
        continue;
      }
      delivered += 1;
      latencies.push(syntheticLatencyMs(viewerCount, eventIndex, viewerIndex));
    }
    if (sequence !== lastSequence + 1) gapCount += 1;
    lastSequence = sequence;
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    environment: 'local-synthetic',
    viewers: viewerCount,
    eventsPerViewer: EVENTS_PER_VIEWER,
    delivered,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    publisherProcessTimeMs: Number(elapsedMs.toFixed(3)),
    deviceProcessTimeProxyMs: Number((elapsedMs / Math.max(1, viewerCount)).toFixed(3)),
    simulatedRecordingGapCount: gapCount,
    simulatedDropCount: dropped,
    note: 'synthetic fanout only; no real WebRTC, network, browser, or model API',
  };
}

const results = VIEWER_STAGES.map(runStage);
for (const result of results) console.log(JSON.stringify(result));

console.log('\n| environment | viewers | latency p50/p95 ms | publisher process ms | device proxy ms | recording gaps | drops |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const result of results) {
  console.log(`| ${result.environment} | ${result.viewers} | ${result.latencyMs.p50}/${result.latencyMs.p95} | ${result.publisherProcessTimeMs} | ${result.deviceProcessTimeProxyMs} | ${result.simulatedRecordingGapCount} | ${result.simulatedDropCount} |`);
}
