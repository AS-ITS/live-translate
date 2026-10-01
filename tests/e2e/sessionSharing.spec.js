import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('Meeting Viewer renders historical bilingual Cues without owner controls', async ({ page }) => {
  const cues = Array.from({ length: 40 }, (_, index) => ({ cueId: `cue-${index + 1}`, sequence: index + 1, startTimeMs: index * 1000, sourceText: `原文 ${index + 1}`, translatedText: `Translation ${index + 1}`, status: 'final' }));
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token(?:\?.*)?$/, async (route) => route.fulfill({ json: { capability: { role: 'viewer', meetingId: 'meeting-1' }, meeting: { id: 'meeting-1', name: '產品會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }, cues, cursor: { eventId: 0, cueSequence: 1 } } }));
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token\/events(?:\?.*)?$/, async (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
  const [snapshotResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'GET' && /\/api\/shared-meetings\/meeting-viewer-token(?:\?.*)?$/.test(new URL(response.url()).pathname + new URL(response.url()).search)),
    page.goto('/#viewer?token=meeting-viewer-token')
  ]);
  await expect((await snapshotResponse).status()).toBe(200);
  const viewerHeader = page.locator('.app-header');
  await expect(viewerHeader.getByRole('heading', { name: '產品會議' })).toBeVisible();
  await expect(viewerHeader.getByText('即時字幕', { exact: true })).toBeVisible();
  await expect(viewerHeader.locator('.app-header-actions')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '即時翻譯' })).toBeVisible();
  await expect(page.getByText('原文 40', { exact: true })).toBeVisible();
  await expect(page.getByText('Translation 40', { exact: true })).toBeVisible();
  await expect(page.getByTestId('meeting-viewer-cue-row').first()).toBeVisible();
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.locator('.viewer-cue-source')).toHaveCount(0);
  await expect(page.locator('.viewer-cue-translation').first()).toBeVisible();
});

test('Meeting Viewer keeps the source toggle visible while waiting for the first Cue', async ({ page }) => {
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token(?:\?.*)?$/, async (route) => route.fulfill({ json: {
    meeting: { id: 'meeting-1', name: '產品會議', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    cues: [],
    cursor: { eventId: 0, cueSequence: 0 }
  } }));
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token\/events(?:\?.*)?$/, async (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));

  await page.goto('/#viewer?token=meeting-viewer-token');

  await expect(page.getByText('等待錄音端送出第一句字幕')).toBeVisible();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveText('顯示原文');
  await expect(page.getByTestId('viewer-source-toggle')).toBeVisible();
});

test('Meeting Viewer loads older Cues with the opaque pagination cursor', async ({ page }) => {
  const latestCues = Array.from({ length: 100 }, (_, index) => ({
    cueId: `cue-${index + 6}`,
    sequence: index + 6,
    startTimeMs: index * 1000,
    sourceText: `原文 ${index + 6}`,
    translatedText: `Translation ${index + 6}`,
    status: 'final'
  }));
  let requestedBefore = '';
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    requestedBefore = url.searchParams.get('before') || '';
    await route.fulfill({ json: {
      meeting: { id: 'meeting-1', name: '產品會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
      cues: requestedBefore ? Array.from({ length: 5 }, (_, index) => ({ cueId: `cue-${index + 1}`, sequence: index + 1, sourceText: `原文 ${index + 1}`, translatedText: `Translation ${index + 1}`, status: 'final' })) : latestCues,
      pagination: requestedBefore ? { limit: 100, hasMore: false, nextCursor: null } : { limit: 100, hasMore: true, nextCursor: 'older-cursor' }
    } });
  });
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token\/events(?:\?.*)?$/, async (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));

  await page.goto('/#viewer?token=meeting-viewer-token');
  await expect(page.getByTestId('viewer-load-older-button')).toBeVisible();
  await page.getByTestId('viewer-load-older-button').click();
  await expect.poll(() => requestedBefore).toBe('older-cursor');
  await expect(page.getByTestId('viewer-load-older-button')).toHaveCount(0);
});
