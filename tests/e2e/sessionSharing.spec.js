import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('Meeting Viewer renders historical bilingual Cues without owner controls', async ({ page }) => {
  const cues = Array.from({ length: 40 }, (_, index) => ({ cueId: `cue-${index + 1}`, sequence: index + 1, startTimeMs: index * 1000, sourceText: `原文 ${index + 1}`, translatedText: `Translation ${index + 1}`, status: 'final' }));
  cues[39] = { ...cues[39], sourceText: '你好。', translatedText: 'Hi.', rawTranslation: 'Hi.', initialTranslation: 'speak Hi.' };
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
  await expect(page.getByText('LIVE TRANSCRIPT')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '即時翻譯' })).toHaveCount(0);
  await expect(page.getByText('你好。', { exact: true })).toBeVisible();
  await expect(page.getByText('speak Hi.', { exact: true })).toBeVisible();
  await expect(page.getByText('Hi.', { exact: true })).toHaveCount(0);
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
  await expect(page.getByTestId('viewer-source-toggle')).toHaveText('隱藏原文');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveText('隱藏翻譯');
  await expect(page.getByTestId('viewer-source-toggle')).toBeVisible();
});

test('Meeting Viewer persists independent subtitle visibility and keeps hidden updates', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
    if (!localStorage.getItem('live-translate:subtitle-visibility:recorder:v1')) {
      localStorage.setItem('live-translate:subtitle-visibility:recorder:v1', JSON.stringify({ showSource: true, showTranslation: false }));
    }
    if (!localStorage.getItem('live-translate:subtitle-visibility:viewer:v1')) {
      localStorage.setItem('live-translate:subtitle-visibility:viewer:v1', JSON.stringify({ showSource: false, showTranslation: false }));
    }
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    }
    window.EventSource = MockEventSource;
    window.__emitViewerCue = (payload) => MockEventSource.instances.at(-1)?.dispatchEvent(
      new MessageEvent(payload.type, { data: JSON.stringify(payload) })
    );
  });
  let snapshotCues = [
    { cueId: 'cue-1', sequence: 1, sourceText: '初始原文', translatedText: 'Initial translation', status: 'final' },
    { cueId: 'cue-2', sequence: 2, sourceText: '僅原文', translatedText: '', status: 'final' },
    { cueId: 'cue-3', sequence: 3, sourceText: '', translatedText: 'Translation only', status: 'final' }
  ];
  await page.route(/\/api\/shared-meetings\/code\/VISIBILITY1(?:\?.*)?$/, async (route) => route.fulfill({ json: {
    meeting: { id: 'meeting-1', name: '產品會議', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    cues: snapshotCues,
    cursor: { eventId: 1, cueSequence: 3 }
  } }));
  await page.route(/\/api\/shared-meetings\/code\/VISIBILITY1\/events(?:\?.*)?$/, async (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
  await page.goto('/#viewer?code=VISIBILITY1');

  const sourceToggle = page.getByTestId('viewer-source-toggle');
  const translationToggle = page.getByTestId('viewer-translation-toggle');
  await expect(sourceToggle).toHaveText('隱藏原文');
  await expect(translationToggle).toHaveText('隱藏翻譯');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('live-translate:subtitle-visibility:viewer:v1')))).toEqual({ showSource: true, showTranslation: true });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('live-translate:subtitle-visibility:recorder:v1')))).toEqual({ showSource: true, showTranslation: false });

  await translationToggle.click();
  await expect(sourceToggle).toBeDisabled();
  await expect(page.locator('.viewer-cue-translation')).toHaveCount(0);
  await expect(page.getByText('僅原文', { exact: true })).toBeVisible();
  await expect(page.getByText('至少顯示原文或翻譯')).toBeVisible();
  snapshotCues = snapshotCues.map((cue) => cue.cueId === 'cue-1'
    ? { ...cue, sourceText: '最新原文', translatedText: 'Latest hidden translation', sourceVersion: 2, translationVersion: 2 }
    : cue);
  await page.reload();
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveText('顯示翻譯');
  await expect(page.getByText('Latest hidden translation')).toHaveCount(0);

  await page.getByTestId('viewer-translation-toggle').click();
  await expect(page.getByText('Latest hidden translation')).toBeVisible();
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.getByTestId('viewer-translation-toggle')).toBeDisabled();
  await expect(page.locator('.viewer-cue-source')).toHaveCount(0);
  await expect(page.getByText('Translation only', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveText('顯示原文');
  await expect(page.getByTestId('viewer-translation-toggle')).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileControlBounds = await page.locator('.subtitle-visibility-controls').boundingBox();
  expect(mobileControlBounds).not.toBeNull();
  expect(mobileControlBounds.x).toBeGreaterThanOrEqual(0);
  expect(mobileControlBounds.x + mobileControlBounds.width).toBeLessThanOrEqual(390);
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
