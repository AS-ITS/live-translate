import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createFileLock } from './fileLock.js';

const INITIAL_STORAGE = { schemaVersion: 1, leases: [], fences: {} };

export function createFileRecorderLeaseService({ filePath, fileSystem, clock = () => Date.now(), ttlMs = 10_000 } = {}) {
  if (!filePath || !fileSystem) throw new TypeError('filePath and fileSystem are required.');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive.');
  const lock = createFileLock({ filePath, fileSystem, now: clock });

  return Object.freeze({
    async claim(sessionId) {
      return lock.run(async () => {
        const storage = await readStorage();
        const now = clock();
        storage.leases = storage.leases.filter((lease) => lease.expiresAt > now);
        const current = storage.leases.find((lease) => lease.sessionId === sessionId);
        if (current) {
          const error = new Error('Recorder lease is already active.');
          error.code = 'recorder_already_active';
          error.lease = publicLease(current);
          throw error;
        }
        const lease = { sessionId, leaseId: `lease-${randomUUID()}`, fenceToken: nextFence(storage, sessionId), expiresAt: now + ttlMs, lastHeartbeatAt: now };
        storage.leases.push(lease);
        await writeStorage(storage);
        return publicLease(lease);
      });
    },
    async heartbeat(sessionId, leaseId, fenceToken) {
      return lock.run(async () => {
        const storage = await readStorage();
        const lease = findValid(storage, sessionId, leaseId, fenceToken, clock());
        lease.lastHeartbeatAt = clock();
        lease.expiresAt = lease.lastHeartbeatAt + ttlMs;
        await writeStorage(storage);
        return publicLease(lease);
      });
    },
    async release(sessionId, leaseId, fenceToken) {
      return lock.run(async () => {
        const storage = await readStorage();
        const index = storage.leases.findIndex((lease) => lease.sessionId === sessionId && lease.leaseId === leaseId && lease.fenceToken === fenceToken);
        if (index < 0) return false;
        storage.leases.splice(index, 1);
        await writeStorage(storage);
        return true;
      });
    },
    async current(sessionId) {
      const storage = await readStorage();
      const lease = storage.leases.find((candidate) => candidate.sessionId === sessionId && candidate.expiresAt > clock());
      return lease ? publicLease(lease) : null;
    }
  });

  async function readStorage() {
    try {
      const parsed = JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.leases)) throw new Error('invalid recorder lease storage');
      parsed.fences ||= {};
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(INITIAL_STORAGE);
      throw error;
    }
  }
  async function writeStorage(storage) {
    await fileSystem.mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await fileSystem.writeFile(temporaryPath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8');
    await fileSystem.rename(temporaryPath, filePath);
  }
}

function nextFence(storage, sessionId) {
  storage.fences ||= {};
  storage.fences[sessionId] = (storage.fences[sessionId] || 0) + 1;
  return storage.fences[sessionId];
}

function findValid(storage, sessionId, leaseId, fenceToken, now) {
  const lease = storage.leases.find((candidate) => candidate.sessionId === sessionId && candidate.leaseId === leaseId && candidate.fenceToken === fenceToken && candidate.expiresAt > now);
  if (!lease) {
    const error = new Error('Recorder lease is invalid or expired.');
    error.code = 'recorder_lease_invalid';
    throw error;
  }
  return lease;
}

function publicLease(lease) {
  return { sessionId: lease.sessionId, leaseId: lease.leaseId, fenceToken: lease.fenceToken, expiresAt: lease.expiresAt, lastHeartbeatAt: lease.lastHeartbeatAt };
}
