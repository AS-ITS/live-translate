import { expect, test } from '@playwright/test';

test('paused Viewer waits without signaling and resumes the original Meeting automatically', async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    }
    class MockPeerConnection {
      constructor() {
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.signalingState = 'stable';
      }
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    }
    window.EventSource = MockEventSource;
    window.RTCPeerConnection = MockPeerConnection;
  });

  let snapshots = 0;
  let joins = 0;
  await page.route(/\/api\/shared-meetings\/code\/PAUSE1(?:\?.*)?$/, async (route) => {
    snapshots += 1;
    const active = snapshots >= 2;
    await route.fulfill({
      json: {
        capability: { role: 'viewer', meetingId: 'meeting-1' },
        meeting: { id: 'meeting-1', name: 'Pause Continue', status: 'active' },
        recordingState: active ? 'active' : 'paused',
        cues: active ? [{
          cueId: 'cue-after-resume', sequence: 1, sourceText: '繼續後字幕',
          status: 'final', sourceVersion: 1, translationVersion: 0
        }] : [],
        cursor: { eventId: active ? 1 : 0, cueSequence: active ? 1 : 0 },
        pagination: { hasMore: false, nextCursor: null }
      }
    });
  });
  await page.route('**/api/webrtc/meeting-1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/join')) {
      joins += 1;
      await route.fulfill({ json: { participantId: 'viewer-1', ttlMs: 30_000, iceServers: [] } });
      return;
    }
    await route.fulfill({ json: { cursor: 1, messages: [] } });
  });

  await page.goto('/#viewer?code=PAUSE1');

  await expect(page.getByText('等待錄音開始', { exact: true })).toBeVisible();
  expect(joins).toBe(0);
  await expect(page.getByText('會議已停止。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('即時字幕連線異常', { exact: true })).toHaveCount(0);

  await expect(page.getByText('繼續後字幕', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => joins).toBe(1);
  expect(snapshots).toBeGreaterThanOrEqual(2);
});

test('connected Viewer survives repeated Pause Continue cycles and reloads the same Meeting', async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    }
    class MockPeerConnection {
      constructor() {
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.signalingState = 'stable';
      }
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    }
    window.EventSource = MockEventSource;
    window.RTCPeerConnection = MockPeerConnection;
    window.__disconnectViewerFallback = () => MockEventSource.instances.at(-1)?.onerror?.(new Event('error'));
    window.__emitViewerCue = (payload) => MockEventSource.instances.at(-1)?.dispatchEvent(
      new MessageEvent('cue.append', { data: JSON.stringify(payload) })
    );
  });

  let recordingState = 'active';
  let joins = 0;
  const cues = [];
  await page.route(/\/api\/shared-meetings\/code\/PAUSE2(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        capability: { role: 'viewer', meetingId: 'meeting-repeat' },
        meeting: { id: 'meeting-repeat', name: 'Repeated Pause Continue', status: 'active' },
        recordingState,
        cues,
        cursor: { eventId: cues.length, cueSequence: cues.length },
        pagination: { hasMore: false, nextCursor: null }
      }
    });
  });
  await page.route('**/api/webrtc/meeting-repeat/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/join')) joins += 1;
    await route.fulfill({
      json: url.pathname.endsWith('/join')
        ? { participantId: `viewer-${joins}`, ttlMs: 30_000, iceServers: [] }
        : { cursor: 0, messages: [] }
    });
  });

  const addCue = (sequence) => {
    const cue = {
      cueId: `cue-${sequence}`, segmentId: `segment-${sequence}`, segmentSequence: sequence,
      sequence: 1, sourceText: `字幕 ${sequence}`, translatedText: `Subtitle ${sequence}`,
      status: 'final', sourceVersion: 1, translationVersion: 1
    };
    cues.push(cue);
    return { eventId: sequence, type: 'cue.append', cue };
  };

  await page.goto('/#viewer?code=PAUSE2');
  await expect.poll(() => joins).toBe(1);
  await page.evaluate((payload) => window.__emitViewerCue(payload), addCue(1));
  await expect(page.getByText('Subtitle 1', { exact: true })).toBeVisible();

  for (let cycle = 2; cycle <= 3; cycle += 1) {
    recordingState = 'paused';
    await page.evaluate(() => window.__disconnectViewerFallback());
    await expect(page.getByText('等待錄音開始', { exact: true })).toBeVisible({ timeout: 5_000 });
    recordingState = 'active';
    addCue(cycle);
    await expect(page.getByText(`Subtitle ${cycle}`, { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => joins).toBe(cycle);
  }

  await page.reload();
  await expect(page.getByText('Subtitle 3', { exact: true })).toBeVisible();
  await expect.poll(() => joins).toBe(4);
  await expect(page.getByText('會議已停止。', { exact: true })).toHaveCount(0);
});
