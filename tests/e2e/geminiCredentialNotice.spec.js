import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('guides users from the meeting flow to the Gemini Key settings page', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));

  await page.goto('/#meetings');

  const notice = page.locator('.gemini-credential-notice');
  await expect(notice).toContainText('開始錄音前，請先設定 Gemini API 金鑰');
  await expect(notice).toContainText('不會儲存到瀏覽器或帳號');
  await expect(notice.getByLabel('Gemini API Key')).toHaveCount(0);
  await expect(notice.getByRole('link', { name: '設定 Gemini 金鑰' })).toHaveCount(0);
  await expect(page.locator('.header-key-action')).toHaveClass(/is-missing/);
  await page.locator('.header-key-action').click();
  await expect(page).toHaveURL(/#settings$/);
  const settingsNotice = page.locator('.gemini-credential-notice');
  await expect(settingsNotice).toHaveCount(0);
  const input = page.getByLabel('Gemini API Key').last();
  await expect(input).toBeVisible();
  await input.fill('test-ABcd');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.locator('body')).not.toContainText('test-ABcd');
  await expect(page.locator('.header-key-action')).not.toHaveClass(/is-missing/);
  await expect(page.locator('.gemini-credential-notice')).toHaveCount(0);
  await page.getByRole('link', { name: 'Gemini Key' }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByText('...ABcd', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤消金鑰' }).click();
  await expect(page.getByText('...ABcd', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '返回上一頁' }).click();
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.locator('.header-key-action')).toHaveClass(/is-missing/);
});
