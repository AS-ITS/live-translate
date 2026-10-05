import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

async function openMeetingManagement(page, profile) {
  await installE2EAuth(page, profile);
  await page.goto('/#meetings');
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();
}

async function expectFeaturePageHeader(page, title, { mobile = false } = {}) {
  await expect(page.locator('.meeting-app-header h1')).toHaveText(title);
  await expect(page.locator('.app-header-actions .header-key-action')).toHaveCount(0);
  if (mobile) {
    await expect(page.getByRole('button', { name: '開啟導覽選單' })).toBeVisible();
    return;
  }
  await expect(page.getByRole('link', { name: '返回會議管理' })).toBeVisible();
  await expect(page.locator('.account-menu-trigger')).toBeVisible();
}

test('owner can use the responsive mobile navigation without admin links', async ({ page }) => {
  await openMeetingManagement(page, { id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' });

  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const menuButton = page.getByRole('button', { name: '開啟導覽選單' });
    await expect(menuButton).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.meeting-app-header h1')).toBeVisible();
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);

    await menuButton.click();
    const menu = page.getByRole('dialog', { name: '導覽選單' });
    await expect(menu).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('link', { name: 'Gemini Key' })).toBeVisible();
    await expect(menu.getByRole('link', { name: '帳號管理' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: '稽核紀錄' })).toHaveCount(0);
    await expect(page.evaluate(() => document.body.style.overflow)).resolves.toBe('hidden');
    await expect(page.evaluate(() => {
      const panel = document.querySelector('.mobile-nav-panel');
      const rect = panel?.getBoundingClientRect();
      return Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth);
    })).resolves.toBe(true);

    if (width === 375) await page.screenshot({ path: 'test-results/header-mobile-open-375.png' });
    if (width === 390) {
      await menu.getByRole('button', { name: '關閉導覽選單' }).click();
    } else if (width === 320 || width === 430) {
      await page.locator('.mobile-nav-backdrop').click({ position: { x: 2, y: 400 }, force: true });
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    await expect(page.evaluate(() => document.body.style.overflow)).resolves.toBe('');
    if (width === 375) await page.screenshot({ path: 'test-results/header-mobile-closed-375.png' });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '開啟導覽選單' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('dialog', { name: '導覽選單' })).toHaveCount(0);
  await expect(page.evaluate(() => document.body.style.overflow)).resolves.toBe('');
});

test('super admin keeps role-based navigation and feature pages hide it after selection', async ({ page }) => {
  await openMeetingManagement(page, { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '開啟導覽選單' })).toBeHidden();
  await expect(page.locator('.app-header-actions').getByRole('link', { name: '帳號管理' })).toBeVisible();
  await expect(page.locator('.app-header-actions').getByRole('link', { name: '稽核紀錄' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const menuButton = page.getByRole('button', { name: '開啟導覽選單' });
  const featurePages = [
    { link: 'Gemini Key', hash: /#settings$/, title: 'Gemini API Key' },
    { link: '帳號管理', hash: /#admin$/, title: '帳號管理' },
    { link: '稽核紀錄', hash: /#audit$/, title: '稽核紀錄' }
  ];

  for (const featurePage of featurePages) {
    await menuButton.click();
    const menu = page.getByRole('dialog', { name: '導覽選單' });
    await expect(menu.getByRole('link', { name: 'Gemini Key' })).toBeVisible();
    await expect(menu.getByRole('link', { name: '帳號管理' })).toBeVisible();
    await expect(menu.getByRole('link', { name: '稽核紀錄' })).toBeVisible();
    await menu.getByRole('link', { name: featurePage.link }).click();
    await expect(page).toHaveURL(featurePage.hash);
    await expect(page.getByRole('dialog', { name: '導覽選單' })).toHaveCount(0);
    await expectFeaturePageHeader(page, featurePage.title, { mobile: true });

    await menuButton.click();
    const featureMenu = page.getByRole('dialog', { name: '導覽選單' });
    await expect(featureMenu.getByRole('link', { name: 'Gemini Key' })).toHaveCount(0);
    await expect(featureMenu.getByRole('link', { name: '帳號管理' })).toHaveCount(0);
    await expect(featureMenu.getByRole('link', { name: '稽核紀錄' })).toHaveCount(0);
    await featureMenu.getByRole('link', { name: '返回會議管理' }).click();
    await expect(page).toHaveURL(/#meetings$/);
    await expect(page.getByRole('dialog', { name: '導覽選單' })).toHaveCount(0);
  }
});

test('feature page header follows the current route across direct entry, reload, back, and forward', async ({ page }) => {
  await openMeetingManagement(page, { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' });
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.locator('.app-header-actions .header-key-action')).toHaveCount(3);
  await page.getByRole('link', { name: 'Gemini Key' }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expectFeaturePageHeader(page, 'Gemini API Key');

  await page.reload();
  await expectFeaturePageHeader(page, 'Gemini API Key');
  await page.getByRole('link', { name: '返回會議管理' }).click();
  await expect(page.locator('.app-header-actions .header-key-action')).toHaveCount(3);

  await page.getByRole('link', { name: '帳號管理' }).click();
  await expectFeaturePageHeader(page, '帳號管理');
  await page.goBack();
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.locator('.app-header-actions .header-key-action')).toHaveCount(3);
  await page.goForward();
  await expectFeaturePageHeader(page, '帳號管理');

  await page.goto('/#audit');
  await expectFeaturePageHeader(page, '稽核紀錄');
});
