import { expect, test } from '@playwright/test';

test('meeting settings steps navigate to each settings card', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
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
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
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
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
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

test('shows the share meeting step after creating a meeting', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      json: {
        meeting: {
          id: 'meeting-1',
          name: '產品會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en',
          echoTargetLanguage: true,
          shouldRecordInputAudio: false,
          glossaryEntries: [],
          privateGlossaryEntries: []
        }
      }
    });
  });
  await page.route('**/api/meetings/meeting-1/shares', async (route) => {
    const { role } = route.request().postDataJSON();
    await route.fulfill({
      json: {
        url: `#${role}?token=${role}-token`,
        share: { id: `share-${role}`, role, shortCode: `${role}-code` }
      }
    });
  });

  await page.goto('/#meeting-settings?mode=create');

  await expect(page.locator('.meeting-settings-step')).toHaveCount(4);
  await expect(page.locator('.meeting-share-results')).toHaveCount(0);

  await page.getByRole('button', { name: '建立會議' }).click();

  await expect(page.locator('.meeting-settings-step')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '分享會議' })).toBeVisible();
  await expect(page.locator('.meeting-share-results')).toBeVisible();
  await expect(page.locator('.share-result')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '建立觀看連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);

  await page.getByRole('button', { name: '分享會議' }).click();
  await expect(page.locator('.meeting-share-results')).toBeInViewport();
  await expect(page.getByRole('button', { name: '分享會議' })).toHaveAttribute('aria-current', 'step');
});

test('automatically creates shares when an existing meeting has no links', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route(/\/api\/meetings\/meeting-2\/shares$/, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { shares: [] } });
    const { role } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        url: `#${role}?token=${role}-token`,
        share: { id: `share-${role}`, role, shortCode: `${role}-code` }
      }
    });
  });
  await page.route(/\/api\/meetings\/meeting-2$/, async (route) => route.fulfill({
    json: {
      meeting: {
        id: 'meeting-2',
        name: '既有會議',
        status: 'created',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en',
        echoTargetLanguage: true,
        shouldRecordInputAudio: false,
        glossaryEntries: [],
        privateGlossaryEntries: []
      }
    }
  }));

  await page.goto('/#meeting-settings?mode=edit&meetingId=meeting-2');

  await expect(page.locator('.meeting-share-results')).toBeVisible();
  await expect(page.locator('.share-result')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '建立觀看連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);
});

test('restores Meeting share QR codes and links after reloading the edit page', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route(/\/api\/meetings\/meeting-3$/, async (route) => route.fulfill({ json: { meeting: {
    id: 'meeting-3', name: '可分享會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    echoTargetLanguage: true, shouldRecordInputAudio: false, glossaryEntries: [], privateGlossaryEntries: []
  } } }));
  await page.route(/\/api\/meetings\/meeting-3\/shares$/, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { shares: [
      { id: 'share-viewer', role: 'viewer', codeUrl: '#viewer?code=VIEWER2' },
      { id: 'share-recorder', role: 'recorder', codeUrl: '#record?code=RECORDER2' }
    ] } });
    return route.fallback();
  });

  await page.goto('/#meeting-settings?mode=edit&meetingId=meeting-3');
  await expect(page.locator('.share-result')).toHaveCount(2);
  await expect(page.locator('.share-url a').nth(0)).toContainText('#viewer?code=VIEWER2');
  await expect(page.locator('.share-url a').nth(1)).toContainText('#record?code=RECORDER2');
  await expect(page.locator('.share-result img')).toHaveCount(2);

  await page.reload();
  await expect(page.locator('.share-result')).toHaveCount(2);
  await expect(page.locator('.share-result img')).toHaveCount(2);
});
