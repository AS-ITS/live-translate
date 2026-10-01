import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeMeetingViewerSnapshot, applyMeetingCueEvent, meetingEventGapDetected, meetingEventDuplicateDetected } from '../../lib/meetingViewerState.js';
import { createMeetingViewerTelemetry } from '../../lib/meetingViewerTelemetry.js';
import { viewerLatencySample } from '../../lib/meetingViewerLatency.js';
import { createMeetingViewerRealtimeController, meetingViewerRealtimeEnabled } from '../../lib/meetingViewerRealtime.js';
import { createWebRtcSubtitleTransport } from '../../webrtc/subtitleTransport.js';
import { webRtcConnectionLabel } from '../../webrtc/useWebRtcDeviceSidecar.js';
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
  const [shareConnection, setShareConnection] = useState({ value: 'connecting' });
  const [retryVersion, setRetryVersion] = useState(0);
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
    let webRtcTransport = null;
    let webRtcStarted = false;
    setShareConnection({ value: 'connecting' });

    function handleSnapshotError(value) {
      if (cancelled) return;
      if (value?.code === 'meeting_stopped') setShareConnection({ value: 'stopped' });
      else if (value?.code === 'share_unauthorized') setShareConnection({ value: 'invalid' });
      else setShareConnection({ value: 'failed' });
      setError(value?.message || '無法連線。');
    }

    function applyWebRtcEnvelope(envelope) {
      if (envelope.type === 'meeting.stopped') {
        setShareConnection({ value: 'stopped' });
        setError('會議已停止。');
        return;
      }
      if (envelope.type === 'snapshot') {
        const merged = mergeMeetingViewerSnapshot(detailRef.current, {
          cues: envelope.cues || [],
          cursor: { cueSequence: envelope.sequence || 0 },
        });
        detailRef.current = merged;
        setDetail(merged);
        return;
      }
      if (envelope.type === 'replay.response') {
        (envelope.events || []).forEach(applyWebRtcEnvelope);
        return;
      }
      if (envelope.type === 'cue.append' || envelope.type === 'cue.update') {
        applyCuePayload(envelope);
      }
    }

    function startWebRtc(meetingId) {
      if (webRtcStarted || !meetingId || typeof RTCPeerConnection !== 'function') return;
      webRtcStarted = true;
      try {
        webRtcTransport = createWebRtcSubtitleTransport({
          meetingId,
          role: 'viewer',
          credential: code ? { shareCode: code } : { shareToken: token },
          onEnvelope: applyWebRtcEnvelope,
          onStatus: (next) => {
            if (cancelled) return;
            setShareConnection(next);
            if (next.value === 'invalid') setError('分享已失效。');
            if (next.value === 'stopped') setError('會議已停止。');
          },
          onError: () => {},
        });
        window.__liveTranslateWebRtcGetStats = () => webRtcTransport.getStats();
        webRtcTransport.start();
      } catch {
        setShareConnection({ value: 'failed' });
      }
    }

    async function fetchSnapshot(before = null) {
      const snapshotUrl = new URL(basePath, window.location.origin);
      if (before) snapshotUrl.searchParams.set('before', before);
      const response = await fetch(`${snapshotUrl.pathname}${snapshotUrl.search}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const code = body?.error?.code || body?.code;
        const stopped = code === 'meeting_stopped' || response.status === 410;
        const error = new Error(stopped ? '會議已停止。' : '分享已失效。');
        error.code = stopped ? 'meeting_stopped' : (response.status === 403 || response.status === 404 ? 'share_unauthorized' : 'viewer_unavailable');
        throw error;
      }
      const value = await response.json();
      if (cancelled) return value;
      nextViewerCursorRef.current = value.pagination?.nextCursor || null;
      setHasOlderCues(Boolean(value.pagination?.hasMore));
      const merged = mergeMeetingViewerSnapshot(detailRef.current, value);
      detailRef.current = merged;
      setDetail(merged);
      startWebRtc(value.meeting?.id || value.meetingId);
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
      void fetchSnapshot()
        .then(() => realtimeController.start())
        .catch(handleSnapshotError);
    } else {
      void fetchSnapshot().then((value) => connectEvents(value?.cursor?.eventId || 0)).catch((value) => {
        handleSnapshotError(value);
      });
    }
    return () => {
      cancelled = true;
      nextViewerCursorRef.current = null;
      loadingOlderRef.current = false;
      void realtimeController?.stop();
      void webRtcTransport?.stop();
      delete window.__liveTranslateWebRtcGetStats;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [token, code, retryVersion]);

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
    <PublicSessionLayout className="live-viewer-page meeting-viewer-page" title={detail?.meeting?.name || '即時字幕'} subtitle="即時字幕">
      <div className="viewer-main">
        <div className="viewer-toolbar">
          <div className={`viewer-connection-status is-${shareConnection.value}`} role="status" aria-live="polite">
            <span className="viewer-status-dot" aria-hidden="true" />
            <span>{webRtcConnectionLabel(shareConnection.value)}</span>
          </div>
          <div className="viewer-toolbar-actions">
            {detail ? (
              <button className={`button detail-button viewer-source-toggle${showSource ? ' is-active' : ''}`} type="button" aria-pressed={showSource} data-testid="viewer-source-toggle" onClick={() => setShowSource((visible) => !visible)}>顯示原文</button>
            ) : null}
            {shareConnection.value === 'failed' ? (
              <button className="button detail-button" type="button" onClick={() => setRetryVersion((version) => version + 1)}>重試</button>
            ) : null}
          </div>
        </div>
        {error ? <p className="error-message viewer-error" role="alert">{error}</p> : null}
        {!detail && !error ? <p className="history-empty viewer-loading">正在載入會議字幕…</p> : null}
        {detail ? (
          <section className={`viewer-cue-panel${showSource ? '' : ' viewer-source-hidden'}`} aria-label="Meeting 完整字幕">
            <div className="viewer-cue-header">
              <div>
                <p className="viewer-cue-eyebrow">LIVE TRANSCRIPT</p>
                <h2>即時翻譯</h2>
                <p className="viewer-cue-description">字幕會自動更新，暫停後繼續錄製也會保留先前內容。</p>
              </div>
              {!isFollowingLatest ? <button className="button detail-button viewer-follow-latest" type="button" data-testid="viewer-follow-latest-button" onClick={scrollToLatest}>回到最新字幕</button> : null}
            </div>
            {cues.length === 0 ? <div className="viewer-empty-state"><span className="viewer-empty-mark" aria-hidden="true" /><p>等待錄音端送出第一句字幕</p><span>連線期間會自動顯示，不需要重新整理。</span></div> : <>
              {hasOlderCues ? <button className="button detail-button viewer-load-older" type="button" data-testid="viewer-load-older-button" onClick={() => void loadOlderCues()} disabled={isLoadingOlder}>{isLoadingOlder ? '載入中…' : '載入較舊字幕'}</button> : null}
              <div ref={viewportRef} className="viewer-cue-viewport" onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop); setIsFollowingLatest(isCueListAtLatestPosition(event.currentTarget)); }} data-testid="meeting-viewer-cue-viewport" role="log" aria-live="polite" aria-label="即時字幕列表">
                <div style={{ height: rowLayout.totalHeight, position: 'relative' }}>
                  {visibleCues.map((cue, index) => {
                    const cueIndex = startIndex + index;
                    return <article className={`viewer-cue-row${cueIndex === cues.length - 1 ? ' is-latest' : ''}`} key={cue.cueId || `${cue.sequence}-${cueIndex}`} style={{ position: 'absolute', top: rowLayout.offsets[cueIndex], left: 0, right: 0 }} data-cue-index={cueIndex} data-testid="meeting-viewer-cue-row">
                      <span className="viewer-cue-index" aria-hidden="true">{String(cueIndex + 1).padStart(2, '0')}</span>
                      {showSource ? <div className="viewer-cue-source"><span className="viewer-cue-language">原文</span><p>{cue.sourceText || '—'}</p></div> : null}
                      {cue.translatedText ? <div className="viewer-cue-translation"><span className="viewer-cue-language">翻譯</span><p>{cue.translatedText}</p></div> : null}
                    </article>;
                  })}
                </div>
              </div>
            </>}
          </section>
        ) : null}
      </div>
    </PublicSessionLayout>
  );
}

function isCueListAtLatestPosition(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 24; }
