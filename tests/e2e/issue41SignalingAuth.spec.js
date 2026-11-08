import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { localE2EAuthSession } from './authBootstrap.js';

test('issue41 isolated signaling authorizes independent Host and Viewer through real Redis', async ({ browser }) => {
  test.setTimeout(90_000);
  const auth = localE2EAuthSession();
  expect(auth).toBeTruthy();
  expect(process.env.ISSUE41_SIGNALING_URL).toBe(`http://127.0.0.1:${process.env.ISSUE41_SIGNALING_PORT || 3001}`);
  expect(process.env.ISSUE41_REDIS_URL).toBe(`redis://127.0.0.1:16379${process.env.ISSUE41_LOCAL_SMOKE === 'true' ? '/15' : ''}`);
  const frontendUrl = `http://127.0.0.1:${process.env.ISSUE41_E2E_FRONTEND_PORT || 5174}`;
  const host = await browser.newContext({ baseURL: frontendUrl });
  const viewer = await browser.newContext({ baseURL: frontendUrl });
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
    const detail = await host.request.get(`/api/meetings/${id}`, { headers: hostHeaders });
    expect(detail.status()).toBe(200);
    expect((await detail.json()).meeting.id).toBe(id);
    const createShare = async (expiresAt) => {
      const response = await host.request.post(`/api/meetings/${id}/shares`, { headers: hostHeaders,
        data: { role: 'viewer', ...(expiresAt === undefined ? {} : { expiresAt }) } });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const share = await createShare();
    expect(share.share?.token).toBeTruthy();
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SECRET_KEY;
    const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const otherEmail = `issue41-other-${randomUUID()}@example.com`;
    const otherPassword = randomUUID() + randomUUID();
    const otherCreated = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password: otherPassword, email_confirm: true })
    });
    expect(otherCreated.ok).toBe(true);
    const otherUser = await otherCreated.json();
    const otherLogin = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password: otherPassword })
    });
    expect(otherLogin.ok).toBe(true);
    const otherToken = (await otherLogin.json()).access_token;
    const otherHeaders = { Authorization: `Bearer ${otherToken}` };
    expect((await host.request.get('/api/profile', { headers: otherHeaders })).status()).toBe(200);
    expect((await host.request.get(`/api/meetings/${id}`, { headers: otherHeaders })).status()).toBe(403);
    expect((await host.request.post(`/api/meetings/${id}/shares`, {
      headers: otherHeaders, data: { role: 'viewer' }
    })).status()).toBe(403);
    const recordingBody = { meetingId: id, sessionId: randomUUID(), segmentId: randomUUID() };
    const otherRecording = await host.request.post('/api/live-token', {
      headers: { ...otherHeaders, 'x-host-local-recording': '1',
        'x-meeting-session-id': recordingBody.sessionId, 'x-meeting-segment-id': recordingBody.segmentId },
      data: recordingBody
    });
    expect(otherRecording.status()).toBe(403);
    expect((await otherRecording.json()).error.code).toBe('recorder_forbidden');
    const disabled = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${otherUser.id}`, {
      method: 'PATCH',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=representation', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' })
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json())[0].status).toBe('disabled');
    expect((await host.request.get('/api/profile', { headers: otherHeaders })).status()).toBe(403);
    const pendingEmail = `issue41-pending-${randomUUID()}@example.com`;
    const pendingPassword = randomUUID() + randomUUID();
    const pendingCreated = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, password: pendingPassword, email_confirm: true })
    });
    expect(pendingCreated.ok).toBe(true);
    const pendingUser = await pendingCreated.json();
    const pendingStatus = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${pendingUser.id}`, {
      method: 'PATCH',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=representation', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' })
    });
    expect(pendingStatus.status).toBe(200);
    expect((await pendingStatus.json())[0].status).toBe('pending');
    const pendingLogin = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, password: pendingPassword })
    });
    expect(pendingLogin.ok).toBe(true);
    const pendingToken = (await pendingLogin.json()).access_token;
    const pendingProfile = await host.request.get('/api/profile', {
      headers: { Authorization: `Bearer ${pendingToken}` }
    });
    expect(pendingProfile.status()).toBe(200);
    expect((await pendingProfile.json()).profile.status).toBe('active');
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
