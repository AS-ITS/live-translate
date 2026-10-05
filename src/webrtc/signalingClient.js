export class WebRtcSignalingClientError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'WebRtcSignalingClientError';
    this.code = code;
    this.status = status;
  }
}

export function createWebRtcSignalingClient({
  meetingId,
  participantId,
  role,
  credential = {},
  fetchImpl = globalThis.fetch,
  baseUrl = '',
  requestTimeoutMs = 8_000,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  AbortControllerImpl = globalThis.AbortController,
} = {}) {
  if (!meetingId || !participantId || !['device', 'viewer'].includes(role) || typeof fetchImpl !== 'function') {
    throw new TypeError('meetingId, participantId, role, and fetchImpl are required.');
  }
  const route = `${String(baseUrl || '').replace(/\/$/u, '')}/api/webrtc/${encodeURIComponent(meetingId)}`;

  async function request(path, init = {}) {
    const controller = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : null;
    const timeout = controller && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? setTimer(() => controller.abort(), requestTimeoutMs)
      : null;
    try {
      const response = await fetchImpl(`${route}${path}`, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof body?.error?.code === 'string' ? body.error.code : 'webrtc_signaling_unavailable';
        throw new WebRtcSignalingClientError(code, response.status, safeMessage(code));
      }
      return body || {};
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new WebRtcSignalingClientError('webrtc_signaling_timeout', 504, safeMessage('webrtc_signaling_timeout'));
      }
      throw error;
    } finally {
      if (timeout) clearTimer(timeout);
    }
  }

  return Object.freeze({
    join() {
      return request('/join', {
        method: 'POST',
        body: JSON.stringify({ participantId, role, ...(role === 'viewer' ? credential : {}) }),
      });
    },
    signal(type, payload) {
      return request('/signal', { method: 'POST', body: JSON.stringify({ participantId, type, payload }) });
    },
    poll(after = 0) {
      return request(`/signal?participantId=${encodeURIComponent(participantId)}&after=${encodeURIComponent(after)}`);
    },
    leave() {
      return request('/leave', { method: 'POST', body: JSON.stringify({ participantId }) });
    },
    stop() {
      return request('/stop', { method: 'POST', body: JSON.stringify({ participantId }) });
    },
  });
}

function safeMessage(code) {
  if (code === 'meeting_stopped' || code === 'meeting_revoked') return '會議已停止。';
  if (code === 'share_unauthorized') return '分享已失效。';
  if (code === 'recorder_forbidden' || code === 'auth_forbidden') return '沒有此會議的錄製權限。';
  if (code === 'auth_required' || code === 'auth_invalid') return '登入狀態已失效。';
  return '字幕分享連線目前無法使用。';
}
