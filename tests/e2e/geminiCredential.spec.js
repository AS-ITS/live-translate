import { expect, test } from '@playwright/test';

test('guides a user through Gemini API Key setup', async ({ page }) => {
  let savedKey;

  await page.route('**/api/profile/gemini-credential', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { credential: { configured: false } } });
    }

    if (route.request().method() === 'PUT') {
      savedKey = route.request().postDataJSON().apiKey;
      return route.fulfill({ json: { credential: { configured: true, lastFour: 'test' } } });
    }

    return route.fallback();
  });

  await page.goto('/#settings');

  await expect(page.getByRole('heading', { name: '先準備一組 Gemini API Key' })).toBeVisible();
  await expect(page.locator('.gemini-credential-steps li')).toHaveCount(4);
  await expect(page.getByText('建立或選取專案')).toBeVisible();
  await expect(page.getByText('安全提醒')).toBeVisible();

  const studioLink = page.getByRole('link', { name: /開啟 Google AI Studio/ });
  await expect(studioLink).toHaveAttribute('href', 'https://aistudio.google.com/app/apikey');
  await expect(studioLink).toHaveAttribute('target', '_blank');

  await page.getByLabel('貼上你的 Gemini API Key').fill('test-api-key');
  await page.getByRole('button', { name: '儲存 Key' }).click();

  await expect.poll(() => savedKey).toBe('test-api-key');
  await expect(page.getByText('已安全儲存。')).toBeVisible();
  await expect(page.getByText('末四碼 test')).toBeVisible();
  await expect(page.getByText('已設定', { exact: true })).toBeVisible();
});

test('stacks the credential setup layout on a narrow viewport', async ({ page }) => {
  await page.route('**/api/profile/gemini-credential', async (route) => {
    await route.fulfill({ json: { credential: { configured: false } } });
  });

  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/#settings');

  await expect.poll(() => page.locator('.gemini-credential-layout').evaluate((node) => {
    const columns = getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/u);
    return columns.length;
  })).toBe(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
