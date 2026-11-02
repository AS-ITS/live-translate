import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { localE2EAuthSession } from './authBootstrap.js';

test('issue41 isolated signaling authorizes independent Host and Viewer through real Redis', async ({ browser }) => {
  test.setTimeout(90_000);
  const auth = localE2EAuthSession();
  expect(auth).toBeTruthy();
  expect(process.env.ISSUE41_SIGNALING_URL).toBe('http://127.0.0.1:3001');
  expect(process.env.ISSUE41_REDIS_URL).toBe('redis://127.0.0.1:16379');
  const host = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  const viewer = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  const hostHeaders = { Authorization: `Bearer ${auth.token}` };
  const meetingId = randomUUID();
  try {
    const profile = await host.request.get('/api/profile', { headers: hostHeaders });
    expect(profile.status()).toBe(200);
    const created = await host.request.post('/api/meetings', { headers: hostHeaders,
      data: { id: meetingId, draft: true, name: 'Issue 41 signaling preflight',
        sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' } });
    expect(created.status()).toBe(201);
  const sessions = await host.request.get('/api/sessions', { headers: hostHeaders });
  expect(sessions.status()).toBe(200);
    const meeting = await created.json();
    const id = meeting.meeting.id;
    const createShare = async (expiresAt) => {
      const response = await host.request.post(`/api/meetings/${id}/shares`, { headers: hostHeaders,
        data: { role: 'viewer', ...(expiresAt === undefined ? {} : { expiresAt }) } });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const share = await createShare();
    expect(share.share?.token).toBeTruthy();
    const route = `/api/webrtc/${id}`;
    const device = await host.request.post(`${route}/join`, { headers: hostHeaders,
      data: { participantId: 'issue41-host-preflight', role: 'device' } });
    expect(device.status(), `Host Join: ${(await device.json()).error?.code || ''}`).toBe(200);
  const requestLog = readFileSync(process.env.ISSUE41_SIGNALING_REQUEST_LOG, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  expect(requestLog).toContainEqual(expect.objectContaining({
    method: 'POST', path: `${route}/join`, status: 200
  }));

    const viewerJoin = await viewer.request.post(`${route}/join`, {
      data: { participantId: 'issue41-viewer-preflight', role: 'viewer', shareToken: share.share.token }
    });
    expect(viewerJoin.status(), `Viewer Join: ${(await viewerJoin.json()).error?.code || ''}`).toBe(200);
    const signal = await viewer.request.post(`${route}/signal`, { data: {
      participantId: 'issue41-viewer-preflight', type: 'viewer-ready',
      negotiationId: 'issue41-negotiation-preflight', payload: {}
    } });
    expect(signal.status()).toBe(200);
    const received = await host.request.get(`${route}/signal?participantId=issue41-host-preflight&after=0`,
      { headers: hostHeaders });
    expect(received.status()).toBe(200);
    expect((await received.json()).messages.some((message) =>
      message.type === 'viewer-ready' && message.participantId === 'issue41-viewer-preflight')).toBe(true);

    const invalid = await viewer.request.post(`${route}/join`, { data: {
      participantId: 'issue41-invalid-preflight', role: 'viewer', shareToken: 'invalid-share-token'
    } });
    expect(invalid.status()).toBe(403);
    expect((await invalid.json()).error.code).toBe('share_unauthorized');
    const otherMeeting = await viewer.request.post(`/api/webrtc/${randomUUID()}/join`, { data: {
      participantId: 'issue41-cross-meeting', role: 'viewer', shareToken: share.share.token
    } });
    expect(otherMeeting.status()).toBe(403);
    expect((await otherMeeting.json()).error.code).toBe('share_unauthorized');

    const revokedShare = await createShare();
    const revoke = await host.request.delete(`/api/meetings/${id}/shares/${revokedShare.share.id}`,
      { headers: hostHeaders });
    expect(revoke.status()).toBe(204);
    const revoked = await viewer.request.post(`${route}/join`, { data: {
      participantId: 'issue41-revoked-preflight', role: 'viewer', shareToken: revokedShare.share.token
    } });
    expect(revoked.status()).toBe(403);
    expect((await revoked.json()).error.code).toBe('share_unauthorized');

    const expiringShare = await createShare(Date.now() + 5_000);
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const expired = await viewer.request.post(`${route}/join`, { data: {
      participantId: 'issue41-expired-preflight', role: 'viewer', shareToken: expiringShare.share.token
    } });
    expect(expired.status()).toBe(403);
    expect((await expired.json()).error.code).toBe('share_unauthorized');
  } finally {
    await host.close();
    await viewer.close();
  }
});
