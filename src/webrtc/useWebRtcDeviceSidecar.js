import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../lib/accessToken.js';
import { mergeMeetingCues } from '../lib/meetingViewerState.js';
import { createWebRtcSubtitleTransport } from './subtitleTransport.js';

export function hostViewerCuesFromLocalRecords(meetingId, records = []) {
  if (!meetingId || !Array.isArray(records)) return [];
  return mergeMeetingCues([], records.filter((record) => record?.meetingId === meetingId
    && record?.segmentId && record?.sessionId && record?.cue?.status === 'final'
    && (!record.cue.meetingId || record.cue.meetingId === meetingId)
    && (!record.cue.segmentId || record.cue.segmentId === record.segmentId)
    && (!record.cue.sessionId || record.cue.sessionId === record.sessionId)
    && record.cue.cueId === record.cueId
    && record.cue.sequence === record.sequence)
    .map((record) => ({ ...record.cue, meetingId,
      sessionId: record.sessionId, segmentId: record.segmentId, sequence: record.sequence })));
}

export function useWebRtcDeviceSidecar({ meetingId, enabled, lifecycleStatus = 'idle', cues = [],
  segmentId = null, segmentSequence = null, segments = [], loadLocalCues } = {}) {
  const [connection, setConnection] = useState({ value: 'idle' });
  const [retryVersion, setRetryVersion] = useState(0);
  const transportRef = useRef(null);
  const cueHistoryRef = useRef({ meetingId: null, cues: [], segmentOrders: new Map() });
  const cuesRef = useRef(cues);
  const segmentMetaRef = useRef({ segmentId, segmentSequence, segments });
  const lifecycleStatusRef = useRef(lifecycleStatus);
  const loadLocalCuesRef = useRef(loadLocalCues);
  cuesRef.current = cues;
  segmentMetaRef.current = { segmentId, segmentSequence, segments };
  lifecycleStatusRef.current = lifecycleStatus;
  loadLocalCuesRef.current = loadLocalCues;

  function rememberCues(nextCues, meta) {
    if (cueHistoryRef.current.meetingId !== meetingId) {
      cueHistoryRef.current = { meetingId, cues: [], segmentOrders: new Map() };
    }
    const history = cueHistoryRef.current;
    for (const segment of meta.segments || []) {
      if (segment?.id && Number.isSafeInteger(segment.sequence) && segment.sequence > 0) {
        history.segmentOrders.set(segment.id, segment.sequence);
      }
    }
    if (meta.segmentId && Number.isSafeInteger(meta.segmentSequence) && meta.segmentSequence > 0) {
      history.segmentOrders.set(meta.segmentId, meta.segmentSequence);
    }
    const ordered = (items) => items.map((cue) => {
      const order = cue?.segmentSequence || history.segmentOrders.get(cue?.segmentId);
      return order ? { ...cue, segmentSequence: order } : cue;
    });
    history.cues = mergeMeetingCues(ordered(history.cues), ordered(nextCues));
  }

  useEffect(() => {
    rememberCues(cuesRef.current, segmentMetaRef.current);
    if (!enabled || !meetingId || typeof RTCPeerConnection !== 'function') {
      setConnection({ value: 'idle' });
      return undefined;
    }
    let disposed = false;
    let transport = null;
    let getStats = null;
    let publishTestCue = null;
    void (async () => {
      try {
        const records = await loadLocalCuesRef.current?.(meetingId) || [];
        if (disposed) return;
        rememberCues(hostViewerCuesFromLocalRecords(meetingId, records), segmentMetaRef.current);
        rememberCues(cuesRef.current, segmentMetaRef.current);
        transport = createWebRtcSubtitleTransport({
          meetingId,
          role: 'device',
          fetchImpl: authenticatedFetch(),
          initialCues: cueHistoryRef.current.cues,
          onStatus: (next) => { if (!disposed) setConnection(next); },
          onError: () => {},
        });
        transportRef.current = transport;
        const initialTransitionStatus = lifecycleStatusRef.current === 'switching-segment' ? 'switching'
          : lifecycleStatusRef.current === 'listening' ? 'ready' : null;
        if (initialTransitionStatus && segmentMetaRef.current.segmentId
          && Number.isSafeInteger(segmentMetaRef.current.segmentSequence)) {
          transport.publishSegmentTransition({
            segmentId: segmentMetaRef.current.segmentId,
            segmentSequence: segmentMetaRef.current.segmentSequence,
            status: initialTransitionStatus
          });
        }
        getStats = () => transport.getStats();
        publishTestCue = (cue) => transport.publishCue(cue);
        globalThis.__liveTranslateWebRtcGetStats = getStats;
        if (import.meta.env.DEV) globalThis.__liveTranslateWebRtcPublishTestCue = publishTestCue;
        transport.start();
      } catch {
        if (!disposed) setConnection({ value: 'failed' });
      }
    })();
    return () => {
      disposed = true;
      if (globalThis.__liveTranslateWebRtcGetStats === getStats) delete globalThis.__liveTranslateWebRtcGetStats;
      if (globalThis.__liveTranslateWebRtcPublishTestCue === publishTestCue) delete globalThis.__liveTranslateWebRtcPublishTestCue;
      if (transportRef.current === transport) transportRef.current = null;
      void transport.stop({ revoke: lifecycleStatusRef.current === 'stopped' });
    };
  }, [enabled, meetingId, retryVersion]);

  useEffect(() => {
    rememberCues(cues, segmentMetaRef.current);
    const transport = transportRef.current;
    if (!transport) return;
    cueHistoryRef.current.cues.forEach((cue) => transport.publishCue(cue));
  }, [cues, meetingId, segmentId, segmentSequence, segments]);
  useEffect(() => {
    const transitionStatus = lifecycleStatus === 'switching-segment' ? 'switching'
      : lifecycleStatus === 'listening' ? 'ready' : null;
    if (transitionStatus && segmentId && Number.isSafeInteger(segmentSequence)) {
      transportRef.current?.publishSegmentTransition({
        segmentId, segmentSequence,
        status: transitionStatus
      });
    }
  }, [lifecycleStatus, segmentId, segmentSequence]);

  return Object.freeze({
    ...connection,
    retry() { setRetryVersion((version) => version + 1); },
  });
}

export function webRtcConnectionLabel(value, { device = false } = {}) {
  const labels = {
    idle: device ? '字幕分享尚未啟動' : '連線中',
    connecting: '連線中',
    waiting: '等待錄音開始',
    connected: '已連線',
    reconnecting: '正在重新連線',
    restored: '已恢復連線',
    invalid: '分享已失效',
    stopped: '會議已停止',
    disconnected: '已中斷連線',
    recovery_failed: '即時字幕連線異常',
    failed: '無法連線',
  };
  return labels[value] || labels.failed;
}
