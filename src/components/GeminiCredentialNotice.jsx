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
          <strong>開始錄音前，請先設定 Gemini API 金鑰</strong>
          <p>只有錄音者需要設定。金鑰僅保留於目前頁面，不會儲存到瀏覽器或帳號。</p>
        </div>
      </div>
      {showSettingsLink ? <a className="button secondary" href={GEMINI_SETTINGS_HASH}>設定 Gemini 金鑰</a> : null}
    </aside>
  );
}
