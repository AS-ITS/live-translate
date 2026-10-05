import { test, expect } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test('global glossary exposes distinct batch actions and deletes selected entries sequentially', async ({ page }) => {
  const entries = [
    { id: 'entry-1', source: '產品名稱', sourceLanguageCode: 'zh-Hant', translations: { en: 'Product name' }, category: 'product', tags: [], enabled: true },
    { id: 'entry-2', source: '會議術語', sourceLanguageCode: 'zh-Hant', translations: { en: 'Meeting term' }, category: 'meeting', tags: [], enabled: true }
  ];
  const categories = [
    { id: 'product', label: '產品名稱' },
    { id: 'meeting', label: '會議常用語' },
    { id: 'other', label: '其他' }
  ];
  const deletedIds = [];
  let deleteInFlight = false;

  await installE2EAuth(page);
  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/glossary') {
      await route.fulfill({ json: { entries } });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/glossary/categories') {
      await route.fulfill({ json: { categories } });
      return;
    }
    if (request.method() === 'DELETE' && url.pathname.startsWith('/api/glossary/entries/')) {
      if (deleteInFlight) {
        await route.fulfill({ status: 409, json: { error: { message: 'Concurrent delete' } } });
        return;
      }
      deleteInFlight = true;
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const index = entries.findIndex((entry) => entry.id === id);
      const [entry] = entries.splice(index, 1);
      deletedIds.push(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      deleteInFlight = false;
      await route.fulfill({ json: { entry } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/#glossary');
  const glossary = page.locator('.global-glossary');
  await expect(glossary.locator('.glossary-card')).toHaveCount(2);
  await glossary.getByRole('button', { name: '全選目前結果' }).click();

  await expect(glossary.getByRole('button', { name: '批次啟用' })).toHaveClass(/primary.*glossary-bulk-enable/);
  await expect(glossary.getByRole('button', { name: '批次停用' })).toHaveClass(/secondary.*glossary-bulk-disable/);
  await expect(glossary.getByRole('button', { name: '批次刪除' })).toHaveClass(/danger-button.*glossary-bulk-delete/);

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toBe('確定要刪除已選取的 2 筆全域詞條嗎？此操作無法復原。');
    await dialog.accept();
  });
  await glossary.getByRole('button', { name: '批次刪除' }).click();

  await expect.poll(() => deletedIds).toEqual(['entry-1', 'entry-2']);
  await expect(glossary.locator('.glossary-card')).toHaveCount(0);
  await expect(glossary.getByRole('status')).toHaveText('已刪除 2 筆全域詞條。');
});
