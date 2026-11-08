// Emit only fixed stage names and bounded error identifiers. Provider messages can contain user data.
const safeIdentifier = (value) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(String(value || ''))
  ? String(value) : 'UNKNOWN_ERROR';

export function observePauseStage(stage, operation, { emit, failedResult = () => false, phase } = {}) {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const publish = (entry) => { try { emit?.(entry); } catch { /* Diagnostics cannot affect Pause. */ } };
  publish({ stage, status: 'START', startedAt });
  const finish = (status, error) => {
    const at = new Date().toISOString();
    publish({ stage, status, startedAt, ...(status === 'DONE' ? { completedAt: at } : { failedAt: at }),
      elapsedMs: Math.round(performance.now() - startedMs),
      ...(status === 'ERROR' ? {
        errorCode: safeIdentifier(error?.code || error?.name),
        ...(phase ? { phase: safeIdentifier(phase()) } : {})
      } : {}) });
  };
  const resolve = (value) => {
    finish(failedResult(value) ? 'ERROR' : 'DONE', { code: 'STAGE_RESULT_ERROR' });
    return value;
  };
  const reject = (error) => { finish('ERROR', error); throw error; };
  try {
    const result = operation();
    return result?.then ? result.then(resolve, reject) : resolve(result);
  } catch (error) {
    return reject(error);
  }
}
