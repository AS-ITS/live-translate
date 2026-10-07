import { test, expect } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test('global glossary card action is centered and opens the editor', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await installE2EAuth(page);

  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/glossary/categories') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories: [{ id: 'product', label: '產品名稱' }, { id: 'other', label: '其他' }] }) });
      return;
    }
    if (url.pathname === '/api/glossary' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'entry-1', source: '哈哈哈哈', sourceLanguageCode: 'zh-Hant', translations: { en: '433544' }, category: 'product', tags: [], enabled: true }] }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/#glossary');
  const button = page.getByRole('button', { name: '更多操作：哈哈哈哈' });
  await expect(button).toBeVisible();
  const metrics = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    const buttonRect = element.getBoundingClientRect();
    const iconRect = element.querySelector('svg').getBoundingClientRect();
    return {
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      borderWidth: style.borderTopWidth,
      centerDeltaY: Math.abs((buttonRect.y + buttonRect.height / 2) - (iconRect.y + iconRect.height / 2))
    };
  });

  expect(metrics).toMatchObject({ alignItems: 'center', justifyContent: 'center', borderWidth: '0px' });
  expect(metrics.centerDeltaY).toBeLessThan(1);
  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
