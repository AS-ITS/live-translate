import { expect, test } from '@playwright/test';

async function openViewer(page, { code, fullscreenApi = 'native', cues = defaultCues() }) {
  await page.addInitScript(({ mode }) => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });

    class MockEventSource extends EventTarget {
      static instances = [];

      constructor() {
        super();
        this.readyState = 1;
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }

      close() {
        this.readyState = 2;
      }
    }

    window.EventSource = MockEventSource;
    window.__reconnectViewer = () => {
      const source = MockEventSource.instances.at(-1);
      source?.onerror?.(new Event('error'));
      source?.onopen?.(new Event('open'));
    };
    window.__emitViewerCue = (payload) => {
      MockEventSource.instances.at(-1)?.dispatchEvent(new MessageEvent('cue.append', {
        data: JSON.stringify(payload)
      }));
    };

    if (mode === 'unsupported') {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    }

    if (mode === 'reject') {
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Fullscreen denied', 'NotAllowedError'))
      });
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    }
  }, { mode: fullscreenApi });

  await page.route(new RegExp(`/api/shared-meetings/code/${code}(?:\\?.*)?$`), (route) => route.fulfill({
    json: {
      meeting: { id: `meeting-${code}`, name: '手機全螢幕測試', status: 'active' },
      cues,
      cursor: { eventId: cues.length, cueSequence: cues.length }
    }
  }));

  await page.goto(`/#viewer?code=${code}`);
  await expect(page.getByTestId('meeting-viewer-cue-viewport')).toBeVisible();
}

function defaultCues(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    cueId: `cue-${index + 1}`,
    segmentId: 'segment-1',
    segmentSequence: 1,
    sequence: index + 1,
    sourceText: `原文 ${index + 1}`,
    translatedText: `Translation ${index + 1}`,
    sourceVersion: 1,
    translationVersion: 1
  }));
}

async function scrollViewerUp(viewport) {
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1_200 }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

test('Viewer subtitle size updates immediately, persists, and preserves history mode', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openViewer(page, {
    code: 'FONT-SIZE',
    fullscreenApi: 'unsupported',
    cues: defaultCues(30)
  });

  const shell = page.getByTestId('viewer-fullscreen-shell');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  const source = page.locator('.viewer-cue-source p').first();
  const translation = page.locator('.viewer-cue-translation p').first();

  await expect(shell).toHaveAttribute('data-subtitle-font-size', 'medium');
  await expect(source).toHaveCSS('font-size', '36px');
  await expect(translation).toHaveCSS('font-size', '36px');

  await scrollViewerUp(viewport);
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  await page.getByTestId('viewer-font-size-large').click();

  await expect(shell).toHaveAttribute('data-subtitle-font-size', 'large');
  await expect(source).toHaveCSS('font-size', '52px');
  await expect(translation).toHaveCSS('font-size', '52px');
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => (
    node.scrollTop < node.scrollHeight - node.clientHeight
  ))).toBe(true);

  await page.evaluate(() => window.__emitViewerCue({
    eventId: 31,
    type: 'cue.append',
    cue: {
      cueId: 'cue-31',
      segmentId: 'segment-1',
      segmentSequence: 1,
      sequence: 31,
      sourceText: '新同步原文',
      translatedText: 'New synchronized translation',
      sourceVersion: 1,
      translationVersion: 1
    }
  }));
  await expect(page.getByTestId('viewer-follow-latest-button')).toContainText('1 則新字幕');
  await page.getByTestId('viewer-follow-latest-button').click();
  await expect(page.getByText('New synchronized translation')).toHaveCSS('font-size', '52px');

  await page.getByTestId('viewer-fullscreen-toggle').click();
  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'css');
  await expect(shell).toHaveAttribute('data-subtitle-font-size', 'large');
  await page.getByTestId('viewer-fullscreen-toggle').click();

  await page.reload();
  await expect(page.getByTestId('meeting-viewer-cue-viewport')).toBeVisible();
  await expect(shell).toHaveAttribute('data-subtitle-font-size', 'large');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
  await expect.poll(() => viewport.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('Viewer uses native Fullscreen API and exits through the same toggle', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-webkit', 'iPhone Safari is covered by the CSS fullscreen fallback test.');
  await openViewer(page, { code: 'FULLSCREEN-NATIVE' });

  const shell = page.getByTestId('viewer-fullscreen-shell');
  const toggle = page.getByTestId('viewer-fullscreen-toggle');
  await toggle.click();

  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'native');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText('結束全螢幕');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.dataset.testid)).toBe('viewer-fullscreen-shell');

  await toggle.click();
  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'inline');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('Viewer uses reversible CSS fullscreen without an error when Fullscreen API is unsupported', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openViewer(page, { code: 'FULLSCREEN-CSS', fullscreenApi: 'unsupported', cues: defaultCues(30) });

  const shell = page.getByTestId('viewer-fullscreen-shell');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  const toggle = page.getByTestId('viewer-fullscreen-toggle');
  await page.getByTestId('viewer-source-toggle').click();
  await scrollViewerUp(viewport);
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  const scrollTopBefore = await viewport.evaluate((node) => node.scrollTop);
  await toggle.click();

  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'css');
  await expect(shell).toHaveCSS('position', 'fixed');
  await expect(toggle).toHaveText('結束全螢幕');
  await expect(page.getByTestId('viewer-fullscreen-error')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Viewer 分享連結 QR Code' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.evaluate(() => window.__reconnectViewer());
  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'css');
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveAttribute('aria-pressed', 'true');

  await toggle.click();
  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'inline');
  await expect(shell).not.toHaveCSS('position', 'fixed');
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(scrollTopBefore);
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('Viewer falls back after native rejection and owns one dismissible five-second error timer', async ({ page }) => {
  await page.clock.install();
  await openViewer(page, { code: 'FULLSCREEN-REJECT', fullscreenApi: 'reject' });

  const shell = page.getByTestId('viewer-fullscreen-shell');
  const toggle = page.getByTestId('viewer-fullscreen-toggle');
  const error = page.getByTestId('viewer-fullscreen-error');
  await toggle.click();

  await expect(shell).toHaveAttribute('data-fullscreen-mode', 'css');
  await expect(error).toHaveCount(1);
  await expect(error).toContainText('已改用版面全螢幕');

  await page.clock.fastForward(1_000);
  await error.getByRole('button', { name: '關閉全螢幕提示' }).click();
  await expect(error).toHaveCount(0);

  await toggle.click();
  await toggle.click();
  await expect(error).toHaveCount(1);
  await page.clock.fastForward(4_001);
  await expect(error).toHaveCount(1);
  await page.clock.fastForward(999);
  await expect(error).toHaveCount(0);
});
