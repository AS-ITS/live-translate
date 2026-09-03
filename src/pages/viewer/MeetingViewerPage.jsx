import React, { useEffect, useMemo, useRef, useState } from 'react';
import { mergeMeetingViewerSnapshot, applyMeetingCueEvent, meetingEventGapDetected } from '../../lib/meetingViewerState.js';
import { viewerLatencySample } from '../../lib/meetingViewerLatency.js';
import { formatCueTimecode } from '../../lib/cueUi.js';
import { PublicSessionLayout } from '../../layouts/AppLayout.jsx';

export function MeetingViewerPage({ token, code }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const viewportRef = useRef(null);
  const detailRef = useRef(null);
  const eventSourceRef = useRef(null);
  const latencySamplesRef = useRef([]);
  const rowHeight = 116;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return undefined;
    const updateViewportHeight = () => {
      const nextHeight = Math.round(viewport.getBoundingClientRect().height);
      if (nextHeight > 0) setViewportHeight(nextHeight);
    };
    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [detail]);

  useEffect(() => {
    const identifier = token || code;
    if (!identifier) {
      setError('分享連結無效或已撤銷。');
      return undefined;
    }
    const basePath = token
      ? `/api/shared-meetings/${encodeURIComponent(token)}`
      : `/api/shared-meetings/code/${encodeURIComponent(code)}`;
    let cancelled = false;
    async function fetchSnapshot() {
      const response = await fetch(basePath);
      if (!response.ok) throw new Error('分享連結無效或已過期。');
      const value = await response.json();
      if (cancelled) return value;
      const merged = mergeMeetingViewerSnapshot(detailRef.current, value);
      detailRef.current = merged;
      setDetail(merged);
      return merged;
    }
    function connectEvents(afterEventId = detailRef.current?.cursor?.eventId || 0) {
      if (cancelled) return;
      eventSourceRef.current?.close();
      const events = new EventSource(`${basePath}/events?after=${encodeURIComponent(afterEventId)}`);
      eventSourceRef.current = events;
      events.onopen = () => setError('');
      events.addEventListener('cue.append', (event) => {
        try {
          const payload = JSON.parse(event.data);
          const receivedAt = Date.now();
          if (meetingEventGapDetected(detailRef.current?.cursor, payload.eventId)) {
            void fetchSnapshot().catch((value) => { if (!cancelled) setError(value.message); });
            return;
          }
          const next = applyMeetingCueEvent(detailRef.current, payload);
          detailRef.current = next;
          setDetail(next);
          requestAnimationFrame(() => {
            const sample = viewerLatencySample({ ...payload, timing: { ...(payload.timing || {}), receivedAt } }, { renderedAt: Date.now() });
            if (sample) latencySamplesRef.current.push(sample);
          });
        } catch {
          if (!cancelled) setError('無法讀取即時字幕。');
        }
      });
      events.addEventListener('meeting.gap', () => {
        void fetchSnapshot().catch((value) => { if (!cancelled) setError(value.message); });
      });
      events.onerror = () => {
        if (!cancelled) setError('分享連線中斷，瀏覽器會自動嘗試重新連線。');
      };
    }
    void fetchSnapshot().then((value) => connectEvents(value?.cursor?.eventId || 0)).catch((value) => {
      if (!cancelled) setError(value.message);
    });
    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [token, code]);

  const cues = useMemo(() => {
    if (Array.isArray(detail?.cues) && detail.cues.length > 0) return detail.cues;
    return (detail?.transcriptItems || [])
      .filter((item) => item.stream === 'source')
      .map((item, index) => ({
        cueId: item.id || `legacy-cue-${index}`,
        sequence: item.sequence || index + 1,
        sourceText: detail?.transcriptItems?.find((source) => source.stream === 'source' && source.sequence === item.sequence)?.text || '',
        translatedText: '',
        startTimeMs: item.startedAt || 0
      }));
  }, [detail]);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 12;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
  const visibleCues = cues.slice(startIndex, startIndex + visibleCount);

  return (
    <PublicSessionLayout className="live-viewer-page meeting-viewer-page" title="即時字幕" subtitle={detail?.meeting?.name || '會議字幕觀看'}>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {!detail && !error ? <p className="history-empty">正在載入會議字幕…</p> : null}
      {detail ? (
        <section className="viewer-cue-panel" aria-label="Meeting 完整字幕">
          <div className="viewer-cue-header"><div><p className="viewer-cue-eyebrow">MEETING</p><h2>{detail.meeting?.name || '未命名會議'}</h2></div></div>
          {cues.length === 0 ? <p className="history-empty">目前尚無已完成字幕。</p> : <>
            <div className="viewer-cue-columns" aria-hidden="true"><span>來源字幕</span></div>
            <div ref={viewportRef} className="viewer-cue-viewport" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} data-testid="meeting-viewer-cue-viewport" role="log" aria-live="polite" aria-label="即時字幕列表">
              <div style={{ height: cues.length * rowHeight, position: 'relative' }}>
                {visibleCues.map((cue, index) => <article className="viewer-cue-row" key={cue.cueId || `${cue.sequence}-${startIndex + index}`} style={{ position: 'absolute', top: (startIndex + index) * rowHeight, left: 0, right: 0, minHeight: rowHeight - 12 }} data-testid="meeting-viewer-cue-row">
                  <div className="viewer-cue-row-meta"><span className="viewer-cue-time">{formatCueTimecode(cue.startTimeMs || 0)}</span></div>
                  <div className="viewer-cue-source"><p>{cue.sourceText || '—'}</p></div>
                  {cue.translatedText ? <div className="viewer-cue-translation"><p>{cue.translatedText}</p></div> : null}
                </article>)}
              </div>
            </div>
          </>}
        </section>
      ) : null}
    </PublicSessionLayout>
  );
}
