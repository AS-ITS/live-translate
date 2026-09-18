import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test('meeting list deletes created drafts without opening the card', async ({ page }) => {
  await installE2EAuth(page);

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'meeting-draft', name: '草稿會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
          { id: 'meeting-active', name: '進行中會議', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
          { id: 'meeting-completed', name: '已完成會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }
        ])
      });
      return;
    }

    if (request.method() === 'DELETE' && url.pathname === '/api/meetings/meeting-draft') {
      await route.fulfill({ status: 204 });
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/glossary**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [] })
    });
  });

  await page.goto('/#meeting');

  const draftCard = page.locator('.meeting-card').filter({ hasText: '草稿會議' });
  await expect(draftCard).toBeVisible();
  await expect(draftCard.getByRole('button', { name: '刪除 草稿會議' })).toBeVisible();
  await expect(page.locator('.meeting-card').filter({ hasText: '進行中會議' }).getByRole('button', { name: /刪除/ })).toHaveCount(0);
  await expect(page.locator('.meeting-card').filter({ hasText: '已完成會議' }).getByRole('button', { name: /刪除/ })).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  const deleteResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && url.pathname === '/api/meetings/meeting-draft';
  });
  await draftCard.getByRole('button', { name: '刪除 草稿會議' }).click();

  await expect((await deleteResponse).status()).toBe(204);
  await expect(draftCard).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('會議已刪除。');
  await expect(page).toHaveURL(/#meetings$/);
});
