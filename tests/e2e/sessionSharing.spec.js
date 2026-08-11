import { expect, test } from '@playwright/test';

test('shared Viewer renders one Session snapshot without owner controls', async ({ page }) => {
  const detail = {
    session: {
      id: 'session-a',
      name: 'Session A',
      status: 'active',
      targetLanguageCode: 'en'
    },
    sourceTranscript: {
      items: [{ id: 'source-a-1', text: 'Only Session A source', status: 'final' }]
    },
    selectedTranslationOutput: {
      items: [{ id: 'translation-a-1', text: 'Only Session A translation', status: 'final' }]
    }
  };

  await page.route('**/api/shared-sessions/token-a', async (route) => route.fulfill({ json: detail }));
  await page.route('**/api/shared-sessions/token-a/events', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `id: 1\nevent: session.snapshot\ndata: ${JSON.stringify(detail)}\n\n`
    });
  });

  await page.goto('/#watch?token=token-a');

  await expect(page.getByRole('heading', { name: '即時翻譯觀看' })).toBeVisible();
  await expect(page.getByText('Only Session A source')).toBeVisible();
  await expect(page.getByText('Only Session A translation')).toBeVisible();
  await expect(page.getByText('Only Session B source')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('唯讀分享內容')).toBeVisible();
});

test('shared Viewer shows an error for an invalid or expired link', async ({ page }) => {
  await page.route('**/api/shared-sessions/expired-token', async (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'session_not_found' } })
  }));
  await page.route('**/api/shared-sessions/expired-token/events', async (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'session_not_found' } })
  }));

  await page.goto('/#watch?token=expired-token');

  await expect(page.getByRole('alert')).toContainText(/分享連結無效或已過期|分享連線中斷/);
});
