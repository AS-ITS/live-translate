import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { clearLiveCredential, hasLiveCredential, setLiveCredential, subscribeToLiveCredentialClear } from '../lib/liveCredentialHolder.js';
import { GEMINI_SETTINGS_HASH } from '../app/routes.js';

export function GeminiCredentialNotice({ showSettingsLink = true }) {
  const inputRef = useRef(null);
  const [isConfigured, setIsConfigured] = useState(hasLiveCredential);

  useEffect(() => {
    return subscribeToLiveCredentialClear(() => {
      if (inputRef.current) inputRef.current.value = '';
      setIsConfigured(false);
    });
  }, []);

  return (
    <aside className="gemini-credential-notice" role="status">
      <div className="gemini-credential-notice-content">
        <span className="gemini-credential-notice-icon"><KeyRound size={18} aria-hidden="true" /></span>
        <div>
          <strong>{isConfigured ? 'Gemini API Key 已載入本頁記憶體' : '錄音者必須輸入 Gemini API Key'}</strong>
          <p>只有要開始錄音的人需要輸入 Key。Key 只保留到這個頁面生命週期結束，不會儲存到瀏覽器或帳號設定。</p>
        </div>
      </div>
      {!isConfigured && showSettingsLink ? <a className="button secondary" href={GEMINI_SETTINGS_HASH}>設定 Gemini Key</a> : null}
      <label className="field"><span className="sr-only">Gemini API Key</span><input ref={inputRef} type="password" autoComplete="new-password" placeholder="AIza…" onChange={(event) => setIsConfigured(setLiveCredential(event.target.value))} /></label>
      {isConfigured ? <button className="button secondary" type="button" onClick={clearLiveCredential}>清除 Key</button> : null}
    </aside>
  );
}
