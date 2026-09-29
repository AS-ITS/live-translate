import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
});

test('sets and revokes the lifecycle-memory Gemini API Key', async ({ page }) => {
  await page.goto('/#settings');

  const input = page.getByRole('textbox', { name: 'Gemini API Key' });
  await expect(input).toBeVisible();
  await input.fill('  test-ABcd  ');
  await page.getByRole('button', { name: '設定金鑰' }).click();

  await expect(page.getByText('...ABcd', { exact: true })).toBeVisible();
  await expect(page.getByText('已設定', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-ABcd');

  await page.getByRole('button', { name: '撤消金鑰' }).click();
  await expect(page.getByText('...ABcd', { exact: true })).toHaveCount(0);
  await expect(page.getByText('已設定', { exact: true })).toHaveCount(0);
});

test('offers inline memory-only Key entry in recording workflow', async ({ page }) => {
  const secret = 'test-inline-ABcd';
  const requests = [];
  page.on('request', (request) => requests.push({ url: request.url(), body: request.postData() || '' }));
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#meetings');

  const input = page.getByRole('textbox', { name: 'Gemini API Key' }).first();
  await expect(input).toBeVisible();
  await input.fill(`  ${secret}  `);
  await page.getByRole('button', { name: '設定金鑰' }).first().click();
  await expect(input).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(secret);
  const persistence = await page.evaluate(async () => ({
    local: Object.keys(localStorage).filter((key) => /gemini|credential|api.?key/u.test(key)),
    session: Object.keys(sessionStorage).filter((key) => /gemini|credential|api.?key/u.test(key)),
    url: window.location.href,
    indexedDb: typeof indexedDB?.databases === 'function'
      ? (await indexedDB.databases()).filter(({ name }) => /gemini|credential|api.?key/u.test(name || ''))
      : [],
    cacheKeys: typeof caches === 'undefined'
      ? []
      : (await caches.keys()).filter((key) => /gemini|credential|api.?key/u.test(key))
  }));
  expect(persistence.local).toEqual([]);
  expect(persistence.session).toEqual([]);
  expect(persistence.indexedDb).toEqual([]);
  expect(persistence.cacheKeys).toEqual([]);
  expect(persistence.url).not.toMatch(/test-inline/u);
  expect(requests.some(({ url, body }) => /live-token/u.test(url) && body.includes(secret))).toBe(false);
});

test('Viewer has no Key prompt and makes no live-token request', async ({ page }) => {
  const liveTokenRequests = [];
  page.on('request', (request) => {
    if (/\/api\/live-token/u.test(request.url())) liveTokenRequests.push(request.url());
  });
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token(?:\?.*)?$/, async (route) => route.fulfill({ json: {
    capability: { role: 'viewer', meetingId: 'meeting-1' },
    meeting: { id: 'meeting-1', name: '產品會議', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    cues: [{ cueId: 'cue-1', sequence: 1, sourceText: '原文', translatedText: 'Translation', status: 'final' }],
    cursor: { eventId: 0, cueSequence: 1 }
  } }));
  await page.route(/\/api\/shared-meetings\/meeting-viewer-token\/events(?:\?.*)?$/, async (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
  await page.goto('/#viewer?token=meeting-viewer-token');
  await expect(page.getByRole('heading', { name: '產品會議' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Gemini API Key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '設定金鑰' })).toHaveCount(0);
  expect(liveTokenRequests).toEqual([]);
});

test('logout clears the lifecycle-memory Gemini API Key', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/#settings');
  await page.getByRole('textbox', { name: 'Gemini API Key' }).fill('test-logout-ABcd');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await expect(page.getByText('...ABcd', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '返回會議管理' }).click();
  await page.locator('.account-menu-trigger').click();
  await page.getByRole('menuitem', { name: '登出' }).click();
  await expect(page.getByRole('heading', { name: '歡迎回來' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-logout-ABcd');
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => /gemini|credential/u.test(key)))).toBe(false);
});
