import { useEffect, useState } from 'react';
import { formatMeetingElapsed, meetingElapsedMs } from '../../lib/meetingElapsedTime.js';

const TIMER_REFRESH_MS = 1000;

export function MeetingElapsedTimer({ startedAt }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!startedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), TIMER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const elapsedMs = meetingElapsedMs(startedAt, now);
  if (elapsedMs === null) return null;
  const elapsed = formatMeetingElapsed(elapsedMs);

  return (
    <span className="meeting-elapsed-timer" data-testid="meeting-elapsed-timer" aria-label={`會議已進行 ${elapsed}`}>
      <span className="meeting-elapsed-label">錄製中 · </span>
      <span className="meeting-elapsed-compact-marker" aria-hidden="true">● </span>
      <time dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}>{elapsed}</time>
    </span>
  );
}
