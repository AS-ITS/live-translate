import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { hasLiveCredential, subscribeToLiveCredentialClear } from '../lib/liveCredentialHolder.js';
import { GEMINI_SETTINGS_HASH } from '../app/routes.js';

export function GeminiCredentialNotice({ showSettingsLink = true }) {
  const [isConfigured, setIsConfigured] = useState(hasLiveCredential);

  useEffect(() => {
    return subscribeToLiveCredentialClear(() => {
      setIsConfigured(false);
    });
  }, []);

  if (isConfigured) return null;

  return (
    <aside className="gemini-credential-notice" role="status">
      <div className="gemini-credential-notice-content">
        <span className="gemini-credential-notice-icon"><KeyRound size={18} aria-hidden="true" /></span>
        <div>
          <strong>錄音者必須輸入 Gemini API Key</strong>
          <p>只有要開始錄音的人需要輸入 Key。Key 只保留到這個頁面生命週期結束，不會儲存到瀏覽器或帳號設定。</p>
        </div>
      </div>
      {showSettingsLink ? <a className="button secondary" href={GEMINI_SETTINGS_HASH}>設定 Gemini Key</a> : null}
    </aside>
  );
}
