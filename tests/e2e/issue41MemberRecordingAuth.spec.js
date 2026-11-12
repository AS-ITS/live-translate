import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { serializeEffectiveGlossary } from '../../src/lib/glossaryRevision.js';
import { installE2EAuth, localE2EAuthSession } from './authBootstrap.js';

test('local Supabase member can pause continue end and reload own recording', async ({ page }) => {
  test.setTimeout(120_000);
  const auth = localE2EAuthSession();
  expect(auth).toBeTruthy();
  await installE2EAuth(page);
  const headers = { Authorization: `Bearer ${auth.token}` };
  const profile = await page.request.get('/api/profile', { headers });
  expect(profile.status()).toBe(200);
  expect((await profile.json()).profile.role).toBe('member');

  const created = await page.request.post('/api/meetings', { headers,
    data: { name: 'Member local recording auth', draft: true,
      sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' } });
  expect(created.status()).toBe(201);
  const meetingId = (await created.json()).meeting.id;
  expect((await page.request.get(`/api/meetings/${meetingId}`, { headers })).status()).toBe(200);

  await page.route('**/api/live-token', async (route) => {
    const body = route.request().postDataJSON();
    const revision = createHash('sha256').update(serializeEffectiveGlossary({
      sourceLanguageCode: body.sourceLanguageCode,
      targetLanguageCode: body.targetLanguageCode,
      entries: []
    })).digest('hex');
    const lifecycleVersion = Number(route.request().headers()['x-meeting-lifecycle-version']);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      token: 'issue41-fake-provider-token',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      liveConnectModel: 'gemini-live-e2e-model',
      liveGlossaryEntries: [], effectiveGlossaryRevision: revision, glossaryEntryCount: 0,
      ...(Number.isSafeInteger(lifecycleVersion) ? { authoritativeSegment: {
        meetingId: body.meetingId, sessionId: body.sessionId,
        segmentId: body.segmentId, lifecycleVersion
      } } : {})
    }) });
  });

  await page.goto('/#meetings');
  await page.evaluate((id) => sessionStorage.setItem(`live-translate:meeting-audio:${id}`,
    JSON.stringify({ inputDeviceId: '', outputDeviceId: '', inputDeviceLabel: '瀏覽器預設麥克風',
      outputDeviceLabel: '瀏覽器預設揚聲器', permissionStatus: 'confirmed',
      confirmedAt: new Date().toISOString() })), meetingId);
  await page.goto('/#settings');
  await page.getByRole('textbox', { name: 'Gemini API Key' }).fill('issue41-test-key');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await page.goto(`/#live?meetingId=${meetingId}`);
  await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
  await page.getByRole('button', { name: '開始錄製' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  const localRecording = () => page.evaluate(async (id) => {
    const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
    const persistence = createLocalMeetingPersistence();
    const restored = await persistence.restore(id);
    const manifest = await persistence.getLocalRecording(id);
    return { ...restored.recording, ownerUserId: manifest?.ownerUserId };
  }, meetingId);
  expect((await localRecording()).ownerUserId).toBe(auth.profile.id);
  await page.getByRole('button', { name: '停止錄音' }).click();
  await expect(page.getByRole('button', { name: '繼續' })).toBeVisible();
  expect((await localRecording()).state).toBe('paused');
  await page.getByRole('button', { name: '繼續' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  expect((await localRecording()).state).toBe('capturing');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '結束會議' }).click();
  await expect.poll(async () => (await localRecording()).state).toBe('stopped_local');
  await page.reload();
  expect((await page.request.get(`/api/meetings/${meetingId}`, { headers })).status()).toBe(200);
  expect((await localRecording()).ownerUserId).toBe(auth.profile.id);
});
