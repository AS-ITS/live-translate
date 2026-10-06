import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test('meeting list deletes created drafts and completed Meetings without opening cards', async ({ page }) => {
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

    if (request.method() === 'DELETE' && ['meeting-draft', 'meeting-completed'].some((id) =>
      url.pathname === `/api/meetings/${id}`)) {
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
  const completedCard = page.locator('.meeting-card').filter({ hasText: '已完成會議' });
  await expect(completedCard.getByRole('button', { name: '刪除 已完成會議' })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  const deleteResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && url.pathname === '/api/meetings/meeting-draft';
  });
  await draftCard.getByRole('button', { name: '刪除 草稿會議' }).click();

  await expect((await deleteResponse).status()).toBe(204);
  await expect(draftCard).toHaveCount(0);
  await expect(page.locator('.success-message[role="status"]')).toHaveText('會議已刪除。');
  await expect(page).toHaveURL(/#meetings$/);

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('其他電腦');
    return dialog.accept();
  });
  const completedDelete = page.waitForResponse((response) =>
    response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/meetings/meeting-completed');
  await completedCard.getByRole('button', { name: '刪除 已完成會議' }).click();
  await expect((await completedDelete).status()).toBe(204);
  await expect(completedCard).toHaveCount(0);
});

test('bounded delete keeps completed Meeting visible until 204', async ({ page }) => {
  await installE2EAuth(page);
  let deletionAttempts = 0;
  await page.route('**/api/meetings**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'GET' && pathname === '/api/meetings') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 'meeting-completed', name: '待清理會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }
      ]) });
    } else if (route.request().method() === 'DELETE' && pathname === '/api/meetings/meeting-completed') {
      deletionAttempts += 1;
      await route.fulfill({ status: deletionAttempts === 1 ? 202 : 204,
        contentType: 'application/json', body: deletionAttempts === 1 ? '{"status":"deleting"}' : '' });
    } else await route.fallback();
  });
  await page.route('**/api/glossary**', (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#meeting');
  const card = page.locator('.meeting-card').filter({ hasText: '待清理會議' });
  const button = card.getByRole('button', { name: '刪除 待清理會議' });
  await expect(button).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await button.click();
  await expect(card).toBeVisible();
  await expect(page.locator('.success-message[role="status"]')).toContainText('清理中');
  page.once('dialog', (dialog) => dialog.accept());
  await button.click();
  await expect(card).toHaveCount(0);
  expect(deletionAttempts).toBe(2);
});
