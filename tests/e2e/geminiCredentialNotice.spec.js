import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('guides users from the meeting flow to the Gemini Key settings page', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));

  await page.goto('/#meeting-settings?mode=create');

  const notice = page.locator('.gemini-credential-notice');
  await expect(notice).toContainText('錄音者必須輸入 Gemini API Key');
  await expect(notice).toContainText('不會儲存到瀏覽器或帳號設定');
  await expect(notice.getByPlaceholder('AIza…')).toHaveCount(0);
  await expect(page.locator('.header-key-action')).toHaveClass(/is-missing/);
  await notice.getByRole('link', { name: '設定 Gemini Key' }).click();
  await expect(page).toHaveURL(/#settings$/);
  const settingsNotice = page.locator('.gemini-credential-notice');
  const input = settingsNotice.getByPlaceholder('AIza…');
  await expect(input).toBeVisible();
  await input.fill('test-api-key');
  await expect(settingsNotice).toContainText('已載入本頁記憶體');
  await page.getByRole('link', { name: '返回會議管理' }).click();
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.locator('.header-key-action')).not.toHaveClass(/is-missing/);
  await expect(page.locator('body')).not.toContainText('test-api-key');
});
