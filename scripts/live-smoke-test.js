import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { isSupportedLanguage } from '../server/languages.js';
import { createLiveToken } from '../server/tokenService.js';
import { buildSmokeSummary, createReconnectPolicy, createTranscriptObserver, formatSmokeDuration, parseGoAwayDelay, pcmChunks, providerDiagnostic, readPcmWav, tokenRefreshDue } from './live-smoke-support.js';

const execFileAsync = promisify(execFile);
const ENABLED = process.env.ENABLE_REAL_GEMINI_TEST === 'true';
const TARGET_LANGUAGE = process.env.LIVE_SMOKE_TARGET_LANGUAGE || 'en';
const TIMEOUT_MS = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS || '15000', 10);
const DURATION_MS = Number.parseInt(process.env.LIVE_SMOKE_DURATION_MS || String(2 * 60 * 60 * 1000), 10);
const MAX_TOKEN_REQUESTS = Number.parseInt(process.env.LIVE_SMOKE_MAX_TOKEN_REQUESTS || '20', 10);
const SPEECH_TEXT = process.env.LIVE_SMOKE_SPEECH_TEXT || '這是一段長會議 Gemini transcription smoke test。';
const SPEECH_INTERVAL_MS = Number.parseInt(process.env.LIVE_SMOKE_SPEECH_INTERVAL_MS || '10000', 10);
const REQUIRE_RECONNECT = process.env.LIVE_SMOKE_REQUIRE_RECONNECT === 'true'
  || (process.env.LIVE_SMOKE_REQUIRE_RECONNECT === undefined && DURATION_MS >= 10 * 60 * 1000);

if (!ENABLED) {
  console.log('Skipping live smoke test. Set ENABLE_REAL_GEMINI_TEST=true to call the real Gemini Live API.');
  process.exit(0);
}

if (!process.env.GEMINI_API_KEY) fail('GEMINI_API_KEY is required when ENABLE_REAL_GEMINI_TEST=true.');
if (process.platform !== 'darwin') fail('The long-meeting Gemini smoke test requires macOS say and afconvert.');
if (!isSupportedLanguage(TARGET_LANGUAGE)) fail(`Unsupported LIVE_SMOKE_TARGET_LANGUAGE: ${TARGET_LANGUAGE}`);
if (!Number.isInteger(DURATION_MS) || DURATION_MS <= 0) fail('LIVE_SMOKE_DURATION_MS must be a positive integer.');
if (!Number.isInteger(MAX_TOKEN_REQUESTS) || MAX_TOKEN_REQUESTS <= 0) fail('LIVE_SMOKE_MAX_TOKEN_REQUESTS must be a positive integer.');
if (!Number.isInteger(SPEECH_INTERVAL_MS) || SPEECH_INTERVAL_MS <= 0) fail('LIVE_SMOKE_SPEECH_INTERVAL_MS must be a positive integer.');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSpeechPcm(tempDirectory) {
  const aiffPath = `${tempDirectory}/speech.aiff`;
  const wavPath = `${tempDirectory}/speech.wav`;
  await withTimeout(execFileAsync('/usr/bin/say', ['-o', aiffPath, SPEECH_TEXT]), TIMEOUT_MS);
  await withTimeout(execFileAsync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiffPath, wavPath]), TIMEOUT_MS);
  return pcmChunks(readPcmWav(await readFile(wavPath)));
}

async function main() {
  const startedAt = Date.now();
  console.log(`[smoke] starting ${DURATION_MS / 60000}-minute Gemini transcription test for target=${TARGET_LANGUAGE}`);
  let tempDirectory = null;
  const metrics = { tokenRequests: 0, tokenRefreshes: 0, providerConnections: 0, providerReconnects: 0, goAwayReconnectSuccesses: 0, goAwayReconnectFailures: 0, lastGoAwayTimeLeft: null, speechSamplesSent: 0, pcmChunksSent: 0, audioStreamEndSent: 0, providerFirstServerEvents: 0, interimTranscriptEvents: 0, inputTranscriptEvents: 0, boundaryEvents: 0, finalTranscriptEvents: 0, duplicateTranscriptEvents: 0 };
  const abnormalEvents = [];
  let goAwayEvents = 0;
  let terminalError = null;
  let status = 'failed';
  const reconnectPolicy = createReconnectPolicy();
  const transcriptObserver = createTranscriptObserver();
  let tokenResponse = null;
  let session = null;
  let resumptionHandle = null;
  let providerEpoch = 0;
  let reconnectTimer = null;
  let tokenRefreshTimer = null;
  let reconnectPromise = null;
  let closeExpected = false;
  let fatalError = null;
  let heartbeatTimer = null;
  let connectionHealthTimer = null;
  let handledProviderFailureEpoch = null;
  let goAwayEpoch = null;
  let goAwayReconnectPending = false;

  function recordAbnormalEvent(type, diagnostic = {}, error = null) {
    if (abnormalEvents.length >= 100) return;
    abnormalEvents.push({
      timestamp: new Date().toISOString(),
      type,
      ...(diagnostic.category ? { category: diagnostic.category } : {}),
      ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
      ...(diagnostic.code ? { code: diagnostic.code } : {}),
      message: diagnostic.message || error?.message || String(error || type),
      ...(diagnostic.consecutiveFailures === undefined ? {} : { consecutiveFailures: diagnostic.consecutiveFailures })
    });
  }

  function printSummary(endedAt) {
    const summary = buildSmokeSummary({ status, startedAt, endedAt, metrics, goAwayEvents, abnormalEvents, terminalError });
    console.log('[smoke] ===== 測試摘要 =====');
    console.log(`[smoke] 狀態：${summary.status === 'passed' ? '成功' : '失敗'}`);
    console.log(`[smoke] 開始時間：${summary.startedAt}`);
    console.log(`[smoke] 結束時間：${summary.endedAt}`);
    console.log(`[smoke] 總耗時：${formatSmokeDuration(summary.durationMs)} (${summary.durationMs}ms)`);
    console.log(`[smoke] Provider 連線次數：${summary.providerConnections}`);
    console.log(`[smoke] Provider 重連次數：${summary.providerReconnects}`);
    console.log(`[smoke] Token 請求次數：${summary.tokenRequests}`);
    console.log(`[smoke] GoAway 次數：${summary.goAwayEvents}`);
    console.log(`[smoke] GoAway 重連成功／失敗：${summary.goAwayReconnectSuccesses}/${summary.goAwayReconnectFailures}`);
    if (summary.lastGoAwayTimeLeft) console.log(`[smoke] 最後 GoAway 剩餘時間：${summary.lastGoAwayTimeLeft}`);
    console.log(`[smoke] 異常事件次數：${summary.abnormalEvents.length}`);
    console.log(`[smoke] 音訊 sample/chunk/end：${summary.speechSamplesSent}/${summary.pcmChunksSent}/${summary.audioStreamEndSent}`);
    console.log(`[smoke] Provider server event/interim/final/boundary：${summary.providerFirstServerEvents}/${summary.interimTranscriptEvents}/${summary.inputTranscriptEvents}/${summary.boundaryEvents}`);
    console.log(`[smoke] 最終轉錄事件：${summary.finalTranscriptEvents}`);
    if (summary.terminalError) console.log(`[smoke] 最後錯誤：${summary.terminalError}`);
    for (const [index, event] of summary.abnormalEvents.entries()) {
      console.log(`[smoke] 異常事件 ${index + 1}：${event.type} ${event.code ? `code=${event.code} ` : ''}${event.message}`);
    }
    console.log('[smoke] =====================');
    console.log(JSON.stringify(summary, null, 2));
  }

  async function getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && tokenResponse && !tokenRefreshDue(tokenResponse.expiresAt)) return tokenResponse;
    console.log(`[smoke] requesting ${forceRefresh ? 'refreshed ' : ''}ephemeral token`);
    tokenResponse = await createLiveToken({ mode: 'transcription', targetLanguageCode: TARGET_LANGUAGE, sourceLanguageCode: 'zh-Hant', echoTargetLanguage: false });
    metrics.tokenRequests += 1;
    if (metrics.tokenRequests > 1) metrics.tokenRefreshes += 1;
    console.log(`[smoke] token ready (requests=${metrics.tokenRequests}, refreshes=${metrics.tokenRefreshes})`);
    scheduleTokenRefresh();
    return tokenResponse;
  }

  function scheduleTokenRefresh() {
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    const delay = Math.max(0, Date.parse(tokenResponse.expiresAt) - Date.now() - (5 * 60 * 1000));
    tokenRefreshTimer = setTimeout(() => {
      tokenRefreshTimer = null;
      void reconnectProvider({ forceRefresh: true }).catch((error) => { fatalError = error; });
    }, delay);
  }

  async function connectProvider({ forceRefresh = false } = {}) {
    const currentToken = await getToken({ forceRefresh });
    console.log(`[smoke] connecting to Gemini Live${resumptionHandle ? ' with session resumption' : ''}`);
    const ai = new GoogleGenAI({ apiKey: currentToken.token, httpOptions: { apiVersion: 'v1alpha' } });
    const epoch = ++providerEpoch;
    const config = { ...currentToken.liveConnectConfig, ...(resumptionHandle ? { sessionResumption: { handle: resumptionHandle } } : {}) };
    const connected = await withTimeout(ai.live.connect({
      model: currentToken.liveConnectModel,
      config,
      callbacks: {
        onmessage(message) {
          if (epoch !== providerEpoch) return;
          if (message?.sessionResumptionUpdate?.newHandle) resumptionHandle = message.sessionResumptionUpdate.newHandle;
          const content = message?.serverContent;
          if (content) {
            if (!metrics.providerFirstServerEvents) metrics.providerFirstServerEvents += 1;
            if (content.interimInputTranscription?.text) metrics.interimTranscriptEvents += 1;
            if (content.inputTranscription?.text) metrics.inputTranscriptEvents += 1;
            if (content.turnComplete || content.generationComplete) metrics.boundaryEvents += 1;
          }
          if (message?.goAway) {
            goAwayEpoch = epoch;
            goAwayEvents += 1;
            metrics.lastGoAwayTimeLeft = message.goAway.timeLeft ?? null;
            scheduleReconnect(message.goAway.timeLeft, providerDiagnostic('go_away', message));
          }
          for (const event of transcriptObserver.observe(message)) {
            if (event.duplicate) metrics.duplicateTranscriptEvents += 1;
            else metrics.finalTranscriptEvents += 1;
          }
        },
        onerror(error) { handleProviderFailure('error', error, epoch); },
        onclose(event) { handleProviderFailure('close', event, epoch); }
      }
    }), TIMEOUT_MS);
    if (closeExpected || epoch !== providerEpoch) {
      connected.close?.();
      return false;
    }
    session = connected;
    metrics.providerConnections += 1;
    if (connectionHealthTimer) clearTimeout(connectionHealthTimer);
    connectionHealthTimer = setTimeout(() => {
      connectionHealthTimer = null;
      reconnectPolicy.recordSuccess();
      metrics.consecutiveReconnectFailures = 0;
    }, 10000);
    console.log(`[smoke] provider connected (connections=${metrics.providerConnections})`);
    return true;
  }

  function logProviderDiagnostic(diagnostic) {
    metrics.lastProviderFailureCategory = diagnostic.category;
    metrics.lastProviderFailureMessage = diagnostic.message;
    console.error(`[smoke] provider ${diagnostic.event}: ${[
      diagnostic.status === undefined ? '' : `status=${diagnostic.status}`,
      diagnostic.code ? `code=${diagnostic.code}` : '',
      `message=${diagnostic.message}`,
      diagnostic.resumptionHandlePresent ? 'resumptionHandlePresent=true' : ''
    ].filter(Boolean).join(' ')}`);
  }

  function handleProviderFailure(event, payload, epoch) {
    if (closeExpected || epoch !== providerEpoch || goAwayEpoch === epoch || handledProviderFailureEpoch === epoch) return;
    handledProviderFailureEpoch = epoch;
    if (connectionHealthTimer) {
      clearTimeout(connectionHealthTimer);
      connectionHealthTimer = null;
    }
    const diagnostic = providerDiagnostic(event, payload);
    const result = reconnectPolicy.recordFailure(diagnostic);
    metrics.consecutiveReconnectFailures = reconnectPolicy.consecutiveFailures;
    recordAbnormalEvent(diagnostic.event, result.diagnostic);
    logProviderDiagnostic(result.diagnostic);
    if (result.fatal) {
      fatalError = new Error(`Provider reconnect failure limit reached (${result.diagnostic.consecutiveFailures}).`);
      fatalError.providerDiagnostic = result.diagnostic;
      return;
    }
    scheduleReconnect(result.delayMs, result.diagnostic);
  }

  function scheduleReconnect(timeLeft, diagnostic = null) {
    if (closeExpected || reconnectTimer) return;
    if (diagnostic?.event === 'go_away') goAwayReconnectPending = true;
    const delay = diagnostic?.event === 'go_away' ? parseGoAwayDelay(timeLeft) : Math.max(0, Number(timeLeft) || 0);
    console.log(`[smoke] provider reconnect scheduled in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const isGoAwayReconnect = goAwayReconnectPending;
      goAwayReconnectPending = false;
      void reconnectProvider({ reason: isGoAwayReconnect ? 'go_away' : 'provider_failure' }).catch((error) => { fatalError = error; });
    }, delay);
  }

  async function reconnectProvider({ forceRefresh = false, reason = 'provider_failure' } = {}) {
    if (closeExpected) return false;
    if (reconnectPromise) return reconnectPromise;
    reconnectPromise = (async () => {
      console.log('[smoke] reconnecting provider with a fresh ephemeral token');
      const previous = session;
      session = null;
      providerEpoch += 1;
      previous?.close?.();
      try {
        // Ephemeral tokens are single-use for starting a Live session. A provider
        // reconnect must provision a new token even when the cached token has not
        // reached its message expiration window yet.
        const resumed = await connectProvider({ forceRefresh: true });
        if (resumed) {
          metrics.providerReconnects += 1;
          if (reason === 'go_away') metrics.goAwayReconnectSuccesses += 1;
        } else if (reason === 'go_away') {
          metrics.goAwayReconnectFailures += 1;
        }
        return resumed;
      } catch (error) {
        const result = reconnectPolicy.recordFailure(providerDiagnostic('error', error));
        metrics.consecutiveReconnectFailures = reconnectPolicy.consecutiveFailures;
        recordAbnormalEvent('error', result.diagnostic);
        logProviderDiagnostic(result.diagnostic);
        if (reason === 'go_away') metrics.goAwayReconnectFailures += 1;
        if (result.fatal) {
          fatalError = new Error(`Provider reconnect failure limit reached (${result.diagnostic.consecutiveFailures}).`);
          fatalError.providerDiagnostic = result.diagnostic;
        } else scheduleReconnect(result.delayMs, result.diagnostic);
        return false;
      }
    })().finally(() => { reconnectPromise = null; });
    return reconnectPromise;
  }

  try {
    tempDirectory = await mkdtemp(`${tmpdir()}/live-translate-smoke-`);
    console.log('[smoke] generating speech sample with macOS say/afconvert');
    const audioChunks = await createSpeechPcm(tempDirectory);
    if (audioChunks.length === 0) throw new Error('Generated speech contains no PCM samples.');
    console.log(`[smoke] speech sample ready (${audioChunks.length} PCM chunks)`);
    if (!(await connectProvider())) throw new Error('Initial Gemini Live connection was not established.');
    const endAt = Date.now() + DURATION_MS;
    heartbeatTimer = setInterval(() => {
      console.log(`[smoke] heartbeat elapsed=${formatSmokeDuration(Date.now() - startedAt)} tokenRequests=${metrics.tokenRequests} providerConnections=${metrics.providerConnections} providerReconnects=${metrics.providerReconnects} consecutiveReconnectFailures=${metrics.consecutiveReconnectFailures || 0} lastProviderFailureCategory=${metrics.lastProviderFailureCategory || 'none'} lastProviderFailureMessage=${metrics.lastProviderFailureMessage || 'none'} finalTranscriptEvents=${metrics.finalTranscriptEvents} duplicateTranscriptEvents=${metrics.duplicateTranscriptEvents}`);
    }, 60 * 1000);
    let nextSpeechAt = Date.now();
    let speechSampleCount = 0;
    while (Date.now() < endAt) {
      if (fatalError) throw fatalError;
      if (Date.now() >= nextSpeechAt && session) {
        for (const chunk of audioChunks) {
          if (Date.now() >= endAt) break;
          session?.sendRealtimeInput({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
          metrics.pcmChunksSent += 1;
          await sleep(100);
        }
        session?.sendRealtimeInput({ audioStreamEnd: true });
        metrics.audioStreamEndSent += 1;
        speechSampleCount += 1;
        metrics.speechSamplesSent += 1;
        console.log(`[smoke] speech sample ${speechSampleCount} sent (transcript events=${metrics.finalTranscriptEvents})`);
        nextSpeechAt = Date.now() + SPEECH_INTERVAL_MS;
      } else await sleep(Math.min(250, Math.max(25, nextSpeechAt - Date.now())));
    }
    if (fatalError) throw fatalError;
    if (metrics.tokenRequests > MAX_TOKEN_REQUESTS) {
      const error = new Error(`Token request limit exceeded: ${metrics.tokenRequests} > ${MAX_TOKEN_REQUESTS}.`);
      recordAbnormalEvent('token_limit', {}, error);
      throw error;
    }
    if (REQUIRE_RECONNECT && metrics.providerReconnects === 0) throw new Error('Gemini did not complete a provider reconnect during the long-meeting run.');
    if (metrics.finalTranscriptEvents === 0) {
      const error = new Error('Gemini returned no final source transcript events.');
      recordAbnormalEvent('test_failure', {}, error);
      throw error;
    }
    status = 'passed';
    console.log(`Gemini long-meeting smoke test passed for ${DURATION_MS / 60000} minutes.`);
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    closeExpected = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (connectionHealthTimer) clearTimeout(connectionHealthTimer);
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try { session?.close?.(); } catch { /* best effort */ }
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    printSummary(Date.now());
  }
}

main().catch((error) => {
  if (error?.providerDiagnostic) {
    const diagnostic = error.providerDiagnostic;
    console.error(`Gemini provider token creation failed (${diagnostic.category}). ${[
      diagnostic.status === undefined ? '' : `status=${diagnostic.status}`,
      diagnostic.code ? `code=${diagnostic.code}` : '',
      diagnostic.message ? `message=${diagnostic.message}` : ''
    ].filter(Boolean).join(' ')}`);
  } else {
    console.error(error.message || error);
  }
  process.exit(1);
});
