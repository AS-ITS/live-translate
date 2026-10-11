import { useState } from 'react';
import { exportClientDiagnostics } from '../lib/clientDiagnostics.js';
import { livePipelineTrace, recordLivePipelineTrace } from '../lib/livePipelineTrace.js';

export function DiagnosticExportButton({ role, meetingId = null, className = '' }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (!livePipelineTrace.isEnabled()) return null;

  async function handleExport() {
    setMessage('');
    setError('');
    recordLivePipelineTrace({
      stage: 'DIAGNOSTIC_EXPORT',
      event: 'diagnostics.export.requested',
      role,
      meetingId
    });
    try {
      const result = await exportClientDiagnostics({ role, meetingId });
      if (result.method !== 'cancelled') setMessage('診斷紀錄已匯出。');
    } catch {
      setError('診斷紀錄匯出失敗，錄音與字幕連線不受影響。');
    }
  }

  return (
    <div className={`diagnostic-export-control${className ? ` ${className}` : ''}`}>
      <button className="button detail-button diagnostic-export-button" type="button" onClick={handleExport}>
        匯出診斷紀錄
      </button>
      {message ? <span className="diagnostic-export-message" role="status">{message}</span> : null}
      {error ? <span className="diagnostic-export-error" role="alert">{error}</span> : null}
    </div>
  );
}
