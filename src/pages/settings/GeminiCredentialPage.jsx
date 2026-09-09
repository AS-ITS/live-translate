import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { createGeminiCredentialApiClient } from '../../lib/geminiCredentialApiClient.js';
import { AppLayout } from '../../layouts/AppLayout.jsx';
import { MEETING_MANAGEMENT_HASH } from '../../app/routes.js';

export function GeminiCredentialPage() {
  const client = useMemo(() => createGeminiCredentialApiClient(), []);
  const [credential, setCredential] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    client.get().then((value) => {
      if (active) { setCredential(value); setStatus('ready'); }
    }).catch((error) => {
      if (active) { setStatus('error'); setMessage(error.message); }
    });
    return () => { active = false; };
  }, [client]);

  async function save(event) {
    event.preventDefault();
    setMessage('');
    try {
      setCredential(await client.save(apiKey));
      setApiKey('');
      setMessage('Gemini API Key 已安全儲存。');
    } catch (error) { setMessage(error.message); }
  }

  async function remove() {
    setMessage('');
    try { await client.remove(); setCredential({ configured: false }); setMessage('Gemini API Key 已移除。'); }
    catch (error) { setMessage(error.message); }
  }

  return (
    <AppLayout className="meeting-app-shell meeting-management-shell" showGeminiKeyAction={false} title="Gemini API Key" subtitle="只供你的會議使用，完整 Key 不會回傳或顯示。" headerAction={<a className="button secondary meeting-header-action" href={MEETING_MANAGEMENT_HASH}>返回會議管理</a>} headerClassName="meeting-app-header">
      <section className="feature-page gemini-credential-page" aria-labelledby="gemini-credential-title">
        <div className="gemini-credential-layout">
          <div className="gemini-credential-guide">
            <div className="gemini-credential-heading">
              <span className="gemini-credential-icon"><KeyRound size={22} aria-hidden="true" /></span>
              <div>
                <p className="eyebrow">開始使用 Gemini</p>
                <h2 id="gemini-credential-title">先準備一組 Gemini API Key</h2>
                <p>API Key 讓你的會議可以使用 Gemini 即時翻譯。第一次設定大約需要一分鐘。</p>
              </div>
            </div>
            <ol className="gemini-credential-steps">
              <li><span>1</span><div><strong>登入 Google AI Studio</strong><p>開啟 Google AI Studio，使用你的 Google 帳號登入。</p></div></li>
              <li><span>2</span><div><strong>建立或選取專案</strong><p>進入 API Keys 頁面，選取現有專案，或依畫面提示建立新專案。</p></div></li>
              <li><span>3</span><div><strong>建立並複製 API Key</strong><p>按下建立 API Key，完成後複製整組 Key。請不要把它貼到公開網站或提交到 Git。</p></div></li>
              <li><span>4</span><div><strong>回到這裡儲存</strong><p>將 Key 貼到右側欄位，按下「儲存 Key」，就可以開始會議。</p></div></li>
            </ol>
            <a className="button secondary gemini-studio-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              開啟 Google AI Studio API Keys
            </a>
            <div className="gemini-credential-safety">
              <ShieldCheck size={18} aria-hidden="true" />
              <p><strong>安全提醒</strong> 完整 Key 只會在儲存時送往後端，之後不會回傳或顯示在瀏覽器中。</p>
            </div>
          </div>

          <div className="gemini-credential-card">
            <div className="gemini-credential-card-header">
              <div><p className="eyebrow">你的設定</p><h2>Gemini API Key</h2></div>
              {status === 'ready' ? <span className={`gemini-credential-status ${credential?.configured ? 'is-configured' : ''}`}><CheckCircle2 size={15} aria-hidden="true" />{credential?.configured ? '已設定' : '尚未設定'}</span> : null}
            </div>
            {status === 'loading' ? <p className="gemini-credential-loading">正在載入設定…</p> : status === 'error' ? <p className="error-message" role="alert">{message}</p> : (
              <form className="gemini-credential-form" onSubmit={save}>
                <p className="gemini-credential-status-detail">{credential?.configured ? `目前使用中的 Key：末四碼 ${credential.lastFour || '****'}` : '尚未設定 Key，請先完成左側教學。'}</p>
                <label className="field"><span>貼上你的 Gemini API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="AIza…" required /></label>
                <div className="gemini-credential-actions"><button className="button primary" type="submit"><Save size={16} aria-hidden="true" />儲存 Key</button>{credential?.configured ? <button className="button secondary" type="button" onClick={remove}><Trash2 size={16} aria-hidden="true" />移除 Key</button> : null}</div>
              </form>
            )}
            {message && status !== 'error' ? <p className="success-message" role="status">{message}</p> : null}
          </div>
        </div>
      </section>
    </AppLayout>
  );
}
