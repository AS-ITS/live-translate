import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('meeting glossary save failure never reports the settings as saved', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'cloud_capability_unavailable' } })
    });
  });
  await page.goto('/#meeting-settings?mode=create');
  const name = page.getByRole('textbox', { name: /會議名稱/ });
  await name.fill('字典儲存失敗測試');

  await page.getByRole('button', { name: '建立會議' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('會議已建立。')).toHaveCount(0);
  await expect(name).toHaveValue('字典儲存失敗測試');
});
