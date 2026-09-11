export const VIEWER_TELEMETRY_EVENTS = Object.freeze(new Set([
  'reconnect', 'event_gap', 'event_duplicate', 'replay_success', 'replay_failure'
]));

export function validateViewerTelemetry(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('telemetry body must be an object.');
  if (!VIEWER_TELEMETRY_EVENTS.has(body.eventType)) throw new TypeError('telemetry event type is not allowed.');
  const count = body.count === undefined ? 1 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new TypeError('telemetry count must be between 1 and 100.');
  const timestampBucket = body.timestampBucket === undefined ? undefined : String(body.timestampBucket);
  if (timestampBucket !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(timestampBucket)) throw new TypeError('telemetry timestamp bucket is invalid.');
  return Object.freeze({ eventType: body.eventType, count, ...(timestampBucket ? { timestampBucket } : {}) });
}
