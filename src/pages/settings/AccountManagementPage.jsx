import { AgGridReact } from 'ag-grid-react';
import { Search, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { dataGridProps } from '../../lib/dataGrid.js';
import { createAccountManagementApiClient } from '../../lib/accountManagementApiClient.js';

function accountRoleLabel(role) {
  return role === 'super_admin' ? '系統管理員' : role === 'owner' ? 'Owner' : '成員';
}

function accountStatusLabel(status) {
  return status === 'active' ? '啟用中' : '已停用';
}

const ACCOUNT_STATUS_FILTERS = [
  { value: 'all', label: '全部狀態' },
  { value: 'active', label: '啟用中' },
  { value: 'disabled', label: '已停用' }
];
const AUDIT_ACTION_FILTERS = [{ value: 'all', label: '全部動作' }, 'member_invited', 'member_removed', 'user_enabled', 'user_disabled', 'asset_transfer'].map((item) => typeof item === 'string' ? { value: item, label: item } : item);
const AUDIT_RESULT_FILTERS = [{ value: 'all', label: '全部結果' }, { value: 'success', label: '成功' }, { value: 'failure', label: '失敗' }];

function AccountStatusCell({ value }) {
  const isActive = value === 'active';
  return <span className={`account-table-status ${isActive ? 'is-active' : 'is-disabled'}`} role="status" aria-label={`帳號狀態：${accountStatusLabel(value)}`}><span aria-hidden="true" />{accountStatusLabel(value)}</span>;
}

function AccountRoleCell({ value }) {
  return <span className="account-table-role"><ShieldCheck size={16} aria-hidden="true" />{accountRoleLabel(value)}</span>;
}

function AccountTransferCell({ data, context }) {
  if (data.status !== 'active') return <span className="account-table-muted">不適用</span>;
  const targets = context.transferTargets.filter((target) => target.id !== data.id);
  return <label className="account-table-transfer-field">
    <span className="sr-only">資產接手者：{data.email}</span>
    <select aria-label={`資產接手者：${data.email}`} value={data.transferTargetId} onChange={(event) => context.onTransferChange(data.id, event.target.value)}>
      <option value="">請選擇</option>
      {targets.map((target) => <option key={target.id} value={target.id}>{target.email}</option>)}
    </select>
  </label>;
}

function AccountActionsCell({ data, context }) {
  const isActive = data.status === 'active';
  const label = isActive ? '停用帳號' : '重新啟用帳號';
  return <button
    className={`button detail-button account-table-action${isActive ? ' account-table-danger-action' : ''}`}
    type="button"
    onClick={() => context.onChangeStatus(data)}
    disabled={data.isBusy || (isActive && !data.transferTargetId)}
  >
    {data.isBusy ? '處理中…' : label}
  </button>;
}

export function AccountManagementPage() {
  const client = useMemo(() => createAccountManagementApiClient(), []);
  const [users, setUsers] = useState([]);
  const [transfer, setTransfer] = useState({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 12, total: 0, totalPages: 0 });
  const [counts, setCounts] = useState({ all: 0, active: 0, disabled: 0 });
  const [transferTargets, setTransferTargets] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditAction, setAuditAction] = useState('all');
  const [auditResult, setAuditResult] = useState('all');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState(null);
  const [auditReloadKey, setAuditReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => { setPage(1); }, [debouncedQuery, statusFilter, pageSize]);
  useEffect(() => { setAuditPage(1); }, [auditAction, auditResult, auditQuery]);

  async function reload() {
    setIsLoading(true);
    try {
      const result = await client.listUsers({ page, pageSize, query: debouncedQuery, status: statusFilter });
      setUsers(result.users || []);
      setTransferTargets(result.transferTargets || []);
      setPagination(result.pagination || { page, pageSize, total: 0, totalPages: 0 });
      setCounts(result.counts || { all: 0, active: 0, disabled: 0 });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    client.listAuditLogs({ page: auditPage, pageSize: 25, query: auditQuery, action: auditAction, result: auditResult }).then((response) => {
      if (!cancelled) { setAuditLogs(response.logs || []); setAuditPagination(response.pagination || auditPagination); setAuditError(null); }
    }).catch((cause) => { if (!cancelled) { setAuditLogs([]); setAuditError(cause); } }).finally(() => { if (!cancelled) setAuditLoading(false); });
    return () => { cancelled = true; };
  }, [auditAction, auditPage, auditQuery, auditResult, auditReloadKey, client]);

  useEffect(() => { void reload().catch(setError); }, [client, page, pageSize, debouncedQuery, statusFilter]);

  async function changeStatus(user) {
    if (user.status === 'active') {
      const target = transferTargets.find((candidate) => candidate.id === transfer[user.id]);
      if (!target) return;
      const confirmed = window.confirm(`停用 ${user.email} 後，owner 資產會移轉給 ${target.email}。Gemini credential 不會移轉。確定要繼續嗎？`);
      if (!confirmed) return;
    }

    setBusy(user.id);
    setNotice('');
    setError(null);
    try {
      if (user.status === 'active') await client.disable(user.id, transfer[user.id]);
      else await client.enable(user.id);
      await reload();
      setNotice('帳號狀態已更新。');
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy('');
    }
  }

  const rowData = useMemo(() => users.map((user) => ({
    ...user,
    transferTargetId: transfer[user.id] || '',
    isBusy: busy === user.id
  })), [users, transfer, busy]);
  const columnDefs = useMemo(() => [
    { headerName: '帳號', field: 'email', minWidth: 260, flex: 1.4 },
    { headerName: '角色', field: 'role', width: 170, cellRenderer: AccountRoleCell },
    { headerName: '狀態', field: 'status', width: 150, cellRenderer: AccountStatusCell },
    { headerName: '資產接手者', field: 'transferTargetId', minWidth: 260, flex: 1.2, sortable: false, cellRenderer: AccountTransferCell },
    { headerName: '操作', width: 170, sortable: false, cellRenderer: AccountActionsCell }
  ], []);
  const gridContext = useMemo(() => ({
    transferTargets,
    onTransferChange: (userId, targetId) => setTransfer((current) => ({ ...current, [userId]: targetId })),
    onChangeStatus: (user) => void changeStatus(user)
  }), [transferTargets]);

  return <section className="feature-page account-management-page" aria-labelledby="account-list-title">
    <div className="account-management-status">
      {notice ? <p className="success-message" role="status">{notice}</p> : null}
      {error ? <p className="error-message" role="alert">{error.apiMessage || error.code || '帳號操作失敗。'}{error.requestId ? `（識別碼：${error.requestId}）` : ''}</p> : null}
    </div>
    <section className="history-panel account-management-panel" aria-label="帳號列表">
      <div className="account-management-panel-header">
        <div>
          <p className="eyebrow">ACCOUNT ACCESS</p>
          <h2 id="account-list-title">帳號列表</h2>
          <p>管理工作區成員的存取狀態。停用帳號前必須將 owner 資產移轉給另一個 active 帳號。</p>
        </div>
      </div>
      <div className="account-summary-grid" aria-label="帳號摘要">
        <div className="account-summary-card"><span>全部帳號</span><strong>{counts.all}</strong></div>
        <div className="account-summary-card account-summary-active"><span>啟用中</span><strong>{counts.active}</strong></div>
        <div className="account-summary-card account-summary-disabled"><span>已停用</span><strong>{counts.disabled}</strong></div>
      </div>
      <div className="account-table-toolbar">
        <label className="field account-search-field">
          <span>搜尋帳號</span>
          <div className="meeting-toolbar-input">
            <Search size={19} aria-hidden="true" />
            <input aria-label="搜尋帳號" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋 email、角色或狀態" />
          </div>
        </label>
        <label className="field account-status-filter-field">
          <span>篩選狀態</span>
          <div className="meeting-toolbar-input meeting-toolbar-select">
            <SlidersHorizontal size={19} aria-hidden="true" />
            <select aria-label="篩選狀態" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              {ACCOUNT_STATUS_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
            </select>
          </div>
        </label>
      </div>
      {isLoading && users.length === 0 ? <p className="empty-state account-management-empty" role="status">載入帳號中…</p> : null}
      {!isLoading && users.length === 0 ? <p className="empty-state account-management-empty">{pagination.total ? '找不到符合條件的帳號。' : '目前沒有可管理的帳號。'}</p> : null}
      {users.length > 0 ? <div className="account-management-table-scroll">
        <AgGridReact
          {...dataGridProps('account-management-data-grid', { fixedHeight: true, hidePaginationPanel: true })}
          aria-label="帳號管理列表"
          columnDefs={columnDefs}
          context={gridContext}
          rowData={rowData}
          getRowId={({ data }) => data.id}
        />
      </div> : null}
      <div className="account-management-pagination" aria-label="帳號列表分頁">
        <span>顯示第 {pagination.total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, pagination.total)} 筆，共 {pagination.total} 筆</span>
        <label>每頁筆數<select aria-label="每頁筆數" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value="12">12</option><option value="24">24</option><option value="48">48</option></select></label>
        <button type="button" onClick={() => setPage((current) => current - 1)} disabled={isLoading || page <= 1}>上一頁</button>
        <span>第 {pagination.totalPages ? page : 0} / {pagination.totalPages} 頁</span>
        <button type="button" onClick={() => setPage((current) => current + 1)} disabled={isLoading || page >= pagination.totalPages}>下一頁</button>
      </div>
    </section>
    <section className="history-panel account-management-panel" aria-labelledby="audit-log-title">
      <div className="account-management-panel-header"><div><p className="eyebrow">AUDIT TRAIL</p><h2 id="audit-log-title">稽核紀錄</h2></div></div>
      <div className="account-table-toolbar"><label className="field"><span>搜尋稽核紀錄</span><input aria-label="搜尋稽核紀錄" value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} placeholder="搜尋 actor、target、meeting 或 request ID" /></label><label className="field"><span>篩選動作</span><select aria-label="篩選稽核動作" value={auditAction} onChange={(event) => setAuditAction(event.target.value)}>{AUDIT_ACTION_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field"><span>篩選結果</span><select aria-label="篩選稽核結果" value={auditResult} onChange={(event) => setAuditResult(event.target.value)}>{AUDIT_RESULT_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
      {auditError ? <div className="account-audit-error"><p className="error-message" role="alert">{auditError.apiMessage || auditError.code || '稽核紀錄載入失敗。'}{auditError.requestId ? `（識別碼：${auditError.requestId}）` : ''}</p><button type="button" onClick={() => setAuditReloadKey((current) => current + 1)}>重新載入稽核紀錄</button></div> : null}
      {auditLoading ? <p className="empty-state" role="status">載入稽核紀錄中…</p> : null}
      {!auditError && !auditLoading && auditLogs.length === 0 ? <p className="empty-state">目前沒有符合條件的稽核紀錄。</p> : null}
      {auditLogs.length > 0 ? <div className="account-management-table-scroll"><table className="account-audit-table"><thead><tr><th>時間</th><th>動作</th><th>結果</th><th>Actor</th><th>Target</th><th>Meeting</th><th>Request</th></tr></thead><tbody>{auditLogs.map((log, index) => <tr key={`${log.created_at}-${index}`}><td>{log.created_at}</td><td>{log.action}</td><td>{log.result}</td><td>{log.actor_user_id || '—'}</td><td>{log.target_user_id || '—'}</td><td>{log.target_meeting_id || '—'}</td><td>{log.request_id || '—'}</td></tr>)}</tbody></table></div> : null}
      <div className="account-management-pagination" aria-label="稽核紀錄分頁"><span>共 {auditPagination.total} 筆</span><button type="button" onClick={() => setAuditPage((current) => current - 1)} disabled={auditLoading || auditPage <= 1}>上一頁</button><span>第 {auditPagination.totalPages ? auditPage : 0} / {auditPagination.totalPages} 頁</span><button type="button" onClick={() => setAuditPage((current) => current + 1)} disabled={auditLoading || auditPage >= auditPagination.totalPages}>下一頁</button></div>
    </section>
  </section>;
}
