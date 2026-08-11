import { dirname } from 'node:path';

export const FILE_LOCK_TIMEOUT_CODE = 'file_lock_timeout';

const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;

export function createFileLock({
  fileSystem,
  filePath,
  retryMs = DEFAULT_RETRY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_MS,
  now = () => Date.now(),
  sleep = defaultSleep
} = {}) {
  assertFileSystem(fileSystem);
  assertFilePath(filePath);
  assertPositiveInteger(retryMs, 'retryMs');
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  assertPositiveInteger(staleMs, 'staleMs');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function.');

  const lockPath = `${filePath}.lock`;

  return Object.freeze({
    async run(task) {
      if (typeof task !== 'function') throw new TypeError('task must be a function.');
      await acquire();
      try {
        return await task();
      } finally {
        await release();
      }
    }
  });

  async function acquire() {
    await fileSystem.mkdir(dirname(filePath), { recursive: true });
    const startedAt = now();

    while (true) {
      try {
        await fileSystem.mkdir(lockPath);
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (await isStale()) {
          await removeLock();
          continue;
        }
        if (now() - startedAt >= timeoutMs) {
          const timeoutError = new Error(`Unable to acquire file lock for ${filePath}.`);
          timeoutError.code = FILE_LOCK_TIMEOUT_CODE;
          throw timeoutError;
        }
        await sleep(retryMs);
      }
    }
  }

  async function release() {
    await removeLock();
  }

  async function removeLock() {
    try {
      await fileSystem.rmdir(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function isStale() {
    try {
      const stats = await fileSystem.stat(lockPath);
      return now() - stats.mtimeMs >= staleMs;
    } catch {
      return false;
    }
  }
}

async function defaultSleep(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertFileSystem(fileSystem) {
  if (!fileSystem || typeof fileSystem !== 'object') throw new TypeError('fileSystem is required.');
  for (const method of ['mkdir', 'rmdir', 'stat']) {
    if (typeof fileSystem[method] !== 'function') throw new TypeError(`fileSystem.${method} must be a function.`);
  }
}

function assertFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new TypeError('filePath must be a non-empty string.');
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
}
