import { accessTokenHeaders } from './accessToken.js';

const MAX_RECONNECT_ATTEMPTS_BEFORE_POLLING = 2;

export function subscribeToExecutionEvents({
  sessionId,
  WebSocketImpl = globalThis.WebSocket,
  onSnapshot = () => {},
  onStatus = () => {},
  refetch = async () => {},
  poll = async () => {},
  pollIntervalMs = 2000,
  baseUrl = ''
} = {}) {
  if (!sessionId || typeof WebSocketImpl !== 'function') return () => {};
  let socket;
  let stopped = false;
  let reconnectTimer;
  let pollingTimer;
  let reconnectAttempts = 0;
  let polling = false;

  connect();
  return cleanup;

  function connect() {
    if (stopped) return;
    onStatus('connecting');
    socket = new WebSocketImpl(webSocketUrl(baseUrl, sessionId));
    socket.addEventListener('open', async () => {
      socket.send(JSON.stringify({ type: 'auth', token: tokenFromHeaders() }));
      reconnectAttempts = 0;
      stopPolling();
      try { await refetch(); } catch { /* REST remains available on the next event/poll. */ }
      if (!stopped) onStatus('connected');
    });
    socket.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload?.type !== 'execution.snapshot' || !payload.execution || typeof payload.execution.id !== 'string') return;
      onSnapshot(payload);
    });
    socket.addEventListener('error', () => onStatus('reconnecting'));
    socket.addEventListener('close', () => {
      if (stopped) return;
      onStatus('reconnecting');
      reconnectAttempts += 1;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS_BEFORE_POLLING) startPolling();
      reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000));
    });
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    onStatus('polling');
    const run = async () => {
      if (stopped || !polling) return;
      try { await poll(); } finally { pollingTimer = window.setTimeout(run, pollIntervalMs); }
    };
    void run();
  }

  function stopPolling() {
    polling = false;
    if (pollingTimer !== undefined) window.clearTimeout(pollingTimer);
    pollingTimer = undefined;
  }

  function cleanup() {
    stopped = true;
    window.clearTimeout(reconnectTimer);
    stopPolling();
    socket?.close();
    socket = undefined;
    onStatus('closed');
  }
}

function tokenFromHeaders() {
  const authorization = accessTokenHeaders({}).Authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
}

function webSocketUrl(baseUrl, sessionId) {
  const configured = String(baseUrl || '');
  if (configured.startsWith('http://') || configured.startsWith('https://')) {
    const url = new URL(configured);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `/api/sessions/${encodeURIComponent(sessionId)}/execution-events`;
    return url.toString();
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${configured}/api/sessions/${encodeURIComponent(sessionId)}/execution-events`;
}
