import { expect, test } from '@playwright/test';

test('shared Viewer renders one Session snapshot without owner controls', async ({ page }) => {
  const detail = {
    session: {
      id: 'session-a',
      name: 'Session A',
      status: 'active',
      targetLanguageCode: 'en'
    },
    sourceTranscript: {
      items: [{ id: 'source-a-1', text: 'Only Session A source', status: 'final' }]
    },
    selectedTranslationOutput: {
      items: [{ id: 'translation-a-1', text: 'Only Session A translation', status: 'final' }]
    }
  };

  await page.route('**/api/shared-sessions/token-a', async (route) => route.fulfill({ json: detail }));
  await page.route('**/api/shared-sessions/token-a/events', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `id: 1\nevent: session.snapshot\ndata: ${JSON.stringify(detail)}\n\n`
    });
  });

  await page.goto('/#watch?token=token-a');

  await expect(page.getByRole('heading', { name: '即時翻譯觀看' })).toBeVisible();
  await expect(page.getByText('Only Session A source')).toBeVisible();
  await expect(page.getByText('Only Session A translation')).toBeVisible();
  await expect(page.getByText('Only Session B source')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('唯讀分享內容')).toBeVisible();
});

test('shared Viewer shows an error for an invalid or expired link', async ({ page }) => {
  await page.route('**/api/shared-sessions/expired-token', async (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'session_not_found' } })
  }));
  await page.route('**/api/shared-sessions/expired-token/events', async (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'session_not_found' } })
  }));

  await page.goto('/#watch?token=expired-token');

  await expect(page.getByRole('alert')).toContainText(/分享連結無效或已過期|分享連線中斷/);
});

test('Meeting Viewer renders historical bilingual Cues without owner controls', async ({ page }) => {
  const cues = Array.from({ length: 40 }, (_, index) => ({
    cueId: `cue-${index + 1}`,
    sequence: index + 1,
    startTimeMs: index * 1000,
    sourceText: `原文 ${index + 1}`,
    translatedText: `Translation ${index + 1}`,
    status: 'final'
  }));
  await page.route('**/api/shared-meetings/meeting-viewer-token', async (route) => route.fulfill({ json: {
    capability: { role: 'viewer', meetingId: 'meeting-1' },
    meeting: { id: 'meeting-1', name: '產品會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    cues: [cues[0]],
    cursor: { eventId: 0, cueSequence: 1 }
  } }));
  await page.route('**/api/shared-meetings/meeting-viewer-token/events**', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `id: 1\nevent: cue.append\ndata: ${JSON.stringify({ eventId: 1, type: 'cue.append', meetingId: 'meeting-1', segmentId: 'segment-1', cue: cues[1] })}\n\n`
  }));

  await page.goto('/#viewer?token=meeting-viewer-token');

  await expect(page.getByRole('heading', { name: '產品會議' })).toBeVisible();
  await expect(page.getByText('原文 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Translation 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Translation 2', { exact: true })).toBeVisible();
  expect(await page.getByTestId('meeting-viewer-cue-row').count()).toBeLessThan(40);
  await expect(page.getByRole('heading', { name: '即時字幕' })).toBeVisible();
  await expect(page.getByText('輸入／原文')).toBeVisible();
  await expect(page.getByText('翻譯', { exact: true })).toBeVisible();
});

test('Legacy Session URL returns to Meeting Management without owner controls', async ({ page }) => {
  await page.goto('/#live?sessionId=session-read-only');

  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.getByRole('heading', { name: '會議管理' })).toBeVisible();
  await expect(page.locator('.live-sidebar, .feature-navigation')).toHaveCount(0);
});
