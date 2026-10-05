import { createSupabaseViewerRealtimeClient, isSupabaseConfigured } from './supabaseAuth.js';

const TOKEN_REFRESH_SKEW_MS = 30_000;
const RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);

export function meetingViewerRealtimeEnabled() {
  return import.meta.env?.VITE_MEETING_VIEWER_REALTIME_ENABLED !== 'false'
    && isSupabaseConfigured();
}

export function createMeetingViewerRealtimeController({
  basePath,
  onEvent,
  onSubscribed,
  replayPath = `${basePath}/events`,
  onConnecting,
  onTelemetry,
  onError,
  fetchImpl = globalThis.fetch,
  client = null,
  clientFactory = createSupabaseViewerRealtimeClient,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  random = Math.random
} = {}) {
  if ((!client && typeof clientFactory !== 'function') || !basePath) {
    throw new TypeError('Meeting Viewer Realtime requires a Supabase client and base path.');
  }
  let stopped = false;
  let realtimeClient = client;
  let accessToken = null;
  let channel = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let generation = 0;

  async function connect() {
    const currentGeneration = ++generation;
    clearScheduledReconnect();
    onConnecting?.();
    try {
      const response = await fetchImpl(`${basePath}/realtime-token`, { method: 'POST' });
      const authorization = await response.json().catch(() => null);
      if (!response.ok) throw createRealtimeError(response.status, authorization);
      if (stopped || currentGeneration !== generation) return;
      accessToken = authorization.accessToken;
      if (!realtimeClient) realtimeClient = clientFactory(async () => accessToken);
      if (!realtimeClient) throw new Error('無法建立即時字幕連線。');
      if (client) await realtimeClient.realtime.setAuth(accessToken);
      else await realtimeClient.realtime.setAuth();
      if (channel) await realtimeClient.removeChannel(channel);
      channel = realtimeClient
        .channel(authorization.channel, { config: { private: true } })
        .on('broadcast', { event: 'cue.append' }, (message) => onEvent?.(message?.payload || message));
      channel.subscribe(async (status) => {
        if (stopped || currentGeneration !== generation) return;
        if (status === 'SUBSCRIBED') {
          reconnectAttempts = 0;
          try {
            await onSubscribed?.({
              async replay(afterEventId = 0) {
                const response = await fetchImpl(`${replayPath}?after=${encodeURIComponent(afterEventId)}`, {
                  headers: { Accept: 'application/json' }
                });
                if (!response.ok) throw new Error('無法補抓遺失的即時字幕。');
                const result = await response.json();
                onTelemetry?.('replay_success');
                return result;
              }
            });
          } catch (error) {
            onTelemetry?.('replay_failure');
            onError?.(error);
            if (isTerminalRealtimeError(error)) {
              stopped = true;
              clearScheduledReconnect();
              return;
            }
            scheduleReconnect();
            return;
          }
          const refreshDelay = Math.max(1000, Number(authorization.expiresAt) - Date.now() - TOKEN_REFRESH_SKEW_MS);
          reconnectTimer = setTimer(() => void reconnect(), refreshDelay);
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          scheduleReconnect();
        }
      });
    } catch (error) {
      if (stopped || currentGeneration !== generation) return;
      onError?.(error);
      if (isTerminalRealtimeError(error)) {
        stopped = true;
        clearScheduledReconnect();
        return;
      }
      scheduleReconnect();
    }
  }

  async function reconnect() {
    if (stopped) return;
    onTelemetry?.('reconnect');
    generation += 1;
    clearScheduledReconnect();
    const previous = channel;
    channel = null;
    if (previous) await realtimeClient?.removeChannel(previous).catch(() => {});
    await connect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    if (reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      const exhausted = new Error('多次重新連線後仍無法取得即時字幕。');
      exhausted.code = 'viewer_retry_exhausted';
      onError?.(exhausted);
      stopped = true;
      return;
    }
    const delay = jitter(RECONNECT_DELAYS_MS[reconnectAttempts], random);
    reconnectAttempts += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void reconnect();
    }, delay);
  }

  function clearScheduledReconnect() {
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
  }

  return Object.freeze({
    start() {
      void connect();
    },
    async stop() {
      stopped = true;
      generation += 1;
      clearScheduledReconnect();
      const previous = channel;
      channel = null;
      if (previous) await realtimeClient?.removeChannel(previous).catch(() => {});
    }
  });
}

function jitter(delay, random) {
  const sample = Math.min(1, Math.max(0, Number(random?.()) || 0));
  return Math.round(delay * (0.75 + sample * 0.5));
}

function isTerminalRealtimeError(error) {
  return ['meeting_stopped', 'meeting_revoked', 'share_unauthorized', 'viewer_retry_exhausted'].includes(error?.code);
}

function createRealtimeError(status, body) {
  const responseCode = body?.error?.code || body?.code;
  const stopped = responseCode === 'meeting_stopped' || responseCode === 'meeting_revoked' || status === 410;
  const unauthorized = responseCode === 'share_unauthorized' || status === 403 || status === 404;
  const error = new Error(stopped ? '會議已停止。' : (unauthorized ? '分享連結無效或已過期。' : '無法取得即時字幕權限。'));
  error.code = stopped ? (responseCode === 'meeting_revoked' ? 'meeting_revoked' : 'meeting_stopped')
    : (unauthorized ? 'share_unauthorized' : 'viewer_unavailable');
  error.status = status;
  return error;
}
