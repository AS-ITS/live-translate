import { expect, test } from '@playwright/test';

test('direct DLQ hash loads metadata, confirms replay, and retains the item', async ({ page }) => {
  const requests = [];
  const item = {
    executionId: 'execution-1',
    requestId: 'request-1',
    attempt: 3,
    failedAt: '2026-08-10T00:00:00.000Z',
    failure: { code: 'provider_unavailable', message: 'Provider unavailable' },
    lastFailure: { code: 'timeout' },
    providerKey: 'gemini',
    providerMetadata: { model: 'test-model' },
    executionMetadata: { source: 'worker' }
  };

  await page.route('**/api/translation-dead-letter-queue**', async (route) => {
    requests.push({ method: route.request().method(), url: route.request().url() });
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items: [item], size: 1 } });
      return;
    }
    await route.fulfill({
      status: 202,
      json: { sourceExecutionId: item.executionId, execution: { id: 'execution-2', status: 'queued', translationRequestId: item.requestId } }
    });
  });

  page.once('dialog', (dialog) => dialog.accept());
  await page.goto('/#dead-letter-queue');

  await expect(page.getByRole('heading', { name: 'Dead-letter queue' })).toBeVisible();
  await expect(page.getByText('execution-1', { exact: true })).toBeVisible();
  await expect(page.getByText('request-1', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dead-letter queue' })).toHaveCount(0);

  await page.getByText('Failure', { exact: true }).click();
  await expect(page.locator('.dead-letter-queue-metadata-disclosure[open] pre')).toContainText('provider_unavailable');
  await page.getByRole('button', { name: 'Replay' }).click();

  await expect(page.getByRole('status')).toContainText('execution-2');
  expect(requests.map(({ method }) => method)).toEqual(['GET', 'POST', 'GET']);
  await expect(page.getByText('execution-1', { exact: true })).toBeVisible();
});
