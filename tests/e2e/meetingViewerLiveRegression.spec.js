import { expect, test } from '@playwright/test';

test('Viewer keeps receiving and following cues when earlier live cues lack segment order', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = MockEventSource;
    window.__emitCue = (payload) => MockEventSource.instances.at(-1)?.dispatchEvent(
      new MessageEvent('cue.append', { data: JSON.stringify(payload) })
    );
    window.__disconnectViewer = () => MockEventSource.instances.at(-1)?.onerror?.(new Event('error'));
  });

  const snapshotCues = Array.from({ length: 25 }, (_, index) => ({
    cueId: `old-${index + 1}`, segmentId: 'segment-1', segmentSequence: 1,
    sequence: index + 1, sourceText: `歷史字幕 ${index + 1}`, sourceVersion: 1,
  }));
  await page.route(/\/api\/shared-meetings\/code\/LIVEORDER(?:\?.*)?$/, (route) => route.fulfill({
    json: { meeting: { id: 'meeting-1', name: '即時字幕測試', status: 'active' },
      cues: snapshotCues, cursor: { eventId: 25, cueSequence: 25 } },
  }));
  await page.goto('/#viewer?code=LIVEORDER');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  const viewerHeader = page.getByTestId('viewer-share-header');
  await expect(viewerHeader.getByRole('img', { name: 'Viewer 分享連結 QR Code' })).toBeVisible();
  const initialShareUrl = await viewerHeader.getByRole('link', { name: 'Viewer 分享連結' }).textContent();
  const initialQrCode = await viewerHeader.getByRole('img', { name: 'Viewer 分享連結 QR Code' }).getAttribute('src');
  await viewerHeader.evaluate((node) => { node.dataset.reconnectMarker = 'stable'; });
  await expect(viewport.locator('[data-cue-id="old-25"]')).toBeVisible();

  async function publish(eventId, cueId, segmentId, segmentSequence, sequence, sourceText, extra = {}) {
    await page.evaluate((payload) => window.__emitCue(payload), {
      eventId, type: 'cue.append', cue: { cueId, segmentId, ...(segmentSequence ? { segmentSequence } : {}),
        sequence, sourceText, sourceVersion: 1, status: 'final', ...extra },
    });
  }

  // Realtime payloads can omit segmentSequence even when snapshot rows include it.
  await publish(26, 'old-26', 'segment-1', null, 26, '舊字幕 26');
  await publish(27, 'old-27', 'segment-1', null, 27, '舊字幕 27');
  await expect(viewport.locator('[data-cue-id="old-27"]')).toBeVisible();
  for (const [index, letter] of ['A', 'B', 'C'].entries()) {
    await publish(28 + index, `new-${letter}`, 'segment-2', 2, index + 1, `新字幕 ${letter}`);
  }
  await expect(viewport.locator('[data-cue-id="new-C"]')).toHaveCount(1);
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-C');
  await expect(viewport.locator('[data-cue-id="new-C"]')).toBeVisible();

  await viewport.hover();
  await page.mouse.wheel(0, -1800);
  await expect(page.getByTestId('viewer-follow-latest-button')).toBeVisible();
  await publish(31, 'new-D', 'segment-2', 2, 4, '新字幕 D');
  await publish(32, 'new-E', 'segment-2', 2, 5, '新字幕 E');
  await page.getByTestId('viewer-follow-latest-button').click();
  await expect(viewport.locator('[data-cue-id="new-E"]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-E');

  await publish(33, 'old-26', 'segment-1', null, 26, '舊字幕 26', {
    translatedText: 'Late translation', translationVersion: 1,
  });
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-E');
  await expect(viewport.locator('[data-cue-id="old-26"]')).toHaveCount(1);
  await expect(viewport.locator('[data-cue-id="old-26"]')).toContainText('Late translation');
  expect(await viewport.locator('[data-cue-id="old-26"]').getAttribute('data-cue-index'))
    .toBe('25');

  // A fresh snapshot fills the offline gap; the new subscription must still receive live cues.
  snapshotCues.push({ cueId: 'new-F', segmentId: 'segment-2', segmentSequence: 2,
    sequence: 6, sourceText: '斷線期間字幕 F', sourceVersion: 1 });
  await page.evaluate(() => window.__disconnectViewer());
  await expect(viewerHeader).toBeVisible();
  await expect(viewerHeader).toHaveAttribute('data-reconnect-marker', 'stable');
  await expect(viewerHeader.getByRole('link', { name: 'Viewer 分享連結' })).toHaveText(initialShareUrl);
  await expect(viewerHeader.getByRole('img', { name: 'Viewer 分享連結 QR Code' })).toHaveAttribute('src', initialQrCode);
  await expect(viewport.locator('[data-cue-id="new-F"]')).toBeVisible();
  await publish(34, 'new-G', 'segment-2', 2, 7, '恢復後字幕 G');
  await expect(viewport.locator('[data-cue-id="new-G"]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) =>
    [...node.querySelectorAll('.viewer-cue-row')].at(-1)?.dataset.cueId)).toBe('new-G');
  await expect(viewerHeader).toHaveAttribute('data-reconnect-marker', 'stable');
});

test('Viewer waits for a late Recorder then receives snapshot and live Cue updates', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay = 0, ...args) => (
      nativeSetTimeout(callback, delay === 12_000 ? 5 : delay, ...args)
    );
    class MockEventSource extends EventTarget {
      constructor() { super(); }
      close() { this.readyState = 2; }
    }
    class MockDataChannel {
      constructor() {
        this.readyState = 'connecting';
        this.listeners = new Map();
        this.sent = [];
      }
      addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
      }
      emit(type, event = new Event(type)) {
        this.listeners.get(type)?.forEach((handler) => handler(event));
        this[`on${type}`]?.(event);
      }
      open() { this.readyState = 'open'; this.emit('open'); }
      send(value) { this.sent.push(JSON.parse(value)); }
      receive(value) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })); }
      close() { this.readyState = 'closed'; }
    }
    window.__lateJoinChannels = [];
    window.__receiveLateJoinPacket = (packet) => window.__lateJoinChannels.at(-1)?.receive(packet);
    window.EventSource = MockEventSource;
    window.RTCPeerConnection = class MockLateJoinPeerConnection {
      constructor() {
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        this.signalingState = 'stable';
      }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        const channel = new MockDataChannel();
        window.__lateJoinChannels.push(channel);
        queueMicrotask(() => { this.ondatachannel?.({ channel }); channel.open(); });
      }
      async createAnswer() { return { type: 'answer', sdp: 'late-answer' }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async addIceCandidate() {}
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    };
  });

  const signaling = { readyCount: 0, participantId: '', negotiationId: '', sequence: 0, offered: false };
  await page.route(/\/api\/shared-meetings\/code\/LATE-RECORDER(?:\?.*)?$/, (route) => route.fulfill({
    json: {
      meeting: { id: 'meeting-late-recorder', name: 'Late Recorder', status: 'active' },
      recordingState: 'recording', cues: [], cursor: { eventId: 0, cueSequence: 0 },
    },
  }));
  await page.route('**/api/webrtc/meeting-late-recorder/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/join')) {
      await route.fulfill({ json: { ttlMs: 60_000, iceServers: [] } });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/signal')) {
      const body = request.postDataJSON();
      if (body.type === 'viewer-ready') {
        signaling.readyCount += 1;
        signaling.participantId = body.participantId;
        signaling.negotiationId = body.negotiationId;
      }
      await route.fulfill({ json: { accepted: true, sequence: ++signaling.sequence } });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/signal')) {
      const shouldOffer = signaling.readyCount > 6 && !signaling.offered;
      const messages = shouldOffer ? [{
        sequence: ++signaling.sequence,
        participantId: 'recorder-late', targetParticipantId: signaling.participantId,
        negotiationId: signaling.negotiationId, type: 'offer',
        payload: { type: 'offer', sdp: 'late-offer' },
      }] : [];
      if (shouldOffer) signaling.offered = true;
      await route.fulfill({ json: { messages, after: signaling.sequence } });
      return;
    }
    await route.fulfill({ json: { left: true } });
  });

  await page.goto('/#viewer?code=LATE-RECORDER');
  await expect.poll(() => signaling.readyCount).toBeGreaterThan(6);
  await expect.poll(() => page.evaluate(() => window.__lateJoinChannels.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => (
    window.__lateJoinChannels[0].sent.some((packet) => packet.type === 'replay.request')
  ))).toBe(true);

  await page.evaluate(() => window.__receiveLateJoinPacket({
    protocol: 'subtitle-webrtc/v1', type: 'snapshot', meetingId: 'meeting-late-recorder',
    sourceId: 'recorder-source', sequence: 1,
    cues: [{ cueId: 'cue-1', segmentId: 'segment-1', sequence: 1, revision: 1,
      sourceText: '初始字幕', translatedText: 'Initial subtitle', sourceVersion: 1, translationVersion: 1 }],
  }));
  await page.evaluate(() => window.__receiveLateJoinPacket({
    protocol: 'subtitle-webrtc/v1', type: 'cue.update', meetingId: 'meeting-late-recorder',
    sourceId: 'recorder-source', sequence: 2,
    cue: { cueId: 'cue-1', segmentId: 'segment-1', sequence: 1, revision: 2,
      sourceText: '修正字幕', translatedText: 'Corrected subtitle', sourceVersion: 2, translationVersion: 2 },
  }));
  await page.evaluate(() => window.__receiveLateJoinPacket({
    protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-late-recorder',
    sourceId: 'recorder-source', sequence: 3,
    cue: { cueId: 'cue-2', segmentId: 'segment-1', sequence: 2, revision: 1,
      sourceText: '後續字幕', translatedText: 'Following subtitle', sourceVersion: 1, translationVersion: 1 },
  }));

  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect(viewport.locator('[data-cue-id="cue-1"]')).toHaveCount(1);
  await expect(viewport.locator('[data-cue-id="cue-1"]')).toContainText('Corrected subtitle');
  await expect(viewport.locator('[data-cue-id="cue-2"]')).toContainText('Following subtitle');
  await expect(page.getByRole('status')).toContainText('已連線');
});

test('Viewer keeps fullscreen presentation state across DataChannel generation recovery', async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
    }

    class MockDataChannel {
      constructor() {
        this.readyState = 'connecting';
        this.listeners = new Map();
        this.sent = [];
      }
      addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
      }
      emit(type, event = new Event(type)) {
        this.listeners.get(type)?.forEach((handler) => handler(event));
        this[`on${type}`]?.(event);
      }
      open() {
        this.readyState = 'open';
        this.emit('open');
      }
      send(value) { this.sent.push(JSON.parse(value)); }
      receive(value) {
        this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) }));
      }
      close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.emit('close');
      }
    }

    window.__viewerChannels = [];
    window.EventSource = MockEventSource;
    window.RTCPeerConnection = class MockViewerPeerConnection {
      constructor() {
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        this.signalingState = 'stable';
        this.localDescription = null;
        this.remoteDescription = null;
      }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        const channel = new MockDataChannel();
        window.__viewerChannels.push(channel);
        queueMicrotask(() => {
          this.ondatachannel?.({ channel });
          channel.open();
        });
      }
      async createAnswer() { return { type: 'answer', sdp: 'mock-answer' }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async addIceCandidate() {}
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    };
    window.__closeViewerChannel = () => window.__viewerChannels.at(-1)?.close();
    window.__receiveViewerPacket = (packet) => window.__viewerChannels.at(-1)?.receive(packet);
  });

  const signaling = { participantId: '', negotiationId: '', offeredNegotiations: new Set(), sequence: 0 };
  await page.route(/\/api\/shared-meetings\/code\/FULLSCREEN(?:\?.*)?$/, (route) => route.fulfill({
    json: {
      meeting: { id: 'meeting-fullscreen', name: '全螢幕重連測試', status: 'active' },
      cues: [{ cueId: 'cue-1', segmentId: 'segment-1', segmentSequence: 1, sequence: 1,
        sourceText: '初始原文', translatedText: 'Initial translation', sourceVersion: 1, translationVersion: 1 }],
      cursor: { eventId: 1, cueSequence: 1 },
    },
  }));
  await page.route('**/api/webrtc/meeting-fullscreen/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/join')) {
      await route.fulfill({ json: { ttlMs: 60_000, iceServers: [] } });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/signal')) {
      const body = request.postDataJSON();
      if (body.type === 'viewer-ready') {
        signaling.participantId = body.participantId;
        signaling.negotiationId = body.negotiationId;
      }
      await route.fulfill({ json: { accepted: true, sequence: ++signaling.sequence } });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/signal')) {
      const shouldOffer = signaling.negotiationId
        && !signaling.offeredNegotiations.has(signaling.negotiationId);
      const messages = shouldOffer ? [{
        sequence: ++signaling.sequence,
        participantId: 'recorder-1',
        targetParticipantId: signaling.participantId,
        negotiationId: signaling.negotiationId,
        type: 'offer',
        payload: { type: 'offer', sdp: `mock-offer-${signaling.sequence}` },
      }] : [];
      if (shouldOffer) signaling.offeredNegotiations.add(signaling.negotiationId);
      await route.fulfill({ json: { messages, after: signaling.sequence } });
      return;
    }
    await route.fulfill({ json: { left: true } });
  });

  await page.goto('/#viewer?code=FULLSCREEN');
  const shell = page.getByTestId('viewer-fullscreen-shell');
  const viewport = page.getByTestId('meeting-viewer-cue-viewport');
  await expect.poll(() => page.evaluate(() => window.__viewerChannels.length)).toBe(1);
  await shell.evaluate((node) => { node.dataset.fullscreenBoundary = 'stable'; });

  await page.getByTestId('viewer-fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.dataset.testid)).toBe('viewer-fullscreen-shell');
  await page.getByTestId('viewer-source-toggle').click();
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('img', { name: 'Viewer 分享連結 QR Code' })).toBeVisible();

  await page.evaluate(() => window.__closeViewerChannel());
  await expect.poll(() => page.evaluate(() => window.__viewerChannels.length), { timeout: 5_000 }).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__viewerChannels.at(-1)?.sent.some((packet) => packet.type === 'replay.request'))).toBe(true);
  await page.evaluate(() => window.__receiveViewerPacket({
    protocol: 'subtitle-webrtc/v1', type: 'replay.response', meetingId: 'meeting-fullscreen',
    sourceId: 'recorder-source', requestId: 'replay-2', fromSequence: 1, toSequence: 2,
    events: [{ protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-fullscreen',
      sourceId: 'recorder-source', sequence: 2, cue: { cueId: 'cue-2', segmentId: 'segment-1',
        segmentSequence: 1, sequence: 2, sourceText: '重連原文', translatedText: 'Recovered translation',
        sourceVersion: 1, translationVersion: 1 } }],
  }));
  await page.evaluate(() => window.__receiveViewerPacket({
    protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-fullscreen',
    sourceId: 'recorder-source', sequence: 3, cue: { cueId: 'cue-3', segmentId: 'segment-1',
      segmentSequence: 1, sequence: 3, sourceText: '最新原文', translatedText: 'Latest translation',
      sourceVersion: 1, translationVersion: 1 },
  }));

  await expect(viewport.locator('[data-cue-id="cue-3"]')).toContainText('Latest translation');
  await expect(shell).toHaveAttribute('data-fullscreen-boundary', 'stable');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.dataset.testid)).toBe('viewer-fullscreen-shell');
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('viewer-translation-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('img', { name: 'Viewer 分享連結 QR Code' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Viewer 分享連結' })).toHaveAttribute('href', /#viewer\?code=FULLSCREEN$/);
});

test('Viewer shows recovery failure in fullscreen and reloads only after the user clicks', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay = 0, ...args) => nativeSetTimeout(callback, delay >= 1_000 ? 0 : delay, ...args);
    class MockEventSource extends EventTarget {
      static instances = [];
      constructor() {
        super();
        MockEventSource.instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = MockEventSource;
    window.__failViewerTransport = () => MockEventSource.instances.at(-1)?.onerror?.(new Event('error'));
    window.__recoverViewerTransport = () => MockEventSource.instances.at(-1)?.onopen?.(new Event('open'));
  });

  let snapshotRequests = 0;
  let navigationRequests = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationRequests += 1;
  });
  await page.route(/\/api\/shared-meetings\/code\/RECOVERY-FAILED(?:\?.*)?$/, async (route) => {
    snapshotRequests += 1;
    if (snapshotRequests > 1) {
      await route.fulfill({ status: 503, json: { error: { code: 'cloud_capability_unavailable' } } });
      return;
    }
    await route.fulfill({ json: {
      meeting: { id: 'meeting-recovery-failed', name: 'Recovery failure regression' },
      cues: [{
        cueId: 'cue-preserved', segmentId: 'segment-1', segmentSequence: 1, sequence: 1,
        sourceText: '保留的舊字幕', translatedText: 'Preserved subtitle', sourceVersion: 1, translationVersion: 1,
      }],
      cursor: { eventId: 1, cueSequence: 1 },
      pagination: { hasMore: false, nextCursor: null },
    } });
  });

  await page.goto('/#viewer?code=RECOVERY-FAILED');
  const shell = page.getByTestId('viewer-fullscreen-shell');
  const preservedCue = page.locator('[data-cue-id="cue-preserved"]');
  await expect(preservedCue).toContainText('保留的舊字幕');
  await page.getByTestId('viewer-source-toggle').click();
  await page.getByTestId('viewer-fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.dataset.testid)).toBe('viewer-fullscreen-shell');

  await page.evaluate(() => window.__failViewerTransport());
  const failurePanel = page.getByTestId('viewer-recovery-failed');
  await expect(failurePanel).toContainText('即時字幕連線異常');
  await expect(failurePanel).toContainText('無法自動恢復即時字幕連線，請重新整理頁面後重新連線。');
  const reloadButton = failurePanel.getByRole('button', { name: '重新整理頁面' });
  await expect(reloadButton).toBeVisible();
  await expect(preservedCue).toContainText('Preserved subtitle');
  await expect(page.getByTestId('viewer-source-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(shell).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.dataset.testid)).toBe('viewer-fullscreen-shell');
  expect(navigationRequests).toBe(1);

  await page.evaluate(() => window.__recoverViewerTransport());
  await expect(page.getByTestId('viewer-recovery-failed')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('已連線');
  await page.evaluate(() => window.__failViewerTransport());
  await expect(failurePanel).toBeVisible();

  await Promise.all([
    page.waitForNavigation(),
    reloadButton.click(),
  ]);
  expect(navigationRequests).toBe(2);
});
