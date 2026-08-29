import React from 'react';
import { RefreshCw } from 'lucide-react';

export function DeadLetterQueuePanel({ items, size, isLoading, loadError, notice, replayingExecutionId, onReplay, onRefresh }) {
  return (
    <div className="dead-letter-queue-panel">
      <div className="history-header">
        <div>
          <h2 id="dead-letter-queue-page-title">Dead-letter queue</h2>
          <p className="history-description">受保護的失敗翻譯工作管理頁面；此頁只透過 #dead-letter-queue 直接進入。</p>
        </div>
        <button className="button secondary" type="button" onClick={onRefresh} disabled={isLoading}>
          <RefreshCw size={18} aria-hidden="true" />
          {isLoading ? '重新整理中…' : '重新整理'}
        </button>
      </div>

      {loadError ? <p className="error-message" role="alert">{deadLetterQueueErrorMessage(loadError)} <button className="inline-retry" type="button" onClick={onRefresh}>重試</button></p> : null}
      {notice ? <p className="success-message" role="status">{notice}</p> : null}
      {isLoading && items.length === 0 ? <p className="history-empty">正在載入 dead-letter queue…</p> : null}
      {!isLoading && !loadError && items.length === 0 ? <p className="history-empty">目前沒有待處理的 dead-letter queue 項目。</p> : null}

      <div className="dead-letter-queue-summary" aria-live="polite">共 {size} 筆，依 FIFO 順序顯示。</div>
      <ol className="dead-letter-queue-list">
        {items.map((item) => (
          <li className="dead-letter-queue-item" key={item.executionId}>
            <div className="history-item-header">
              <div>
                <h3>{item.executionId}</h3>
                <p className="history-summary">Request ID：{item.requestId}</p>
              </div>
              <button className="detail-button primary" type="button" onClick={() => onReplay(item)} disabled={replayingExecutionId === item.executionId}>
                {replayingExecutionId === item.executionId ? 'Replay 中…' : 'Replay'}
              </button>
            </div>
            <dl className="history-metadata dead-letter-queue-metadata">
              <div><dt>Attempt</dt><dd>{item.attempt}</dd></div>
              <div><dt>Failed at</dt><dd>{item.failedAt}</dd></div>
              <div><dt>Provider key</dt><dd>{item.providerKey || '未提供'}</dd></div>
            </dl>
            <div className="dead-letter-queue-failures">
              <MetadataDisclosure label="Failure" value={item.failure} />
              <MetadataDisclosure label="Last failure" value={item.lastFailure} />
              <MetadataDisclosure label="Provider metadata" value={item.providerMetadata} />
              <MetadataDisclosure label="Execution metadata" value={item.executionMetadata} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MetadataDisclosure({ label, value }) {
  return <details className="dead-letter-queue-metadata-disclosure"><summary>{label}</summary><pre>{formatDeadLetterMetadata(value)}</pre></details>;
}

function formatDeadLetterMetadata(value) {
  if (value === null || value === undefined) return '未提供';
  try { return JSON.stringify(value, null, 2); } catch { return '資料無法顯示。'; }
}

function deadLetterQueueErrorMessage(error) {
  if (error?.status === 503 || error?.code === 'dead_letter_queue_unavailable') return 'DLQ 目前未啟用，請稍後重試。';
  if (error?.status === 401 || error?.status === 403) return '你沒有權限查看 DLQ，請確認 Access Token 後重試。';
  if (error?.status === 404 || error?.code === 'dead_letter_item_not_found') return '找不到這筆 DLQ 項目，請重新整理清單。';
  return 'DLQ 載入或操作失敗，請檢查連線後重試。';
}
