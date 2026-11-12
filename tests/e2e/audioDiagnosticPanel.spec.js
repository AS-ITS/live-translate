import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test('audio diagnostics show safe recent errors after reopening on desktop and iPhone', async ({ page, browserName }) => {
  await installE2EAuth(page, { id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' });
  await page.goto('/#meetings');
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const { recordAudioFailure, recordAudioRecorderState } = await import('/src/lib/audioFailureDiagnostic.js');
    recordAudioRecorderState({ mimeType: 'audio/mp4', chunkRecorded: true });
    for (let index = 0; index < 12; index += 1) {
      recordAudioFailure({ audioPath: 'ORIGINAL_AUDIO', stage: 'PCM_CAPTURE',
        error: { code: 'WEBM_UNSUPPORTED', message: 'secret subtitle token', stack: 'private stack' },
        segmentId: 'private-meeting-id' });
    }
    const error = new DOMException('private storage path', 'UnknownError');
    error.opfsOperation = 'WRITABLE_CREATE';
    error.opfsApi = 'GET_DIRECTORY_HANDLE';
    recordAudioFailure({ audioPath: 'TRANSLATED_AUDIO', stage: 'AUDIO_CHUNK_WRITE', error });
  });

  const menuButton = page.getByRole('button', { name: '開啟導覽選單' });
  if (await menuButton.isVisible()) await menuButton.click();
  const menu = await menuButton.isVisible()
    ? page.getByRole('dialog', { name: '導覽選單' }) : page.locator('.app-header-actions');
  await menu.getByRole('button', { name: '音訊診斷' }).click();
  const panel = page.getByRole('dialog', { name: '音訊診斷' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('WebM / Opus 瀏覽器宣告')).toBeVisible();
  await expect(panel.getByText('MP4 / AAC 瀏覽器宣告')).toBeVisible();
  await expect(panel.getByText('audio/mp4')).toBeVisible();
  await expect(panel.getByText('已收到非空音訊區塊')).toBeVisible();
  await expect(panel.locator('.audio-diagnostic-events li')).toHaveCount(10);
  await expect(panel.getByText('WEBM_UNSUPPORTED').first()).toBeVisible();
  await expect(panel.getByText('WRITABLE_CREATE')).toBeVisible();
  await expect(panel.getByText('GET_DIRECTORY_HANDLE')).toBeVisible();
  await expect(panel.getByText('DOM_EXCEPTION')).toBeVisible();
  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/secret|subtitle|token|private|owner@example.com|meeting-id|stack/iu);
  await panel.getByRole('button', { name: '複製診斷摘要' }).click();
  await expect(panel.getByRole('status')).toContainText(/已複製診斷摘要|無法複製，可直接截圖回報/u);
  if (browserName === 'chromium' && await panel.getByRole('status').innerText() === '已複製診斷摘要') {
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('ORIGINAL_AUDIO PCM_CAPTURE WEBM_UNSUPPORTED');
    expect(copied).not.toMatch(/secret|subtitle|token|private|meeting-id|stack/iu);
  }
  await panel.getByRole('button', { name: '關閉' }).click();
  if (await menuButton.isVisible()) await menuButton.click();
  const reopenedMenu = await menuButton.isVisible()
    ? page.getByRole('dialog', { name: '導覽選單' }) : page.locator('.app-header-actions');
  await reopenedMenu.getByRole('button', { name: '音訊診斷' }).click();
  await expect(panel.locator('.audio-diagnostic-events li')).toHaveCount(10);
  const layout = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(layout.scroll).toBeLessThanOrEqual(layout.viewport + 1);
});
