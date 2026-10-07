export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  livePipelineTraceEnabled: false
});

export async function loadRuntimeConfig({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return DEFAULT_RUNTIME_CONFIG;
  try {
    const response = await fetchImpl('/api/runtime-config', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!response?.ok) return DEFAULT_RUNTIME_CONFIG;
    const payload = await response.json();
    return Object.freeze({
      livePipelineTraceEnabled: payload?.livePipelineTraceEnabled === true
    });
  } catch {
    return DEFAULT_RUNTIME_CONFIG;
  }
}
