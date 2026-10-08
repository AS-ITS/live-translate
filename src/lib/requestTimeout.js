export async function fetchWithTimeout(fetchImpl, url, options = {}, {
  timeoutMs,
  operation = 'request',
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  AbortControllerImpl = globalThis.AbortController
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortControllerImpl !== 'function') {
    return fetchImpl(url, options);
  }

  const controller = new AbortControllerImpl();
  const timeout = setTimeoutFn(() => controller.abort(), Math.floor(timeoutMs));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (!controller.signal.aborted) throw cause;
    const error = new Error(`${operation} timed out after ${Math.floor(timeoutMs)} ms.`);
    error.name = 'RequestTimeoutError';
    error.code = 'request_timeout';
    error.status = 504;
    error.operation = operation;
    error.outcomeUnknown = String(options?.method || 'GET').toUpperCase() !== 'GET';
    error.cause = cause;
    throw error;
  } finally {
    clearTimeoutFn(timeout);
  }
}
