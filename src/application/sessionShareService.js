import { createHash, randomBytes } from 'node:crypto';

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createSessionShareService({ clock = () => Date.now() } = {}) {
  const shares = new Map();

  return Object.freeze({
    createShare(sessionId, { role = 'viewer', expiresAt = null } = {}) {
      assertSessionId(sessionId);
      assertRole(role);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= clock())) {
        throw new RangeError('Share expiry must be in the future.');
      }
      const token = randomBytes(32).toString('base64url');
      const shortCode = createShortCode();
      const share = {
        id: `share-${randomBytes(12).toString('hex')}`,
        sessionId,
        role,
        tokenHash: hashToken(token),
        shortCodeHash: hashShortCode(shortCode),
        createdAt: clock(),
        expiresAt
      };
      shares.set(share.id, share);
      return { ...publicShare(share), token, shortCode };
    },

    createMeetingShare(meetingId, options = {}) {
      const created = this.createShare(meetingId, options);
      const share = shares.get(created.id);
      share.resourceType = 'meeting';
      share.meetingId = meetingId;
      return { ...publicShare(share), token: created.token, shortCode: created.shortCode };
    },

    bindShareToSession(shareId, sessionId) {
      const share = shares.get(shareId);
      if (!share || share.resourceType !== 'meeting') return false;
      share.sessionId = sessionId;
      share.resourceType = 'session';
      return true;
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

    resolveCode(code) {
      if (!isValidShortCode(code)) return null;
      const shortCodeHash = hashShortCode(code);
      for (const share of shares.values()) {
        if (share.shortCodeHash !== shortCodeHash) continue;
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

function publicShare(share) {
  return {
    id: share.id,
    sessionId: share.sessionId,
    role: share.role || 'viewer',
    resourceType: share.resourceType || 'session',
    ...(share.meetingId ? { meetingId: share.meetingId } : {}),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt
  };
}

function assertRole(value) {
  if (value !== 'viewer' && value !== 'recorder') throw new RangeError('Share role must be viewer or recorder.');
}

function assertSessionId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('sessionId is required.');
  }
}
