import { expect, test } from '@playwright/test';

test('Meeting Viewer opens without a Workspace login', async ({ page }) => {
  await page.route(/\/api\/shared-meetings\/code\/VIEWER2(?:\?.*)?$/, async (route) => route.fulfill({
    json: {
      capability: { role: 'viewer', meetingId: 'meeting-1' },
      meeting: {
        id: 'meeting-1',
        name: '公開觀看會議',
        status: 'active',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en'
      },
      cues: [{
        cueId: 'cue-1',
        sequence: 1,
        startTimeMs: 0,
        sourceText: '公開原文',
        translatedText: 'Public translation',
        status: 'final'
      }],
      cursor: { eventId: 0, cueSequence: 1 }
    }
  }));
  await page.route(/\/api\/shared-meetings\/code\/VIEWER2\/events(?:\?.*)?$/, async (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: ''
  }));

  await page.goto('/#viewer?code=VIEWER2');

  await expect(page.getByRole('heading', { name: '公開觀看會議' })).toBeVisible();
  await expect(page.getByText('Public translation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用 Google 登入' })).toHaveCount(0);
  await expect(page.locator('.viewer-cue-index')).toHaveCount(0);
  const desktopDividers = await page.locator('.viewer-cue-row').evaluate((row) => ({
    rowBottom: getComputedStyle(row).borderBottomWidth,
    translationLeft: getComputedStyle(row.querySelector('.viewer-cue-translation')).borderLeftWidth
  }));
  expect(desktopDividers).toEqual({ rowBottom: '0px', translationLeft: '1px' });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDividers = await page.locator('.viewer-cue-row').evaluate((row) => ({
    rowBottom: getComputedStyle(row).borderBottomWidth,
    translationTop: getComputedStyle(row.querySelector('.viewer-cue-translation')).borderTopWidth
  }));
  expect(mobileDividers).toEqual({ rowBottom: '0px', translationTop: '1px' });
});

test('Meeting Viewer renders source-only Cue and updates delayed translation in place after reload', async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        this.readyState = 1;
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = MockEventSource;
    window.__emitViewerCue = (payload) => {
      const event = new MessageEvent('cue.append', { data: JSON.stringify(payload) });
      MockEventSource.instances.at(-1)?.dispatchEvent(event);
    };
  });
  await page.route(/\/api\/shared-meetings\/code\/PARTIAL1(?:\?.*)?$/, async (route) => route.fulfill({
    json: {
      capability: { role: 'viewer', meetingId: 'meeting-1' },
      meeting: { id: 'meeting-1', name: '部分完成字幕', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
      cues: [{
        cueId: 'cue-1', sequence: 1, startTimeMs: 0, sourceText: '先顯示原文', translatedText: '',
        sourceStatus: 'finalized', translationStatus: 'pending', sourceVersion: 1, translationVersion: 0, status: 'final'
      }],
      cursor: { eventId: 1, cueSequence: 1 }
    }
  }));

  await page.goto('/#viewer?code=PARTIAL1');
  await expect(page.getByText('先顯示原文', { exact: true })).toBeVisible();
  await expect(page.locator('.viewer-cue-row')).toHaveCount(1);

  const delayedTranslation = {
    eventId: 2,
    type: 'cue.append',
    cue: {
      cueId: 'cue-1', sequence: 1, startTimeMs: 0, sourceText: '先顯示原文', translatedText: 'Translation arrived later',
      sourceStatus: 'finalized', translationStatus: 'finalized', sourceVersion: 1, translationVersion: 1, status: 'final'
    }
  };
  await page.evaluate((payload) => window.__emitViewerCue(payload), delayedTranslation);
  await expect(page.getByText('Translation arrived later', { exact: true })).toBeVisible();
  await expect(page.locator('.viewer-cue-row')).toHaveCount(1);

  await page.reload();
  await expect(page.getByText('先顯示原文', { exact: true })).toBeVisible();
  await expect(page.locator('.viewer-cue-row')).toHaveCount(1);
  await page.evaluate((payload) => window.__emitViewerCue(payload), delayedTranslation);
  await expect(page.getByText('Translation arrived later', { exact: true })).toBeVisible();
  await expect(page.locator('.viewer-cue-row')).toHaveCount(1);
});

test('Meeting Viewer keeps current subtitles while a gap snapshot retries a transient 503', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        this.readyState = 1;
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = MockEventSource;
    window.__emitViewerGap = () => {
      const payload = { eventId: 3, type: 'cue.append', cue: { cueId: 'cue-gap', sequence: 3 } };
      MockEventSource.instances.at(-1)?.dispatchEvent(new MessageEvent('cue.append', { data: JSON.stringify(payload) }));
    };
  });

  let snapshots = 0;
  await page.route(/\/api\/shared-meetings\/code\/RETRY503(?:\?.*)?$/, async (route) => {
    snapshots += 1;
    if (snapshots === 2) {
      await route.fulfill({ status: 503, json: { error: { code: 'cloud_capability_unavailable' } } });
      return;
    }
    await route.fulfill({
      json: {
        capability: { role: 'viewer', meetingId: 'meeting-1' },
        meeting: { id: 'meeting-1', name: '恢復測試', status: 'active' },
        cues: snapshots === 1
          ? [{ cueId: 'cue-1', sequence: 1, sourceText: '斷線期間保留', sourceVersion: 1 }]
          : [{ cueId: 'cue-2', sequence: 2, sourceText: '重新連線後補齊', sourceVersion: 1 }],
        cursor: { eventId: snapshots === 1 ? 1 : 3, cueSequence: snapshots === 1 ? 1 : 2 },
      },
    });
  });

  await page.goto('/#viewer?code=RETRY503');
  await expect(page.getByText('斷線期間保留', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__emitViewerGap());
  await expect(page.getByText('斷線期間保留', { exact: true })).toBeVisible();
  await expect(page.getByText('重新連線後補齊', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => snapshots).toBe(3);
  await expect(page.getByRole('status')).toContainText('已連線');
  await expect(page.locator('.viewer-cue-row')).toHaveCount(2);
});

test('history scrolling keeps new Cues in DOM order and return-to-latest continues following', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
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
      new MessageEvent('cue.append', { data: JSON.stringify(payload) })
    );
  });
  const oldCues = Array.from({ length: 25 }, (_, index) => ({
    cueId: `old-${index + 1}`, segmentId: 'segment-1', segmentSequence: 1, sequence: index + 1,
    sourceText: `歷史字幕 ${index + 1}`, status: 'final', sourceVersion: 1, translationVersion: 0,
  }));
  await page.route(/\/api\/shared-meetings\/code\/ORDER1(?:\?.*)?$/, (route) => route.fulfill({
    json: { meeting: { id: 'meeting-1', name: '字幕排序', status: 'active' }, cues: oldCues,
      cursor: { eventId: 25, cueSequence: 25 } },
  }));
  await page.goto('/#viewer?code=ORDER1');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="old-25"]')).toBeVisible();
  await viewport.evaluate((node) => {
    node.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  await page.getByTestId('viewer-translation-toggle').click();
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(24);
  await page.getByTestId('viewer-translation-toggle').click();

  for (let index = 1; index <= 3; index += 1) {
    await page.evaluate((payload) => window.__emitViewerCue(payload), {
      eventId: 25 + index, type: 'cue.append',
      cue: { cueId: `new-${index}`, segmentId: 'segment-2', sequence: index,
        sourceText: `新字幕 ${index}`, status: 'final', sourceVersion: 1, translationVersion: 0 },
    });
  }
  const followLatestButton = page.getByTestId('viewer-follow-latest-button');
  await expect(followLatestButton).toHaveText('回到最新字幕（3 則新字幕）');
  await page.evaluate((payload) => window.__emitViewerCue(payload), {
    eventId: 28,
    type: 'cue.update',
    cue: {
      cueId: 'new-3', segmentId: 'segment-2', sequence: 3,
      sourceText: '新字幕 3 final revision', status: 'final', sourceVersion: 2, translationVersion: 0
    }
  });
  await expect(followLatestButton).toHaveText('回到最新字幕（3 則新字幕）');
  await followLatestButton.click();
  await expect(viewport.locator('[data-cue-id="new-3"]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => ({
    ids: [...node.querySelectorAll('.viewer-cue-row')].map((row) => row.dataset.cueId),
    atBottom: node.scrollHeight - node.scrollTop - node.clientHeight < 24,
  }))).toMatchObject({ atBottom: true, ids: expect.arrayContaining(['new-3']) });
  const bottomId = await viewport.evaluate((node) => [...node.querySelectorAll('.viewer-cue-row')]
    .sort((a, b) => Number(a.dataset.cueIndex) - Number(b.dataset.cueIndex)).at(-1)?.dataset.cueId);
  expect(bottomId).toBe('new-3');

  await page.evaluate((payload) => window.__emitViewerCue(payload), {
    eventId: 29, type: 'cue.update',
    cue: { cueId: 'new-3', segmentId: 'segment-2', sequence: 3, sourceText: '新字幕 3',
      translatedText: 'Delayed translation with an additional wrapped line', status: 'final',
      sourceVersion: 1, translationVersion: 1 },
  });
  await expect(viewport.locator('[data-cue-id="new-3"]')).toContainText('Delayed translation');
  await page.evaluate((payload) => window.__emitViewerCue(payload), {
    eventId: 30, type: 'cue.append',
    cue: { cueId: 'new-4', segmentId: 'segment-2', sequence: 4,
      sourceText: '繼續跟隨', status: 'final', sourceVersion: 1, translationVersion: 0 },
  });
  await expect(viewport.locator('[data-cue-id="new-4"]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(24);
});
