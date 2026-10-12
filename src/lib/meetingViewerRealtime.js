import { createSupabaseViewerRealtimeClient, isSupabaseConfigured } from './supabaseAuth.js';
import { recordLivePipelineTrace } from './livePipelineTrace.js';

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
  let tokenRefreshTimer = null;
  let reconnectAttempts = 0;
  let generation = 0;

  function recordRealtimeTrace(details) {
    recordLivePipelineTrace({ stage: 'VIEWER_REALTIME', ...details });
    recordLivePipelineTrace({
      stage: 'REALTIME_STATE_CHANGED',
      realtimeState: details.transportResult,
      ...details,
    });
  }

  async function connect() {
    const currentGeneration = ++generation;
    const isCurrent = () => !stopped && currentGeneration === generation;
    clearScheduledReconnect();
    recordRealtimeTrace({
      eventType: 'token.request', transportGeneration: currentGeneration,
      transportResult: 'connecting',
    });
    onConnecting?.();
    try {
      const response = await fetchImpl(`${basePath}/realtime-token`, { method: 'POST' });
      const authorization = await response.json().catch(() => null);
      if (!response.ok) throw createRealtimeError(response.status, authorization);
      if (!isCurrent()) return;
      recordRealtimeTrace({
        eventType: 'token.received', transportGeneration: currentGeneration,
        transportResult: 'authorized',
      });
      accessToken = authorization.accessToken;
      if (!realtimeClient) realtimeClient = clientFactory(async () => accessToken);
      if (!realtimeClient) throw new Error('無法建立即時字幕連線。');
      if (client) await realtimeClient.realtime.setAuth(accessToken);
      else await realtimeClient.realtime.setAuth();
      if (!isCurrent()) return;
      if (channel) await realtimeClient.removeChannel(channel);
      if (!isCurrent()) return;
      channel = realtimeClient
        .channel(authorization.channel, { config: { private: true } })
        .on('broadcast', { event: 'cue.append' }, (message) => {
          if (isCurrent()) onEvent?.(message?.payload || message);
        });
      channel.subscribe(async (status) => {
        if (!isCurrent()) return;
        recordRealtimeTrace({
          eventType: 'channel.status', channelStatus: status,
          transportGeneration: currentGeneration, transportResult: status,
        });
        if (status === 'SUBSCRIBED') {
          try {
            await onSubscribed?.({
              isCurrent,
              async replay(afterEventId = 0) {
                if (!isCurrent()) return { events: [] };
                const response = await fetchImpl(`${replayPath}?after=${encodeURIComponent(afterEventId)}`, {
                  headers: { Accept: 'application/json' }
                });
                if (!isCurrent()) return { events: [] };
                if (!response.ok) throw new Error('無法補抓遺失的即時字幕。');
                const result = await response.json();
                if (!isCurrent()) return { events: [] };
                onTelemetry?.('replay_success');
                return result;
              }
            });
            if (!isCurrent()) return;
          } catch (error) {
            if (!isCurrent()) return;
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
          reconnectAttempts = 0;
          const refreshDelay = Math.max(1000, Number(authorization.expiresAt) - Date.now() - TOKEN_REFRESH_SKEW_MS);
          clearTokenRefresh();
          tokenRefreshTimer = setTimer(() => {
            tokenRefreshTimer = null;
            void reconnect();
          }, refreshDelay);
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          const error = new Error('即時字幕連線已中斷。');
          error.code = 'realtime_channel_interrupted';
          error.channelStatus = status;
          error.generation = currentGeneration;
          onError?.(error);
          scheduleReconnect();
        }
      });
    } catch (error) {
      if (!isCurrent()) return;
      recordRealtimeTrace({
        eventType: 'connect.failed', transportGeneration: currentGeneration,
        reason: error?.code || error?.message, transportResult: 'failed',
      });
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
    clearTokenRefresh();
    const previous = channel;
    channel = null;
    if (previous) await realtimeClient?.removeChannel(previous).catch(() => {});
    await connect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    clearTokenRefresh();
    if (reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      const exhausted = new Error('多次重新連線後仍無法取得即時字幕。');
      exhausted.code = 'viewer_retry_exhausted';
      onError?.(exhausted);
      stopped = true;
      return;
    }
    const delay = jitter(RECONNECT_DELAYS_MS[reconnectAttempts], random);
    reconnectAttempts += 1;
    recordRealtimeTrace({
      eventType: 'reconnect.scheduled',
      transportGeneration: generation, eventSequence: reconnectAttempts,
      decision: 'retry', transportResult: 'scheduled',
    });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void reconnect();
    }, delay);
  }

  function clearScheduledReconnect() {
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
  }

  function clearTokenRefresh() {
    if (tokenRefreshTimer) clearTimer(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }

  return Object.freeze({
    start() {
      void connect();
    },
    async stop() {
      stopped = true;
      generation += 1;
      clearScheduledReconnect();
      clearTokenRefresh();
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
