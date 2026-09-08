export const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;
export const DEFAULT_PCM_CHUNK_MS = 100;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;
export const DEFAULT_MAX_CONSECUTIVE_RECONNECT_FAILURES = 5;
export const DEFAULT_RECONNECT_JITTER_MS = 250;

export function formatSmokeDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours > 0 ? `${hours} 小時 ` : ''}${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

export function buildSmokeSummary({ status, startedAt, endedAt, metrics = {}, goAwayEvents = 0, abnormalEvents = [], terminalError = null }) {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  return {
    status,
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    durationMs: Math.max(0, end.getTime() - start.getTime()),
    providerConnections: metrics.providerConnections || 0,
    providerReconnects: metrics.providerReconnects || 0,
    tokenRequests: metrics.tokenRequests || 0,
    goAwayEvents,
    goAwayReconnectSuccesses: metrics.goAwayReconnectSuccesses || 0,
    goAwayReconnectFailures: metrics.goAwayReconnectFailures || 0,
    lastGoAwayTimeLeft: metrics.lastGoAwayTimeLeft || null,
    speechSamplesSent: metrics.speechSamplesSent || 0,
    pcmChunksSent: metrics.pcmChunksSent || 0,
    audioStreamEndSent: metrics.audioStreamEndSent || 0,
    providerFirstServerEvents: metrics.providerFirstServerEvents || 0,
    interimTranscriptEvents: metrics.interimTranscriptEvents || 0,
    inputTranscriptEvents: metrics.inputTranscriptEvents || 0,
    boundaryEvents: metrics.boundaryEvents || 0,
    consecutiveReconnectFailures: metrics.consecutiveReconnectFailures || 0,
    finalTranscriptEvents: metrics.finalTranscriptEvents || 0,
    duplicateTranscriptEvents: metrics.duplicateTranscriptEvents || 0,
    abnormalEvents,
    terminalError: terminalError ? String(terminalError.message || terminalError) : null
  };
}

export function tokenRefreshDue(expiresAt, now = Date.now(), safetyMs = TOKEN_REFRESH_SAFETY_MS) {
  const expiry = Date.parse(expiresAt || '');
  return !Number.isFinite(expiry) || expiry - now <= safetyMs;
}

export function parseGoAwayDelay(timeLeft, maxDelayMs = 30000) {
  const match = String(timeLeft ?? '').trim().match(/^([\d.]+)\s*(ms|s|m)?$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multiplier = unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  return Math.max(0, Math.min(value * multiplier, maxDelayMs));
}

function redactProviderMessage(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(authorization|api[-_ ]?key|token|ephemeral(?:[-_ ]?token)?|resumption(?:[-_ ]?handle)?)\s*[:=]\s*[^\s,;}]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function providerDiagnostic(event, payload = {}) {
  const source = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const status = source?.status ?? source?.statusCode ?? source?.error?.status;
  const code = source?.code ?? source?.error?.code;
  const message = redactProviderMessage(source?.message ?? source?.reason ?? source?.error?.message ?? source?.error ?? event);
  return {
    category: event === 'go_away' ? 'go_away' : 'provider_error',
    event,
    ...(Number.isFinite(Number(status)) ? { status: Number(status) } : {}),
    ...(code === undefined || code === null ? {} : { code: redactProviderMessage(code) }),
    message: message || 'Provider connection closed without a message.',
    retryable: event === 'go_away' || ![400, 401, 403].includes(Number(status)),
    resumptionHandlePresent: Boolean(payload?.sessionResumptionUpdate?.newHandle || payload?.resumptionHandle || payload?.handle)
  };
}

export function reconnectDelay(consecutiveFailures, { maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS, jitterMs = DEFAULT_RECONNECT_JITTER_MS, random = Math.random } = {}) {
  const attempt = Math.max(1, Math.floor(Number(consecutiveFailures) || 1));
  const base = Math.min(1000 * (2 ** (attempt - 1)), maxDelayMs);
  const jitter = Math.max(0, Math.min(jitterMs, Math.floor(random() * (jitterMs + 1))));
  return Math.min(maxDelayMs, base + jitter);
}

export function createReconnectPolicy({ maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_RECONNECT_FAILURES, maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS, jitterMs = DEFAULT_RECONNECT_JITTER_MS, random = Math.random } = {}) {
  let consecutiveFailures = 0;
  return {
    get consecutiveFailures() { return consecutiveFailures; },
    recordFailure(diagnostic) {
      consecutiveFailures += 1;
      return {
        diagnostic: { ...diagnostic, consecutiveFailures },
        delayMs: reconnectDelay(consecutiveFailures, { maxDelayMs, jitterMs, random }),
        fatal: consecutiveFailures >= maxConsecutiveFailures
      };
    },
    recordSuccess() {
      consecutiveFailures = 0;
    }
  };
}

export function transcriptEventKey(message, fallbackSequence) {
  return message?.eventId || message?.event_id || message?.id || `message:${fallbackSequence}`;
}

export function createTranscriptObserver() {
  let pendingInputTranscript = null;
  let awaitingInputTranscriptAfterBoundary = false;
  let sequence = 0;
  const finalizedIds = new Set();

  function observe(message = {}) {
    const content = message?.serverContent || {};
    const inputText = content?.inputTranscription?.text;
    const interimText = content?.interimInputTranscription?.text;
    const isBoundary = Boolean(content.turnComplete || content.generationComplete);
    const events = [];

    if (inputText) {
      const eventId = transcriptEventKey(message, ++sequence);
      const transcript = {
        eventId,
        text: String(inputText),
        isLateTranscript: awaitingInputTranscriptAfterBoundary
      };
      // Gemini's inputTranscription is the authoritative finalized field.
      // Keep boundary handling below for providers/messages that deliver an
      // interim hypothesis before the boundary and no final field.
      events.push(finalize(transcript));
      pendingInputTranscript = null;
      awaitingInputTranscriptAfterBoundary = false;
    } else if (interimText) {
      const eventId = transcriptEventKey(message, ++sequence);
      pendingInputTranscript = {
        eventId,
        text: String(interimText),
        isLateTranscript: awaitingInputTranscriptAfterBoundary
      };
    }

    if (isBoundary) {
      if (pendingInputTranscript) {
        events.push(finalize({ ...pendingInputTranscript, isLateTranscript: false }));
        pendingInputTranscript = null;
        awaitingInputTranscriptAfterBoundary = true;
      } else if (!inputText) {
        awaitingInputTranscriptAfterBoundary = true;
      }
    }

    return events.filter(Boolean);
  }

  function finalize(transcript) {
    const key = transcript.eventId || `transcript:${sequence}:${transcript.text}`;
    if (finalizedIds.has(key)) return { duplicate: true, key };
    finalizedIds.add(key);
    return { duplicate: false, key, ...transcript };
  }

  return {
    observe,
    get pendingInputTranscript() { return pendingInputTranscript; },
    get finalizedCount() { return finalizedIds.size; }
  };
}

export function readPcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Generated audio is not a valid WAV file.');
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) throw new Error('Generated WAV file is truncated.');
    if (chunkId === 'fmt ' && chunkSize >= 16) format = { audioFormat: buffer.readUInt16LE(chunkStart), channels: buffer.readUInt16LE(chunkStart + 2), sampleRate: buffer.readUInt32LE(chunkStart + 4), bitsPerSample: buffer.readUInt16LE(chunkStart + 14) };
    if (chunkId === 'data') data = buffer.subarray(chunkStart, chunkEnd);
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bitsPerSample !== 16) throw new Error('Generated WAV must be signed PCM, mono, 16kHz, 16-bit.');
  return data;
}

export function pcmChunks(pcm, { chunkMs = DEFAULT_PCM_CHUNK_MS, sampleRate = 16000, bytesPerSample = 2 } = {}) {
  const bytesPerChunk = Math.max(bytesPerSample, Math.floor(sampleRate * bytesPerSample * chunkMs / 1000));
  const chunks = [];
  for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) chunks.push(pcm.subarray(offset, Math.min(offset + bytesPerChunk, pcm.length)));
  return chunks;
}
