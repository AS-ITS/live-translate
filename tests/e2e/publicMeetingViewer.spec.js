import { expect, test } from '@playwright/test';

test('Meeting Viewer opens without a Workspace login', async ({ page }) => {
  await page.route(/\/api\/shared-meetings\/code\/VIEWER2(?:\?.*)?$/, async (route) => route.fulfill({
    json: {
      capability: { role: 'viewer', meetingId: 'meeting-1' },
      meeting: {
        id: 'meeting-1',
        name: '公開觀看會議',
        status: 'active',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en'
      },
      cues: [{
        cueId: 'cue-1',
        sequence: 1,
        startTimeMs: 0,
        sourceText: '公開原文',
        translatedText: 'Public translation',
        status: 'final'
      }],
      cursor: { eventId: 0, cueSequence: 1 }
    }
  }));
  await page.route(/\/api\/shared-meetings\/code\/VIEWER2\/events(?:\?.*)?$/, async (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: ''
  }));

  await page.goto('/#viewer?code=VIEWER2');

  await expect(page.getByRole('heading', { name: '公開觀看會議' })).toBeVisible();
  await expect(page.getByText('Public translation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用 Google 登入' })).toHaveCount(0);
});
