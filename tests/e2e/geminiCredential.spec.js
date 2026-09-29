import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('sets and revokes the lifecycle-memory Gemini API Key', async ({ page }) => {
  await page.goto('/#settings');

  const input = page.getByRole('textbox', { name: 'Gemini API Key' });
  await expect(input).toBeVisible();
  await input.fill('  test-ABcd  ');
  await page.getByRole('button', { name: '設定金鑰' }).click();

  await expect(page.getByText('...ABcd', { exact: true })).toBeVisible();
  await expect(page.getByText('已設定', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-ABcd');

  await page.getByRole('button', { name: '撤消金鑰' }).click();
  await expect(page.getByText('...ABcd', { exact: true })).toHaveCount(0);
  await expect(page.getByText('已設定', { exact: true })).toHaveCount(0);
});

test('logout clears the lifecycle-memory Gemini API Key', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#settings');
  await page.getByRole('textbox', { name: 'Gemini API Key' }).fill('test-logout-ABcd');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await expect(page.getByText('...ABcd', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '返回會議管理' }).click();
  await page.locator('.account-menu-trigger').click();
  await page.getByRole('menuitem', { name: '登出' }).click();
  await expect(page.getByRole('heading', { name: '歡迎回來' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-logout-ABcd');
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => /gemini|credential/u.test(key)))).toBe(false);
});
