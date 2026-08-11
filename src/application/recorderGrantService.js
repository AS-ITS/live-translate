import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function createRecorderGrantService({ clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive.');
  const grants = new Map();

  return Object.freeze({
    issue({ sessionId, shareId, leaseId, fenceToken }) {
      assertString(sessionId, 'sessionId');
      assertString(shareId, 'shareId');
      assertString(leaseId, 'leaseId');
      if (!Number.isInteger(fenceToken) || fenceToken <= 0) throw new TypeError('fenceToken must be a positive integer.');
      const plaintext = randomBytes(32).toString('base64url');
      const expiresAt = clock() + ttlMs;
      grants.set(hash(plaintext), { sessionId, shareId, leaseId, fenceToken, expiresAt });
      return { grant: plaintext, expiresAt };
    },

    validate(plaintext) {
      if (typeof plaintext !== 'string' || plaintext.length < 20) return null;
      const key = hash(plaintext);
      const record = grants.get(key);
      if (!record) return null;
      if (record.expiresAt <= clock()) {
        grants.delete(key);
        return null;
      }
      return { ...record };
    },

    refresh(plaintext, patch = {}) {
      const current = this.validate(plaintext);
      if (!current) return null;
      const expiresAt = clock() + ttlMs;
      grants.set(hash(plaintext), { ...current, ...patch, expiresAt });
      return { expiresAt };
    },

    revoke(plaintext) {
      if (typeof plaintext !== 'string') return false;
      return grants.delete(hash(plaintext));
    }
  });
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required.`);
}
