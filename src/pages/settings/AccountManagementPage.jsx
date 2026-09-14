import { useEffect, useMemo, useState } from 'react';
import { createAccountManagementApiClient } from '../../lib/accountManagementApiClient.js';

export function AccountManagementPage() {
  const client = useMemo(() => createAccountManagementApiClient(), []);
  const [users, setUsers] = useState([]);
  const [transfer, setTransfer] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const reload = () => client.listUsers().then(setUsers).catch(() => setError('無法載入帳號清單。'));
  useEffect(() => { void reload(); }, []);
  async function changeStatus(user) {
    setError(''); setBusy(user.id);
    try {
      if (user.status === 'disabled') await client.enable(user.id);
      else await client.disable(user.id, transfer[user.id]);
      await reload();
    } catch (cause) { setError(cause.code === 'transfer_target_required' ? '停用前必須選擇 active 帳號接手資產。' : '帳號操作失敗。'); }
    finally { setBusy(''); }
  }
  const activeTargets = users.filter((item) => item.status === 'active');
  return <section className="feature-page" aria-labelledby="account-management-title"><h2 id="account-management-title">帳號管理</h2><p>停用帳號前必須將會議、字幕、匯出與字典資產移轉給另一個 active 帳號。</p>{error ? <p className="error-message" role="alert">{error}</p> : null}<div>{users.map((user) => <article key={user.id}><strong>{user.email}</strong><span>{user.role} · {user.status}</span>{user.status === 'active' ? <><label>資產接手者<select value={transfer[user.id] || ''} onChange={(event) => setTransfer((current) => ({ ...current, [user.id]: event.target.value }))}><option value="">請選擇</option>{activeTargets.filter((target) => target.id !== user.id).map((target) => <option key={target.id} value={target.id}>{target.email}</option>)}</select></label><button type="button" onClick={() => void changeStatus(user)} disabled={busy === user.id || !transfer[user.id]}>停用</button></> : <button type="button" onClick={() => void changeStatus(user)} disabled={busy === user.id}>啟用</button>}</article>)}</div></section>;
}

