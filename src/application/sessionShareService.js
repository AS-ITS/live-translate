import { createHash, randomBytes } from 'node:crypto';

export function createSessionShareService({ clock = () => Date.now() } = {}) {
  const shares = new Map();

  return Object.freeze({
    createShare(sessionId, { expiresAt = null } = {}) {
      assertSessionId(sessionId);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= clock())) {
        throw new RangeError('Share expiry must be in the future.');
      }
      const token = randomBytes(32).toString('base64url');
      const share = {
        id: `share-${randomBytes(12).toString('hex')}`,
        sessionId,
        tokenHash: hashToken(token),
        createdAt: clock(),
        expiresAt
      };
      shares.set(share.id, share);
      return { ...publicShare(share), token };
    },

    resolveShare(token) {
      if (typeof token !== 'string' || token.length < 20) return null;
      const tokenHash = hashToken(token);
      for (const share of shares.values()) {
        if (share.tokenHash !== tokenHash) continue;
        if (share.expiresAt !== null && share.expiresAt <= clock()) return null;
        return publicShare(share);
      }
      return null;
    },

    listShares(sessionId) {
      return [...shares.values()]
        .filter((share) => share.sessionId === sessionId && (share.expiresAt === null || share.expiresAt > clock()))
        .map(publicShare);
    },

    revokeShare(sessionId, shareId) {
      const share = shares.get(shareId);
      if (!share || share.sessionId !== sessionId) return false;
      shares.delete(shareId);
      return true;
    }
  });
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicShare(share) {
  return {
    id: share.id,
    sessionId: share.sessionId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt
  };
}

function assertSessionId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('sessionId is required.');
  }
}
