import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '33333333-3333-4333-8333-333333333333';
const meetingFor = (id) => ({ id, name: `Readiness ${id.slice(0, 8)}`, status: 'created', lifecycleContractVersion: 2, lifecycleVersion: 0, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mockMeetings(page, { detailDelay = 0, segmentsDelay = 0, firstSegmentsDelay = segmentsDelay } = {}) {
  const calls = [];
  await installE2EAuth(page);
  await page.route('**/api/meetings**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const startedAt = Date.now();
    if (path === '/api/meetings') {
      await route.fulfill({ json: [meetingFor(firstId), meetingFor(secondId)] });
    } else if ([firstId, secondId].some((id) => path === `/api/meetings/${id}`)) {
      const id = path.split('/').at(-1);
      await pause(detailDelay);
      await route.fulfill({ json: { meeting: meetingFor(id), segments: [], cues: [], transcriptItems: [] } });
    } else if ([firstId, secondId].some((id) => path === `/api/meetings/${id}/segments`)) {
      const id = path.split('/').at(-2);
      await pause(id === firstId ? firstSegmentsDelay : segmentsDelay);
      await route.fulfill({ json: { meetingId: id, segments: [] } });
    } else {
      await route.fallback();
      return;
    }
    calls.push({ path, startedAt, completedAt: Date.now() });
  });
  return calls;
}

for (const [name, delays] of [
  ['detail delayed, selected state late', { detailDelay: 300, segmentsDelay: 0 }],
  ['segments delayed after detail', { detailDelay: 0, segmentsDelay: 300 }]
]) {
  test(`new v2 meeting becomes recordable: ${name}`, async ({ page }) => {
    const calls = await mockMeetings(page, delays);
    await page.goto(`/#live?meetingId=${firstId}`);
    await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
    expect(calls.some(({ path }) => path === `/api/meetings/${firstId}/segments`)).toBe(true);
    expect(calls.some(({ path }) => path === `/api/meetings/${firstId}`)).toBe(true);
    await expect(page.getByRole('button', { name: '正在準備會議…' })).toHaveCount(0);
  });
}

test('late segments from old meeting cannot replace new meeting draft', async ({ page }) => {
  const calls = await mockMeetings(page, { firstSegmentsDelay: 550 });
  await page.goto(`/#live?meetingId=${firstId}`);
  await expect(page.getByRole('button', { name: '正在準備會議…' })).toBeVisible();
  await page.evaluate((id) => { window.location.hash = `#live?meetingId=${id}`; }, secondId);
  await expect(page.getByTestId('live-session-toolbar')).toContainText(meetingFor(secondId).name);
  await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
  await expect.poll(() => calls.some(({ path }) => path === `/api/meetings/${firstId}/segments`)).toBe(true);
  await pause(650);
  await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
});
