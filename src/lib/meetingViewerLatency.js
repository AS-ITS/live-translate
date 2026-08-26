export function viewerLatencySample(event, { receivedAt = null, renderedAt = null } = {}) {
  const producedAt = Number(event?.timing?.producedAt);
  const publishedAt = Number(event?.timing?.publishedAt);
  const received = Number(receivedAt ?? event?.timing?.receivedAt);
  const rendered = Number(renderedAt ?? event?.timing?.renderedAt);
  if (![producedAt, publishedAt, received, rendered].every(Number.isFinite)) return null;
  return {
    cueId: event?.cue?.cueId || null,
    producedAt,
    publishedAt,
    receivedAt: received,
    renderedAt: rendered,
    publishLatencyMs: Math.max(0, publishedAt - producedAt),
    viewerLatencyMs: Math.max(0, rendered - producedAt)
  };
}

export function summarizeViewerLatency(samples = []) {
  const values = samples.map((sample) => Number(sample?.viewerLatencyMs)).filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) return { count: 0, p95Ms: null, maxMs: null };
  return {
    count: values.length,
    p95Ms: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)],
    maxMs: values.at(-1)
  };
}
