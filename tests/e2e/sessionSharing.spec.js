import { expect, test } from '@playwright/test';
import { installHostViewerHarness } from './hostViewerHarness.js';
import { readViewerCueStore } from './issue41ViewerFinalStateContract.js';


test('Meeting Viewer renders Host bilingual Cues without owner controls', async ({ page }) => {
  const cues = Array.from({ length: 40 }, (_, index) => ({ cueId: `cue-${index + 1}`, sequence: index + 1, sessionId: 'session-1', segmentId: 'segment-1', startTimeMs: index * 1000, sourceText: `原文 ${index + 1}`, translatedText: `Translation ${index + 1}`, sourceVersion: 1, translationVersion: 1, status: 'final' }));
  cues[39] = { ...cues[39], sourceText: '你好。', translatedText: 'Hi.', rawTranslation: 'Hi.', initialTranslation: 'speak Hi.' };
  const state = await installHostViewerHarness(page, { code: 'HISTORY40', meetingId: 'meeting-1', meetingName: '產品會議', cues, segments: [{ id: 'segment-1', sessionId: 'session-1', sequence: 1 }] });
  await page.goto('/#viewer?code=HISTORY40');
  const canonicalViewerUrl = new URL('/#viewer?code=HISTORY40', page.url()).href;
  const viewerHeader = page.getByTestId('viewer-share-header');
  await expect(viewerHeader.getByRole('heading', { name: '產品會議' })).toBeVisible();
  await expect(viewerHeader.getByText('即時字幕', { exact: true })).toBeVisible();
  await expect(viewerHeader.getByRole('link', { name: 'Viewer 分享連結' })).toHaveText(canonicalViewerUrl);
  await expect(viewerHeader.getByRole('img', { name: 'Viewer 分享連結 QR Code' })).toBeVisible();
  await expect(viewerHeader.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('LIVE TRANSCRIPT')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '即時翻譯' })).toHaveCount(0);
  await expect(page.getByText('你好。', { exact: true })).toBeVisible();
  await expect(page.getByText('speak Hi.', { exact: true })).toBeVisible();
  await expect(page.getByText('Hi.', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('meeting-viewer-cue-row').first()).toBeVisible();
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.locator('.viewer-cue-source')).toHaveCount(0);
  await expect(page.locator('.viewer-cue-translation').first()).toBeVisible();

  const cueViewport = page.getByTestId('meeting-viewer-cue-viewport');
  const headerTop = await viewerHeader.evaluate((node) => node.getBoundingClientRect().top);
  const initialScrollTop = await cueViewport.evaluate((node) => node.scrollTop);
  await cueViewport.hover();
  await page.mouse.wheel(0, -1800);
  const followLatestButton = page.getByTestId('viewer-follow-latest-button');
  await expect(followLatestButton).toBeVisible();
  const visibilityButtonColors = await page.getByTestId('viewer-source-toggle').evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
  const followLatestButtonColors = await followLatestButton.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
  for (const colors of [visibilityButtonColors, followLatestButtonColors]) {
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.color).toBe('rgb(255, 255, 255)');
  }
  await expect.poll(() => cueViewport.evaluate((node) => node.scrollTop)).toBeLessThan(initialScrollTop);
  expect(await viewerHeader.evaluate((node) => node.getBoundingClientRect().top)).toBe(headerTop);
  await followLatestButton.click();
  await expect.poll(() => cueViewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(24);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => {
    const header = document.querySelector('[data-testid="viewer-share-header"]').getBoundingClientRect();
    const viewport = document.querySelector('[data-testid="meeting-viewer-cue-viewport"]').getBoundingClientRect();
    const shareUrl = document.querySelector('.viewer-share-url').getBoundingClientRect();
    return { headerBottom: header.bottom, viewportTop: viewport.top, shareUrlRight: shareUrl.right, pageWidth: document.documentElement.scrollWidth };
  });
  expect(mobileLayout.pageWidth).toBeLessThanOrEqual(390);
  expect(mobileLayout.shareUrlRight).toBeLessThanOrEqual(390);
  expect(mobileLayout.headerBottom).toBeLessThanOrEqual(mobileLayout.viewportTop);
  expect(state.metadataReads).toBeGreaterThan(0);
  expect(state.cloudContentReads).toBe(0);
});

test('Meeting Viewer keeps the source toggle visible while waiting for the first Host Cue', async ({ page }) => {
  const state = await installHostViewerHarness(page, { code: 'WAITFIRST', meetingId: 'meeting-1', meetingName: '產品會議' });
  await page.goto('/#viewer?code=WAITFIRST');
  await expect(page.getByText('等待錄音端送出第一句字幕')).toBeVisible();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveText('隱藏原文');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveText('隱藏翻譯');
  expect(state.cloudContentReads).toBe(0);
});
test('Meeting Viewer persists independent subtitle visibility and keeps hidden DataChannel updates', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('live-translate:subtitle-visibility:recorder:v1')) {
      localStorage.setItem('live-translate:subtitle-visibility:recorder:v1',
        JSON.stringify({ showSource: true, showTranslation: false }));
    }
    if (!localStorage.getItem('live-translate:subtitle-visibility:viewer:v1')) {
      localStorage.setItem('live-translate:subtitle-visibility:viewer:v1',
        JSON.stringify({ showSource: false, showTranslation: false }));
    }
  });
  const segment = { id: 'segment-1', sessionId: 'session-1', sequence: 1 };
  const base = { sessionId: segment.sessionId, segmentId: segment.id, sourceVersion: 1, translationVersion: 1, status: 'final' };
  const state = await installHostViewerHarness(page, {
    code: 'VISIBILITY1', meetingId: 'meeting-1', meetingName: '產品會議',
    segments: [segment], cues: [
      { ...base, cueId: 'cue-1', sequence: 1, sourceText: '初始原文', translatedText: 'Initial translation' },
      { ...base, cueId: 'cue-2', sequence: 2, sourceText: '僅原文', translatedText: '' },
      { ...base, cueId: 'cue-3', sequence: 3, sourceText: '', translatedText: 'Translation only' }
    ]
  });
  await page.goto('/#viewer?code=VISIBILITY1');
  const sourceToggle = page.getByTestId('viewer-source-toggle');
  const translationToggle = page.getByTestId('viewer-translation-toggle');
  await expect(sourceToggle).toHaveText('隱藏原文');
  await expect(translationToggle).toHaveText('隱藏翻譯');
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('live-translate:subtitle-visibility:viewer:v1'))))
    .toEqual({ showSource: true, showTranslation: true });
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('live-translate:subtitle-visibility:recorder:v1'))))
    .toEqual({ showSource: true, showTranslation: false });
  await translationToggle.click();
  await expect(sourceToggle).toBeEnabled();
  await expect(page.locator('.viewer-cue-translation')).toHaveCount(0);
  await expect(page.getByText('僅原文', { exact: true })).toBeVisible();
  await expect(page.getByText('至少顯示原文或翻譯')).toHaveCount(0);
  await page.evaluate(() => window.__hostPublish({
    ...window.__hostCues[0], sourceText: '最新原文', translatedText: 'Latest hidden translation',
    sourceVersion: 2, translationVersion: 2
  }, 'cue.update'));
  await expect.poll(async () => (await page.evaluate(readViewerCueStore)).cues?.[0]?.sourceVersion).toBe(2);
  await page.reload();
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveText('顯示翻譯');
  await expect(page.getByText('Latest hidden translation')).toHaveCount(0);
  await page.getByTestId('viewer-translation-toggle').click();
  await expect(page.getByText('Latest hidden translation')).toBeVisible();
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.getByTestId('viewer-translation-toggle')).toBeEnabled();
  await expect(page.locator('.viewer-cue-source')).toHaveCount(0);
  await expect(page.getByText('Translation only', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveText('顯示原文');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveText('隱藏翻譯');
  await expect(page.getByTestId('viewer-translation-toggle')).toBeEnabled();
  await page.getByTestId('viewer-translation-toggle').click();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveText('隱藏原文');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveText('顯示翻譯');
  await expect(page.getByTestId('viewer-source-toggle')).toBeEnabled();
  await expect(page.locator('.viewer-cue-source').first()).toBeVisible();
  await expect(page.locator('.viewer-cue-translation')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('.subtitle-visibility-controls').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(state.cloudContentReads).toBe(0);
});

test('Viewer restores older Host Cues from DataChannel snapshot after reconnect', async ({ page }) => {
  const cues = Array.from({ length: 105 }, (_, index) => ({
    cueId: `cue-${index + 1}`, sessionId: 'session-1', segmentId: 'segment-1',
    sequence: index + 1, startTimeMs: index * 1000,
    sourceText: `原文 ${index + 1}`, translatedText: `Translation ${index + 1}`,
    sourceVersion: 1, translationVersion: 1, status: 'final'
  }));
  const state = await installHostViewerHarness(page, {
    code: 'REPLAY105', meetingId: 'meeting-1', cues,
    segments: [{ id: 'segment-1', sessionId: 'session-1', sequence: 1 }]
  });
  await page.goto('/#viewer?code=REPLAY105');
  await expect.poll(async () => (await page.evaluate(readViewerCueStore)).cues?.length).toBe(105);
  await page.evaluate(() => window.__hostClose());
  await expect(page.getByText('等待 Host 重新連線', { exact: true })).toBeVisible();
  await expect.poll(async () => (await page.evaluate(readViewerCueStore)).cues?.length).toBe(105);
  const restored = await page.evaluate(readViewerCueStore);
  expect(restored.cues.map((item) => item.cueId)).toEqual(cues.map((item) => item.cueId));
  expect(restored.cues.every((item) => item.sourceVersion === 1 && item.translationVersion === 1)).toBe(true);
  expect(state.cloudContentReads).toBe(0);
});
