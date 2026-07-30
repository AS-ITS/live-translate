import { dirname, join } from 'node:path';

export const SESSION_AUDIO_KINDS = Object.freeze(['input', 'translation']);
const SESSION_AUDIO_KIND_SET = new Set(SESSION_AUDIO_KINDS);
const AUDIO_MIME_TYPE = 'audio/wav';

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
        mimeType: AUDIO_MIME_TYPE,
        byteLength: buffer.byteLength,
        fileName: safeFileName,
        storagePath: relativePath,
        createdAt: clock()
      };
    },

    async read(metadata) {
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

    async deleteMany(artifacts = {}) {
      const targets = Object.values(artifacts || {})
        .map((metadata) => metadata?.storagePath)
        .filter(Boolean);
      await Promise.all(targets.map(async (storagePath) => {
        try {
          await fileSystem.unlink(join(directory, validateStoragePath(storagePath)));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }));
    }
  });
}

export function audioArtifactDownloadUrl({ sessionId, kind, meetingId } = {}) {
  const normalizedKind = validateKind(kind);
  if (meetingId) {
    return `/api/meetings/${encodeURIComponent(validateIdPart(meetingId, 'meetingId'))}/audio/${normalizedKind}`;
  }
  return `/api/sessions/${encodeURIComponent(validateIdPart(sessionId, 'sessionId'))}/audio/${normalizedKind}`;
}

export function sanitizeAudioArtifactsForDTO(artifacts = {}, { sessionId, meetingId } = {}) {
  const result = {};
  for (const kind of SESSION_AUDIO_KINDS) {
    const metadata = sanitizeMetadata(artifacts?.[kind]);
    if (metadata) {
      const { storagePath, ...publicMetadata } = metadata;
      result[kind] = {
        ...publicMetadata,
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
  return {
    kind,
    mimeType: metadata.mimeType === AUDIO_MIME_TYPE ? AUDIO_MIME_TYPE : AUDIO_MIME_TYPE,
    byteLength: Number.isFinite(metadata.byteLength) ? metadata.byteLength : 0,
    fileName: sanitizeFileName(metadata.fileName) || `${kind}.wav`,
    storagePath: typeof metadata.storagePath === 'string' ? metadata.storagePath : '',
    createdAt: metadata.createdAt ?? null
  };
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
