import { test, expect, request as playwrightRequest } from '@playwright/test';

const uniqueMeetingName = () => `codex-cloud-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('staging authenticated API smoke and cleanup', async ({ request }) => {
  const unauthenticated = await playwrightRequest.newContext({
    baseURL: process.env.CLOUD_BASE_URL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: {
      Authorization: '',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  });
  try {
    for (const [index, check] of [
      { method: 'get', path: '/api/meetings' },
      { method: 'get', path: '/api/metrics' },
      { method: 'post', path: '/api/internal/worker' }
    ].entries()) {
      const path = check.method === 'get'
        ? `${check.path}?cloud-smoke=${Date.now()}-${index}`
        : check.path;
      const response = await unauthenticated[check.method](path);
      const responseHeaders = response.headers();
      const safeDiagnostics = Object.fromEntries(
        ['cache-control', 'content-type', 'x-vercel-cache', 'x-vercel-id']
          .filter((name) => responseHeaders[name])
          .map((name) => [name, responseHeaders[name]])
      );
      expect(
        response.status(),
        `${check.method.toUpperCase()} ${check.path} ${JSON.stringify(safeDiagnostics)}`
      ).toBe(401);
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
  expect(meetingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  try {
    const detail = await request.get(`/api/meetings/${encodeURIComponent(meetingId)}`);
    expect(detail.status()).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.meeting?.id).toBe(meetingId);

    const meetings = await request.get('/api/meetings');
    expect(meetings.status()).toBe(200);
    const listedMeetingIds = (await meetings.json())
      .filter((meeting) => meeting.id === meetingId)
      .map((meeting) => meeting.id);
    expect(listedMeetingIds).toEqual([meetingId]);

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
    const responseHeaders = deleted.headers();
    const responseText = await deleted.text();
    let responseBody = {};
    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      responseBody = {};
    }
    const safeHeaders = Object.fromEntries(
      ['content-type', 'x-request-id', 'cache-control', 'x-vercel-cache', 'x-vercel-id']
        .filter((name) => responseHeaders[name])
        .map((name) => [name, responseHeaders[name]])
    );
    expect(
      deleted.status(),
      `DELETE cleanup failed: code=${responseBody.error?.code || 'unknown'} ` +
        `requestId=${responseBody.error?.requestId || responseHeaders['x-request-id'] || 'unknown'} ` +
        `headers=${JSON.stringify(safeHeaders)}`
    ).toBe(204);
  }
});
