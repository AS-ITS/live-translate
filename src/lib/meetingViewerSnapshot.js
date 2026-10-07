const SNAPSHOT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 10_000]);

export async function fetchMeetingViewerSnapshotWithRetry({
  url,
  fetchImpl = globalThis.fetch,
  signal,
  wait = defaultWait,
  random = Math.random,
  onRetry,
} = {}) {
  if (!url || typeof fetchImpl !== 'function') throw new TypeError('Viewer snapshot URL and fetch implementation are required.');
  let lastError = null;
  for (let attempt = 0; attempt <= SNAPSHOT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await fetchImpl(url, signal ? { signal } : undefined);
      const body = await response.json().catch(() => null);
      if (response.ok) return body || {};
      throw classifySnapshotError(response.status, body);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError();
      if (isTerminalViewerError(error)) throw error;
      lastError = error;
    }
    if (attempt >= SNAPSHOT_RETRY_DELAYS_MS.length) break;
    const delay = jitter(SNAPSHOT_RETRY_DELAYS_MS[attempt], random);
    onRetry?.({ attempt: attempt + 1, delay, error: lastError });
    await wait(delay, signal);
  }
  const exhausted = new Error('多次重新連線後仍無法取得字幕。');
  exhausted.code = 'viewer_retry_exhausted';
  exhausted.cause = lastError;
  throw exhausted;
}

export function isTerminalViewerError(error) {
  return ['meeting_stopped', 'meeting_revoked', 'share_unauthorized'].includes(error?.code);
}

function classifySnapshotError(status, body) {
  const responseCode = body?.error?.code || body?.code;
  const stopped = responseCode === 'meeting_stopped' || responseCode === 'meeting_revoked' || status === 410;
  const unauthorized = responseCode === 'share_unauthorized' || status === 403 || status === 404;
  const error = new Error(stopped ? '會議已停止。' : (unauthorized ? '分享已失效。' : '字幕服務暫時無法使用。'));
  error.code = stopped ? (responseCode === 'meeting_revoked' ? 'meeting_revoked' : 'meeting_stopped')
    : (unauthorized ? 'share_unauthorized' : 'viewer_unavailable');
  error.status = status;
  return error;
}

function jitter(delay, random) {
  const sample = Math.min(1, Math.max(0, Number(random?.()) || 0));
  return Math.round(delay * (0.75 + sample * 0.5));
}

function defaultWait(delay, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError() {
  const error = new Error('Viewer snapshot request was cancelled.');
  error.name = 'AbortError';
  return error;
}
