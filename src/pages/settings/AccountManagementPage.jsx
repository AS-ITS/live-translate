import { useEffect, useMemo, useState } from 'react';
import { createAccountManagementApiClient } from '../../lib/accountManagementApiClient.js';

export function AccountManagementPage() {
  const client = useMemo(() => createAccountManagementApiClient(), []);
  const [users, setUsers] = useState([]);
  const [transfer, setTransfer] = useState({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  async function reload() { setUsers(await client.listUsers()); }
  useEffect(() => { void reload().catch(setError); }, [client]);
  async function changeStatus(user) {
    setBusy(user.id); setNotice(''); setError(null);
    try {
      if (user.status === 'active') await client.disable(user.id, transfer[user.id]);
      else await client.enable(user.id);
      await reload(); setNotice('帳號狀態已更新。');
    } catch (cause) { setError(cause); } finally { setBusy(''); }
  }
  const activeTargets = users.filter((user) => user.status === 'active');
  return <section className="feature-page" aria-labelledby="account-management-title">
    <h2 id="account-management-title">帳號管理</h2>
    <p>停用帳號前必須將 owner 資產移轉給另一個 active 帳號。Gemini credential 不會移轉。</p>
    {notice ? <p className="success-message" role="status">{notice}</p> : null}
    {error ? <p className="error-message" role="alert">{error.apiMessage || error.code || '帳號操作失敗。'}{error.requestId ? `（識別碼：${error.requestId}）` : ''}</p> : null}
    <div>{users.map((user) => <article key={user.id}>
      <strong>{user.email}</strong><span>{user.role} · {user.status}</span>
      {user.status === 'active' ? <>
        <label>資產接手者<select value={transfer[user.id] || ''} onChange={(event) => setTransfer((current) => ({ ...current, [user.id]: event.target.value }))}>
          <option value="">請選擇</option>{activeTargets.filter((target) => target.id !== user.id).map((target) => <option key={target.id} value={target.id}>{target.email}</option>)}
        </select></label>
        <button type="button" onClick={() => void changeStatus(user)} disabled={busy === user.id || !transfer[user.id]}>停用</button>
      </> : <button type="button" onClick={() => void changeStatus(user)} disabled={busy === user.id}>啟用</button>}
    </article>)}</div>
  </section>;
}
