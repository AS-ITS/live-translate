import { expect, test } from '@playwright/test';
import { installHostViewerHarness } from './hostViewerHarness.js';

test('Viewer joins from Host snapshot and reconnects without HTTP or SSE Cue', async ({ page }) => {
  const segment = { id: 'segment-1', sessionId: 'session-1', sequence: 1, status: 'active' };
  const first = { cueId: 'first', meetingId: 'meeting-slice-2', sessionId: 'session-1',
    segmentId: 'segment-1', sequence: 1, sourceText: 'Host subtitle', sourceVersion: 1 };
  const state = await installHostViewerHarness(page, { code: 'SLICE2', meetingId: 'meeting-slice-2',
    cues: [first], segments: [segment] });
  await page.goto('/#viewer?code=SLICE2');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="first"]')).toContainText('Host subtitle');
  state.hostAvailable = false;
  await page.evaluate(() => { window.__hostAvailable = false; window.__hostClose(); });
  await expect(viewport.locator('[data-cue-id="first"]')).toBeVisible();
  await expect(page.getByText('等待 Host 重新連線', { exact: true })).toBeVisible();
  state.hostAvailable = true;
  await page.evaluate(() => {
    window.__hostPublish({ ...window.__hostCues[0], cueId: 'second', sequence: 2, sourceText: 'Recovered subtitle' });
    window.__hostAvailable = true;
  });
  await expect(viewport.locator('[data-cue-id="second"]')).toContainText('Recovered subtitle');
  await expect(page.getByText('等待 Host 重新連線', { exact: true })).toHaveCount(0);
  expect(state.metadataReads).toBeGreaterThan(0);
  expect(state.cloudContentReads).toBe(0);
});

test('Viewer keeps Host Cues when Segment metadata arrives later', async ({ page }) => {
  const firstSegment = { id: 'segment-1', sessionId: 'session-1', sequence: 1 };
  const secondSegment = { id: 'segment-2', sessionId: 'session-2', sequence: 2 };
  const state = await installHostViewerHarness(page, {
    code: 'LATESEG', meetingId: 'meeting-late-segment', segments: [firstSegment],
    cues: [{ cueId: 'first', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, sourceText: 'First', sourceVersion: 1 }],
  });
  await page.goto('/#viewer?code=LATESEG');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="first"]')).toBeVisible();
  await page.evaluate(() => {
    window.__hostPublish({ cueId: 'second', meetingId: 'meeting-late-segment',
      sessionId: 'session-2', segmentId: 'segment-2', sequence: 1,
      sourceText: 'Second', sourceVersion: 1 });
    window.__hostPublish({ cueId: 'third', meetingId: 'meeting-late-segment',
      sessionId: 'session-2', segmentId: 'segment-2', sequence: 2,
      sourceText: 'Third', sourceVersion: 1 });
  });
  await expect(viewport.locator('[data-cue-id="second"]')).toContainText('Second');
  await expect(viewport.locator('[data-cue-id="third"]')).toContainText('Third');
  state.segments = [firstSegment, secondSegment];
  state.lifecycleVersion += 1;
  await expect(viewport.locator('[data-cue-id="second"]')).toContainText('Second');
  await expect(viewport.locator('[data-cue-id="third"]')).toContainText('Third');
  await expect(viewport.locator('[data-cue-id="second"]')).toHaveCount(1);
  await expect(viewport.locator('[data-cue-id="third"]')).toHaveCount(1);
  expect(state.cloudContentReads).toBe(0);
});

test('Host source changes after reload and Viewer rebuilds snapshot without cloud Cue', async ({ page }) => {
  const segment = { id: 'segment-1', sessionId: 'session-1', sequence: 1 };
  const state = await installHostViewerHarness(page, {
    code: 'HOSTRELOAD', meetingId: 'meeting-host-reload', segments: [segment],
    cues: [{ cueId: 'first', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, sourceText: 'Before reload', sourceVersion: 1 }],
  });
  await page.goto('/#viewer?code=HOSTRELOAD');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="first"]')).toContainText('Before reload');
  await page.evaluate(() => {
    window.__hostReload();
    window.__hostPublish({ cueId: 'second', meetingId: 'meeting-host-reload',
      sessionId: 'session-1', segmentId: 'segment-1', sequence: 2,
      sourceText: 'After reload', sourceVersion: 1 });
  });
  await expect(viewport.locator('[data-cue-id="second"]')).toContainText('After reload');
  await expect.poll(() => page.evaluate(() => window.__hostChannels.length)).toBeGreaterThan(1);
  expect(state.cloudContentReads).toBe(0);
});

test('Host End and Retention 410 prevent further Cue recovery', async ({ page }) => {
  const segment = { id: 'segment-1', sessionId: 'session-1', sequence: 1 };
  const state = await installHostViewerHarness(page, {
    code: 'HOSTEND', meetingId: 'meeting-host-end', segments: [segment],
    cues: [{ cueId: 'first', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, sourceText: 'Before end', sourceVersion: 1 }],
  });
  await page.goto('/#viewer?code=HOSTEND');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="first"]')).toContainText('Before end');
  state.recordingState = 'ended';
  state.lifecycleVersion += 1;
  await page.evaluate(() => window.__hostClose());
  await expect(page.getByText('會議已結束。', { exact: true })).toBeVisible();
  const channelsAtEnd = await page.evaluate(() => window.__hostChannels.length);
  await page.evaluate(() => window.__hostPublish({ cueId: 'late', meetingId: 'meeting-host-end',
    sessionId: 'session-1', segmentId: 'segment-1', sequence: 2,
    sourceText: 'Must not recover', sourceVersion: 1 }));
  await expect(viewport.locator('[data-cue-id="late"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__hostChannels.length)).toBe(channelsAtEnd);
  state.retentionExpired = true;
  await page.reload();
  await expect(page.getByText('此會議內容已超過保留時間。', { exact: true })).toBeVisible();
  await expect(page.locator('[data-cue-id="first"]')).toHaveCount(0);
  await expect(page.locator('[data-cue-id="late"]')).toHaveCount(0);
  expect(state.cloudContentReads).toBe(0);
});

test('late Replay cannot replace newer live Cue and still fills the next sequence', async ({ page }) => {
  const segment = { id: 'segment-1', sessionId: 'session-1', sequence: 1 };
  const state = await installHostViewerHarness(page, {
    code: 'RACE', meetingId: 'meeting-race', segments: [segment],
    cues: [{ cueId: 'first', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, sourceText: 'First-1', sourceVersion: 1 }],
  });
  await page.goto('/#viewer?code=RACE');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="first"]')).toContainText('First-1');
  await page.evaluate(() => window.__hostPublish({
    cueId: 'first', meetingId: 'meeting-race', sessionId: 'session-1',
    segmentId: 'segment-1', sequence: 1, sourceText: 'First-3', sourceVersion: 3,
  }, 'cue.update'));
  await expect(viewport.locator('[data-cue-id="first"]')).toContainText('First-3');
  await page.evaluate(() => {
    const envelope = (sequence, cue, type) => ({
      protocol: 'subtitle-webrtc/v1', type, meetingId: 'meeting-race',
      sourceId: window.__hostSourceId, sequence, cue,
    });
    window.__hostReceive({
      protocol: 'subtitle-webrtc/v1', type: 'replay.response', meetingId: 'meeting-race',
      sourceId: window.__hostSourceId, requestId: 'late-replay', fromSequence: 1, toSequence: 3,
      events: [
        envelope(2, { cueId: 'first', meetingId: 'meeting-race', sessionId: 'session-1',
          segmentId: 'segment-1', sequence: 1, sourceText: 'First-2', sourceVersion: 2 }, 'cue.update'),
        envelope(3, { cueId: 'second', meetingId: 'meeting-race', sessionId: 'session-1',
          segmentId: 'segment-1', sequence: 2, sourceText: 'Second', sourceVersion: 1 }, 'cue.append'),
      ],
    });
  });
  await expect(viewport.locator('[data-cue-id="first"]')).toContainText('First-3');
  await expect(viewport.locator('[data-cue-id="first"]')).toHaveCount(1);
  await expect(viewport.locator('[data-cue-id="second"]')).toContainText('Second');
  await expect(viewport.locator('[data-cue-id="second"]')).toHaveCount(1);
  expect(state.cloudContentReads).toBe(0);
});
