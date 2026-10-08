import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mergeMeetingViewerSnapshot, applyMeetingCueEvent, meetingEventGapDetected, meetingEventDuplicateDetected } from '../../lib/meetingViewerState.js';
import { createMeetingViewerTelemetry } from '../../lib/meetingViewerTelemetry.js';
import { viewerLatencySample } from '../../lib/meetingViewerLatency.js';
import { effectiveTranslationForCue } from '../../lib/cueContent.js';
import { createMeetingViewerRealtimeController, meetingViewerRealtimeEnabled } from '../../lib/meetingViewerRealtime.js';
import { fetchMeetingViewerSnapshotWithRetry, isTerminalViewerError } from '../../lib/meetingViewerSnapshot.js';
import { createWebRtcSubtitleTransport } from '../../webrtc/subtitleTransport.js';
import { webRtcConnectionLabel } from '../../webrtc/useWebRtcDeviceSidecar.js';
import { resolveViewerTransportState } from '../../webrtc/viewerTransportState.js';
import { PublicSessionLayout } from '../../layouts/AppLayout.jsx';
import { configureLivePipelineElapsedContext, recordLivePipelineTrace } from '../../lib/livePipelineTrace.js';
import {
  readSubtitleVisibilityPreference,
  toggleSubtitleVisibility,
  VIEWER_SUBTITLE_VISIBILITY_STORAGE_KEY,
  writeSubtitleVisibilityPreference
} from '../../lib/subtitleVisibilityPreference.js';
import { canonicalViewerShareUrl } from '../../lib/viewerShare.js';
import { ViewerShareHeader } from './ViewerShareHeader.jsx';

export function MeetingViewerPage({ token, code }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const viewportRef = useRef(null);
  const userScrollIntentRef = useRef(false);
  const detailRef = useRef(null);
  const eventSourceRef = useRef(null);
  const nextViewerCursorRef = useRef(null);
  const loadingOlderRef = useRef(false);
  const latencySamplesRef = useRef([]);
  const rowHeightsRef = useRef(new Map());
  const [rowLayoutVersion, setRowLayoutVersion] = useState(0);
  const [visibility, setVisibility] = useState(() => readSubtitleVisibilityPreference(VIEWER_SUBTITLE_VISIBILITY_STORAGE_KEY));
  const { showSource, showTranslation } = visibility;
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [hasOlderCues, setHasOlderCues] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [shareConnection, setShareConnection] = useState({ value: 'connecting' });
  const [retryVersion, setRetryVersion] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const fullscreenShellRef = useRef(null);
  const estimatedRowHeight = 64;
  const shareUrl = useMemo(() => canonicalViewerShareUrl({ code, token }), [code, token]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenShellRef.current);
    };
    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    writeSubtitleVisibilityPreference(VIEWER_SUBTITLE_VISIBILITY_STORAGE_KEY, visibility);
  }, [visibility]);

  useEffect(() => {
    rowHeightsRef.current.clear();
    setRowLayoutVersion((version) => version + 1);
  }, [showSource, showTranslation]);

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
    let realtimeController = null;
    let restoredTimer = null;
    let sseReconnectTimer = null;
    let sseReconnectAttempts = 0;
    let fallbackEpoch = 0;
    let sseEpoch = 0;
    let terminal = false;
    let everConnected = false;
    const channelStates = { webRtc: 'idle', fallback: 'connecting' };
    const snapshotController = new AbortController();
    setShareConnection({ value: 'connecting' });

    function stopConnections() {
      snapshotController.abort();
      if (restoredTimer) clearTimeout(restoredTimer);
      restoredTimer = null;
      if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      void realtimeController?.stop();
      void webRtcTransport?.stop();
    }

    function showRestoredConnection() {
      if (cancelled || terminal) return;
      if (restoredTimer) clearTimeout(restoredTimer);
      setShareConnection({ value: 'restored' });
      setError('');
      restoredTimer = setTimeout(() => {
        const value = resolveViewerTransportState({ ...channelStates, webRtcRequired: webRtcStarted, everConnected });
        if (!cancelled && !terminal && (value === 'connected' || value === 'restored')) {
          setShareConnection({ value: 'connected' });
        }
      }, 3_000);
    }

    function setChannelState(channel, next, message = '') {
      if (cancelled || terminal) return;
      const previous = resolveViewerTransportState({ ...channelStates, webRtcRequired: webRtcStarted, everConnected });
      channelStates[channel] = next.value;
      const value = resolveViewerTransportState({ ...channelStates, webRtcRequired: webRtcStarted, everConnected });
      if (value === 'connected' || value === 'restored') {
        if (everConnected && (!['connected', 'restored'].includes(previous) || value === 'restored')) showRestoredConnection();
        else setShareConnection({ value: 'connected' });
        everConnected = true;
        setError('');
        return;
      }
      if (value === 'recovery_failed') {
        setShareConnection({ ...next, value: 'recovery_failed' });
        setError('');
        return;
      }
      if (value === 'failed') {
        setShareConnection({ value: 'failed' });
        setError(message || '多次重新連線後仍無法取得即時字幕。');
      } else {
        setShareConnection({ value });
        setError('');
      }
    }

    function handleSnapshotError(value) {
      if (cancelled) return;
      if (value?.name === 'AbortError') return;
      if (isTerminalViewerError(value)) {
        terminal = true;
        setShareConnection({ value: value.code === 'share_unauthorized' ? 'invalid' : 'stopped' });
        setError(value?.message || '分享已失效。');
        stopConnections();
      } else setChannelState('fallback', { value: 'failed' }, value?.message || '無法連線。');
    }

    function applyWebRtcEnvelope(envelope, transportMeta = {}) {
      if (cancelled || terminal) return;
      if (envelope.type === 'meeting.stopped') {
        terminal = true;
        setShareConnection({ value: 'stopped' });
        setError('會議已停止。');
        stopConnections();
        return;
      }
      if (envelope.type === 'snapshot') {
        const merged = mergeMeetingViewerSnapshot(detailRef.current, {
          cues: envelope.cues || [],
          cursor: { cueSequence: envelope.sequence || 0 },
        });
        detailRef.current = merged;
        setDetail(merged);
        recordLivePipelineTrace({
          stage: 'VIEWER_STORE_UPDATED', meetingId: merged?.meeting?.id || merged?.meetingId,
          messageType: 'snapshot', sequence: envelope.sequence, sourceId: envelope.sourceId,
          transportGeneration: transportMeta.transportGeneration,
          receivedAt: transportMeta.receivedAt,
          decision: 'snapshot_merged', transportResult: 'updated',
        });
        return;
      }
      if (envelope.type === 'replay.response') {
        (envelope.events || []).forEach((event) => applyWebRtcEnvelope(event, transportMeta));
        return;
      }
      if (envelope.type === 'cue.append' || envelope.type === 'cue.update') {
        applyCuePayload(envelope, transportMeta);
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
            if (cancelled || terminal) return;
            if (next.value === 'invalid' || next.value === 'stopped') {
              terminal = true;
              setShareConnection(next);
              setError(next.value === 'invalid' ? '分享已失效。' : '會議已停止。');
              stopConnections();
              return;
            }
            if (restoredTimer) clearTimeout(restoredTimer);
            restoredTimer = null;
            setChannelState('webRtc', next);
          },
          onError: () => {},
        });
        window.__liveTranslateWebRtcGetStats = () => webRtcTransport.getStats();
        webRtcTransport.start();
      } catch {
        setChannelState('webRtc', { value: 'failed' });
      }
    }

    async function fetchSnapshot(before = null, expectedEpoch = fallbackEpoch) {
      const snapshotUrl = new URL(basePath, window.location.origin);
      let retried = false;
      if (before) snapshotUrl.searchParams.set('before', before);
      const value = await fetchMeetingViewerSnapshotWithRetry({
        url: `${snapshotUrl.pathname}${snapshotUrl.search}`,
        signal: snapshotController.signal,
        onRetry: ({ attempt }) => {
          retried = true;
          if (!cancelled && expectedEpoch === fallbackEpoch) setChannelState('fallback', { value: 'reconnecting', attempt });
        },
      });
      if (cancelled || terminal || expectedEpoch !== fallbackEpoch) return null;
      nextViewerCursorRef.current = value.pagination?.nextCursor || null;
      setHasOlderCues(Boolean(value.pagination?.hasMore));
      const merged = mergeMeetingViewerSnapshot(detailRef.current, value);
      detailRef.current = merged;
      configureLivePipelineElapsedContext({ meetingStartedAt: merged?.meeting?.startedAt });
      setDetail(merged);
      startWebRtc(value.meeting?.id || value.meetingId);
      if (retried && sseConnected) setChannelState('fallback', { value: 'restored' });
      return merged;
    }
    function applyCuePayload(payload, transportMeta = {}) {
      if (cancelled || terminal) return;
      const receivedAt = transportMeta.receivedAt || Date.now();
      const receivedCue = payload?.cue && typeof payload.cue === 'object' ? payload.cue : payload;
      const duplicate = meetingEventDuplicateDetected(detailRef.current, payload);
      recordLivePipelineTrace({
        stage: 'VIEWER_RECEIVED',
        meetingId: receivedCue?.meetingId || detailRef.current?.meeting?.id || detailRef.current?.meetingId,
        recordingId: receivedCue?.sessionId || null,
        segmentId: receivedCue?.segmentId || null,
        audioTurnId: receivedCue?.audioTurnId || null,
        turnKey: receivedCue?.turnKey || null,
        cueId: receivedCue?.cueId || null,
        messageType: payload.type || 'viewer_cue_received',
        sequence: payload.sequence ?? receivedCue?.sequence,
        revision: receivedCue?.revision,
        sourceVersion: receivedCue?.sourceVersion,
        translationVersion: receivedCue?.translationVersion,
        transportGeneration: transportMeta.transportGeneration,
        receivedAt,
        reason: payload.type || 'viewer_cue_received',
        transportResult: duplicate ? 'deduped' : 'accepted',
      });
      if (duplicate) {
        recordLivePipelineTrace({
          stage: 'VIEWER_PACKET_DROPPED', cueAction: 'drop',
          meetingId: receivedCue?.meetingId || detailRef.current?.meeting?.id || detailRef.current?.meetingId,
          sessionId: receivedCue?.sessionId, segmentId: receivedCue?.segmentId,
          cueId: receivedCue?.cueId, messageType: payload.type,
          sequence: payload.sequence ?? receivedCue?.sequence, revision: receivedCue?.revision,
          sourceVersion: receivedCue?.sourceVersion, translationVersion: receivedCue?.translationVersion,
          transportGeneration: transportMeta.transportGeneration,
          receivedAt, dropReason: 'stale_or_duplicate_revision', transportResult: 'dropped',
        });
      }
      const next = applyMeetingCueEvent(detailRef.current, payload);
      detailRef.current = next;
      setDetail(next);
      recordLivePipelineTrace({
        stage: 'VIEWER_STORE_UPDATED',
        meetingId: receivedCue?.meetingId || next?.meeting?.id || next?.meetingId,
        sessionId: receivedCue?.sessionId, segmentId: receivedCue?.segmentId,
        cueId: receivedCue?.cueId, messageType: payload.type,
        sequence: payload.sequence ?? receivedCue?.sequence, revision: receivedCue?.revision,
        transportGeneration: transportMeta.transportGeneration,
        receivedAt, decision: duplicate ? 'unchanged' : 'merged',
        transportResult: duplicate ? 'deduped' : 'updated',
      });
      requestAnimationFrame(() => {
        const renderedAt = Date.now();
        const sample = viewerLatencySample({
          ...payload,
          timing: { ...(payload.timing || {}), publishedAt: payload.committedAt || payload.timing?.publishedAt, receivedAt }
        }, { renderedAt });
        if (sample) latencySamplesRef.current.push(sample);
        recordLivePipelineTrace({
          stage: 'REACT_RENDER',
          meetingId: receivedCue?.meetingId || detailRef.current?.meeting?.id || detailRef.current?.meetingId,
          sessionId: receivedCue?.sessionId, segmentId: receivedCue?.segmentId,
          cueId: receivedCue?.cueId, messageType: payload.type,
          sequence: payload.sequence ?? receivedCue?.sequence, revision: receivedCue?.revision,
          transportGeneration: transportMeta.transportGeneration,
          receivedAt, timestamp: renderedAt, transportResult: 'rendered',
        });
      });
    }
    let sseConnected = false;
    function scheduleSseReconnect() {
      if (cancelled || terminal || sseReconnectTimer) return;
      const delays = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000];
      if (sseReconnectAttempts >= delays.length) {
        setChannelState('fallback', { value: 'failed' }, '多次重新連線後仍無法取得即時字幕。');
        return;
      }
      const delay = Math.round(delays[sseReconnectAttempts++] * (0.75 + Math.random() * 0.5));
      sseReconnectTimer = setTimeout(() => {
        sseReconnectTimer = null;
        void fetchSnapshot()
          .then((value) => { if (value && !terminal && !cancelled) connectEvents(value.cursor?.eventId || 0); })
          .catch(handleSnapshotError);
      }, delay);
    }

    function connectEvents(afterEventId = detailRef.current?.cursor?.eventId || 0) {
      if (cancelled || terminal) return;
      eventSourceRef.current?.close();
      const epoch = ++sseEpoch;
      const events = new EventSource(`${basePath}/events?after=${encodeURIComponent(afterEventId)}`);
      eventSourceRef.current = events;
      events.onopen = () => {
        if (cancelled || terminal || epoch !== sseEpoch) return;
        if (sseConnected) void telemetry.report('reconnect');
        setChannelState('fallback', { value: sseConnected ? 'restored' : 'connected' });
        sseConnected = true;
        sseReconnectAttempts = 0;
      };
      events.addEventListener('cue.append', (event) => {
        if (cancelled || terminal || epoch !== sseEpoch) return;
        try {
          const payload = JSON.parse(event.data);
          if (meetingEventGapDetected(detailRef.current?.cursor, payload.eventId)) {
            void telemetry.report('event_gap');
            void fetchSnapshot().then(() => telemetry.report('replay_success')).catch((value) => {
              void telemetry.report('replay_failure');
              handleSnapshotError(value);
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
        if (cancelled || terminal || epoch !== sseEpoch) return;
        void telemetry.report('event_gap');
        void fetchSnapshot().then(() => telemetry.report('replay_success')).catch((value) => {
          void telemetry.report('replay_failure');
          handleSnapshotError(value);
        });
      });
      events.onerror = () => {
        if (!cancelled && !terminal && epoch === sseEpoch) {
          events.close();
          setChannelState('fallback', { value: 'reconnecting' });
          scheduleSseReconnect();
        }
      };
    }
    if (meetingViewerRealtimeEnabled()) {
      let snapshotReady = false;
      let bufferedEvents = [];
      let realtimeSubscribed = false;
      realtimeController = createMeetingViewerRealtimeController({
        basePath,
        onConnecting: () => {
          fallbackEpoch += 1;
          snapshotReady = false;
          bufferedEvents = [];
          setChannelState('fallback', { value: realtimeSubscribed ? 'reconnecting' : 'connecting' });
        },
        onTelemetry: (eventType) => { void telemetry.report(eventType); },
        onEvent: (payload) => {
          if (!snapshotReady) bufferedEvents.push(payload);
          else applyCuePayload(payload);
        },
        onSubscribed: async ({ replay, isCurrent }) => {
          const epoch = fallbackEpoch;
          const beforeSnapshot = Number(detailRef.current?.cursor?.eventId) || 0;
          await fetchSnapshot(null, epoch);
          if (!isCurrent() || epoch !== fallbackEpoch || terminal) return;
          const recovered = await replay(beforeSnapshot);
          if (!isCurrent() || epoch !== fallbackEpoch || terminal) return;
          recovered.events?.sort((left, right) => Number(left.eventId) - Number(right.eventId)).forEach(applyCuePayload);
          snapshotReady = true;
          const pending = bufferedEvents;
          bufferedEvents = [];
          pending.forEach(applyCuePayload);
          setChannelState('fallback', { value: realtimeSubscribed ? 'restored' : 'connected' });
          realtimeSubscribed = true;
        },
        onError: (value) => {
          if (cancelled) return;
          if (isTerminalViewerError(value)) handleSnapshotError(value);
          else if (value?.code === 'viewer_retry_exhausted') setChannelState('fallback', { value: 'failed' }, value.message);
          else setChannelState('fallback', { value: 'reconnecting' });
        }
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
      snapshotController.abort();
      nextViewerCursorRef.current = null;
      loadingOlderRef.current = false;
      stopConnections();
      delete window.__liveTranslateWebRtcGetStats;
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
      // Loading history is an explicit review action; keep the return-to-latest control available.
      setIsFollowingLatest(false);
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
    if (Array.isArray(detail?.cues) && detail.cues.length > 0) {
      return detail.cues.map((cue) => ({ ...cue, translatedText: effectiveTranslationForCue(cue) }));
    }
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
    const renderedCues = visibleCues.filter((cue) => cue?.cueId);
    if (renderedCues.length === 0) {
      recordLivePipelineTrace({
        stage: 'REACT_RENDER',
        recordingId: detail?.meeting?.liveSessionId || null,
        sourceStatus: 'empty',
        translationStatus: 'empty',
        reason: 'viewer_render'
      });
      return;
    }
    for (const cue of renderedCues) {
      recordLivePipelineTrace({
        stage: 'REACT_RENDER',
        recordingId: detail?.meeting?.liveSessionId || null,
        segmentId: cue.segmentId || null,
        audioTurnId: cue.audioTurnId || null,
        turnKey: cue.turnKey || null,
        cueId: cue.cueId,
        sourceStatus: cue.sourceText ? 'present' : 'empty',
        translationStatus: cue.translatedText ? 'present' : 'empty',
        turnState: cue.status || null,
        reason: 'viewer_render'
      });
    }
  }, [detail?.meeting?.liveSessionId, visibleCues]);

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
  }, [cues, endIndex, showSource, showTranslation, startIndex]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || cues.length === 0 || !isFollowingLatest) return undefined;
    // The spacer represents unrendered rows; its measured total is the latest index position.
    const frame = requestAnimationFrame(() => viewport.scrollTo({ top: rowLayout.totalHeight, behavior: 'auto' }));
    return () => cancelAnimationFrame(frame);
  }, [cues.length, cues.at(-1)?.cueId, cues.at(-1)?.sourceText, cues.at(-1)?.translatedText,
    isFollowingLatest, rowLayout.totalHeight, showSource, showTranslation]);

  function scrollToLatest() {
    setIsFollowingLatest(true);
  }

  async function toggleFullscreen() {
    const shell = fullscreenShellRef.current;
    if (!shell) return;
    setFullscreenError('');
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch {
      setFullscreenError('無法切換全螢幕，請確認瀏覽器允許全螢幕顯示。');
    }
  }

  return (
    <PublicSessionLayout className="live-viewer-page meeting-viewer-page" title={detail?.meeting?.name || '即時字幕'} subtitle="即時字幕" showHeader={false}>
      <div ref={fullscreenShellRef} className="viewer-fullscreen-shell" data-testid="viewer-fullscreen-shell">
        <ViewerShareHeader meetingTitle={detail?.meeting?.name || '即時字幕'} shareUrl={shareUrl} />
        <div className="viewer-main">
        <div className="viewer-toolbar">
          <div className={`viewer-connection-status is-${shareConnection.value}`} role="status" aria-live="polite">
            <span className="viewer-status-dot" aria-hidden="true" />
            <span>{viewerConnectionLabel(shareConnection.value)}</span>
          </div>
          <div className="viewer-toolbar-actions">
            {detail ? (
              <div className="subtitle-visibility-controls">
                <button className={`button detail-button viewer-visibility-toggle${showSource ? ' is-active' : ''}`} type="button" aria-pressed={showSource} data-testid="viewer-source-toggle" onClick={() => setVisibility((current) => toggleSubtitleVisibility(current, 'source'))}>{showSource ? '隱藏原文' : '顯示原文'}</button>
                <button className={`button detail-button viewer-visibility-toggle${showTranslation ? ' is-active' : ''}`} type="button" aria-pressed={showTranslation} data-testid="viewer-translation-toggle" onClick={() => setVisibility((current) => toggleSubtitleVisibility(current, 'translation'))}>{showTranslation ? '隱藏翻譯' : '顯示翻譯'}</button>
              </div>
            ) : null}
            {detail && !isFollowingLatest ? <button className="button detail-button viewer-follow-latest" type="button" data-testid="viewer-follow-latest-button" onClick={scrollToLatest}>回到最新字幕</button> : null}
            {shareConnection.value === 'failed' ? (
              <button className="button detail-button viewer-retry-button" type="button" onClick={() => setRetryVersion((version) => version + 1)}>重新連線</button>
            ) : null}
            <button className="button detail-button viewer-fullscreen-toggle" type="button" aria-pressed={isFullscreen} data-testid="viewer-fullscreen-toggle" onClick={() => void toggleFullscreen()}>{isFullscreen ? '結束全螢幕' : '全螢幕'}</button>
          </div>
        </div>
        {fullscreenError ? <p className="error-message viewer-error" role="alert">{fullscreenError}</p> : null}
        {shareConnection.value === 'reconnecting' ? <p className="viewer-reconnecting-detail">正在嘗試恢復即時字幕連線</p> : null}
        {shareConnection.value === 'recovery_failed' ? (
          <div className="viewer-recovery-failed" role="alert" data-testid="viewer-recovery-failed">
            <strong>🔴 即時字幕連線異常</strong>
            <p>無法自動恢復即時字幕連線，請重新整理頁面後重新連線。</p>
            <button className="button viewer-reload-button" type="button" onClick={() => window.location.reload()}>重新整理頁面</button>
          </div>
        ) : null}
        {error ? <p className="error-message viewer-error" role="alert">{error}</p> : null}
        {!detail && !error ? <p className="history-empty viewer-loading">正在載入會議字幕…</p> : null}
        {detail ? (
          <section className={`viewer-cue-panel${showSource ? '' : ' viewer-source-hidden'}${showTranslation ? '' : ' viewer-translation-hidden'}`} aria-label="Meeting 完整字幕">
            {cues.length === 0 ? <div className="viewer-empty-state"><span className="viewer-empty-mark" aria-hidden="true" /><p>等待錄音端送出第一句字幕</p><span>連線期間會自動顯示，不需要重新整理。</span></div> : <>
              {hasOlderCues ? <button className="button detail-button viewer-load-older" type="button" data-testid="viewer-load-older-button" onClick={() => void loadOlderCues()} disabled={isLoadingOlder}>{isLoadingOlder ? '載入中…' : '載入較舊字幕'}</button> : null}
              <div ref={viewportRef} className="viewer-cue-viewport"
                onWheel={() => { userScrollIntentRef.current = true; }}
                onTouchMove={() => { userScrollIntentRef.current = true; }}
                onPointerDown={() => { userScrollIntentRef.current = true; }}
                onKeyDown={(event) => { if (['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End'].includes(event.key)) userScrollIntentRef.current = true; }}
                onScroll={(event) => {
                  setScrollTop(event.currentTarget.scrollTop);
                  if (isCueListAtLatestPosition(event.currentTarget)) setIsFollowingLatest(true);
                  else if (userScrollIntentRef.current) setIsFollowingLatest(false);
                  userScrollIntentRef.current = false;
                }} data-testid="meeting-viewer-cue-viewport" role="log" tabIndex={0} aria-live="polite" aria-label="即時字幕列表">
                <div style={{ height: rowLayout.totalHeight, position: 'relative' }}>
                  {visibleCues.map((cue, index) => {
                    const cueIndex = startIndex + index;
                    return <article className={`viewer-cue-row${cueIndex === cues.length - 1 ? ' is-latest' : ''}`} key={cue.cueId || `${cue.sequence}-${cueIndex}`} style={{ position: 'absolute', top: rowLayout.offsets[cueIndex], left: 0, right: 0 }} data-cue-index={cueIndex} data-cue-id={cue.cueId || undefined} data-testid="meeting-viewer-cue-row">
                      {showSource ? <div className="viewer-cue-source"><span className="viewer-cue-language">原文</span><p>{cue.sourceText || '—'}</p></div> : null}
                      {showTranslation && (cue.translatedText || !showSource) ? <div className="viewer-cue-translation"><span className="viewer-cue-language">翻譯</span><p>{cue.translatedText || '翻譯處理中…'}</p></div> : null}
                    </article>;
                  })}
                </div>
              </div>
            </>}
          </section>
        ) : null}
        </div>
      </div>
    </PublicSessionLayout>
  );
}

function viewerConnectionLabel(value) {
  if (value === 'connected' || value === 'restored') return `🟢 ${webRtcConnectionLabel(value)}`;
  if (value === 'reconnecting') return '🟠 正在重新連線…';
  if (value === 'recovery_failed') return '🔴 即時字幕連線異常';
  return webRtcConnectionLabel(value);
}

function isCueListAtLatestPosition(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 24; }
