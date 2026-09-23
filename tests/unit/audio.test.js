import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base64ToBytes,
  buildInputAudioFileName,
  buildTranslatedAudioFileName,
  bytesToBase64,
  createPcmChunker,
  createPcm16WavBytes,
  floatToPcm16,
  normalizePcm16Peak,
  pcm16ChunksToWavBlob,
  pcm16ToFloat,
  resampleLinear
} from '../../src/lib/audio.js';

globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

test('floatToPcm16 clamps samples and writes signed little-endian PCM', () => {
  const bytes = floatToPcm16(new Float32Array([-2, -1, 0, 0.5, 1, 2]));

  assert.deepEqual(Array.from(bytes), [0, 128, 0, 128, 0, 0, 255, 63, 255, 127, 255, 127]);
});

test('pcm16ToFloat converts signed little-endian PCM to normalized floats', () => {
  const floats = pcm16ToFloat(new Uint8Array([0, 128, 0, 0, 255, 127]));

  assert.equal(floats.length, 3);
  assert.equal(floats[0], -1);
  assert.equal(floats[1], 0);
  assert.ok(floats[2] > 0.9999);
});

test('base64 conversion round-trips PCM bytes', () => {
  const input = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);

  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(input))), Array.from(input));
});

test('resampleLinear downsamples with deterministic interpolation', () => {
  const input = new Float32Array([0, 0.5, 1, 0.5]);
  const output = resampleLinear(input, 4, 2);

  assert.equal(output.length, 2);
  assert.deepEqual(Array.from(output), [0, 1]);
});

test('resampleLinear returns original samples when rates match', () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);

  assert.equal(resampleLinear(input, 16000, 16000), input);
});

test('createPcmChunker emits 100ms 16kHz PCM frames and buffers remainders', () => {
  const chunker = createPcmChunker({ sourceRate: 16000 });

  assert.equal(chunker.push(new Float32Array(800).fill(0.25)).length, 0);

  const chunks = chunker.push(new Float32Array(800).fill(0.25));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].byteLength, 3200);
});

test('createPcmChunker flushes the final partial PCM frame', () => {
  const chunker = createPcmChunker({ sourceRate: 16000 });

  chunker.push(new Float32Array([0.25, -0.25, 0.5]));

  const flushed = chunker.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].byteLength, 6);
  assert.ok(Math.abs(pcm16ToFloat(flushed[0])[0] - 0.25) < 0.0001);
  assert.ok(Math.abs(pcm16ToFloat(flushed[0])[1] + 0.25) < 0.0001);
  assert.ok(Math.abs(pcm16ToFloat(flushed[0])[2] - 0.5) < 0.0001);
  assert.deepEqual(chunker.flush(), []);
});

test('createPcmChunker preserves raw input samples without gain processing', () => {
  const chunker = createPcmChunker({ sourceRate: 16000 });
  const input = new Float32Array(1600);
  input[0] = 0.02;
  input[1] = -0.02;

  const [chunk] = chunker.push(input);
  const samples = pcm16ToFloat(chunk);

  assert.ok(Math.abs(samples[0] - 0.02) < 0.0001);
  assert.ok(Math.abs(samples[1] + 0.02) < 0.0001);
});

test('pcm16ChunksToWavBlob wraps PCM chunks as mono 24kHz WAV', async () => {
  const blob = pcm16ChunksToWavBlob([
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6])
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(blob.type, 'audio/wav');
  assert.equal(ascii(bytes, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(ascii(bytes, 8, 4), 'WAVE');
  assert.equal(ascii(bytes, 12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint32(28, true), 48000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(bytes, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual(Array.from(bytes.slice(44)), [1, 2, 3, 4, 5, 6]);
});

test('createPcm16WavBytes rejects incomplete PCM16 samples', () => {
  assert.throws(
    () => createPcm16WavBytes(new Uint8Array([1, 2, 3])),
    {
      name: 'TypeError',
      message: 'PCM16 data must contain complete 16-bit samples.'
    }
  );
});

test('pcm16ChunksToWavBlob can normalize quiet PCM before wrapping', async () => {
  const blob = pcm16ChunksToWavBlob([new Uint8Array([100, 0, 156, 255])], {
    normalizePeak: true,
    targetPeak: 0.5
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(view.getInt16(44, true), 16384);
  assert.equal(view.getInt16(46, true), -16384);
});

test('normalizePcm16Peak preserves silence and scales signed samples', () => {
  assert.deepEqual(Array.from(normalizePcm16Peak(new Uint8Array([0, 0, 0, 0]))), [0, 0, 0, 0]);

  const normalized = normalizePcm16Peak(new Uint8Array([100, 0, 156, 255]), { targetPeak: 0.5 });
  const view = new DataView(normalized.buffer);
  assert.equal(view.getInt16(0, true), 16384);
  assert.equal(view.getInt16(2, true), -16384);
});

test('buildTranslatedAudioFileName includes sanitized session id and timestamp', () => {
  assert.equal(
    buildTranslatedAudioFileName({
      sessionId: 'Session:ABC/123',
      startedAt: Date.UTC(2026, 6, 30, 12, 34, 56)
    }),
    'live-translate-translated-audio-session-abc-123-20260730-123456.wav'
  );
});

test('buildInputAudioFileName includes sanitized session id and timestamp', () => {
  assert.equal(
    buildInputAudioFileName({
      sessionId: 'Session:ABC/123',
      startedAt: Date.UTC(2026, 6, 30, 12, 34, 56)
    }),
    'live-translate-input-audio-session-abc-123-20260730-123456.wav'
  );
});

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
