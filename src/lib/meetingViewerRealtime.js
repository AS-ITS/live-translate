import { supabase } from './supabaseAuth.js';

const TOKEN_REFRESH_SKEW_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function meetingViewerRealtimeEnabled() {
  return Boolean(supabase && import.meta.env?.VITE_SUPABASE_URL);
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
  client = supabase,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout
} = {}) {
  if (!client || !basePath) throw new TypeError('Meeting Viewer Realtime requires a Supabase client and base path.');
  let stopped = false;
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
      if (!response.ok) throw new Error(response.status === 404 ? '分享連結無效或已過期。' : '無法取得即時字幕權限。');
      const authorization = await response.json();
      if (stopped || currentGeneration !== generation) return;
      await client.realtime.setAuth(authorization.accessToken);
      if (channel) await client.removeChannel(channel);
      channel = client
        .channel(authorization.channel, { config: { private: true } })
        .on('broadcast', { event: 'cue.append' }, (message) => onEvent?.(message?.payload || message));
      channel.subscribe(async (status) => {
        if (stopped || currentGeneration !== generation) return;
        if (status === 'SUBSCRIBED') {
          reconnectAttempts = 0;
          try {
            await onSubscribed?.({
              async replay(afterEventId = 0) {
                const response = await fetchImpl(`${replayPath}?after=${encodeURIComponent(afterEventId)}`);
                if (!response.ok) throw new Error('無法補抓遺失的即時字幕。');
                const result = await response.json();
                onTelemetry?.('replay_success');
                return result;
              }
            });
          } catch (error) {
            onTelemetry?.('replay_failure');
            onError?.(error);
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
    if (previous) await client.removeChannel(previous).catch(() => {});
    await connect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(1000 * (2 ** reconnectAttempts), MAX_RECONNECT_DELAY_MS);
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
      if (previous) await client.removeChannel(previous).catch(() => {});
    }
  });
}
