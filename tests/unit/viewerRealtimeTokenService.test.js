import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createViewerRealtimeTokenService } from '../../server/viewerRealtimeTokenService.js';

test('viewer realtime token is short lived and scoped to one private meeting channel', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...await exportJWK(privateKey), alg: 'ES256', kid: 'realtime-test' };
  const now = Date.parse('2026-09-09T00:00:00.000Z');
  const service = createViewerRealtimeTokenService({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_REALTIME_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk)
    },
    clock: () => now
  });

  const issued = await service.issue({
    id: 'share-1',
    meetingId: 'meeting-1',
    role: 'viewer',
    expiresAt: now + 60_000
  });
  const verified = await jwtVerify(issued.accessToken, publicKey, {
    issuer: 'https://project.supabase.co/auth/v1',
    audience: 'authenticated',
    currentDate: new Date(now)
  });

  assert.equal(issued.channel, 'meeting:meeting-1');
  assert.equal(issued.expiresAt, now + 60_000);
  assert.equal(verified.payload.sub, 'share-1');
  assert.equal(verified.payload.meeting_id, 'meeting-1');
  assert.equal(verified.payload.viewer_share_id, 'share-1');
  assert.equal(verified.payload.role, 'authenticated');
});

test('viewer realtime token rejects expired or non-viewer shares', async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...await exportJWK(privateKey), alg: 'ES256', kid: 'realtime-test' };
  const now = Date.parse('2026-09-09T00:00:00.000Z');
  const service = createViewerRealtimeTokenService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_REALTIME_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk) },
    clock: () => now
  });

  await assert.rejects(() => service.issue({ id: 'share-1', meetingId: 'meeting-1', role: 'recorder', expiresAt: now + 1_000 }), { code: 'meeting_share_invalid' });
  await assert.rejects(() => service.issue({ id: 'share-1', meetingId: 'meeting-1', role: 'viewer', expiresAt: now }), { code: 'meeting_share_invalid' });
});
