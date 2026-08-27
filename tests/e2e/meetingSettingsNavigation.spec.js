import { expect, test } from '@playwright/test';

test('meeting settings steps navigate to each settings card', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: [] }));
  await page.goto('/#meeting-settings?mode=create');

  const languageSelects = page.locator('.meeting-language-fields select');
  await expect(languageSelects).toHaveCount(2);
  await expect(languageSelects.nth(0)).toHaveCSS('height', '64px');
  await expect(languageSelects.nth(1)).toHaveCSS('height', '64px');
  await expect(page.locator('.meeting-language-direction')).toHaveCSS('height', '64px');

  await page.setViewportSize({ width: 600, height: 800 });
  await expect(languageSelects.nth(0)).toHaveCSS('height', '64px');
  await expect(languageSelects.nth(1)).toHaveCSS('height', '64px');
  await expect(page.locator('.meeting-language-direction')).toHaveCSS('height', '64px');

  const stepButtons = page.locator('.meeting-settings-step');
  await expect(stepButtons).toHaveCount(4);
  await expect(stepButtons.nth(0)).toHaveAttribute('aria-current', 'step');

  await stepButtons.nth(2).click();
  await expect(page.locator('#meeting-audio-settings-title')).toBeInViewport();
  await expect(stepButtons.nth(2)).toHaveAttribute('aria-current', 'step');
  await expect(stepButtons.nth(0)).not.toHaveAttribute('aria-current', 'step');

  await stepButtons.nth(3).click();
  await expect(page.locator('#meeting-dictionary-settings-title')).toBeInViewport();
  await expect(stepButtons.nth(3)).toHaveAttribute('aria-current', 'step');
});

test('short desktop viewport can scroll the settings steps to the dictionary step', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: [] }));
  await page.setViewportSize({ width: 1024, height: 400 });
  await page.goto('/#meeting-settings?mode=create');

  const steps = page.locator('.meeting-settings-steps');
  const stepButtons = steps.locator('.meeting-settings-step');
  await expect(stepButtons).toHaveCount(4);
  await expect(steps).toHaveCSS('overflow-y', 'auto');

  await stepButtons.nth(3).click();
  await expect(page.locator('#meeting-dictionary-settings-title')).toBeInViewport();
  await expect(stepButtons.nth(3)).toHaveAttribute('aria-current', 'step');
});

test('active step stays on the first step at the top and follows the 40% focus line', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: [] }));
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/#meeting-settings?mode=create');

  const stepButtons = page.locator('.meeting-settings-step');
  const cards = page.locator('.meeting-settings-card');

  await expect(stepButtons.nth(0)).toHaveAttribute('aria-current', 'step');
  await page.evaluate(() => window.scrollTo(0, 40));
  await expect(stepButtons.nth(0)).toHaveAttribute('aria-current', 'step');

  for (const index of [1, 2]) {
    await cards.nth(index).evaluate((section) => {
      const rect = section.getBoundingClientRect();
      const targetScrollTop = section.ownerDocument.defaultView.scrollY + rect.top + rect.height / 2 - window.innerHeight * 0.4;
      window.scrollTo(0, targetScrollTop);
    });
    await expect(stepButtons.nth(index)).toHaveAttribute('aria-current', 'step');
  }
});
