import { useEffect, useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { createGeminiCredentialApiClient } from '../lib/geminiCredentialApiClient.js';

export function GeminiCredentialNotice() {
  const client = useMemo(() => createGeminiCredentialApiClient(), []);
  const [isUnconfigured, setIsUnconfigured] = useState(false);

  useEffect(() => {
    let active = true;
    client.get()
      .then((credential) => {
        if (active) setIsUnconfigured(credential?.configured === false);
      })
      .catch(() => {
        if (active) setIsUnconfigured(false);
      });
    return () => { active = false; };
  }, [client]);

  if (!isUnconfigured) return null;

  return (
    <aside className="gemini-credential-notice" role="status">
      <div className="gemini-credential-notice-content">
        <span className="gemini-credential-notice-icon"><KeyRound size={18} aria-hidden="true" /></span>
        <div>
          <strong>尚未設定 Gemini API Key</strong>
          <p>開始即時翻譯前，請先完成設定。</p>
        </div>
      </div>
      <a className="button primary" href="#settings">設定 Gemini API Key</a>
    </aside>
  );
}
