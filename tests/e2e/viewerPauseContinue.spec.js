import { expect, test } from '@playwright/test';
import { installHostViewerHarness } from './hostViewerHarness.js';

test('paused Viewer waits without signaling and resumes the original Meeting automatically', async ({ page }) => {
  const segment = { id: 'segment-1', sessionId: 'session-1', sequence: 1, status: 'active' };
  const state = await installHostViewerHarness(page, {
    code: 'PAUSE1', meetingId: 'meeting-1', meetingName: 'Pause Continue',
    cues: [{ cueId: 'cue-after-resume', segmentId: segment.id, sessionId: segment.sessionId,
      sequence: 1, sourceText: '繼續後字幕', status: 'final', sourceVersion: 1, translationVersion: 0 }],
    segments: [segment], lifecycle: { recordingState: 'paused' },
  });
  await page.goto('/#viewer?code=PAUSE1');
  await expect(page.getByText('等待錄音開始', { exact: true })).toBeVisible();
  expect(state.joins).toBe(0);
  await expect(page.getByText('會議已停止。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('即時字幕連線異常', { exact: true })).toHaveCount(0);

  state.recordingState = 'active';
  state.lifecycleVersion += 1;
  await expect(page.getByText('繼續後字幕', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => state.joins).toBe(1);
  expect(state.metadataReads).toBeGreaterThanOrEqual(2);
  expect(state.cloudContentReads).toBe(0);
});

test('connected Viewer survives repeated Pause Continue cycles and reloads the same Meeting', async ({ page }) => {
  const segments = [1, 2, 3].map((sequence) => ({
    id: `segment-${sequence}`, sessionId: `session-${sequence}`, sequence, status: 'active',
  }));
  const state = await installHostViewerHarness(page, {
    code: 'PAUSE2', meetingId: 'meeting-repeat', meetingName: 'Repeated Pause Continue', segments,
  });
  const addCue = async (sequence) => {
    const segment = segments[sequence - 1];
    await page.evaluate((cue) => window.__hostPublish(cue), {
      cueId: `cue-${sequence}`, meetingId: 'meeting-repeat',
      segmentId: segment.id, sessionId: segment.sessionId, segmentSequence: sequence,
      sequence: 1, sourceText: `字幕 ${sequence}`, translatedText: `Subtitle ${sequence}`,
      status: 'final', sourceVersion: 1, translationVersion: 1,
    });
  };

  await page.goto('/#viewer?code=PAUSE2');
  await expect.poll(() => state.joins).toBe(1);
  await addCue(1);
  await expect(page.getByText('Subtitle 1', { exact: true })).toBeVisible();

  for (let cycle = 2; cycle <= 3; cycle += 1) {
    state.recordingState = 'paused';
    state.lifecycleVersion += 1;
    await page.evaluate(() => window.__hostClose());
    await expect(page.getByText('等待錄音開始', { exact: true })).toBeVisible({ timeout: 5_000 });
    await addCue(cycle);
    state.recordingState = 'active';
    state.lifecycleVersion += 1;
    await expect(page.getByText(`Subtitle ${cycle}`, { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => state.joins).toBe(cycle);
  }

  await page.reload();
  await expect(page.getByText('Subtitle 3', { exact: true })).toBeVisible();
  await expect.poll(() => state.joins).toBe(4);
  await expect(page.getByText('會議已停止。', { exact: true })).toHaveCount(0);
  expect(state.cloudContentReads).toBe(0);
});
