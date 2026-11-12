const stages = new Set([
  'MEDIA_RECORDER_PAUSE_DRAIN', 'SESSION_STOP_FIRST', 'SESSION_STOP_PROVIDER_CLOSE',
  'PCM_EPOCH_SEAL', 'TRANSCRIPT_FINALIZE', 'CUE_PUBLISH_FLUSH', 'CHECKPOINT_FLUSH',
  'LOCAL_PAUSE_COMMIT', 'PCM_WRITER_CLOSE', 'SESSION_SNAPSHOT_FLUSH', 'UI_PAUSED_TRANSITION'
]);
const identifier = (value) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(String(value || ''))
  ? String(value) : 'UNKNOWN';
const timestamp = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
  ? new Date(value).toISOString() : null;

export function capturePauseConsole(message, diagnostics) {
  const text = message.text();
  if (text.startsWith('ISSUE41_PAUSE ')) {
    try {
      const raw = JSON.parse(text.slice('ISSUE41_PAUSE '.length));
      if (!stages.has(raw.stage) || !['START', 'DONE', 'ERROR'].includes(raw.status)) return;
      diagnostics.stages.push({ stage: raw.stage, status: raw.status,
        startedAt: timestamp(raw.startedAt), completedAt: timestamp(raw.completedAt),
        failedAt: timestamp(raw.failedAt), elapsedMs: Number.isFinite(raw.elapsedMs) ? raw.elapsedMs : null,
      errorCode: raw.status === 'ERROR' ? identifier(raw.errorCode) : null,
      phase: raw.status === 'ERROR' && raw.phase ? identifier(raw.phase) : null });
    } catch { diagnostics.console.push({ type: 'diagnostic_parse_error' }); }
    return;
  }
  if (['error', 'warning'].includes(message.type())) diagnostics.console.push({ type: message.type() });
}

export function summarizePauseDiagnostics(diagnostics, uiState) {
  const open = new Map();
  let lastCompletedStage = null;
  for (const event of diagnostics.stages) {
    if (event.status === 'START') open.set(event.stage, event);
    else {
      open.delete(event.stage);
      if (event.status === 'DONE') lastCompletedStage = event.stage;
    }
  }
  return { lastCompletedStage, firstUnfinishedStage: [...open.keys()][0] || null,
    unfinishedStages: [...open.keys()], uiState,
    consoleSummary: { errors: diagnostics.console.filter((item) => item.type === 'error').length,
      warnings: diagnostics.console.filter((item) => item.type === 'warning').length,
      pageerrors: diagnostics.pageerrors.length, requestfailed: diagnostics.requestfailed.length },
    timeline: diagnostics.stages.map(({ stage, status, startedAt, completedAt, failedAt, elapsedMs, errorCode, phase }) =>
      ({ stage, status, at: completedAt || failedAt || startedAt, elapsedMs, errorCode, phase })) };
}

export function createPauseDiagnostics() {
  return { stages: [], console: [], pageerrors: [], requestfailed: [] };
}

export function writePauseArtifact(path, diagnostics, uiState, testStatus) {
  const artifact = { ...diagnostics, summary: summarizePauseDiagnostics(diagnostics, uiState),
    testStatus: ['passed', 'failed', 'timedOut', 'interrupted'].includes(testStatus) ? testStatus : 'unknown' };
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export function attachPauseDiagnostics(page, diagnostics) {
  page.on('console', (message) => capturePauseConsole(message, diagnostics));
  page.on('pageerror', (error) => diagnostics.pageerrors.push({ name: identifier(error?.name) }));
  page.on('requestfailed', async (request) => {
    const url = new URL(request.url());
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[REDACTED]');
    url.hash = '';
    const openStages = new Set();
    for (const event of diagnostics.stages) {
      if (event.status === 'START') openStages.add(event.stage);
      else openStages.delete(event.stage);
    }
    const failure = {
      at: new Date().toISOString(),
      stage: [...openStages].at(-1) || (diagnostics.stages.length ? 'AFTER_PAUSE' : 'BEFORE_PAUSE'),
      url: url.toString(),
      method: identifier(request.method()),
      resourceType: identifier(request.resourceType()),
      reason: String(request.failure()?.errorText || 'UNKNOWN').slice(0, 160),
      httpStatus: null
    };
    diagnostics.requestfailed.push(failure);
    failure.httpStatus = (await request.response().catch(() => null))?.status() ?? null;
  });
}

export async function pauseUiState(page) {
  if (page.isClosed()) return { pageClosed: true };
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const button = (label) => buttons.find((item) => item.textContent?.trim() === label);
    const stop = button('停止錄音');
    const end = button('結束會議');
    return { pageClosed: false, stopVisible: Boolean(stop && stop.getClientRects().length),
      endVisible: Boolean(end && end.getClientRects().length), endEnabled: Boolean(end && !end.disabled) };
  });
}
import { writeFileSync } from 'node:fs';
