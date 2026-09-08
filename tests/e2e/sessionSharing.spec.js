import { expect, test } from '@playwright/test';

test('Meeting Viewer renders historical bilingual Cues without owner controls', async ({ page }) => {
  const cues = Array.from({ length: 40 }, (_, index) => ({
    cueId: `cue-${index + 1}`,
    sequence: index + 1,
    startTimeMs: index * 1000,
    sourceText: index === 2 ? `原文 ${index + 1} `.repeat(18) : `原文 ${index + 1}`,
    translatedText: index === 2 ? `Translation ${index + 1} `.repeat(18) : `Translation ${index + 1}`,
    status: 'final'
  }));
  await page.route('**/api/shared-meetings/meeting-viewer-token', async (route) => route.fulfill({ json: {
    capability: { role: 'viewer', meetingId: 'meeting-1' },
    meeting: { id: 'meeting-1', name: '產品會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    cues,
    cursor: { eventId: 0, cueSequence: 1 }
  } }));
  await page.route('**/api/shared-meetings/meeting-viewer-token/events**', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `id: 1\nevent: cue.append\ndata: ${JSON.stringify({ eventId: 1, type: 'cue.append', meetingId: 'meeting-1', segmentId: 'segment-1', cue: { ...cues[1], cueId: 'cue-41', sequence: 41, sourceText: '原文 41', translatedText: 'Translation 41' } })}\n\n`
  }));

  await page.goto('/#viewer?token=meeting-viewer-token');

  await expect(page.getByRole('heading', { name: '產品會議' })).toBeVisible();
  await expect(page.getByText('原文 41', { exact: true })).toBeVisible();
  await expect(page.getByText('Translation 41', { exact: true })).toBeVisible();
  expect(await page.getByTestId('meeting-viewer-cue-row').count()).toBeGreaterThanOrEqual(10);
  await expect(page.getByRole('heading', { name: '即時字幕' })).toBeVisible();
  await expect(page.locator('.viewer-cue-actions')).toHaveCSS('flex-wrap', 'nowrap');
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.viewer-cue-source')).toHaveCount(0);
  await expect(page.locator('.viewer-cue-translation').first()).toHaveCSS('border-left-width', '0px');
  expect(await page.locator('.viewer-cue-row').first().evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.getByText('原文 40', { exact: true })).toBeVisible();
  await expect(page.getByText('來源字幕', { exact: true })).toHaveCount(0);
  await expect(page.locator('.viewer-cue-time')).toHaveCount(0);
  await expect(page.locator('.viewer-cue-row').first()).toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.viewer-cue-row').first()).toHaveCSS('grid-template-columns', /.+/);
  await expect(page.locator('.viewer-cue-translation').first()).toHaveCSS('border-left-width', '1px');
  expect(await page.locator('.viewer-cue-row').first().evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length)).toBe(2);
  expect(await page.getByTestId('meeting-viewer-cue-viewport').evaluate((viewport) => viewport.scrollWidth <= viewport.clientWidth)).toBe(true);

  await page.getByTestId('meeting-viewer-cue-viewport').evaluate((viewport) => viewport.scrollTo({ top: 0, behavior: 'auto' }));
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  expect(await page.locator('.viewer-cue-actions .button').evaluateAll((buttons) => Math.abs(buttons[0].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top) < 2)).toBe(true);
  expect(await page.getByTestId('meeting-viewer-cue-viewport').evaluate((viewport) => viewport.scrollTop)).toBe(0);
  await page.getByTestId('viewer-follow-latest-button').click();
  await expect.poll(() => page.getByTestId('meeting-viewer-cue-viewport').evaluate((viewport) => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)).toBeLessThan(24);

  await page.setViewportSize({ width: 599, height: 800 });
  await expect(page.locator('.viewer-cue-actions')).toHaveCSS('flex-wrap', 'nowrap');
  await page.getByTestId('meeting-viewer-cue-viewport').evaluate((viewport) => viewport.scrollTo({ top: 0, behavior: 'auto' }));
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  expect(await page.locator('.viewer-cue-actions .button').evaluateAll((buttons) => Math.abs(buttons[0].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top) < 2)).toBe(true);
  await expect(page.locator('.viewer-cue-row').first()).toHaveCSS('grid-template-columns', /.+/);
  expect(await page.locator('.viewer-cue-row').first().evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length)).toBe(1);
  await expect(page.locator('.viewer-cue-translation').first()).toHaveCSS('border-left-width', '0px');
  expect(await page.getByTestId('meeting-viewer-cue-viewport').evaluate((viewport) => viewport.scrollWidth <= viewport.clientWidth)).toBe(true);
  await expect.poll(() => page.locator('.viewer-cue-row').evaluateAll((rows) => rows.slice(0, -1).every((row, index) => row.getBoundingClientRect().bottom <= rows[index + 1].getBoundingClientRect().top))).toBe(true);
});
