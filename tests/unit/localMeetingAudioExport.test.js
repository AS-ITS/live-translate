import assert from 'node:assert/strict';
import test from 'node:test';
import { composeLocalMeetingAudioArtifact } from '../../src/lib/localMeetingAudioExport.js';

function chunk(overrides = {}) {
  return {
    chunkId: 'chunk-1',
    sequence: 1,
    segmentId: 'segment-1',
    mimeType: 'audio/webm;codecs=opus',
    path: 'chunk-1.webm',
    ...overrides
  };
}

test('single capture segment exports its original container without transcoding', async () => {
  const files = new Map([
    ['chunk-1.webm', new Blob(['header-'])],
    ['chunk-2.webm', new Blob(['audio'])]
  ]);
  let decodeCalls = 0;

  const artifact = await composeLocalMeetingAudioArtifact({
    chunks: [chunk(), chunk({ chunkId: 'chunk-2', sequence: 2, path: 'chunk-2.webm' })],
    readChunk: (path) => files.get(path),
    decodeSegments: async () => { decodeCalls += 1; return []; }
  });

  assert.equal(artifact.mimeType, 'audio/webm;codecs=opus');
  assert.equal(artifact.extension, 'webm');
  assert.equal(artifact.captureSegmentCount, 1);
  assert.equal(await artifact.blob.text(), 'header-audio');
  assert.equal(decodeCalls, 0);
});

test('multiple capture containers are decoded in sequence and exported as one valid WAV without duplicate chunks', async () => {
  const files = new Map([
    ['chunk-1.webm', new Blob(['first-a'])],
    ['chunk-2.webm', new Blob(['first-b'])],
    ['chunk-3.webm', new Blob(['second'])]
  ]);
  const decodedContainers = [];

  const artifact = await composeLocalMeetingAudioArtifact({
    chunks: [
      chunk(),
      chunk({ chunkId: 'chunk-2', sequence: 2, path: 'chunk-2.webm' }),
      chunk({ chunkId: 'chunk-2', sequence: 2, path: 'chunk-2.webm' }),
      chunk({ chunkId: 'chunk-3', sequence: 3, segmentId: 'segment-2', path: 'chunk-3.webm' })
    ],
    readChunk: (path) => files.get(path),
    decodeSegments: async (containers) => {
      decodedContainers.push(...await Promise.all(containers.map((container) => container.blob.text())));
      return [
        { sampleRate: 16000, channels: [new Float32Array([0.25, -0.25])] },
        { sampleRate: 16000, channels: [new Float32Array([0.5])] }
      ];
    }
  });

  assert.deepEqual(decodedContainers, ['first-afirst-b', 'second']);
  assert.equal(artifact.mimeType, 'audio/wav');
  assert.equal(artifact.extension, 'wav');
  assert.equal(artifact.captureSegmentCount, 2);
  assert.deepEqual(artifact.chunkIds, ['chunk-1', 'chunk-2', 'chunk-3']);

  const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(bytes.byteLength, 50);
});
