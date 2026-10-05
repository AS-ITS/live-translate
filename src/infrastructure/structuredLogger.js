const SECRET_KEY = /(api[_-]?key|jwt|token|authorization|transcript|audio|prompt|response|payload|sessionid|executionid|signed|share|url)/i;
const SAFE_PROVIDER_DIAGNOSTIC_FIELDS = new Set([
  'level', 'event', 'requestId', 'stage', 'deployment', 'hasSupabaseAccessToken',
  'hasGeminiApiKey', 'geminiApiKeyLength', 'model', 'apiVersion', 'status', 'code',
  'category', 'tokenCreated'
]);

export function redactLogValue(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactLogValue(item, name)]));
  if (typeof value === 'string' && value.length > 512) return `${value.slice(0, 509)}...`;
  return value;
}

export function createStructuredLogger({ service = 'live-translate', instanceId = process.env.OBSERVABILITY_INSTANCE_ID || `instance-${process.pid}`, write = console.log, clock = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    log(event = {}) {
      const safe = event.event === 'gemini_token_provider_failure'
        ? Object.fromEntries(Object.entries(event).filter(([key]) => SAFE_PROVIDER_DIAGNOSTIC_FIELDS.has(key)))
        : redactLogValue(event);
      write(JSON.stringify({ timestamp: clock(), level: 'info', service, instanceId, requestId: null, durationMs: null, statusClass: null, safeSummary: null, ...safe }));
    }
  });
}
