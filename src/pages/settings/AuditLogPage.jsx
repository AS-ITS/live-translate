import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { createAccountManagementApiClient } from '../../lib/accountManagementApiClient.js';
import { dataGridProps } from '../../lib/dataGrid.js';

const AUDIT_ACTION_LABELS = { member_invited: '邀請成員', member_removed: '移除成員', user_approved: '核准帳號', user_enabled: '啟用帳號', user_disabled: '停用帳號', asset_transfer: '資產移轉', auth_login: '登入' };
const AUDIT_ACTION_FILTERS = [{ value: 'all', label: '全部動作' }, ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }))];
const AUDIT_RESULT_FILTERS = [{ value: 'all', label: '全部結果' }, { value: 'success', label: '成功' }, { value: 'failure', label: '失敗' }];
const AUDIT_PAGE_SIZES = [25, 50, 100];
const AUDIT_COLUMN_DEFS = [
  { headerName: '時間', field: 'created_at', minWidth: 220, flex: 1.2 },
  { headerName: '動作', field: 'actionLabel', minWidth: 140, flex: 0.8 },
  { headerName: '結果', field: 'resultLabel', minWidth: 100, flex: 0.6 },
  { headerName: 'Actor', field: 'actorLabel', minWidth: 190, flex: 1 },
  { headerName: 'Target', field: 'targetLabel', minWidth: 190, flex: 1 },
  { headerName: 'Target Meeting', field: 'meetingLabel', minWidth: 220, flex: 1.1 },
  { headerName: 'Request', field: 'requestLabel', minWidth: 220, flex: 1.1 }
];

export function AuditLogPage() {
  const client = useMemo(() => createAccountManagementApiClient(), []);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditAction, setAuditAction] = useState('all');
  const [auditResult, setAuditResult] = useState('all');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [auditPageSize, setAuditPageSize] = useState(25);
  const [auditPagination, setAuditPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState(null);
  const [auditReloadKey, setAuditReloadKey] = useState(0);
  const auditRows = useMemo(() => auditLogs.map((log, index) => ({
    id: `${log.created_at}-${log.request_id || log.action || index}`,
    created_at: log.created_at,
    actionLabel: AUDIT_ACTION_LABELS[log.action] || log.action || '—',
    resultLabel: log.result === 'success' ? '成功' : '失敗',
    actorLabel: log.actor_user_id || '—',
    targetLabel: log.target_user_id || '—',
    meetingLabel: log.target_meeting_id || '—',
    requestLabel: log.request_id || '—'
  })), [auditLogs]);

  useEffect(() => { setAuditPage(1); }, [auditAction, auditResult, auditQuery, auditPageSize]);

  useEffect(() => {
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    client.listAuditLogs({ page: auditPage, pageSize: auditPageSize, query: auditQuery, action: auditAction, result: auditResult }).then((response) => {
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
  }, [auditAction, auditPage, auditPageSize, auditQuery, auditResult, auditReloadKey, client]);

  return <section className="feature-page account-management-page" aria-labelledby="audit-log-title">
    <section className="history-panel account-management-panel" aria-label="稽核紀錄列表">
      <div className="account-management-panel-header">
        <div>
          <p className="eyebrow">AUDIT TRAIL</p>
          <h2 id="audit-log-title">稽核紀錄</h2>
          <p>查看帳號管理與工作區資產操作留下的安全紀錄。</p>
        </div>
      </div>
      <div className="account-table-toolbar account-audit-toolbar">
        <label className="field account-search-field account-audit-search-field">
          <span>搜尋稽核紀錄</span>
          <input aria-label="搜尋稽核紀錄" value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} placeholder="搜尋 actor、target、meeting 或 request ID" />
        </label>
        <label className="field account-audit-filter-field">
          <span>篩選動作</span>
          <select aria-label="篩選稽核動作" value={auditAction} onChange={(event) => setAuditAction(event.target.value)}>{AUDIT_ACTION_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label className="field account-audit-filter-field">
          <span>篩選結果</span>
          <select aria-label="篩選稽核結果" value={auditResult} onChange={(event) => setAuditResult(event.target.value)}>{AUDIT_RESULT_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
      </div>
      {auditError ? <div className="account-audit-error"><p className="error-message" role="alert">{auditError.apiMessage || auditError.code || '稽核紀錄載入失敗。'}{auditError.requestId ? `（識別碼：${auditError.requestId}）` : ''}</p><button type="button" onClick={() => setAuditReloadKey((current) => current + 1)}>重新載入稽核紀錄</button></div> : null}
      <div className="account-management-table-region">
        {auditLoading ? <p className="empty-state account-management-empty" role="status">載入稽核紀錄中…</p> : null}
        {!auditError && !auditLoading && auditLogs.length === 0 ? <p className="empty-state account-management-empty">目前沒有符合條件的稽核紀錄。</p> : null}
        {auditLogs.length > 0 ? <div className="account-management-table-scroll">
          <AgGridReact
            {...dataGridProps('account-audit-data-grid', { fixedHeight: true, hidePaginationPanel: true })}
            aria-label="稽核紀錄資料表"
            columnDefs={AUDIT_COLUMN_DEFS}
            rowData={auditRows}
            getRowId={({ data }) => data.id}
          />
        </div> : null}
      </div>
      <div className="account-management-pagination" aria-label="稽核紀錄分頁"><span>共 {auditPagination.total} 筆</span><label>每頁筆數<select aria-label="稽核紀錄每頁筆數" value={auditPageSize} onChange={(event) => setAuditPageSize(Number(event.target.value))}>{AUDIT_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label><button type="button" onClick={() => setAuditPage((current) => current - 1)} disabled={auditLoading || auditPage <= 1}>上一頁</button><span>第 {auditPagination.totalPages ? auditPage : 0} / {auditPagination.totalPages} 頁</span><button type="button" onClick={() => setAuditPage((current) => current + 1)} disabled={auditLoading || auditPage >= auditPagination.totalPages}>下一頁</button></div>
    </section>
  </section>;
}
