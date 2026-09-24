import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('shows a memory-only Gemini Key input on the meeting creation flow', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));

  await page.goto('/#meeting-settings?mode=create');

  const notice = page.locator('.gemini-credential-notice');
  const input = notice.getByPlaceholder('AIza…');
  await expect(notice).toContainText('錄音者必須輸入 Gemini API Key');
  await expect(notice).toContainText('不會儲存到瀏覽器或帳號設定');
  await notice.getByRole('link', { name: '設定 Gemini Key' }).click();
  await expect(page).toHaveURL(/#settings$/);
  await page.goBack();
  await expect(notice).toBeVisible();
  await input.fill('test-api-key');
  await expect(notice).toContainText('已載入本頁記憶體');
  await expect(page.locator('body')).not.toContainText('test-api-key');
});
