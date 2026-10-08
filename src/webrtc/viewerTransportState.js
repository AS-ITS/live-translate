const HEALTHY = new Set(['connected', 'restored']);

export function resolveViewerTransportState({ webRtc = 'idle', fallback = 'idle', webRtcRequired = false, everConnected = false } = {}) {
  if (webRtcRequired) {
    if (HEALTHY.has(webRtc)) return webRtc;
    if (webRtc === 'failed') return 'failed';
    if (webRtc === 'waiting' && fallback === 'idle') return 'waiting';
    if (everConnected || webRtc === 'reconnecting') return 'reconnecting';
    return 'connecting';
  }
  if (HEALTHY.has(fallback)) return fallback;
  if (fallback === 'failed') return 'failed';
  if (everConnected || fallback === 'reconnecting') return 'reconnecting';
  return 'connecting';
}
