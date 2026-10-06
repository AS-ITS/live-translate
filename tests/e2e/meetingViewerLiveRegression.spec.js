import { expect, test } from '@playwright/test';

test('Viewer keeps receiving and following cues when earlier live cues lack segment order', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = MockEventSource;
    window.__emitCue = (payload) => MockEventSource.instances.at(-1)?.dispatchEvent(
      new MessageEvent('cue.append', { data: JSON.stringify(payload) })
    );
    window.__disconnectViewer = () => MockEventSource.instances.at(-1)?.onerror?.(new Event('error'));
  });

  const snapshotCues = Array.from({ length: 25 }, (_, index) => ({
    cueId: `old-${index + 1}`, segmentId: 'segment-1', segmentSequence: 1,
    sequence: index + 1, sourceText: `歷史字幕 ${index + 1}`, sourceVersion: 1,
  }));
  await page.route(/\/api\/shared-meetings\/code\/LIVEORDER(?:\?.*)?$/, (route) => route.fulfill({
    json: { meeting: { id: 'meeting-1', name: '即時字幕測試', status: 'active' },
      cues: snapshotCues, cursor: { eventId: 25, cueSequence: 25 } },
  }));
  await page.goto('/#viewer?code=LIVEORDER');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="old-25"]')).toBeVisible();

  async function publish(eventId, cueId, segmentId, segmentSequence, sequence, sourceText, extra = {}) {
    await page.evaluate((payload) => window.__emitCue(payload), {
      eventId, type: 'cue.append', cue: { cueId, segmentId, ...(segmentSequence ? { segmentSequence } : {}),
        sequence, sourceText, sourceVersion: 1, status: 'final', ...extra },
    });
  }

  // Realtime payloads can omit segmentSequence even when snapshot rows include it.
  await publish(26, 'old-26', 'segment-1', null, 26, '舊字幕 26');
  await publish(27, 'old-27', 'segment-1', null, 27, '舊字幕 27');
  await expect(viewport.locator('[data-cue-id="old-27"]')).toBeVisible();
  for (const [index, letter] of ['A', 'B', 'C'].entries()) {
    await publish(28 + index, `new-${letter}`, 'segment-2', 2, index + 1, `新字幕 ${letter}`);
  }
  await expect(viewport.locator('[data-cue-id="new-C"]')).toHaveCount(1);
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-C');
  await expect(viewport.locator('[data-cue-id="new-C"]')).toBeVisible();

  await viewport.hover();
  await page.mouse.wheel(0, -1800);
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  await publish(31, 'new-D', 'segment-2', 2, 4, '新字幕 D');
  await publish(32, 'new-E', 'segment-2', 2, 5, '新字幕 E');
  await page.getByTestId('viewer-follow-latest-button').click();
  await expect(viewport.locator('[data-cue-id="new-E"]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-E');

  await publish(33, 'old-26', 'segment-1', null, 26, '舊字幕 26', {
    translatedText: 'Late translation', translationVersion: 1,
  });
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-E');
  await expect(viewport.locator('[data-cue-id="old-26"]')).toHaveCount(1);
  await expect(viewport.locator('[data-cue-id="old-26"]')).toContainText('Late translation');
  expect(await viewport.locator('[data-cue-id="old-26"]').getAttribute('data-cue-index'))
    .toBe('25');

  // A fresh snapshot fills the offline gap; the new subscription must still receive live cues.
  snapshotCues.push({ cueId: 'new-F', segmentId: 'segment-2', segmentSequence: 2,
    sequence: 6, sourceText: '斷線期間字幕 F', sourceVersion: 1 });
  await page.evaluate(() => window.__disconnectViewer());
  await expect(viewport.locator('[data-cue-id="new-F"]')).toBeVisible();
  await publish(34, 'new-G', 'segment-2', 2, 7, '恢復後字幕 G');
  await expect(viewport.locator('[data-cue-id="new-G"]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-G');
});
