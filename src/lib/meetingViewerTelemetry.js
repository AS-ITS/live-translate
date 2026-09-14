export function createMeetingViewerTelemetry({ basePath, fetchImpl = globalThis.fetch } = {}) {
  if (!basePath || typeof fetchImpl !== 'function') throw new TypeError('Viewer telemetry requires basePath and fetch.');
  return Object.freeze({
    report(eventType, count = 1) {
      return Promise.resolve(fetchImpl(`${basePath}/events/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, count })
      })).catch(() => undefined);
    }
  });
}
