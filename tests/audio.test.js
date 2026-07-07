import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  floatToPcm16,
  pcm16ToFloat,
  resampleLinear
} from '../src/lib/audio.js';

globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

test('floatToPcm16 writes little-endian signed samples', () => {
  const bytes = floatToPcm16(new Float32Array([-1, 0, 1]));
  assert.deepEqual(Array.from(bytes), [0, 128, 0, 0, 255, 127]);
});

test('resampleLinear produces deterministic target length', () => {
  const input = new Float32Array([0, 0.5, 1, 0.5]);
  const output = resampleLinear(input, 4, 2);

  assert.equal(output.length, 2);
  assert.deepEqual(Array.from(output), [0, 1]);
});

test('base64 conversion round-trips bytes', () => {
  const input = new Uint8Array([1, 2, 3, 254, 255]);
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(input))), Array.from(input));
});

test('pcm16ToFloat converts signed bytes back to floats', () => {
  const floats = pcm16ToFloat(new Uint8Array([0, 128, 0, 0, 255, 127]));

  assert.equal(floats.length, 3);
  assert.equal(floats[0], -1);
  assert.equal(floats[1], 0);
  assert.ok(floats[2] > 0.9999);
});

test('createPcmChunker emits 100ms 16kHz PCM chunks', () => {
  const chunker = createPcmChunker({ sourceRate: 16000 });
  const chunks = chunker.push(new Float32Array(1600).fill(0.25));

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].byteLength, 3200);
});

