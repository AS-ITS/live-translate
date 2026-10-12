import { floatToPcm16, pcm16ChunksToWavBlob, resampleLinear } from './audio.js';

const EXPORT_SAMPLE_RATE = 16000;

export async function composeLocalMeetingAudioArtifact({
  chunks = [],
  readChunk,
  decodeSegments = decodeAudioSegments,
  BlobImpl = globalThis.Blob
} = {}) {
  if (typeof readChunk !== 'function') throw new TypeError('readChunk is required.');
  if (typeof BlobImpl !== 'function') throw new TypeError('Blob is unavailable.');

  const orderedChunks = uniqueOrderedChunks(chunks);
  const containers = await buildCaptureContainers(orderedChunks, readChunk, BlobImpl);
  if (containers.length === 0) {
    return emptyArtifact(BlobImpl);
  }

  if (containers.length === 1) {
    const [{ blob, mimeType }] = containers;
    return Object.freeze({
      blob,
      mimeType,
      extension: extensionForMimeType(mimeType),
      captureSegmentCount: 1,
      chunkIds: orderedChunks.map((chunk) => chunk.chunkId)
    });
  }

  const decoded = await decodeSegments(containers);
  if (!Array.isArray(decoded) || decoded.length !== containers.length) {
    throw new Error('Unable to decode every saved audio segment.');
  }
  const pcmChunks = decoded.map((segment) => floatToPcm16(
    resampleLinear(mixChannelsToMono(segment.channels), segment.sampleRate, EXPORT_SAMPLE_RATE)
  ));
  const blob = pcm16ChunksToWavBlob(pcmChunks, { sampleRate: EXPORT_SAMPLE_RATE, BlobImpl });
  if (blob.size <= 44) throw new Error('Saved audio segments produced an empty export.');

  return Object.freeze({
    blob,
    mimeType: 'audio/wav',
    extension: 'wav',
    captureSegmentCount: containers.length,
    chunkIds: orderedChunks.map((chunk) => chunk.chunkId)
  });
}

async function buildCaptureContainers(chunks, readChunk, BlobImpl) {
  const groups = [];
  for (const chunk of chunks) {
    const key = `${chunk.segmentId || ''}\u0000${chunk.mimeType || 'audio/webm'}`;
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      groups.push({ key, mimeType: chunk.mimeType || 'audio/webm', chunks: [chunk] });
    } else {
      current.chunks.push(chunk);
    }
  }

  return Promise.all(groups.map(async (group) => {
    const parts = await Promise.all(group.chunks.map(async (chunk) => normalizeBlob(
      await readChunk(chunk.path),
      group.mimeType,
      BlobImpl
    )));
    return Object.freeze({
      segmentId: group.chunks[0]?.segmentId || '',
      mimeType: group.mimeType,
      blob: new BlobImpl(parts, { type: group.mimeType })
    });
  }));
}

async function decodeAudioSegments(containers) {
  const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextImpl !== 'function') throw new Error('Audio decoding is unavailable.');
  const context = new AudioContextImpl();
  try {
    return await Promise.all(containers.map(async ({ blob }) => {
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      return Object.freeze({
        sampleRate: buffer.sampleRate,
        channels: Object.freeze(Array.from(
          { length: buffer.numberOfChannels },
          (_, index) => new Float32Array(buffer.getChannelData(index))
        ))
      });
    }));
  } finally {
    await context.close?.();
  }
}

function uniqueOrderedChunks(chunks) {
  const byId = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk?.chunkId || !Number.isInteger(chunk.sequence) || chunk.sequence < 1 || !chunk.path) continue;
    if (!byId.has(chunk.chunkId)) byId.set(chunk.chunkId, chunk);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function mixChannelsToMono(channels) {
  const usable = (Array.isArray(channels) ? channels : []).filter((channel) => channel?.length > 0);
  if (usable.length === 0) throw new Error('Decoded audio segment is empty.');
  const length = Math.min(...usable.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (const channel of usable) {
    for (let index = 0; index < length; index += 1) mono[index] += channel[index] / usable.length;
  }
  return mono;
}

function normalizeBlob(value, mimeType, BlobImpl) {
  if (value instanceof BlobImpl) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return new BlobImpl([value], { type: mimeType });
  }
  throw new TypeError('Saved audio chunk is unreadable.');
}

function emptyArtifact(BlobImpl) {
  return Object.freeze({
    blob: new BlobImpl([], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    extension: 'webm',
    captureSegmentCount: 0,
    chunkIds: Object.freeze([])
  });
}

function extensionForMimeType(mimeType) {
  if (String(mimeType).includes('ogg')) return 'ogg';
  if (String(mimeType).includes('mp4')) return 'm4a';
  if (String(mimeType).includes('wav')) return 'wav';
  return 'webm';
}
