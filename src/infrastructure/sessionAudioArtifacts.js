import { dirname, join } from 'node:path';
import { composePcm16WavSegments } from '../lib/audio.js';

export const SESSION_AUDIO_KINDS = Object.freeze(['input', 'translation']);
const SESSION_AUDIO_KIND_SET = new Set(SESSION_AUDIO_KINDS);
const AUDIO_MIME_TYPE = 'audio/wav';
const SEGMENTED_STORAGE_MODE = 'segmented';

export function createFileSessionAudioArtifactRepository({ directory, fileSystem, clock = () => Date.now() } = {}) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new TypeError('session audio artifact directory must be a non-empty string.');
  }
  for (const method of ['mkdir', 'readFile', 'writeFile', 'unlink']) {
    if (!fileSystem || typeof fileSystem[method] !== 'function') {
      throw new TypeError(`fileSystem.${method} must be a function.`);
    }
  }

  return Object.freeze({
    async save({ sessionId, kind, bytes, fileName }) {
      const normalizedSessionId = validateIdPart(sessionId, 'sessionId');
      const normalizedKind = validateKind(kind);
      const buffer = normalizeBytes(bytes);
      const safeFileName = sanitizeFileName(fileName) || buildDefaultFileName({ sessionId: normalizedSessionId, kind: normalizedKind });
      const relativePath = `${normalizedSessionId}/${normalizedKind}.wav`;
      const filePath = join(directory, relativePath);

      await fileSystem.mkdir(dirname(filePath), { recursive: true });
      await fileSystem.writeFile(filePath, buffer);

      return {
        kind: normalizedKind,
        storageMode: 'single',
        mimeType: AUDIO_MIME_TYPE,
        byteLength: buffer.byteLength,
        fileName: safeFileName,
        storagePath: relativePath,
        createdAt: clock()
      };
    },

    async saveSegment({ sessionId, kind, segmentIndex, bytes }) {
      const normalizedSessionId = validateIdPart(sessionId, 'sessionId');
      const normalizedKind = validateKind(kind);
      const normalizedSegmentIndex = validateSegmentIndex(segmentIndex);
      const buffer = normalizeBytes(bytes);
      const relativePath = `${normalizedSessionId}/${normalizedKind}-segments/${String(normalizedSegmentIndex).padStart(6, '0')}.wav`;
      const filePath = join(directory, relativePath);

      await fileSystem.mkdir(dirname(filePath), { recursive: true });
      await fileSystem.writeFile(filePath, buffer);

      return {
        index: normalizedSegmentIndex,
        byteLength: buffer.byteLength,
        storagePath: relativePath,
        createdAt: clock()
      };
    },

    async read(metadata) {
      const sanitized = sanitizeMetadata(metadata);
      if (sanitized?.storageMode === SEGMENTED_STORAGE_MODE) {
        const parts = await Promise.all(sanitized.segments.map((segment) => readBytes(segment.storagePath)));
        return {
          metadata: sanitized,
          bytes: Buffer.from(composePcm16WavSegments(parts))
        };
      }

      const storagePath = validateStoragePath(metadata?.storagePath);
      let bytes;
      try {
        bytes = await fileSystem.readFile(join(directory, storagePath));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          const notFound = new Error('Session audio artifact not found.');
          notFound.code = 'session_not_found';
          notFound.status = 404;
          throw notFound;
        }
        throw error;
      }
      return {
        metadata: sanitizeMetadata(metadata),
        bytes
      };
    },

    async *stream(metadata) {
      const sanitized = sanitizeMetadata(metadata);
      if (sanitized?.storageMode !== SEGMENTED_STORAGE_MODE) {
        const artifact = await this.read(metadata);
        yield artifact.bytes;
        return;
      }

      const dataByteLength = segmentedAudioDataByteLength(sanitized.segments);
      let headerSent = false;
      for (const segment of sanitized.segments) {
        const bytes = await readBytes(segment.storagePath);
        const parsed = parseWavSegment(bytes);
        if (!headerSent) {
          yield createPcm16WavHeader({ sampleRate: parsed.sampleRate, dataByteLength });
          headerSent = true;
        }
        yield parsed.pcmBytes;
      }
      if (!headerSent) yield createPcm16WavHeader({ dataByteLength: 0 });
    },

    async deleteMany(artifacts = {}) {
      const targets = Object.values(artifacts || {}).flatMap((metadata) => {
        const sanitized = sanitizeMetadata(metadata);
        if (!sanitized) return [];
        if (sanitized.storageMode === SEGMENTED_STORAGE_MODE) {
          return sanitized.segments.map((segment) => segment.storagePath);
        }
        return [sanitized.storagePath].filter(Boolean);
      });
      await Promise.all(targets.map(async (storagePath) => {
        try {
          await fileSystem.unlink(join(directory, validateStoragePath(storagePath)));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }));
    }
  });

  async function readBytes(storagePath) {
    try {
      return await fileSystem.readFile(join(directory, validateStoragePath(storagePath)));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const notFound = new Error('Session audio artifact not found.');
        notFound.code = 'session_not_found';
        notFound.status = 404;
        throw notFound;
      }
      throw error;
    }
  }
}

export function audioArtifactDownloadUrl({ sessionId, kind, meetingId } = {}) {
  const normalizedKind = validateKind(kind);
  if (meetingId) {
    return `/api/meetings/${encodeURIComponent(validateIdPart(meetingId, 'meetingId'))}/audio/${normalizedKind}`;
  }
  return `/api/sessions/${encodeURIComponent(validateIdPart(sessionId, 'sessionId'))}/audio/${normalizedKind}`;
}

export function audioArtifactDownloadByteLength(metadata) {
  const sanitized = sanitizeMetadata(metadata);
  if (sanitized?.storageMode !== SEGMENTED_STORAGE_MODE) return sanitized?.byteLength || 0;
  return 44 + segmentedAudioDataByteLength(sanitized.segments);
}

export function sanitizeAudioArtifactsForDTO(artifacts = {}, { sessionId, meetingId } = {}) {
  const result = {};
  for (const kind of SESSION_AUDIO_KINDS) {
    const metadata = sanitizeMetadata(artifacts?.[kind]);
    if (metadata) {
      const { storagePath, segments, ...publicMetadata } = metadata;
      result[kind] = {
        ...publicMetadata,
        ...(segments ? { segments: segments.map(({ storagePath: _storagePath, ...segment }) => segment) } : {}),
        downloadUrl: audioArtifactDownloadUrl({ sessionId, meetingId, kind })
      };
    }
  }
  return result;
}

export function validateAudioArtifactKind(kind) {
  return validateKind(kind);
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const kind = SESSION_AUDIO_KIND_SET.has(metadata.kind) ? metadata.kind : null;
  if (!kind) return null;
  if (metadata.storageMode === SEGMENTED_STORAGE_MODE) {
    return {
      kind,
      storageMode: SEGMENTED_STORAGE_MODE,
      mimeType: AUDIO_MIME_TYPE,
      byteLength: Number.isFinite(metadata.byteLength) ? metadata.byteLength : 0,
      fileName: sanitizeFileName(metadata.fileName) || `${kind}.wav`,
      segments: sanitizeSegments(metadata.segments),
      createdAt: metadata.createdAt ?? null,
      updatedAt: metadata.updatedAt ?? null
    };
  }
  return {
    kind,
    storageMode: metadata.storageMode === 'meeting-composed' ? 'meeting-composed' : 'single',
    mimeType: metadata.mimeType === AUDIO_MIME_TYPE ? AUDIO_MIME_TYPE : AUDIO_MIME_TYPE,
    byteLength: Number.isFinite(metadata.byteLength) ? metadata.byteLength : 0,
    fileName: sanitizeFileName(metadata.fileName) || `${kind}.wav`,
    storagePath: typeof metadata.storagePath === 'string' ? metadata.storagePath : '',
    createdAt: metadata.createdAt ?? null
  };
}

function sanitizeSegments(segments = []) {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((segment) => {
      const index = Number.isInteger(segment?.index) && segment.index >= 0 ? segment.index : null;
      if (index === null || typeof segment?.storagePath !== 'string') return null;
      return {
        index,
        byteLength: Number.isFinite(segment.byteLength) ? segment.byteLength : 0,
        storagePath: segment.storagePath,
        createdAt: segment.createdAt ?? null
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index);
}

function segmentedAudioDataByteLength(segments = []) {
  return segments.reduce((total, segment) => total + Math.max(0, segment.byteLength - 44), 0);
}

function parseWavSegment(bytes) {
  const source = Buffer.from(bytes);
  if (source.length < 44 || source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TypeError('WAV segment is invalid.');
  }
  const dataByteLength = source.readUInt32LE(40);
  const end = 44 + dataByteLength;
  if (end > source.length) throw new TypeError('WAV segment is invalid.');
  return { sampleRate: source.readUInt32LE(24), pcmBytes: source.subarray(44, end) };
}

function createPcm16WavHeader({ sampleRate = 24000, dataByteLength = 0 } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataByteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataByteLength, 40);
  return header;
}

function validateKind(kind) {
  if (!SESSION_AUDIO_KIND_SET.has(kind)) {
    const error = new Error('Invalid session audio artifact kind.');
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
  return kind;
}

function validateIdPart(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const error = new TypeError(`${name} must be a non-empty string.`);
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function validateStoragePath(value) {
  if (typeof value !== 'string' || value.includes('..') || value.startsWith('/') || value.trim().length === 0) {
    const error = new Error('Invalid session audio artifact storage path.');
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
  return value;
}

function validateSegmentIndex(value) {
  const segmentIndex = Number(value);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    const error = new Error('Invalid session audio segment index.');
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
  return segmentIndex;
}

function normalizeBytes(bytes) {
  if (bytes instanceof Uint8Array || Buffer.isBuffer(bytes)) {
    return Buffer.from(bytes);
  }
  const error = new TypeError('Audio artifact bytes must be a byte array.');
  error.code = 'invalid_request';
  error.status = 400;
  throw error;
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
}

function buildDefaultFileName({ sessionId, kind }) {
  return `live-translate-${kind}-audio-${sanitizeFileName(sessionId) || 'session'}.wav`;
}
