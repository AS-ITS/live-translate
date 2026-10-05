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
