import { livePipelineTrace, recordLivePipelineTrace } from './livePipelineTrace.js';

const FILE_NAME_LIMIT = 64;

export async function exportClientDiagnostics({
  role,
  meetingId = null,
  navigatorImpl = globalThis.navigator,
  documentImpl = globalThis.document,
  URLImpl = globalThis.URL,
  BlobImpl = globalThis.Blob,
  FileImpl = globalThis.File,
  now = () => new Date(),
  setTimer = globalThis.setTimeout
} = {}) {
  if (!livePipelineTrace.isEnabled()) throw new Error('診斷模式尚未啟用。');

  const json = livePipelineTrace.exportJson();
  const filename = diagnosticFilename({ role, meetingId, now: now() });
  const fileOptions = { type: 'application/json;charset=utf-8' };
  const file = typeof FileImpl === 'function'
    ? new FileImpl([json], filename, fileOptions)
    : null;

  if (file && typeof navigatorImpl?.share === 'function') {
    let canShareFiles = false;
    try { canShareFiles = typeof navigatorImpl.canShare === 'function' && navigatorImpl.canShare({ files: [file] }); } catch { canShareFiles = false; }
    if (canShareFiles) {
      try {
        await navigatorImpl.share({ files: [file], title: 'Live Translate 診斷紀錄' });
        return Object.freeze({ method: 'share', filename });
      } catch (error) {
        if (error?.name === 'AbortError') return Object.freeze({ method: 'cancelled', filename });
        throw error;
      }
    }
  }

  if (typeof BlobImpl !== 'function' || typeof URLImpl?.createObjectURL !== 'function' || !documentImpl?.createElement) {
    throw new Error('此瀏覽器無法建立診斷紀錄檔。');
  }
  const blob = new BlobImpl([json], fileOptions);
  const url = URLImpl.createObjectURL(blob);
  const anchor = documentImpl.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentImpl.body?.append?.(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove?.();
    if (typeof setTimer === 'function') setTimer(() => URLImpl.revokeObjectURL?.(url), 1_000);
    else URLImpl.revokeObjectURL?.(url);
  }
  return Object.freeze({ method: 'download', filename });
}

export function attachClientDiagnosticLifecycle({
  role,
  getContext = () => ({}),
  windowImpl = globalThis.window,
  documentImpl = globalThis.document
} = {}) {
  if (!windowImpl?.addEventListener || !documentImpl?.addEventListener) return () => {};

  const record = (event, details = {}) => recordLivePipelineTrace({
    stage: 'BROWSER_LIFECYCLE',
    event: `browser.${event}`,
    role,
    ...getContext(),
    visibilityState: documentImpl.visibilityState || null,
    ...details
  });
  const onVisibilityChange = () => record('visibilitychange');
  const onPageShow = (event) => record('pageshow', { pagePersisted: event?.persisted === true });
  const onPageHide = (event) => record('pagehide', { pagePersisted: event?.persisted === true });

  documentImpl.addEventListener('visibilitychange', onVisibilityChange);
  windowImpl.addEventListener('pageshow', onPageShow);
  windowImpl.addEventListener('pagehide', onPageHide);
  return () => {
    documentImpl.removeEventListener('visibilitychange', onVisibilityChange);
    windowImpl.removeEventListener('pageshow', onPageShow);
    windowImpl.removeEventListener('pagehide', onPageHide);
  };
}

function diagnosticFilename({ role, meetingId, now }) {
  const safeRole = role === 'viewer' ? 'viewer' : 'recorder';
  const safeMeetingId = String(meetingId || 'unknown')
    .replace(/[^0-9A-Za-z_-]+/gu, '-')
    .slice(0, FILE_NAME_LIMIT) || 'unknown';
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/gu, '-');
  return `live-translate-diagnostics-${safeRole}-${safeMeetingId}-${timestamp}.json`;
}
