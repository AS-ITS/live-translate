import { expect, test } from '@playwright/test';

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
