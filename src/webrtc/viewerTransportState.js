const HEALTHY = new Set(['connected', 'restored']);

export function resolveViewerTransportState({ webRtc = 'idle', fallback = 'idle', webRtcRequired = false, everConnected = false } = {}) {
  if (webRtcRequired) {
    if (HEALTHY.has(webRtc)) return webRtc;
    if (webRtc === 'recovery_failed') return 'recovery_failed';
    if (webRtc === 'failed') return 'failed';
    if (webRtc === 'disconnected') return 'disconnected';
    if (webRtc === 'waiting' && fallback === 'idle') return 'waiting';
    if (everConnected || webRtc === 'reconnecting') return 'reconnecting';
    return 'connecting';
  }
  if (HEALTHY.has(fallback)) return fallback;
  if (fallback === 'recovery_failed' || fallback === 'failed') return 'recovery_failed';
  if (fallback === 'disconnected') return 'disconnected';
  if (everConnected || fallback === 'reconnecting') return 'reconnecting';
  return 'connecting';
}
