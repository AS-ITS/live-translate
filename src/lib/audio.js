export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const CHUNK_MS = 100;
const WAV_HEADER_BYTES = 44;

export function resampleLinear(samples, sourceRate, targetRate = INPUT_SAMPLE_RATE) {
  if (sourceRate === targetRate) {
    return samples;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(lower + 1, samples.length - 1);
    const weight = sourceIndex - lower;
    output[index] = samples[lower] * (1 - weight) + samples[upper] * weight;
  }

  return output;
}

export function floatToPcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(index * 2, value, true);
  }

  return new Uint8Array(buffer);
}

export function pcm16ToFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function createPcmChunker({ sourceRate, targetRate = INPUT_SAMPLE_RATE, chunkMs = CHUNK_MS }) {
  const chunkSamples = Math.round((targetRate * chunkMs) / 1000);
  let pending = new Float32Array(0);

  return {
    push(inputSamples) {
      const resampled = resampleLinear(inputSamples, sourceRate, targetRate);
      const combined = new Float32Array(pending.length + resampled.length);
      combined.set(pending);
      combined.set(resampled, pending.length);

      const chunks = [];
      let offset = 0;

      while (offset + chunkSamples <= combined.length) {
        chunks.push(floatToPcm16(combined.subarray(offset, offset + chunkSamples)));
        offset += chunkSamples;
      }

      pending = combined.subarray(offset);
      return chunks;
    },
    reset() {
      pending = new Float32Array(0);
    }
  };
}

export function pcm16ChunksToWavBlob(chunks = [], {
  sampleRate = OUTPUT_SAMPLE_RATE,
  normalizePeak = false,
  targetPeak = 0.95,
  BlobImpl = globalThis.Blob
} = {}) {
  if (typeof BlobImpl !== 'function') {
    throw new TypeError('Blob is not available.');
  }

  const pcmBytes = normalizePeak
    ? normalizePcm16Peak(concatenateBytes(chunks), { targetPeak })
    : concatenateBytes(chunks);
  const wavBytes = new Uint8Array(WAV_HEADER_BYTES + pcmBytes.byteLength);
  const view = new DataView(wavBytes.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);
  wavBytes.set(pcmBytes, WAV_HEADER_BYTES);

  return new BlobImpl([wavBytes], { type: 'audio/wav' });
}

export function buildTranslatedAudioFileName({ sessionId = '', startedAt = null } = {}) {
  const safeSessionId = sanitizeFilePart(sessionId) || 'session';
  return `live-translate-translated-audio-${safeSessionId}-${timestampForFileName(startedAt)}.wav`;
}

export function buildInputAudioFileName({ sessionId = '', startedAt = null } = {}) {
  const safeSessionId = sanitizeFilePart(sessionId) || 'session';
  return `live-translate-input-audio-${safeSessionId}-${timestampForFileName(startedAt)}.wav`;
}

export function normalizePcm16Peak(bytes, { targetPeak = 0.95 } = {}) {
  if (!bytes || bytes.byteLength === 0) {
    return new Uint8Array(0);
  }

  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const output = new Uint8Array(source);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let maxAbs = 0;

  for (let offset = 0; offset + 1 < output.byteLength; offset += 2) {
    maxAbs = Math.max(maxAbs, Math.abs(view.getInt16(offset, true)));
  }

  if (maxAbs === 0) {
    return output;
  }

  const safeTargetPeak = Math.max(0, Math.min(1, Number.isFinite(targetPeak) ? targetPeak : 0.95));
  const targetAbs = Math.max(1, Math.round(0x7fff * safeTargetPeak));
  const gain = targetAbs / maxAbs;

  for (let offset = 0; offset + 1 < output.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    const normalized = Math.max(-0x8000, Math.min(0x7fff, Math.round(sample * gain)));
    view.setInt16(offset, normalized, true);
  }

  return output;
}

function concatenateBytes(chunks) {
  const normalizedChunks = chunks
    .filter((chunk) => chunk && Number.isFinite(chunk.byteLength) && chunk.byteLength > 0)
    .map((chunk) => chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  const totalBytes = normalizedChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of normalizedChunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function sanitizeFilePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function timestampForFileName(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}
