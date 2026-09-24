import { ExternalLink, KeyRound, ShieldCheck } from 'lucide-react';
import { GeminiCredentialNotice } from '../../components/GeminiCredentialNotice.jsx';
import { AppLayout } from '../../layouts/AppLayout.jsx';
import { MEETING_MANAGEMENT_HASH } from '../../app/routes.js';

export function GeminiCredentialPage() {
  return (
    <AppLayout className="meeting-app-shell meeting-management-shell" showGeminiKeyAction={false} title="Gemini API Key" subtitle="僅供目前頁面生命週期的即時翻譯使用。" headerAction={<a className="button secondary meeting-header-action" href={MEETING_MANAGEMENT_HASH}>返回會議管理</a>} headerClassName="meeting-app-header">
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
              <li><span>4</span><div><strong>回到這裡貼上</strong><p>將 Key 貼到右側欄位，即可在目前頁面生命週期內開始會議。</p></div></li>
            </ol>
            <a className="button secondary gemini-studio-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              開啟 Google AI Studio API Keys
            </a>
            <div className="gemini-credential-safety">
              <ShieldCheck size={18} aria-hidden="true" />
              <p><strong>安全提醒</strong> 完整 Key 不會寫入瀏覽器或帳號設定，只會隨 live-token 請求傳送。</p>
            </div>
          </div>

          <div className="gemini-credential-card"><GeminiCredentialNotice showSettingsLink={false} /></div>
        </div>
      </section>
    </AppLayout>
  );
}
