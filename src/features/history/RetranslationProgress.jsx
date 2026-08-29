import React, { useEffect, useState } from 'react';

export function RetranslationProgress({
  progress,
  lineages = null,
  onRetry,
  retryingExecutionId = '',
  helpers
}) {
  const hasTimedProgress = progress.executions.some((execution) => ['queued', 'processing', 'running'].includes(execution.status));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasTimedProgress) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasTimedProgress]);

  if (progress.outputs.length === 0 && progress.executions.length === 0) return null;

  return (
    <section className="translation-history-summary" aria-label="重新翻譯進度">
      <h4>重新翻譯進度</h4>
      {progress.executions.length > 0 ? (
        lineages ? (
          <div className="retry-lineage-list">
            {lineages.map((lineage, index) => (
              <section className="retry-lineage" key={lineage.requestId || `legacy-lineage-${index}`} aria-label={`重新翻譯 lineage ${lineage.requestId || 'legacy'}`}>
                <div className="retry-lineage-header"><strong>{lineage.requestId ? `Request ${lineage.requestId}` : 'Legacy execution'}</strong><span>{lineage.executions.length} 次 execution</span></div>
                <ol className="translation-history-list retry-lineage-timeline">
                  {lineage.executions.map((execution) => <RetranslationExecutionItem key={execution.id} execution={execution} nowMs={nowMs} onRetry={onRetry} retryingExecutionId={retryingExecutionId} helpers={helpers} />)}
                </ol>
              </section>
            ))}
          </div>
        ) : <ol className="translation-history-list">{progress.executions.map((execution) => <RetranslationExecutionItem key={execution.id} execution={execution} nowMs={nowMs} onRetry={onRetry} retryingExecutionId={retryingExecutionId} helpers={helpers} />)}</ol>
      ) : null}
      {progress.outputs.length > 0 ? <ol className="translation-history-list">{progress.outputs.map((output) => <li key={output.id}><span>{helpers.translationOutputTitle(output)}</span><span className="history-status history-status-completed">已完成</span></li>)}</ol> : null}
    </section>
  );
}

function RetranslationExecutionItem({ execution, nowMs, onRetry, retryingExecutionId, helpers }) {
  const timing = helpers.translationExecutionTimingText(execution, nowMs);
  return (
    <li>
      <span>{helpers.targetLanguageLabelFor(execution.targetLanguageCode) || execution.targetLanguageCode || '未知語言'}</span>
      <span className={`history-status history-status-${execution.status}`}>{helpers.translationExecutionStatusLabel(execution)}</span>
      <p className="retry-lineage-execution-id">Execution：{execution.id}</p>
      {timing ? <p>{timing}</p> : null}
      {execution.status === 'failed' ? <p>{helpers.translationFailureReasonText(execution.failureInfo)}</p> : null}
      {execution.status === 'failed' && onRetry ? <button className="button detail-button" type="button" onClick={() => onRetry(execution)} disabled={retryingExecutionId === execution.id}>{retryingExecutionId === execution.id ? '正在重試…' : '重試'}</button> : null}
    </li>
  );
}
