import { useEffect, useMemo, useState } from 'react';
import { backgroundTranslationSummary } from './backgroundTranslationState.js';

export function BackgroundTranslationNotice({ cues = [], nowMs = Date.now() }) {
  const summary = useMemo(() => backgroundTranslationSummary(cues), [cues]);
  const [currentTimeMs, setCurrentTimeMs] = useState(nowMs);

  useEffect(() => {
    if (!summary.pending) return undefined;
    const timer = window.setInterval(() => setCurrentTimeMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [summary.pending]);

  if (!summary.pending) return null;

  const overdue = Number.isFinite(summary.startedAtMs)
    && currentTimeMs - summary.startedAtMs >= 5 * 60 * 1000;
  const updatedText = summary.updatedAt
    ? new Date(summary.updatedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '剛剛';

  return (
    <aside className="background-translation-notice" data-testid="background-translation-notice" aria-live="polite">
      <strong>{summary.status === 'queued' || summary.status === 'pending' ? '已送出，等待背景處理' : '背景處理中'}</strong>
      <span>最近更新：{updatedText}</span>
      <span>通常幾分鐘內完成，頁面會自動更新。</span>
      {overdue ? <span>處理時間比平常久，系統仍會自動更新，你可以先離開此頁面。</span> : null}
    </aside>
  );
}
