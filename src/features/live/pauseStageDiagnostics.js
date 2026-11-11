// Emit only fixed stage names and bounded error identifiers. Provider messages can contain user data.
const safeIdentifier = (value) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(String(value || ''))
  ? String(value) : 'UNKNOWN_ERROR';
const SAFE_MESSAGES = new Set([
  'IndexedDB transaction failed.', 'IndexedDB transaction aborted.',
  'Unable to flush meeting checkpoint before completion.',
  'One or more Local Cue mutations were not committed.'
]);
const FAILURE_CLASSIFICATIONS = {
  CUE_PUBLISH_FLUSH: 'CUE_SAVE_FAILURE',
  CHECKPOINT_FLUSH: 'CHECKPOINT_FAILURE',
  PCM_EPOCH_SEAL: 'PCM_JOURNAL_FAILURE',
  PCM_WRITER_CLOSE: 'PCM_JOURNAL_FAILURE',
  MEDIA_RECORDER_PAUSE_DRAIN: 'AUDIO_PERSISTENCE_FAILURE'
};

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
        classification: FAILURE_CLASSIFICATIONS[stage] || 'LIFECYCLE_FAILURE',
        errorCode: safeIdentifier(error?.code || error?.name),
        errorName: safeIdentifier(error?.name),
        message: SAFE_MESSAGES.has(error?.message) ? error.message : error?.message ? '[redacted]' : null,
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
