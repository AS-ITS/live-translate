import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const INITIAL_STORAGE = Object.freeze({
  schemaVersion: 2,
  shares: Object.freeze([])
});

export function createFileSessionShareService({ filePath, fileSystem, clock = () => Date.now() } = {}) {
  assertFilePath(filePath);
  assertFileSystem(fileSystem);

  let mutationQueue = Promise.resolve();
  let cachedStorage = null;
  let storageReadPromise = null;

  return Object.freeze({
    async createShare(sessionId, { expiresAt = null } = {}) {
      assertSessionId(sessionId);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= clock())) {
        throw new RangeError('Share expiry must be in the future.');
      }

      const token = randomBytes(32).toString('base64url');
      const shortCode = createShortCode();
      const share = {
        id: `share-${randomBytes(12).toString('hex')}`,
        sessionId,
        tokenHash: hashToken(token),
        shortCodeHash: hashShortCode(shortCode),
        createdAt: clock(),
        expiresAt
      };

      await mutate((storage) => {
        storage.shares.push(share);
      });
      return { ...publicShare(share), token, shortCode };
    },

    async resolveShare(token) {
      if (typeof token !== 'string' || token.length < 20) return null;
      const tokenHash = hashToken(token);
      const storage = await readCachedStorage();
      const share = storage.shares.find((stored) => stored.tokenHash === tokenHash);
      if (!share || (share.expiresAt !== null && share.expiresAt <= clock())) return null;
      return publicShare(share);
    },

    async resolveCode(code) {
      if (!isValidShortCode(code)) return null;
      const storage = await readCachedStorage();
      const share = storage.shares.find((stored) => stored.shortCodeHash === hashShortCode(code));
      if (!share || (share.expiresAt !== null && share.expiresAt <= clock())) return null;
      return publicShare(share);
    },

    async listShares(sessionId) {
      const storage = await readCachedStorage();
      return storage.shares
        .filter((share) => share.sessionId === sessionId && (share.expiresAt === null || share.expiresAt > clock()))
        .map(publicShare);
    },

    async revokeShare(sessionId, shareId) {
      return mutate((storage) => {
        const index = storage.shares.findIndex((share) => share.id === shareId && share.sessionId === sessionId);
        if (index < 0) return false;
        storage.shares.splice(index, 1);
        return true;
      });
    }
  });

  async function mutate(operation) {
    const nextMutation = mutationQueue.then(async () => {
      const storage = clonePlain(await readCachedStorage());
      const result = await operation(storage);
      const normalized = normalizeStorage(storage);
      await writeStorage({ filePath, fileSystem, storage: normalized });
      cachedStorage = normalized;
      return result;
    });

    mutationQueue = nextMutation.catch(() => {});
    return nextMutation;
  }

  async function readCachedStorage() {
    if (cachedStorage) return cachedStorage;
    if (!storageReadPromise) storageReadPromise = readStorage({ filePath, fileSystem });
    try {
      cachedStorage = await storageReadPromise;
      return cachedStorage;
    } finally {
      storageReadPromise = null;
    }
  }
}

async function readStorage({ filePath, fileSystem }) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return clonePlain(INITIAL_STORAGE);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw storageError('Session share storage JSON is invalid.');
  }

  return normalizeStorage(parsed);
}

async function writeStorage({ filePath, fileSystem, storage }) {
  const directory = dirname(filePath);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fileSystem.writeFile(temporaryPath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8');
  await fileSystem.rename(temporaryPath, filePath);
}

function normalizeStorage(value) {
  if (!isRecord(value) || ![1, 2].includes(value.schemaVersion) || !Array.isArray(value.shares)) {
    throw storageError('Session share storage shape is invalid.');
  }

  return {
    schemaVersion: 1,
    shares: value.shares.map((share, index) => {
      if (!isRecord(share) || typeof share.id !== 'string' || share.id.trim().length === 0 ||
          typeof share.sessionId !== 'string' || share.sessionId.trim().length === 0 ||
          typeof share.tokenHash !== 'string' || share.tokenHash.length !== 64 ||
          (share.shortCodeHash !== undefined && share.shortCodeHash !== null && (typeof share.shortCodeHash !== 'string' || share.shortCodeHash.length !== 64)) ||
          typeof share.createdAt !== 'number' || !Number.isFinite(share.createdAt) ||
          (share.expiresAt !== null && (typeof share.expiresAt !== 'number' || !Number.isFinite(share.expiresAt)))) {
        throw storageError(`Session share ${index} is invalid.`);
      }
      return clonePlain({ ...share, shortCodeHash: share.shortCodeHash || null });
    })
  };
}

function publicShare(share) {
  return {
    id: share.id,
    sessionId: share.sessionId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function hashShortCode(code) {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

function createShortCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join('').slice(0, 8);
}

function isValidShortCode(code) {
  return typeof code === 'string' && /^[A-HJ-NP-Z2-9]{8}$/i.test(code);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function storageError(message) {
  const error = new TypeError(message);
  error.code = 'invalid_session_share_storage';
  return error;
}

function assertFilePath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('filePath is required.');
}

function assertFileSystem(value) {
  if (!value || typeof value.readFile !== 'function' || typeof value.mkdir !== 'function' ||
      typeof value.writeFile !== 'function' || typeof value.rename !== 'function') {
    throw new TypeError('fileSystem must provide readFile, mkdir, writeFile, and rename.');
  }
}

function assertSessionId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('sessionId is required.');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
