import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeMeetingViewerSnapshot, applyMeetingCueEvent, meetingEventGapDetected, meetingEventDuplicateDetected } from '../../lib/meetingViewerState.js';
import { createMeetingViewerTelemetry } from '../../lib/meetingViewerTelemetry.js';
import { viewerLatencySample } from '../../lib/meetingViewerLatency.js';
import { createMeetingViewerRealtimeController, meetingViewerRealtimeEnabled } from '../../lib/meetingViewerRealtime.js';
import { PublicSessionLayout } from '../../layouts/AppLayout.jsx';

export function MeetingViewerPage({ token, code }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const viewportRef = useRef(null);
  const detailRef = useRef(null);
  const eventSourceRef = useRef(null);
  const nextViewerCursorRef = useRef(null);
  const loadingOlderRef = useRef(false);
  const latencySamplesRef = useRef([]);
  const rowHeightsRef = useRef(new Map());
  const [rowLayoutVersion, setRowLayoutVersion] = useState(0);
  const [showSource, setShowSource] = useState(true);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [hasOlderCues, setHasOlderCues] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const estimatedRowHeight = 64;

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
    const telemetry = createMeetingViewerTelemetry({ basePath });
    let cancelled = false;
    async function fetchSnapshot(before = null) {
      const snapshotUrl = new URL(basePath, window.location.origin);
      if (before) snapshotUrl.searchParams.set('before', before);
      const response = await fetch(`${snapshotUrl.pathname}${snapshotUrl.search}`);
      if (!response.ok) throw new Error('分享連結無效或已過期。');
      const value = await response.json();
      if (cancelled) return value;
      nextViewerCursorRef.current = value.pagination?.nextCursor || null;
      setHasOlderCues(Boolean(value.pagination?.hasMore));
      const merged = mergeMeetingViewerSnapshot(detailRef.current, value);
      detailRef.current = merged;
      setDetail(merged);
      return merged;
    }
    function applyCuePayload(payload) {
      const receivedAt = Date.now();
      const next = applyMeetingCueEvent(detailRef.current, payload);
      detailRef.current = next;
      setDetail(next);
      requestAnimationFrame(() => {
        const sample = viewerLatencySample({
          ...payload,
          timing: { ...(payload.timing || {}), publishedAt: payload.committedAt || payload.timing?.publishedAt, receivedAt }
        }, { renderedAt: Date.now() });
        if (sample) latencySamplesRef.current.push(sample);
      });
    }
    let sseConnected = false;
    function connectEvents(afterEventId = detailRef.current?.cursor?.eventId || 0) {
      if (cancelled) return;
      eventSourceRef.current?.close();
      const events = new EventSource(`${basePath}/events?after=${encodeURIComponent(afterEventId)}`);
      eventSourceRef.current = events;
      events.onopen = () => {
        if (sseConnected) void telemetry.report('reconnect');
        sseConnected = true;
        setError('');
      };
      events.addEventListener('cue.append', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (meetingEventGapDetected(detailRef.current?.cursor, payload.eventId)) {
            void telemetry.report('event_gap');
          void fetchSnapshot().then(() => telemetry.report('replay_success')).catch((value) => {
            void telemetry.report('replay_failure');
            if (!cancelled) setError(value.message);
          });
            return;
          }
          if (meetingEventDuplicateDetected(detailRef.current, payload)) void telemetry.report('event_duplicate');
          applyCuePayload(payload);
        } catch {
          if (!cancelled) setError('無法讀取即時字幕。');
        }
      });
      events.addEventListener('meeting.gap', () => {
        void telemetry.report('event_gap');
        void fetchSnapshot().then(() => telemetry.report('replay_success')).catch((value) => {
          void telemetry.report('replay_failure');
          if (!cancelled) setError(value.message);
        });
      });
      events.onerror = () => {
        if (!cancelled) setError('分享連線中斷，瀏覽器會自動嘗試重新連線。');
      };
    }
    let realtimeController = null;
    if (meetingViewerRealtimeEnabled()) {
      let snapshotReady = false;
      let bufferedEvents = [];
      realtimeController = createMeetingViewerRealtimeController({
        basePath,
        onConnecting: () => { snapshotReady = false; },
        onTelemetry: (eventType) => { void telemetry.report(eventType); },
        onEvent: (payload) => {
          if (!snapshotReady) bufferedEvents.push(payload);
          else applyCuePayload(payload);
        },
        onSubscribed: async ({ replay }) => {
          const beforeSnapshot = Number(detailRef.current?.cursor?.eventId) || 0;
          await fetchSnapshot();
          const recovered = await replay(beforeSnapshot);
          recovered.events?.sort((left, right) => Number(left.eventId) - Number(right.eventId)).forEach(applyCuePayload);
          snapshotReady = true;
          const pending = bufferedEvents;
          bufferedEvents = [];
          pending.forEach(applyCuePayload);
          if (!cancelled) setError('');
        },
        onError: (value) => { if (!cancelled) setError(value.message || '分享連線中斷，瀏覽器會自動嘗試重新連線。'); }
      });
      realtimeController.start();
    } else {
      void fetchSnapshot().then((value) => connectEvents(value?.cursor?.eventId || 0)).catch((value) => {
        if (!cancelled) setError(value.message);
      });
    }
    return () => {
      cancelled = true;
      nextViewerCursorRef.current = null;
      loadingOlderRef.current = false;
      void realtimeController?.stop();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [token, code]);

  async function loadOlderCues() {
    const cursor = nextViewerCursorRef.current;
    if (!cursor || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    const basePath = token
      ? `/api/shared-meetings/${encodeURIComponent(token)}`
      : `/api/shared-meetings/code/${encodeURIComponent(code)}`;
    try {
      const response = await fetch(`${basePath}?before=${encodeURIComponent(cursor)}`);
      if (!response.ok) throw new Error('無法載入較舊字幕。');
      const value = await response.json();
      nextViewerCursorRef.current = value.pagination?.nextCursor || null;
      setHasOlderCues(Boolean(value.pagination?.hasMore));
      const merged = mergeMeetingViewerSnapshot(detailRef.current, value);
      detailRef.current = merged;
      setDetail(merged);
    } catch (value) {
      setError(value.message || '無法載入較舊字幕。');
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }

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
  const rowLayout = useMemo(() => {
    const offsets = [];
    let totalHeight = 0;
    cues.forEach((cue, index) => {
      offsets.push(totalHeight);
      totalHeight += rowHeightsRef.current.get(cue.cueId || index) || estimatedRowHeight;
    });
    return { offsets, totalHeight };
  }, [cues, rowLayoutVersion]);
  const startIndex = useMemo(() => {
    let low = 0;
    let high = rowLayout.offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rowLayout.offsets[middle] < scrollTop) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 7);
  }, [rowLayout.offsets, scrollTop]);
  const endIndex = useMemo(() => {
    const limit = scrollTop + viewportHeight + estimatedRowHeight * 7;
    let index = startIndex;
    while (index < cues.length && rowLayout.offsets[index] < limit) index += 1;
    return Math.max(startIndex + 1, index);
  }, [cues.length, estimatedRowHeight, rowLayout.offsets, scrollTop, startIndex, viewportHeight]);
  const visibleCues = cues.slice(startIndex, endIndex);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      entries.forEach((entry) => {
        const index = Number(entry.target.dataset.cueIndex);
        const cue = cues[index];
        if (!cue || !Number.isFinite(index)) return;
        const key = cue.cueId || index;
        const height = Math.ceil(entry.target.getBoundingClientRect().height);
        if (height > 0 && rowHeightsRef.current.get(key) !== height) {
          rowHeightsRef.current.set(key, height);
          changed = true;
        }
      });
      if (changed) setRowLayoutVersion((version) => version + 1);
    });
    viewport.querySelectorAll('.viewer-cue-row').forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [cues, endIndex, startIndex]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || cues.length === 0 || !isFollowingLatest) return undefined;
    const frame = requestAnimationFrame(() => viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' }));
    return () => cancelAnimationFrame(frame);
  }, [cues.length, cues.at(-1)?.cueId, cues.at(-1)?.updatedTimeMs, isFollowingLatest, rowLayoutVersion, showSource]);

  function scrollToLatest() {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' });
    setIsFollowingLatest(true);
  }

  return (
    <PublicSessionLayout className="live-viewer-page meeting-viewer-page" title="即時字幕" subtitle={detail?.meeting?.name || '會議字幕觀看'}>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {!detail && !error ? <p className="history-empty">正在載入會議字幕…</p> : null}
      {detail ? (
        <section className={`viewer-cue-panel${showSource ? '' : ' viewer-source-hidden'}`} aria-label="Meeting 完整字幕">
          <div className="viewer-cue-header">
            <div><p className="viewer-cue-eyebrow">MEETING</p><h2>{detail.meeting?.name || '未命名會議'}</h2></div>
            {cues.length > 0 ? <div className="viewer-cue-actions">
              <button className={`button detail-button viewer-source-toggle${showSource ? ' is-active' : ''}`} type="button" aria-pressed={showSource} data-testid="viewer-source-toggle" onClick={() => setShowSource((visible) => !visible)}>顯示原文</button>
              {!isFollowingLatest ? <button className="button detail-button" type="button" data-testid="viewer-follow-latest-button" onClick={scrollToLatest}>回到最新字幕</button> : null}
            </div> : null}
          </div>
          {cues.length === 0 ? <p className="history-empty">目前尚無已完成字幕。</p> : <>
            {hasOlderCues ? <button className="button detail-button viewer-load-older" type="button" data-testid="viewer-load-older-button" onClick={() => void loadOlderCues()} disabled={isLoadingOlder}>{isLoadingOlder ? '載入中…' : '載入較舊字幕'}</button> : null}
            <div ref={viewportRef} className="viewer-cue-viewport" onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop); setIsFollowingLatest(isCueListAtLatestPosition(event.currentTarget)); }} data-testid="meeting-viewer-cue-viewport" role="log" aria-live="polite" aria-label="即時字幕列表">
              <div style={{ height: rowLayout.totalHeight, position: 'relative' }}>
                {visibleCues.map((cue, index) => <article className="viewer-cue-row" key={cue.cueId || `${cue.sequence}-${startIndex + index}`} style={{ position: 'absolute', top: rowLayout.offsets[startIndex + index], left: 0, right: 0 }} data-cue-index={startIndex + index} data-testid="meeting-viewer-cue-row">
                  {showSource ? <div className="viewer-cue-source"><p>{cue.sourceText || '—'}</p></div> : null}
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

function isCueListAtLatestPosition(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 24; }
