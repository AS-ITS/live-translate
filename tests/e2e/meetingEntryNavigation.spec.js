import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page);
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.enumerateDevices = async () => [];
    }
  });
});

test('opens unfinished meeting settings before entering live captions', async ({ page }) => {
  const meeting = {
    id: 'meeting-active',
    name: '進行中的產品會議',
    status: 'active',
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    shouldRecordInputAudio: false,
    glossaryEntries: [],
    privateGlossaryEntries: []
  };

  await page.addInitScript((meetingId) => {
    sessionStorage.setItem(`live-translate:meeting-audio:${meetingId}`, JSON.stringify({
      inputDeviceId: '',
      outputDeviceId: '',
      permissionStatus: 'confirmed',
      confirmedAt: '2026-10-02T00:00:00.000Z'
    }));
  }, meeting.id);
  await page.route('**/api/glossary', async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/meetings**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({ json: [meeting] });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === `/api/meetings/${meeting.id}`) {
      await route.fulfill({ json: { meeting, segments: [], cues: [] } });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname.endsWith('/shares')) {
      await route.fulfill({
        json: {
          shares: [{
            id: 'share-viewer',
            role: 'viewer',
            codeUrl: '#viewer?code=MEETINGACTIVE'
          }]
        }
      });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/shares')) {
      await route.fulfill({
        json: {
          share: {
            id: 'share-viewer',
            role: 'viewer',
            codeUrl: '#viewer?code=MEETINGACTIVE'
          }
        }
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname.endsWith('/members')) {
      await route.fulfill({ json: { members: [] } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/#meetings');
  const meetingCard = page.locator('.meeting-card').filter({ hasText: meeting.name });
  await expect(meetingCard.getByRole('button', { name: '確認設定並開啟字幕' })).toBeVisible();
  await meetingCard.click();

  await expect(page).toHaveURL(new RegExp(`#meeting-settings\\?mode=edit&meetingId=${meeting.id}$`));
  await expect(page.getByRole('heading', { name: '基本資訊' })).toBeVisible();

  await page.getByRole('button', { name: '前往即時字幕' }).click();
  await expect(page).toHaveURL(new RegExp(`#live\\?meetingId=${meeting.id}$`));
});
