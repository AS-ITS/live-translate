export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const CHUNK_MS = 100;

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

