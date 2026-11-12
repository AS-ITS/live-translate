import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test('meeting navigation has no audio diagnostic entry or panel', async ({ page }) => {
  await installE2EAuth(page, { id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' });
  await page.goto('/#meetings');
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();

  const menuButton = page.getByRole('button', { name: '開啟導覽選單' });
  if (await menuButton.isVisible()) await menuButton.click();
  const menu = await menuButton.isVisible()
    ? page.getByRole('dialog', { name: '導覽選單' }) : page.locator('.app-header-actions');
  await expect(menu.getByRole('button', { name: '音訊診斷' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '音訊診斷' })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: 'Gemini Key' })).toBeVisible();
});
