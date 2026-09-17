import { expect, test } from '@playwright/test';

async function mockNoticeDependencies(page, credential) {
  await page.route('**/api/profile/gemini-credential', async (route) => route.fulfill({ json: { credential } }));
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
}

test('shows the Gemini Key notice on the meeting management page when unconfigured', async ({ page }) => {
  await mockNoticeDependencies(page, { configured: false });
  await page.goto('/#meetings');

  const notice = page.getByRole('status');
  await expect(notice).toContainText('尚未設定 Gemini API Key');
  await expect(notice.getByRole('link', { name: '設定 Gemini API Key' })).toHaveAttribute('href', '#settings');
});

test('hides the notice when configured and shows it in meeting settings when unconfigured', async ({ page }) => {
  await mockNoticeDependencies(page, { configured: true });
  await page.goto('/#meetings');
  await expect(page.getByText('尚未設定 Gemini API Key')).toHaveCount(0);

  await page.unroute('**/api/profile/gemini-credential');
  await page.route('**/api/profile/gemini-credential', async (route) => route.fulfill({ json: { credential: { configured: false } } }));
  await page.goto('/#meeting-settings?mode=create');
  await expect(page.locator('.gemini-credential-notice')).toContainText('尚未設定 Gemini API Key');
});

import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});
