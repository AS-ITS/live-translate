import { expect, test } from '@playwright/test'; test('continues loading meeting settings when glossary is unavailable', async ({ page }) => { await page.route('**/api/glossary', async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'supabase_unavailable' } }) })); await page.goto('/#meeting-settings?mode=create'); await expect(page.getByRole('heading', { name: '基本資訊' })).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('.warning-message')).toHaveText('共用詞彙目前無法載入，仍可使用私人詞彙。'); });

test('requires a meeting name before saving', async ({ page }) => {
  let createRequestCount = 0;
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() === 'POST') createRequestCount += 1;
    await route.fallback();
  });
  await page.goto('/#meeting-settings?mode=create');

  const nameInput = page.getByRole('textbox', { name: /會議名稱/ });
  await page.getByRole('button', { name: '建立會議' }).click();

  await expect(nameInput).toBeFocused();
  await expect(page.locator('#meeting-name-error')).toContainText('請輸入會議名稱。');
  await expect(nameInput).toHaveAttribute('aria-invalid', 'true');
  await expect(createRequestCount).toBe(0);

  await nameInput.fill('產品會議');
  await expect(nameInput).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('#meeting-name-error')).toHaveCount(0);
});

test('requires microphone confirmation before saving', async ({ page }) => {
  let createRequestCount = 0;
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() === 'POST') createRequestCount += 1;
    await route.fallback();
  });
  await page.goto('/#meeting-settings?mode=create');

  await page.getByRole('textbox', { name: /會議名稱/ }).fill('產品會議');
  const confirmButton = page.getByRole('button', { name: '測試並確認音訊' });
  await page.getByRole('button', { name: '建立會議' }).click();

  await expect(confirmButton).toBeFocused();
  await expect(page.locator('#meeting-audio-settings-title')).toBeInViewport();
  await expect(page.locator('#meeting-audio-settings-error')).toContainText('請先測試並確認麥克風權限。');
  await expect(confirmButton).toHaveAttribute('aria-invalid', 'true');
  const controlRowLayout = await page.evaluate(() => {
    const button = document.querySelector('.meeting-audio-controls > .button');
    const status = document.querySelector('.meeting-audio-status');
    const buttonRect = button.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    return statusRect.top < buttonRect.bottom && statusRect.bottom > buttonRect.top;
  });
  expect(controlRowLayout).toBe(true);
  await expect(createRequestCount).toBe(0);
});

test('meeting settings steps navigate to each settings card', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#meeting-settings?mode=create');

  const languageSelects = page.locator('.meeting-language-fields select');
  await expect(languageSelects).toHaveCount(2);
  await expect(languageSelects.nth(0)).toHaveCSS('height', '56px');
  await expect(languageSelects.nth(1)).toHaveCSS('height', '56px');
  await expect(page.locator('.meeting-language-direction')).toHaveCSS('height', '56px');

  await page.setViewportSize({ width: 600, height: 800 });
  await expect(languageSelects.nth(0)).toHaveCSS('height', '56px');
  await expect(languageSelects.nth(1)).toHaveCSS('height', '56px');
  await expect(page.locator('.meeting-language-direction')).toHaveCSS('height', '56px');

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

test('keeps the microphone-only audio controls in a compact 20px control row', async ({ page }) => {
  await page.addInitScript(() => {
    if (globalThis.AudioContext?.prototype) {
      Object.defineProperty(globalThis.AudioContext.prototype, 'setSinkId', { configurable: true, value: undefined });
    }
  });
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#meeting-settings?mode=create');

  const deviceGrid = page.locator('.meeting-audio-device-grid');
  const confirmButton = page.getByRole('button', { name: '測試並確認音訊' });
  const status = page.locator('.meeting-audio-status');
  await expect(deviceGrid).toHaveClass(/microphone-only/);
  await expect(page.getByLabel('選擇會議揚聲器')).toHaveCount(0);
  await expect(status).toHaveClass(/is-pending/);
  await expect(status.locator('.meeting-audio-status-icon')).toHaveCount(1);

  const desktopGaps = await page.evaluate(() => {
    const grid = document.querySelector('.meeting-audio-device-grid');
    const select = document.querySelector('.meeting-audio-device-grid select');
    const button = document.querySelector('.meeting-audio-controls > .button');
    const statusNode = document.querySelector('.meeting-audio-status');
    const selectRect = select.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const statusRect = statusNode.getBoundingClientRect();
    return {
      gridToButton: buttonRect.left - grid.getBoundingClientRect().right,
      buttonToStatus: statusRect.left - buttonRect.right,
      buttonCenterOffset: Math.abs((buttonRect.top + buttonRect.bottom) / 2 - (selectRect.top + selectRect.bottom) / 2),
      statusCenterOffset: Math.abs((statusRect.top + statusRect.bottom) / 2 - (selectRect.top + selectRect.bottom) / 2)
    };
  });
  expect(desktopGaps.gridToButton).toBe(20);
  expect(desktopGaps.buttonToStatus).toBe(20);
  expect(desktopGaps.buttonCenterOffset).toBeLessThanOrEqual(1);
  expect(desktopGaps.statusCenterOffset).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator('body')).toHaveCSS('overflow-x', 'visible');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const controls = document.querySelector('.meeting-audio-controls').getBoundingClientRect();
    const button = document.querySelector('.meeting-audio-controls > .button').getBoundingClientRect();
    return Math.abs(button.width - controls.width) <= 1;
  })).toBe(true);
  await expect(status).toBeVisible();
});

test('keeps both audio device selectors in a two-column layout when output selection is supported', async ({ page }) => {
  await page.addInitScript(() => {
    if (globalThis.AudioContext?.prototype) {
      Object.defineProperty(globalThis.AudioContext.prototype, 'setSinkId', { configurable: true, value: async () => {} });
    }
  });
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#meeting-settings?mode=create');

  const deviceGrid = page.locator('.meeting-audio-device-grid');
  await expect(deviceGrid).toHaveClass(/has-speaker/);
  await expect(page.getByLabel('選擇會議麥克風')).toBeVisible();
  await expect(page.getByLabel('選擇會議揚聲器')).toBeVisible();
  await expect.poll(() => deviceGrid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(2);
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

test('meeting settings imports private glossary rows and saves them with the meeting', async ({ page }) => {
  let savedBody;
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings/glossary/import/preview', async (route) => route.fulfill({ json: {
    summary: { total: 2, creates: 1, updates: 0, duplicates: 1, invalid: 0 },
    rows: [
      { rowNumber: 2, status: 'create', entry: { source: '產品名稱', translations: { en: 'Product name' } }, errors: [], warnings: [] },
      { rowNumber: 3, status: 'duplicate', entry: { source: '產品名稱', translations: { en: 'Duplicate' } }, errors: [], warnings: ['Import contains a duplicate source term.'] }
    ]
  } }));
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    savedBody = route.request().postDataJSON();
    return route.fulfill({ json: { meeting: { id: 'meeting-import', name: '產品會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', echoTargetLanguage: true, shouldRecordInputAudio: false, glossaryEntries: [], privateGlossaryEntries: savedBody.privateGlossaryEntries } } });
  });
  await page.route(/\/api\/meetings\/meeting-import\/shares(?:\?.*)?$/, async (route) => route.fulfill({ json: { url: '#viewer?code=viewer-code', share: { id: 'share-1', role: 'viewer', shortCode: 'viewer-code' } } }));

  await page.goto('/#meeting-settings?mode=create');
  await page.getByRole('textbox', { name: /會議名稱/ }).fill('產品會議');
  await page.getByRole('button', { name: '測試並確認音訊' }).click();
  await expect(page.locator('.meeting-audio-status')).toHaveClass(/is-confirmed/);
  await page.getByRole('button', { name: '匯入詞彙' }).click();
  const importHelp = page.getByRole('dialog', { name: '匯入會議詞彙' });
  await expect(importHelp).toContainText('XLSX 格式');
  await expect(importHelp).toContainText('JSON 範例');
  await expect(importHelp).toContainText('翻譯結果,Translation result');
  await page.locator('#meeting-glossary-import-file').setInputFiles({ name: 'terms.csv', mimeType: 'text/csv', buffer: Buffer.from('source,translation\n產品名稱,Product name\n產品名稱,Duplicate') });
  await expect(page.getByRole('dialog', { name: '預覽匯入：terms.csv' })).toBeVisible();
  await page.getByRole('button', { name: '加入會議詞彙' }).click();
  await expect(page.locator('.meeting-private-entry')).toContainText('產品名稱');
  await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/meetings'),
    page.getByRole('button', { name: '建立會議' }).click(),
  ]);
  await expect.poll(() => savedBody?.privateGlossaryEntries).toEqual([{ source: '產品名稱', translations: { en: 'Product name' }, replacementAliases: {} }]);
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
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
    }
  });
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.addInitScript(() => {
    const originalDecode = HTMLImageElement.prototype.decode;
    if (!originalDecode) return;
    HTMLImageElement.prototype.decode = function delayedDecode() {
      return new Promise((resolve) => {
        window.setTimeout(() => originalDecode.call(this).then(resolve).catch(resolve), 120);
      });
    };
  });
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
  await page.route(/\/api\/meetings\/meeting-1\/shares(?:\?.*)?$/, async (route) => {
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

  await page.getByRole('textbox', { name: /會議名稱/ }).fill('產品會議');
  await page.getByRole('button', { name: '測試並確認音訊' }).click();
  await expect(page.locator('.meeting-audio-status')).toHaveClass(/is-confirmed/);
  const [meetingResponse, shareResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/meetings$/.test(new URL(response.url()).pathname)),
    page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/meetings\/meeting-1\/shares(?:\?.*)?$/.test(new URL(response.url()).pathname + new URL(response.url()).search)),
    page.getByRole('button', { name: '建立會議' }).click(),
  ]);
  await expect(meetingResponse.status()).toBe(200);
  await expect(shareResponse.status()).toBe(200);

  await expect(page.locator('.meeting-settings-step')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '分享會議' })).toBeVisible();
  await expect(page.locator('.meeting-share-results')).toBeVisible();
  await expect(page.locator('.share-result')).toHaveCount(1);
  const settingsCardOrder = await page.locator('.meeting-settings-form > .meeting-settings-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-labelledby')));
  expect(settingsCardOrder).toEqual([
    'meeting-basic-settings-title',
    'meeting-language-settings-title',
    'meeting-audio-settings-title',
    'meeting-dictionary-settings-title',
    'meeting-share-results-title',
    'meeting-members-title',
    'meeting-recording-permissions-title'
  ]);
  await expect(page.locator('.meeting-share-results .eyebrow')).toHaveText('STEP 5');
  await expect(page.locator('.meeting-share-results .meeting-settings-card-number')).toHaveText('5');
  const memberCard = page.locator('.meeting-settings-card').filter({ has: page.locator('#meeting-members-title') });
  await expect(memberCard.locator('.eyebrow')).toHaveText('STEP 6 · ACCESS');
  await expect(memberCard.locator('.meeting-settings-card-number')).toHaveText('6');
  const desktopShareLayout = await page.locator('.share-result').evaluate((card) => {
    const preview = card.querySelector('.share-result-preview').getBoundingClientRect();
    const details = card.querySelector('.share-result-details').getBoundingClientRect();
    const links = card.parentElement.getBoundingClientRect();
    return {
      cardWidth: card.getBoundingClientRect().width,
      linksWidth: links.width,
      previewRight: preview.right,
      detailsLeft: details.left,
      columns: getComputedStyle(card).gridTemplateColumns.split(' ').length
    };
  });
  expect(desktopShareLayout.cardWidth).toBeGreaterThanOrEqual(desktopShareLayout.linksWidth - 1);
  expect(desktopShareLayout.previewRight).toBeLessThanOrEqual(desktopShareLayout.detailsLeft);
  expect(desktopShareLayout.columns).toBe(2);
  await expect(page.locator('.share-result-details .share-url')).toBeVisible();
  await expect(page.locator('.share-result-details .detail-button')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const submitButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('儲存變更'));
    const section = document.querySelector('.meeting-share-results');
    if (!submitButton || !section) return false;
    const buttonRect = submitButton.getBoundingClientRect();
    const rect = section.getBoundingClientRect();
    return buttonRect.top >= 0 && buttonRect.bottom <= window.innerHeight && rect.bottom > 0 && rect.top < window.innerHeight;
  })).toBe(true);
  await expect(page.getByRole('button', { name: '儲存變更' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '分享會議' })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('button', { name: '建立觀看連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);

  await page.getByRole('button', { name: '分享會議' }).click();
  await expect(page.locator('.meeting-share-results')).toBeInViewport();
  await page.getByRole('button', { name: '成員與錄製權限' }).click();
  await expect(page.locator('#meeting-members-title')).toBeInViewport();
  await page.setViewportSize({ width: 600, height: 800 });
  await expect.poll(() => page.locator('.share-result').evaluate((card) => getComputedStyle(card).gridTemplateColumns.split(' ').length)).toBe(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('automatically creates shares when an existing meeting has no links', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route(/\/api\/meetings\/meeting-2\/shares(?:\?.*)?$/, async (route) => {
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
  await expect(page.locator('.share-result')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '建立觀看連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);
});

test('shows a deployment-specific message when the share route returns 404', async ({ page }) => {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
    }
  });
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: {
      meeting: {
        id: 'meeting-share-404',
        name: '分享失敗會議',
        status: 'created',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en',
        echoTargetLanguage: true,
        shouldRecordInputAudio: false,
        glossaryEntries: [],
        privateGlossaryEntries: []
      }
    } });
  });
  await page.route(/\/api\/meetings\/meeting-share-404\/shares(?:\?.*)?$/, async (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

  await page.goto('/#meeting-settings?mode=create');
  await page.getByRole('textbox', { name: /會議名稱/ }).fill('分享失敗會議');
  await page.getByRole('button', { name: '測試並確認音訊' }).click();
  await page.getByRole('button', { name: '建立會議' }).click();

  await expect(page.getByText('分享連結服務找不到，請確認部署的 API 版本。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新產生分享' })).toBeVisible();
});

test('restores Meeting share QR codes and links after reloading the edit page', async ({ page }) => {
  const meetingId = '11111111-1111-4111-8111-111111111111';
  const detailRequestUrls = [];
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route(new RegExp(`/api/meetings/${meetingId.replaceAll('-', '\\-')}$`), async (route) => {
    detailRequestUrls.push(route.request().url());
    return route.fulfill({ json: { meeting: {
    id: meetingId, name: '可分享會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    echoTargetLanguage: true, shouldRecordInputAudio: false, glossaryEntries: [], privateGlossaryEntries: []
  } } });
  });
  await page.route(new RegExp(`/api/meetings/${meetingId.replaceAll('-', '\\-')}/shares(?:\\?.*)?$`), async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { shares: [
      { id: 'share-viewer', role: 'viewer', codeUrl: '#viewer?code=VIEWER2' }
    ] } });
    return route.fallback();
  });

  await page.goto(`/#meeting-settings?mode=edit&meetingId=${meetingId}`);
  await expect(page.locator('.share-result')).toHaveCount(1);
  await expect(page.locator('.share-url a').nth(0)).toContainText('#viewer?code=VIEWER2');
  await expect(page.locator('.share-result img')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('.share-result')).toHaveCount(1);
  await expect(page.locator('.share-result img')).toHaveCount(1);
  expect(detailRequestUrls).toHaveLength(2);
  expect(detailRequestUrls.every((url) => new URL(url).pathname === `/api/meetings/${meetingId}`)).toBe(true);
});

test('shows the meeting_not_found request ID when an edit meeting is missing', async ({ page }) => {
  const meetingId = 'f5e14262-c4f5-4b26-ac77-236c36de2355';
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route(new RegExp(`/api/meetings/${meetingId.replaceAll('-', '\\-')}$`), async (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'meeting_not_found' }, requestId: 'meeting-settings-404' })
  }));

  const missingResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/meetings/${meetingId}`);
  await page.goto(`/#meeting-settings?mode=edit&meetingId=${meetingId}`);
  const missingResponse = await missingResponsePromise;
  expect(missingResponse.status()).toBe(404);
  expect((await missingResponse.json()).error.code).toBe('meeting_not_found');

  await expect(page.getByRole('alert')).toContainText('找不到這場會議');
  await expect(page.getByRole('alert')).toContainText('meeting-settings-404');
});
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
  });
});
