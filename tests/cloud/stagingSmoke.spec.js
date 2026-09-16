import { test, expect, request as playwrightRequest } from '@playwright/test';

const uniqueMeetingName = () => `codex-cloud-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('staging authenticated API smoke and cleanup', async ({ request }) => {
  const unauthenticated = await playwrightRequest.newContext({ baseURL: process.env.CLOUD_BASE_URL });
  try {
    for (const check of [
      { method: 'get', path: '/api/meetings' },
      { method: 'get', path: '/api/metrics' },
      { method: 'post', path: '/api/internal/worker' }
    ]) {
      const response = await unauthenticated[check.method](check.path);
      expect(response.status(), `${check.method.toUpperCase()} ${check.path}`).toBe(401);
    }
  } finally {
    await unauthenticated.dispose();
  }

  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect((await health.json()).ok).toBe(true);

  const readiness = await request.get('/readyz');
  expect(readiness.status()).toBe(200);
  expect((await readiness.json()).ok).toBe(true);

  const profile = await request.get('/api/profile');
  expect(profile.status()).toBe(200);
  expect((await profile.json()).profile).toBeTruthy();

  const name = uniqueMeetingName();
  const created = await request.post('/api/meetings', {
    data: { draft: true, name, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json();
  const meetingId = createdBody.meeting?.id;
  expect(meetingId).toBeTruthy();

  try {
    const detail = await request.get(`/api/meetings/${encodeURIComponent(meetingId)}`);
    expect(detail.status()).toBe(200);
    expect((await detail.json()).meeting?.id).toBe(meetingId);

    const meetings = await request.get('/api/meetings');
    expect(meetings.status()).toBe(200);
    expect((await meetings.json()).some((meeting) => meeting.id === meetingId)).toBe(true);

    const shareResponse = await request.post(`/api/meetings/${encodeURIComponent(meetingId)}/shares`, {
      data: { role: 'viewer', expiresAt: null }
    });
    expect(shareResponse.status()).toBe(201);
    const shareBody = await shareResponse.json();
    const share = shareBody.share || shareBody;
    expect(share.role).toBe('viewer');
    expect(share.shortCode).toBeTruthy();

    const sharedMeeting = await request.get(`/api/shared-meetings/code/${encodeURIComponent(share.shortCode)}`);
    expect(sharedMeeting.status()).toBe(200);
  } finally {
    const deleted = await request.delete(`/api/meetings/${encodeURIComponent(meetingId)}`);
    expect(deleted.status()).toBe(204);
  }
});
