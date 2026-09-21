import { test, expect, request as playwrightRequest } from '@playwright/test';

function uniqueMeetingName() {
  return `codex-issue35-reload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('authenticated Meeting survives a fresh context direct-url reload and update', async ({ request }) => {
  const created = await request.post('/api/meetings', {
    data: {
      draft: true,
      name: uniqueMeetingName(),
      sourceLanguageCode: 'zh-Hant',
      targetLanguageCode: 'en'
    }
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json();
  const meetingId = createdBody.meeting?.id;
  expect(meetingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  const updatedName = `${createdBody.meeting.name} updated`;
  const freshContext = await playwrightRequest.newContext({
    baseURL: process.env.CLOUD_BASE_URL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${process.env.CLOUD_TEST_ACCESS_TOKEN}`,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  });

  try {
    const directUrlRead = await freshContext.get(`/api/meetings/${encodeURIComponent(meetingId)}`);
    expect(directUrlRead.status()).toBe(200);
    const directUrlBody = await directUrlRead.json();
    expect(directUrlBody.meeting?.id).toBe(meetingId);

    const updated = await freshContext.patch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      data: { name: updatedName }
    });
    expect(updated.status()).toBe(200);

    const reread = await request.get(`/api/meetings/${encodeURIComponent(meetingId)}`);
    expect(reread.status()).toBe(200);
    const rereadBody = await reread.json();
    expect(rereadBody.meeting?.id).toBe(meetingId);
    expect(rereadBody.meeting?.name).toBe(updatedName);
  } finally {
    await freshContext.dispose();
    const deleted = await request.delete(`/api/meetings/${encodeURIComponent(meetingId)}`);
    expect(deleted.status()).toBe(204);
  }
});
