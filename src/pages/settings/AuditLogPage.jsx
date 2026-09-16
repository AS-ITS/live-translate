import { useEffect, useMemo, useState } from 'react';
import { createAccountManagementApiClient } from '../../lib/accountManagementApiClient.js';

const AUDIT_ACTION_FILTERS = [{ value: 'all', label: '全部動作' }, 'member_invited', 'member_removed', 'user_created', 'user_enabled', 'user_disabled', 'asset_transfer'].map((item) => typeof item === 'string' ? { value: item, label: item } : item);
const AUDIT_RESULT_FILTERS = [{ value: 'all', label: '全部結果' }, { value: 'success', label: '成功' }, { value: 'failure', label: '失敗' }];

export function AuditLogPage() {
  const client = useMemo(() => createAccountManagementApiClient(), []);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditAction, setAuditAction] = useState('all');
  const [auditResult, setAuditResult] = useState('all');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState(null);
  const [auditReloadKey, setAuditReloadKey] = useState(0);

  useEffect(() => { setAuditPage(1); }, [auditAction, auditResult, auditQuery]);

  useEffect(() => {
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    client.listAuditLogs({ page: auditPage, pageSize: 25, query: auditQuery, action: auditAction, result: auditResult }).then((response) => {
      if (!cancelled) {
        setAuditLogs(response.logs || []);
        setAuditPagination(response.pagination || auditPagination);
        setAuditError(null);
      }
    }).catch((cause) => {
      if (!cancelled) {
        setAuditLogs([]);
        setAuditError(cause);
      }
    }).finally(() => {
      if (!cancelled) setAuditLoading(false);
    });
    return () => { cancelled = true; };
  }, [auditAction, auditPage, auditQuery, auditResult, auditReloadKey, client]);

  return <section className="feature-page account-management-page" aria-labelledby="audit-log-title">
    <section className="history-panel account-management-panel" aria-label="稽核紀錄列表">
      <div className="account-management-panel-header">
        <div>
          <p className="eyebrow">AUDIT TRAIL</p>
          <h2 id="audit-log-title">稽核紀錄</h2>
          <p>查看帳號管理與工作區資產操作留下的安全紀錄。</p>
        </div>
      </div>
      <div className="account-table-toolbar">
        <label className="field account-search-field">
          <span>搜尋稽核紀錄</span>
          <input aria-label="搜尋稽核紀錄" value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} placeholder="搜尋 actor、target、meeting 或 request ID" />
        </label>
        <label className="field">
          <span>篩選動作</span>
          <select aria-label="篩選稽核動作" value={auditAction} onChange={(event) => setAuditAction(event.target.value)}>{AUDIT_ACTION_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label className="field">
          <span>篩選結果</span>
          <select aria-label="篩選稽核結果" value={auditResult} onChange={(event) => setAuditResult(event.target.value)}>{AUDIT_RESULT_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
      </div>
      {auditError ? <div className="account-audit-error"><p className="error-message" role="alert">{auditError.apiMessage || auditError.code || '稽核紀錄載入失敗。'}{auditError.requestId ? `（識別碼：${auditError.requestId}）` : ''}</p><button type="button" onClick={() => setAuditReloadKey((current) => current + 1)}>重新載入稽核紀錄</button></div> : null}
      {auditLoading ? <p className="empty-state" role="status">載入稽核紀錄中…</p> : null}
      {!auditError && !auditLoading && auditLogs.length === 0 ? <p className="empty-state">目前沒有符合條件的稽核紀錄。</p> : null}
      {auditLogs.length > 0 ? <div className="account-management-table-scroll"><table className="account-audit-table"><thead><tr><th>時間</th><th>動作</th><th>結果</th><th>Actor</th><th>Target</th><th>Meeting</th><th>Request</th></tr></thead><tbody>{auditLogs.map((log, index) => <tr key={`${log.created_at}-${index}`}><td>{log.created_at}</td><td>{log.action}</td><td>{log.result}</td><td>{log.actor_user_id || '—'}</td><td>{log.target_user_id || '—'}</td><td>{log.target_meeting_id || '—'}</td><td>{log.request_id || '—'}</td></tr>)}</tbody></table></div> : null}
      <div className="account-management-pagination" aria-label="稽核紀錄分頁"><span>共 {auditPagination.total} 筆</span><button type="button" onClick={() => setAuditPage((current) => current - 1)} disabled={auditLoading || auditPage <= 1}>上一頁</button><span>第 {auditPagination.totalPages ? auditPage : 0} / {auditPagination.totalPages} 頁</span><button type="button" onClick={() => setAuditPage((current) => current + 1)} disabled={auditLoading || auditPage >= auditPagination.totalPages}>下一頁</button></div>
    </section>
  </section>;
}
