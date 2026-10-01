import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../lib/accessToken.js';
import { createWebRtcSubtitleTransport } from './subtitleTransport.js';

export function useWebRtcDeviceSidecar({ meetingId, enabled, lifecycleStatus = 'idle', cues = [] } = {}) {
  const [connection, setConnection] = useState({ value: 'idle' });
  const [retryVersion, setRetryVersion] = useState(0);
  const transportRef = useRef(null);
  const cuesRef = useRef(cues);
  const lifecycleStatusRef = useRef(lifecycleStatus);
  cuesRef.current = cues;
  lifecycleStatusRef.current = lifecycleStatus;

  useEffect(() => {
    if (!enabled || !meetingId || typeof RTCPeerConnection !== 'function') {
      setConnection({ value: 'idle' });
      return undefined;
    }
    let disposed = false;
    const transport = createWebRtcSubtitleTransport({
      meetingId,
      role: 'device',
      fetchImpl: authenticatedFetch(),
      initialCues: cuesRef.current,
      onStatus: (next) => { if (!disposed) setConnection(next); },
      onError: () => {},
    });
    transportRef.current = transport;
    transport.start();
    return () => {
      disposed = true;
      if (transportRef.current === transport) transportRef.current = null;
      void transport.stop({ revoke: lifecycleStatusRef.current === 'stopped' });
    };
  }, [enabled, meetingId, retryVersion]);

  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) return;
    cues.forEach((cue) => transport.publishCue(cue));
  }, [cues]);

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
    reconnecting: '重新連線中',
    invalid: '分享已失效',
    stopped: '會議已停止',
    failed: '無法連線',
  };
  return labels[value] || labels.failed;
}
