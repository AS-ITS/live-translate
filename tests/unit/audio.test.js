import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  floatToPcm16,
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
