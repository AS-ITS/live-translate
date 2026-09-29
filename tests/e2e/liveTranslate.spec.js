import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const resetResponse = await page.request.delete('/api/test/sessions');
  expect(resetResponse.status()).toBe(204);
  page.liveTokenRequests = [];
  page.failLiveTokenRequestAt = null;
  page.liveGlossaryEntries = [];
  page.delayLiveTokenRequestMs = 0;
  page.useMockMeetings = true;
  page.mockMeetingLanguage = { sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' };
  page.useMeetingRootForGoto = true;
  page.hasMeetingCheckpointMock = false;

  await page.addInitScript(() => {
    window.__mockMicTracks = [];
    window.__mockAudioContexts = [];
    window.__mockAudioProcessors = [];
    window.__mockMediaRecorders = [];
    window.__mockLiveConnectDelayMs = 0;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (window.__mockMissingMicrophone) {
            throw new DOMException('No microphone device found', 'NotFoundError');
          }
          const track = {
            kind: 'audio',
            enabled: true,
            readyState: 'live',
            stopped: false,
            listeners: new Map(),
            stop() {
              this.stopped = true;
              this.readyState = 'ended';
            },
            addEventListener(event, handler) {
              this.listeners.set(event, handler);
            },
            removeEventListener(event, handler) {
              if (this.listeners.get(event) === handler) this.listeners.delete(event);
            },
            emit(event) {
              this.listeners.get(event)?.();
            }
          };
          window.__mockMicTracks.push(track);
          return {
            active: true,
            getTracks: () => [track]
          };
        }
      }
    });

    class MockAudioContext {
      constructor() {
        this.sampleRate = 16000;
        this.currentTime = 0;
        this.destination = {};
        this.state = 'running';
        this.resumeCalls = 0;
        window.__mockAudioContexts.push(this);
      }

      async resume() {
        this.resumeCalls += 1;
        this.state = 'running';
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        window.__mockAudioProcessors.push(processor);
        return processor;
      }

      createBuffer() {
        return {
          duration: 0,
          copyToChannel() {}
        };
      }

      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          disconnect() {},
          start() {
            this.onended?.();
          },
          stop() {},
          onended: null
        };
      }

      async close() {
        this.state = 'closed';
      }
    }

    window.AudioContext = MockAudioContext;
    window.webkitAudioContext = MockAudioContext;

    class MockMediaRecorder {
      static isTypeSupported(mimeType) {
        return mimeType === 'audio/webm;codecs=opus' || mimeType === 'audio/webm';
      }

      constructor(stream, options = {}) {
        this.stream = stream;
        this.mimeType = options.mimeType || 'audio/webm';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onerror = null;
        this.onstop = null;
        window.__mockMediaRecorders.push(this);
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const tracks = typeof this.stream?.getTracks === 'function' ? this.stream.getTracks() : [];
        if (!tracks.every((track) => track.stopped)) {
          this.ondataavailable?.({
            data: new Blob([`audio-${window.__mockMediaRecorders.length}`], { type: this.mimeType })
          });
        }
        this.onstop?.({});
      }

      emitError(message = 'mock recorder error') {
        this.onerror?.({ error: new Error(message) });
      }
    }

    window.MediaRecorder = MockMediaRecorder;
  });

  await page.route('**/api/live-token', async (route) => {
    const request = route.request();
    const body = JSON.parse(request.postData() || '{}');
    page.liveTokenRequests.push(body);

    if (page.failLiveTokenRequestAt === page.liveTokenRequests.length) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'provider_unavailable' } })
      });
      return;
    }

    if (page.delayLiveTokenRequestMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, page.delayLiveTokenRequestMs));
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: `mock-token-for-${body.targetLanguageCode}`,
        expiresAt: '2026-07-07T00:30:00.000Z',
        liveConnectModel: 'gemini-live-e2e-model',
        liveGlossaryEntries: page.liveGlossaryEntries
      })
    });
  });

  await page.route('**/api/translation-requests', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ request: { ...body, status: 'queued' } })
    });
  });

  await page.route('**/api/translation-executions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ execution: { ...body, status: 'queued' } })
    });
  });

  await page.route('**/api/translation-executions/*', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ execution: body })
    });
  });

  await page.route('**/api/translation-outputs', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ output: body })
    });
  });

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(page.useMockMeetings && page.url().includes('#live?meetingId=meeting-1') ? [{
          id: 'meeting-1',
          name: '測試會議',
          status: 'created',
          sourceLanguageCode: page.mockMeetingLanguage.sourceLanguageCode,
          targetLanguageCode: page.mockMeetingLanguage.targetLanguageCode
        }] : [])
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/meetings/meeting-1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: 'meeting-1', name: '測試會議', status: 'created',
            sourceLanguageCode: page.mockMeetingLanguage.sourceLanguageCode,
            targetLanguageCode: page.mockMeetingLanguage.targetLanguageCode,
            glossaryEntries: []
          }
        })
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/meetings/meeting-1/segments') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ meetingId: 'meeting-1', segments: [{
          id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'created', liveSessionId: null
        }] })
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/meetings/meeting-1/segments/segment-1/start') {
      const body = JSON.parse(request.postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: 'meeting-1', name: '測試會議', status: 'active',
            sourceLanguageCode: page.mockMeetingLanguage.sourceLanguageCode,
            targetLanguageCode: page.mockMeetingLanguage.targetLanguageCode
          },
          segment: { id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'active', liveSessionId: body.liveSessionId }
        })
      });
      return;
    }
    if (/^\/api\/meetings\/meeting-1\/segments\/segment-1\/checkpoint$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint: {
          idempotencyKey: null, durableChunks: [], finalCues: [], cueCheckpoint: null, pendingPartial: null, updatedAt: null
        } })
      });
      return;
    }
    await route.fallback();
  });

  const originalGoto = page.goto.bind(page);
  page.goto = (url, options) => originalGoto(
    url === '/' && page.useMeetingRootForGoto ? '/#live?meetingId=meeting-1' : url,
    options
  );

  await installE2EAuth(page);
});

function sessionDetail(page) {
  return page.locator('.session-detail');
}

function liveCuePanel(page) {
  return page.getByTestId('live-cue-panel');
}

function cueList(page) {
  return liveCuePanel(page).getByTestId('cue-list');
}

function translationCueList(page) {
  return liveCuePanel(page).getByTestId('cue-paired-list');
}

function finalCueRows(page) {
  return liveCuePanel(page).getByTestId('cue-paired-list').getByTestId('cue-final-row');
}

function partialCueRows(page) {
  return liveCuePanel(page).getByTestId('cue-paired-list').getByTestId('cue-partial-row');
}

function cueRow(page, cueId) {
  return cueList(page).locator(`[data-cue-id="${cueId}"]`);
}

async function expectCueRow(row, { sourceText, translatedText, timecode } = {}) {
  if (sourceText !== undefined) await expect(row.getByTestId('cue-source-text')).toHaveText(sourceText);
  if (translatedText !== undefined) {
    const pairedTranslation = row.getByTestId('cue-translated-text');
    if (await pairedTranslation.count() > 0) {
      await expect(pairedTranslation).toHaveText(translatedText);
    }
  }
  if (timecode !== undefined) await expect(row.getByTestId('cue-timecode')).toHaveText(timecode);
}

function savedExportPanel(page) {
  return sessionDetail(page).getByLabel('已儲存逐字稿匯出');
}

function activeExportPanel(page) {
  return page.getByRole('complementary', { name: '逐字稿匯出' });
}

async function expectActiveExportDownloadEnabled(page) {
  const trigger = page.getByRole('button', { name: '匯出', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(activeExportPanel(page).getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await activeExportPanel(page).getByRole('button', { name: '關閉匯出' }).click();
}

async function openLiveSettings(page) {
  const drawer = page.getByRole('complementary', { name: '即時字幕設定' });
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

async function liveSetting(page, label) {
  const drawer = page.getByRole('complementary', { name: '即時字幕設定' });
  const settingsTrigger = page.getByRole('button', { name: '設定', exact: true });
  if (await settingsTrigger.isVisible()) {
    if (!(await drawer.isVisible())) await openLiveSettings(page);
    const field = drawer.getByLabel(label);
    return {
      check: async (...args) => {
        await field.check(...args);
        await page.keyboard.press('Escape');
      },
      selectOption: async (...args) => {
        const result = await field.selectOption(...args);
        await page.keyboard.press('Escape');
        return result;
      }
    };
  }
  return page.getByLabel(label);
}

function glossaryPanel(page) {
  return page.locator('.glossary-panel');
}

async function mockMeetingCheckpointApi(page, {
  failCheckpoint = false,
  failCheckpointAttempts = 0,
  waitForSegmentList = null,
  delayMeetingListMs = 0,
  meetingDetailCues = [],
  sourceLanguageCode = 'zh-Hant',
  targetLanguageCode = 'en',
  initialSegmentStatus = 'created',
  initialLiveSessionId = null
} = {}) {
  page.useMockMeetings = true;
  page.hasMeetingCheckpointMock = true;
  page.mockMeetingLanguage = { sourceLanguageCode, targetLanguageCode };
  const checkpointRequests = [];
  const rolloverRequests = [];
  const recoverRequests = [];
  const checkpoints = new Map();
  let latestSegmentNumber = 1;
  let checkpointFailuresRemaining = failCheckpointAttempts;

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && url.pathname === '/api/meetings') {
      if (delayMeetingListMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMeetingListMs));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(page.useMockMeetings ? [{
          id: 'meeting-1',
          name: '測試會議',
          status: 'created',
          sourceLanguageCode,
          targetLanguageCode
        }] : [])
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/meetings/meeting-1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: 'meeting-1',
            name: '測試會議',
            status: 'created',
            sourceLanguageCode,
            targetLanguageCode
          },
          cues: meetingDetailCues
        })
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/meetings') {
      const body = JSON.parse(request.postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: { id: 'meeting-1', status: 'active' },
          segment: {
            id: 'segment-1',
            meetingId: 'meeting-1',
            sequence: 0,
            status: 'active',
            liveSessionId: body.liveSessionId || null
          }
        })
      });
      return;
    }

    const startMatch = url.pathname.match(/^\/api\/meetings\/meeting-1\/segments\/(segment-\d+)\/start$/);
    if (method === 'POST' && startMatch) {
      const body = JSON.parse(request.postData() || '{}');
      latestSegmentNumber = Math.max(latestSegmentNumber, Number(startMatch[1].split('-')[1]));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: { id: 'meeting-1', name: '測試會議', status: 'active', sourceLanguageCode, targetLanguageCode },
          segment: { id: startMatch[1], meetingId: 'meeting-1', sequence: Number(startMatch[1].split('-')[1]) - 1, status: 'active', liveSessionId: body.liveSessionId }
        })
      });
      return;
    }

    const segmentMatch = url.pathname.match(/^\/api\/meetings\/meeting-1\/segments\/(segment-\d+)\/checkpoint$/);
    if (method === 'PUT' && segmentMatch) {
      const body = JSON.parse(request.postData() || '{}');
      checkpointRequests.push(body);

      if (failCheckpoint || checkpointFailuresRemaining > 0) {
        checkpointFailuresRemaining = Math.max(0, checkpointFailuresRemaining - 1);
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'meeting_checkpoint_unavailable' } })
        });
        return;
      }

      checkpoints.set(segmentMatch[1], {
        idempotencyKey: body.idempotencyKey,
        durableChunks: body.durableChunks,
        finalCues: body.finalCues || [],
        cueCheckpoint: body.cueCheckpoint || null,
        pendingPartial: null,
        updatedAt: 1000
      });

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meetingId: 'meeting-1',
          segmentId: segmentMatch[1],
          checkpoint: checkpoints.get(segmentMatch[1])
        })
      });
      return;
    }

    if (method === 'GET' && segmentMatch) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meetingId: 'meeting-1',
          segmentId: segmentMatch[1],
          checkpoint: checkpoints.get(segmentMatch[1]) || {
            idempotencyKey: null,
            durableChunks: [],
            finalCues: [],
            cueCheckpoint: null,
            pendingPartial: null,
            updatedAt: null
          }
        })
      });
      return;
    }

    const rolloverMatch = url.pathname.match(/^\/api\/meetings\/meeting-1\/segments\/segment-(\d+)\/rollover$/);
    if (method === 'POST' && rolloverMatch) {
      const currentSegmentNumber = Number(rolloverMatch[1]);
      const body = JSON.parse(request.postData() || '{}');
      latestSegmentNumber = Math.max(latestSegmentNumber, currentSegmentNumber + 1);
      const nextSegmentId = `segment-${currentSegmentNumber + 1}`;
      rolloverRequests.push({ currentSegmentId: `segment-${currentSegmentNumber}`, body });

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          completedSegment: {
            id: `segment-${currentSegmentNumber}`,
            meetingId: 'meeting-1',
            sequence: currentSegmentNumber - 1,
            status: 'completed'
          },
          segment: {
            id: nextSegmentId,
            meetingId: 'meeting-1',
            sequence: currentSegmentNumber,
            status: 'active',
            liveSessionId: body.nextLiveSessionId
          }
        })
      });
      return;
    }

    const recoverMatch = url.pathname.match(/^\/api\/meetings\/meeting-1\/segments\/segment-(\d+)\/recover$/);
    if (method === 'POST' && recoverMatch) {
      const currentSegmentNumber = Number(recoverMatch[1]);
      const body = JSON.parse(request.postData() || '{}');
      latestSegmentNumber = Math.max(latestSegmentNumber, currentSegmentNumber + 1);
      const nextSegmentId = `segment-${currentSegmentNumber + 1}`;
      recoverRequests.push({ currentSegmentId: `segment-${currentSegmentNumber}`, body });
      const existingCheckpoint = checkpoints.get(`segment-${currentSegmentNumber}`) || {
        idempotencyKey: null,
        durableChunks: [],
        pendingPartial: null,
        updatedAt: null
      };
      checkpoints.set(`segment-${currentSegmentNumber}`, {
        ...existingCheckpoint,
        idempotencyKey: body.idempotencyKey,
        updatedAt: 1000
      });

      if (body.outcome === 'failed') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            failedSegment: {
              id: `segment-${currentSegmentNumber}`,
              meetingId: 'meeting-1',
              sequence: currentSegmentNumber - 1,
              status: 'failed',
              errorInfo: { reason: body.failureReason, category: body.failureCategory }
            }
          })
        });
        return;
      }

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          interruptedSegment: {
            id: `segment-${currentSegmentNumber}`,
            meetingId: 'meeting-1',
            sequence: currentSegmentNumber - 1,
            status: 'interrupted',
            errorInfo: { reason: body.failureReason, category: body.failureCategory }
          },
          segment: {
            id: nextSegmentId,
            meetingId: 'meeting-1',
            sequence: currentSegmentNumber,
            status: 'active',
            liveSessionId: body.nextLiveSessionId
          }
        })
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/meetings/meeting-1/segments') {
      await waitForSegmentList?.();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meetingId: 'meeting-1',
          segments: Array.from({ length: latestSegmentNumber }, (_, index) => ({
            id: `segment-${index + 1}`,
            meetingId: 'meeting-1',
            sequence: index,
            status: index + 1 === latestSegmentNumber ? initialSegmentStatus : 'completed',
            liveSessionId: index + 1 === latestSegmentNumber ? initialLiveSessionId : null
          }))
        })
      });
      return;
    }

    await route.fallback();
  });

  checkpointRequests.rolloverRequests = rolloverRequests;
  checkpointRequests.recoverRequests = recoverRequests;
  return checkpointRequests;
}

async function mockSingleMeetingList(page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (new URL(url, window.location.origin).pathname === '/api/meetings') {
        return new Response(JSON.stringify([{
          id: 'meeting-1',
          name: '測試會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en'
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    };
  });
  await page.route('**/api/meetings**', async (route) => {
    if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/meetings') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'meeting-1',
        name: '測試會議',
        status: 'created',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en'
      }])
    });
  });
}

async function mockLiveLayoutMeeting(page, { meetingId = '4444', archivedSegmentCount = 0 } = {}) {
  const segmentCount = archivedSegmentCount + 1;
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    id: `${meetingId}-segment-${index + 1}`,
    meetingId,
    sequence: index,
    status: index === segmentCount - 1 ? 'active' : 'completed'
  }));

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: meetingId,
          name: '版面回歸測試會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en'
        }])
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname === `/api/meetings/${meetingId}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: meetingId,
            name: '版面回歸測試會議',
            status: 'created',
            sourceLanguageCode: 'zh-Hant',
            targetLanguageCode: 'en',
            glossaryEntries: []
          }
        })
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname === `/api/meetings/${meetingId}/segments`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ meetingId, segments })
      });
      return;
    }
    if (request.method() === 'GET' && new RegExp(`^/api/meetings/${meetingId}/segments/[^/]+/checkpoint$`).test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meetingId,
          segmentId: url.pathname.split('/').at(-2),
          checkpoint: {
            durableChunks: [],
            finalCues: [],
            refinedSubtitleCues: [],
            cueCheckpoint: null,
            pendingPartial: null,
            updatedAt: null
          }
        })
      });
      return;
    }
    await route.fallback();
  });
}

async function openGlossaryPage(page) {
  await page.goto('/#glossary');
  await expect(page).toHaveURL(/#meetings\?panel=global-glossary$/);
}

async function openLivePage(page) {
  if (page.useMeetingRootForGoto || page.sessionHistoryMode) {
    page.useMockMeetings = true;
    page.useMeetingRootForGoto = true;
    page.sessionHistoryMode = false;
    await page.evaluate(() => { window.location.hash = 'live?meetingId=meeting-1'; });
    await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
    return;
  }
  await page.goto('/#meetings');
  await expect(page).toHaveURL(/#meetings$/);
}

async function gotoMockMeetingLive(page, { sourceLanguageCode, targetLanguageCode } = {}) {
  if (sourceLanguageCode || targetLanguageCode) {
    page.mockMeetingLanguage = {
      sourceLanguageCode: sourceLanguageCode || page.mockMeetingLanguage.sourceLanguageCode,
      targetLanguageCode: targetLanguageCode || page.mockMeetingLanguage.targetLanguageCode
    };
  }
  if (!page.hasMeetingCheckpointMock) await mockMeetingCheckpointApi(page, page.mockMeetingLanguage);
  await page.goto('/#live?meetingId=meeting-1');
  await page.evaluate(() => {
    sessionStorage.setItem('live-translate:meeting-audio:meeting-1', JSON.stringify({
      inputDeviceId: '',
      outputDeviceId: '',
      inputDeviceLabel: '瀏覽器預設麥克風',
      outputDeviceLabel: '瀏覽器預設揚聲器',
      permissionStatus: 'confirmed',
      confirmedAt: new Date().toISOString()
    }));
  });
  await expect(page.locator('h1', { hasText: '即時字幕' })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回會議管理' })).toHaveAttribute('href', '#meetings');
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
}

test('live recording can start while the meeting list is still loading', async ({ page }) => {
  await mockMeetingCheckpointApi(page, { delayMeetingListMs: 500 });
  await page.goto('/#live?meetingId=meeting-1');
  await page.evaluate(() => {
    sessionStorage.setItem('live-translate:meeting-audio:meeting-1', JSON.stringify({
      inputDeviceId: '',
      outputDeviceId: '',
      inputDeviceLabel: '瀏覽器預設麥克風',
      outputDeviceLabel: '瀏覽器預設揚聲器',
      permissionStatus: 'confirmed',
      confirmedAt: new Date().toISOString()
    }));
  });
  await expect(page.getByTestId('live-session-toolbar')).toContainText('測試會議');
  await page.getByRole('button', { name: '開始錄製' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
});

test('recording diagnostics debug API exposes bounded numeric metadata', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await expect.poll(
    () => page.evaluate(() => window.__liveTranslateRecordingDebug?.getSnapshot?.()),
    { timeout: 5000 }
  ).not.toBeUndefined();
  const snapshot = await page.evaluate(() => window.__liveTranslateRecordingDebug.getSnapshot());
  expect(snapshot).toMatchObject({
    chunkCount: 0,
    totalChunkBytes: 0,
    chunkCallbackGapP95Ms: 0,
    upload: null
  });
  expect(JSON.stringify(snapshot)).not.toMatch(/transcript|token|signed.?url|audio bytes/i);
});

test('live recording falls back when AudioWorklet has no callback', async ({ page }) => {
  await page.addInitScript(() => {
    const AudioContextImpl = window.AudioContext;
    window.AudioWorkletNode = class MockAudioWorkletNode {
      constructor() {
        this.port = { onmessage: null };
      }

      connect() {}

      disconnect() {}
    };
    window.AudioContext = class MockWorkletAudioContext extends AudioContextImpl {
      constructor(...args) {
        super(...args);
        this.audioWorklet = { addModule: async () => {} };
      }
    };
  });
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始錄製' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = window.__liveTranslateDebug?.getSnapshot?.();
    return snapshot?.captureProcessorMode;
  }), { timeout: 5000 }).toBe('script');
  const state = await page.evaluate(() => window.__liveTranslateDebug.getSnapshot());
  expect(state.captureEnabled).toBe(true);
  expect(state.failureDiagnostics.at(-1).reasonHint).toBe('audio_worklet_callback_stalled');
  await expect(page.getByText('無法擷取麥克風音訊')).toHaveCount(0);
});

async function emitFinalTranscript(page, sourceText = 'history source', translationText = 'history translation', { waitMs = 750 } = {}) {
  await page.evaluate(
    ({ sourceText, translationText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText },
          turnComplete: true
        }
      });
    },
    { sourceText, translationText }
  );
  await page.waitForTimeout(waitMs);
}

async function emitPartialTranscript(page, sourceText = 'partial source', translationText = 'partial translation') {
  await page.evaluate(
    ({ sourceText, translationText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
    },
    { sourceText, translationText }
  );
}

async function emitInterimInputWithOutput(page, sourceText = 'interim source', translationText = 'interim translation') {
  await page.evaluate(
    ({ sourceText, translationText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          interimInputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
    },
    { sourceText, translationText }
  );
}

async function emitOutputAudio(page, bytes = [1, 0, 255, 127]) {
  await page.evaluate((audioBytes) => {
    const data = btoa(String.fromCharCode(...audioBytes));
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{
            inlineData: {
              data,
              mimeType: 'audio/pcm;rate=24000'
            }
          }]
        }
      }
    });
  }, bytes);
}

async function emitMicrophoneAudio(page, sampleValue = 0.25) {
  await page.evaluate((value) => {
    const processor = window.__mockAudioProcessors.at(-1);
    processor?.onaudioprocess?.({
      inputBuffer: {
        getChannelData() {
          return new Float32Array(1600).fill(value);
        }
      }
    });
  }, sampleValue);
}

function liveResourceDiagnostics() {
  const micTracks = window.__mockMicTracks || [];
  const audioContexts = window.__mockAudioContexts || [];
  const liveSessions = window.__mockGoogleGenAI?.liveSessions || [];

  return {
    micTrackCount: micTracks.length,
    activeMicTrackCount: micTracks.filter((track) => !track.stopped).length,
    audioContextCount: audioContexts.length,
    openAudioContextCount: audioContexts.filter((context) => context.state !== 'closed').length,
    liveSessionCount: liveSessions.length,
    openLiveSessionCount: liveSessions.filter((session) => !session.closed).length
  };
}

async function emitTurnComplete(page) {
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({ serverContent: { turnComplete: true } });
  });
}

test('live recording surface exposes meeting and session controls', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await expect(page.locator('h1', { hasText: '即時字幕' })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回會議管理' })).toHaveAttribute('href', '#meetings');
  await expect(page.getByRole('combobox', { name: '選擇會議' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '設定', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^字典/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '匯出', exact: true })).toHaveCount(0);
  const meetingSettingsButton = page.getByRole('link', { name: '修改會議設定' });
  await expect(meetingSettingsButton).toBeVisible();
  await expect(meetingSettingsButton).toHaveAttribute('href', '#meeting-settings?mode=edit&meetingId=meeting-1');
  await expect(page.locator('.meeting-app-header .live-header-actions').getByRole('link', { name: '修改會議設定' })).toHaveCount(1);
  await expect(page.getByTestId('live-session-toolbar').locator('.live-meeting-summary').getByRole('link', { name: '修改會議設定' })).toHaveCount(0);
  await expect(page.getByTestId('live-session-toolbar').locator('.live-session-status .live-device-summary')).toHaveCount(1);
  await expect(page.getByTestId('live-session-toolbar').locator('.live-meeting-summary .live-device-summary')).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(meetingSettingsButton).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId('live-session-toolbar')).toContainText('準備就緒');
  await page.screenshot({ path: test.info().outputPath('live-control-ready.png'), fullPage: true });

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('live-control-listening.png'), fullPage: true });
  await expect(page.getByRole('button', { name: '暫停' })).toBeVisible();
  await expect(page.getByRole('button', { name: '結束本次工作階段' })).toBeVisible();

  await page.getByRole('button', { name: '暫停' }).click();
  await expect(page.getByLabel('即時字幕狀態：已暫停')).toBeVisible();
  await expect(page.getByRole('button', { name: '繼續' })).toBeVisible();
  await expect(page.getByRole('button', { name: '結束本次工作階段' })).toBeVisible();
});

test('entering live recording from meeting settings loads the selected meeting', async ({ page }) => {
  await page.route('**/api/glossary', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ entries: [] })
  }));

  await page.goto('/#meeting-settings?mode=edit&meetingId=meeting-1');
  await expect(page.getByRole('heading', { name: '基本資訊' })).toBeVisible();

  await page.getByRole('button', { name: '前往即時字幕' }).click();

  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await expect(page.getByTestId('live-session-toolbar')).toContainText('測試會議');
  await expect(page.getByTestId('live-session-toolbar')).not.toContainText('正在載入會議…');
});

test('active recording can return from meeting settings without restarting', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  const initialSessionCount = await page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length);
  const initialTokenRequestCount = page.liveTokenRequests.length;

  await page.getByRole('link', { name: '修改會議設定' }).click();
  await expect(page).toHaveURL(/#meeting-settings\?mode=edit&meetingId=meeting-1$/);
  await page.getByRole('button', { name: '前往即時字幕' }).click();

  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(initialSessionCount);
  expect(page.liveTokenRequests).toHaveLength(initialTokenRequestCount);
});

test('live recording shows a retryable error when meeting detail loading fails', async ({ page }) => {
  await page.route('**/api/meetings/meeting-1', async (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error' } })
  }));

  await page.goto('/#live?meetingId=meeting-1');

  await expect(page.getByRole('alert')).toContainText('會議詳細資料載入失敗。請重試。');
  await expect(page.getByRole('button', { name: '重試' })).toBeVisible();
  await expect(page.getByTestId('live-session-toolbar')).not.toContainText('正在載入會議…');
});

test('live recording shows an actionable unselected meeting state', async ({ page }) => {
  await page.goto('/#live');

  await expect(page.getByTestId('live-session-toolbar')).toContainText('尚未選擇會議');
  await expect(page.getByRole('combobox', { name: '選擇會議' })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('cue-empty-state')).toHaveCount(1);
  await expect(page.getByTestId('cue-empty-state')).toContainText('開始錄音後');
  await page.screenshot({ path: test.info().outputPath('live-control-unselected.png'), fullPage: true });
});

test('global glossary page creates, edits, and deletes entries', async ({ page }) => {
  const requests = [];
  const loadRequests = { entries: 0, categories: 0 };
  let entries = [];
  let categories = [
    { id: 'product', label: '產品名稱' },
    { id: 'department', label: '部門／職能' },
    { id: 'abbreviation', label: '縮寫' },
    { id: 'meeting', label: '會議常用語' },
    { id: 'technical', label: '技術名詞' },
    { id: 'sales', label: '銷售用語' },
    { id: 'legal', label: '法務用語' },
    { id: 'customer', label: '客戶名詞' },
    { id: 'other', label: '其他' }
  ];

  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && url.pathname === '/api/glossary') {
      loadRequests.entries += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/glossary/categories') {
      loadRequests.categories += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ categories })
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/glossary/categories') {
      const body = JSON.parse(request.postData() || '{}');
      const category = { id: 'project', label: body.label };
      categories = [...categories, category];
      requests.push({ method, body });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ category }) });
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/glossary/categories/order') {
      const body = JSON.parse(request.postData() || '{}');
      categories = body.categoryIds.map((id) => categories.find((category) => category.id === id));
      requests.push({ method, body });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories }) });
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/glossary/categories/project') {
      const body = JSON.parse(request.postData() || '{}');
      categories = categories.map((category) => category.id === 'project' ? { ...category, label: body.label } : category);
      requests.push({ method, body });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ category: categories.find((category) => category.id === 'project') }) });
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/glossary/categories/project') {
      categories = categories.filter((category) => category.id !== 'project');
      entries = entries.map((entry) => entry.category === 'project' ? { ...entry, category: 'other' } : entry);
      requests.push({ method });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ category: categories.find((category) => category.id === 'other'), reassignedEntryCount: 0 }) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/glossary/entries') {
      const body = JSON.parse(request.postData() || '{}');
      requests.push({ method, body });
      const entry = { id: 'entry-1', ...body, createdAt: 1000, updatedAt: 1000 };
      entries = [entry];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ entry }) });
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/glossary/entries/entry-1') {
      const body = JSON.parse(request.postData() || '{}');
      requests.push({ method, body });
      const entry = { id: 'entry-1', ...body, createdAt: 1000, updatedAt: 2000 };
      entries = [entry];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entry }) });
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/glossary/entries/entry-1') {
      requests.push({ method });
      const [entry] = entries;
      entries = [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entry }) });
      return;
    }

    await route.fallback();
  });

  await page.goto('/#glossary');
  await expect(page).toHaveURL(/#glossary$/);

  await expect(page.getByRole('heading', { name: '全域字典' })).toBeVisible();
  await expect.poll(() => loadRequests.entries).toBe(1);
  await expect.poll(() => loadRequests.categories).toBe(1);
  await page.waitForTimeout(100);
  expect(loadRequests).toEqual({ entries: 1, categories: 1 });
  const glossary = page.locator('.global-glossary');
  await expect(glossary.locator('.global-glossary-filter-row').getByLabel('分類')).toHaveCount(0);
  await expect(glossary.locator('.glossary-category-sidebar').getByRole('button', { name: /全部分類/ })).toHaveClass(/is-active/);
  await expect(glossary.locator('.glossary-category-sidebar > button')).toHaveCount(9);
  await glossary.getByRole('button', { name: '更多分類' }).click();
  await expect(glossary.locator('.glossary-category-more-menu')).toContainText('客戶名詞');
  await glossary.locator('.glossary-category-more-menu').getByRole('menuitem', { name: /客戶名詞/ }).click();
  await glossary.locator('.glossary-category-sidebar').getByRole('button', { name: /全部分類/ }).click();
  await glossary.getByRole('button', { name: '管理分類' }).click();
  const categoryDialog = page.getByRole('dialog', { name: '管理分類' });
  const categoryCloseButton = categoryDialog.getByRole('button', { name: '關閉分類管理' });
  await expect(categoryCloseButton).toHaveCSS('width', '44px');
  await expect(categoryCloseButton).toHaveCSS('height', '44px');
  await categoryDialog.getByRole('searchbox').fill('法務');
  await expect(categoryDialog.locator('.category-management-row')).toHaveCount(1);
  await categoryDialog.getByRole('searchbox').fill('');
  await categoryDialog.getByRole('textbox').fill('專案名詞');
  await categoryDialog.getByRole('button', { name: '新增分類' }).click();
  await expect(categoryDialog.locator('.category-management-row')).toHaveCount(10);
  await categoryDialog.getByRole('button', { name: '上移 專案名詞' }).click();
  await expect(categoryDialog.locator('.category-management-row').nth(8)).toContainText('專案名詞');
  expect(requests.filter((request) => request.method === 'PUT' && request.body?.categoryIds).length).toBe(1);
  const projectRow = categoryDialog.locator('.category-management-row').filter({ hasText: '專案名詞' });
  await projectRow.getByRole('button', { name: '編輯' }).click();
  await categoryDialog.getByRole('textbox').fill('專案詞彙');
  await categoryDialog.getByRole('button', { name: '儲存名稱' }).click();
  await expect(categoryDialog.locator('.category-management-row').filter({ hasText: '專案詞彙' })).toHaveCount(1);
  await categoryDialog.getByRole('button', { name: '關閉分類管理' }).click();
  await expect(page.getByText('無法更新分類順序。')).toHaveCount(0);
  await glossary.getByRole('button', { name: '新增詞條' }).click();
  const dialog = page.getByRole('dialog', { name: '新增詞條' });
  await dialog.getByLabel('原文字詞').fill('microphone');
  await dialog.getByLabel('翻譯語言').selectOption('ja');
  await dialog.getByLabel('翻譯內容：ja').fill('Alan speak');
  await dialog.getByLabel('分類').selectOption('project');
  await dialog.getByLabel('標籤（以逗號分隔）').fill('audio, product');
  await expect(dialog.getByText('套用範圍')).toHaveCount(0);
  await expect(dialog.locator('select')).toHaveCount(3);
  await expect.poll(() => dialog.locator('select').evaluateAll((selects) => selects.map((select) => getComputedStyle(select).height))).toEqual(['56px', '56px', '56px']);
  await expect(dialog.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '新增全域詞條' })).toBeVisible();
  await dialog.getByRole('button', { name: '新增全域詞條' }).click();
  await expect(glossary.locator('.glossary-card').first()).toContainText('microphone');
  await expect(glossary.locator('.glossary-card').first()).toContainText('Alan speak');

  const selectAllButton = glossary.getByRole('button', { name: '全選目前結果' });
  await expect(selectAllButton).toHaveAttribute('aria-pressed', 'false');
  await selectAllButton.click();
  await expect(selectAllButton).toHaveText('取消全選目前結果');
  await expect(selectAllButton).toHaveAttribute('aria-pressed', 'true');
  await expect(glossary.getByRole('button', { name: '取消選取' })).toHaveCount(0);
  await expect(glossary.locator('.glossary-card-topline > input[type="checkbox"]')).toBeChecked();
  await selectAllButton.click();
  await expect(glossary.getByRole('button', { name: '全選目前結果' })).toHaveAttribute('aria-pressed', 'false');
  await expect(glossary.locator('.glossary-card-topline > input[type="checkbox"]')).not.toBeChecked();

  await glossary.locator('.glossary-card').first().click();
  await expect(page.getByRole('dialog', { name: '編輯詞條' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '編輯詞條' })).toHaveCount(0);

  await glossary.locator('.glossary-card').first().click();
  const editDialog = page.getByRole('dialog', { name: '編輯詞條' });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(editDialog.getByRole('button', { name: '儲存變更' })).toBeVisible();
  await editDialog.getByRole('button', { name: '儲存變更' }).click();

  page.once('dialog', (dialog) => dialog.accept());
  await glossary.locator('.glossary-card').first().click();
  await page.getByRole('dialog', { name: '編輯詞條' }).getByRole('button', { name: '刪除詞條' }).click();
  await expect(glossary.locator('.glossary-empty')).toBeVisible();
  await expect(glossary.getByRole('button', { name: '全選目前結果' })).toBeDisabled();

  await glossary.getByRole('button', { name: '管理分類' }).click();
  const finalCategoryDialog = page.getByRole('dialog', { name: '管理分類' });
  page.once('dialog', (dialog) => dialog.accept());
  await finalCategoryDialog.locator('.category-management-row').filter({ hasText: '專案詞彙' }).getByRole('button', { name: '刪除' }).click();
  await expect(finalCategoryDialog.locator('.category-management-row')).toHaveCount(9);
  await finalCategoryDialog.getByRole('button', { name: '關閉分類管理' }).click();

  expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'PUT', 'POST', 'PUT', 'DELETE', 'DELETE']);
  expect(requests[0].body.label).toBe('專案名詞');
  expect(requests[1].body.categoryIds[8]).toBe('project');
  expect(requests[2].body.label).toBe('專案詞彙');
  expect(requests[3].body.scope).toBe('live');
  expect(requests[3].body.category).toBe('project');
  expect(requests[3].body.source).toBe('microphone');
  expect(requests[3].body.tags).toEqual(['audio', 'product']);
  expect(requests[4].body.scope).toBe('live');
});

test('global glossary batch updates selected entries sequentially', async ({ page }) => {
  const entries = [
    { id: 'entry-1', source: '產品名稱', sourceLanguageCode: 'zh-Hant', translations: { en: 'Product name' }, category: 'product', tags: [], enabled: true },
    { id: 'entry-2', source: '會議術語', sourceLanguageCode: 'zh-Hant', translations: { en: 'Meeting term' }, category: 'meeting', tags: [], enabled: true }
  ];
  const categories = [
    { id: 'product', label: '產品名稱' },
    { id: 'meeting', label: '會議常用語' },
    { id: 'other', label: '其他' }
  ];
  const updates = [];
  let updateInFlight = false;

  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/glossary') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/glossary/categories') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories }) });
      return;
    }
    if (request.method() === 'PUT' && url.pathname.startsWith('/api/glossary/entries/')) {
      if (updateInFlight) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Concurrent update' } }) });
        return;
      }
      updateInFlight = true;
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const body = JSON.parse(request.postData() || '{}');
      updates.push({ id, body });
      await new Promise((resolve) => setTimeout(resolve, 20));
      updateInFlight = false;
      const entry = { ...entries.find((item) => item.id === id), ...body, updatedAt: Date.now() };
      entries.splice(entries.findIndex((item) => item.id === id), 1, entry);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entry }) });
      return;
    }
    await route.fallback();
  });

  await page.goto('/#glossary');
  const glossary = page.locator('.global-glossary');
  await expect(glossary.locator('.glossary-card')).toHaveCount(2);
  await glossary.getByRole('button', { name: '全選目前結果' }).click();
  await glossary.getByRole('button', { name: '批次停用' }).click();
  await expect.poll(() => updates.length).toBe(2);
  expect(updates.map(({ id, body }) => [id, body.enabled])).toEqual([['entry-1', false], ['entry-2', false]]);
  await expect(glossary.locator('.glossary-status.is-disabled')).toHaveCount(2);

  await glossary.getByRole('button', { name: '全選目前結果' }).click();
  await glossary.getByRole('button', { name: '批次啟用' }).click();
  await expect.poll(() => updates.length).toBe(4);
  expect(updates.slice(2).map(({ id, body }) => [id, body.enabled]).sort()).toEqual([['entry-1', true], ['entry-2', true]]);
  await expect(glossary.locator('.glossary-status:not(.is-disabled)')).toHaveCount(2);
});

test('global glossary import explains the format and applies selected settings', async ({ page }) => {
  const importRequests = [];
  const categories = [
    { id: 'product', label: '產品名稱' },
    { id: 'project', label: '專案' },
    { id: 'other', label: '其他' }
  ];

  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/glossary') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/glossary/categories') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories }) });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/glossary/import/preview') {
      const body = JSON.parse(request.postData() || '{}');
      importRequests.push({ type: 'preview', body });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          baseRevision: 'revision-1',
          summary: { total: 2, valid: 1, invalid: 1, creates: 1, updates: 0, duplicates: 0 },
          rows: [
            { rowNumber: 2, status: 'create', entry: { source: '產品名稱', sourceLanguageCode: body.sourceLanguageCode, translations: { [body.targetLanguageCode]: 'Product name' }, category: body.category }, conflict: null, errors: [] },
            { rowNumber: 3, status: 'invalid', entry: { source: '缺少翻譯' }, conflict: null, errors: ['Translation is required.'] }
          ]
        })
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/glossary/import') {
      const body = JSON.parse(request.postData() || '{}');
      importRequests.push({ type: 'commit', body });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ createdCount: 1, updatedCount: 0, skippedCount: 0, total: 1 }) });
      return;
    }
    await route.fallback();
  });

  await page.goto('/#glossary');
  const glossary = page.locator('.global-glossary');
  await glossary.getByRole('button', { name: '匯入字典' }).click();
  const helpDialog = page.getByRole('dialog', { name: '匯入字典' });
  await expect(helpDialog).toContainText('source,translation');
  await expect(helpDialog).toContainText('entries');
  await expect(helpDialog).toContainText('XLSX');
  await expect(helpDialog).toContainText('會議室');
  await expect(helpDialog).toContainText('翻譯結果');

  await glossary.locator('#global-glossary-import-file').setInputFiles({
    name: 'terms.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('test xlsx content')
  });
  const previewDialog = page.getByRole('dialog', { name: /預覽匯入/ });
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.locator('.import-entry-preview').first()).toHaveText('產品名稱→Product name');
  await expect(previewDialog.locator('.import-entry-arrow').first()).toHaveText('→');
  const firstImportRow = previewDialog.locator('.glossary-import-row').first();
  const entryPreviewBox = await firstImportRow.locator('.import-entry-preview').boundingBox();
  const rowStatusBox = await firstImportRow.locator(':scope > span').boundingBox();
  expect(entryPreviewBox?.x).toBeLessThan(rowStatusBox?.x ?? Number.POSITIVE_INFINITY);
  await previewDialog.getByLabel('來源語言').selectOption('en');
  await expect.poll(() => importRequests.filter((request) => request.type === 'preview').at(-1)?.body).toMatchObject({ sourceLanguageCode: 'en', targetLanguageCode: 'en', category: 'other' });
  await previewDialog.getByLabel('目標語言').selectOption('ja');
  await expect.poll(() => importRequests.filter((request) => request.type === 'preview').at(-1)?.body).toMatchObject({ sourceLanguageCode: 'en', targetLanguageCode: 'ja', category: 'other' });
  await previewDialog.getByLabel('分類').selectOption('project');
  await expect.poll(() => importRequests.filter((request) => request.type === 'preview').at(-1)?.body).toMatchObject({ sourceLanguageCode: 'en', targetLanguageCode: 'ja', category: 'project' });
  await expect(previewDialog.getByLabel('選取第 2 列')).toBeChecked();
  await expect(previewDialog.getByLabel('選取第 3 列')).not.toBeChecked();
  await expect(previewDialog.getByLabel('選取第 3 列')).toBeDisabled();
  await previewDialog.getByRole('button', { name: '確認匯入' }).click();
  await expect.poll(() => importRequests.find((request) => request.type === 'commit')?.body).toMatchObject({ sourceLanguageCode: 'en', targetLanguageCode: 'ja', category: 'project', selectedRows: [2] });
});

test('global glossary cards use responsive desktop, tablet, and mobile columns', async ({ page }) => {
  const entries = [
    { id: 'entry-1', source: '產品名稱', sourceLanguageCode: 'zh-Hant', translations: { en: 'Product name' }, category: 'product', tags: [], enabled: true },
    { id: 'entry-2', source: '會議術語', sourceLanguageCode: 'zh-Hant', translations: { en: 'Meeting term' }, category: 'meeting', tags: [], enabled: true },
    { id: 'entry-3', source: '技術名詞', sourceLanguageCode: 'zh-Hant', translations: { en: 'Technical term' }, category: 'technical', tags: [], enabled: true },
    { id: 'entry-4', source: '其他詞彙', sourceLanguageCode: 'zh-Hant', translations: { en: 'Other term' }, category: 'other', tags: [], enabled: true }
  ];
  const categories = [
    { id: 'product', label: '產品名稱' },
    { id: 'meeting', label: '會議常用語' },
    { id: 'technical', label: '技術名詞' },
    { id: 'other', label: '其他' }
  ];

  await page.route('**/api/glossary**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/glossary/categories') {
      await route.fulfill({ json: { categories } });
      return;
    }
    await route.fulfill({ json: { entries } });
  });

  const columnCount = () => page.locator('.glossary-card-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  const cardRegionFits = () => page.locator('.glossary-card-region').evaluate((region) => region.scrollWidth <= region.clientWidth);

  for (const [width, expectedColumns] of [[1440, 4], [1280, 3], [1024, 2], [760, 1]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#glossary');
    await expect(page.locator('.glossary-card-grid')).toBeVisible();
    await expect.poll(columnCount).toBe(expectedColumns);
    await expect.poll(cardRegionFits).toBe(true);
    if (width <= 760) {
      await expect(page.locator('.glossary-category-sidebar')).toBeHidden();
      await expect(page.locator('.glossary-mobile-category')).toBeVisible();
    } else {
      await expect(page.locator('.glossary-category-sidebar')).toBeVisible();
      await expect(page.locator('.glossary-mobile-category')).toBeHidden();
    }
  }
});

test.skip('live translation meeting glossary is read-only', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'meeting-glossary', name: '字典會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }])
    });
  });
  await page.route('**/api/meetings/meeting-glossary', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: {
          id: 'meeting-glossary',
          name: '字典會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en',
          glossaryEntries: [{ source: 'microphone', target: 'Mic' }]
        }
      })
    });
  });
  await page.route('**/api/glossary', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [{ id: 'entry-live', source: 'microphone', translations: { en: 'Mic' }, scope: 'live' }] })
    });
  });

  await page.goto('/#live?meetingId=meeting-glossary');
  await page.getByRole('button', { name: /^字典/ }).click();

  const drawer = page.getByRole('complementary', { name: '本次翻譯字典' });
  await expect(drawer.getByText('這些詞條來自會議建立設定；如需修改，請回會議管理。')).toBeVisible();
  await expect(drawer.getByRole('checkbox')).toBeDisabled();
  await expect(drawer.locator('.glossary-quick-add')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '回會議管理修改' })).toBeVisible();
});

test('active session locks workspace navigation while listening', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'meeting-1', name: '錄音鎖定測試會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }])
    });
  });
  await page.route('**/api/meetings/meeting-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: { id: 'meeting-1', name: '錄音鎖定測試會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', glossaryEntries: [] },
        segments: []
      })
    });
  });
  await page.route('**/api/meetings/meeting-1/segments/segment-1/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: { id: 'meeting-1', name: '錄音鎖定測試會議', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
        segment: { id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'active', liveSessionId: 'live-session-1' }
      })
    });
  });

  await page.goto('/#live?meetingId=meeting-1');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await expect(page.locator('.history-page')).toHaveCount(0);
  await expect(page.locator('.live-sidebar, .feature-navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回會議管理' })).toHaveAttribute('href', '#meetings');
});

test('active recording blocks settings and management navigation', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.getByRole('link', { name: '修改會議設定' }).click();
  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await expect(page.getByRole('alert')).toContainText('請先暫停或停止目前錄音');

  await page.getByRole('link', { name: '返回會議管理' }).click();
  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await expect(page.getByRole('alert')).toContainText('請先暫停或停止目前錄音');
});

test('paused recording can open settings and return without resetting', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.getByRole('button', { name: '暫停' }).click();
  await expect(page.getByLabel('即時字幕狀態：已暫停')).toBeVisible();
  const sessionCount = await page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length);
  const tokenCount = page.liveTokenRequests.length;

  await page.getByRole('link', { name: '修改會議設定' }).click();
  await expect(page).toHaveURL(/#meeting-settings\?mode=edit&meetingId=meeting-1$/);
  await page.getByRole('button', { name: '前往即時字幕' }).click();

  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await expect(page.getByLabel('即時字幕狀態：已暫停')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(sessionCount);
  expect(page.liveTokenRequests).toHaveLength(tokenCount);
});

test('direct URL navigation force-stops active recording before leaving', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#meeting-settings?mode=edit&meetingId=meeting-1'; });

  await expect(page).toHaveURL(/#meeting-settings\?mode=edit&meetingId=meeting-1$/);
  await expect.poll(() => page.evaluate(liveResourceDiagnostics)).toEqual({
    micTrackCount: 1,
    activeMicTrackCount: 0,
    audioContextCount: 1,
    openAudioContextCount: 0,
    liveSessionCount: 1,
    openLiveSessionCount: 0
  });
});

test('recording stays disabled until checkpoint recovery finishes', async ({ page }) => {
  let resolveSegmentList;
  const segmentListLoaded = new Promise((resolve) => {
    resolveSegmentList = resolve;
  });
  await mockMeetingCheckpointApi(page, { waitForSegmentList: () => segmentListLoaded });

  await page.goto('/#live?meetingId=meeting-1');
  const preparingButton = page.getByRole('button', { name: '正在準備會議…' });
  await expect(preparingButton).toBeDisabled();

  resolveSegmentList();

  await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
});

test('missing microphone keeps a retryable error visible', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'session-1',
          name: '測試會議',
          meetingId: 'meeting-1',
          segmentId: 'segment-1',
          status: 'created',
          targetLanguageCode: 'en',
          sourceLanguageCode: 'zh-Hant'
        }
      })
    });
  });
  await page.goto('/#settings');
  await page.getByRole('textbox', { name: 'Gemini API Key' }).fill('test-api-key');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await page.evaluate(() => {
    window.__mockMissingMicrophone = true;
    sessionStorage.setItem('live-translate:meeting-audio:meeting-1', JSON.stringify({
      inputDeviceId: '',
      outputDeviceId: '',
      inputDeviceLabel: '瀏覽器預設麥克風',
      outputDeviceLabel: '瀏覽器預設揚聲器',
      permissionStatus: 'confirmed',
      confirmedAt: new Date().toISOString()
    }));
    window.location.hash = '#live?meetingId=meeting-1';
  });
  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);
  await page.getByRole('button', { name: '開始錄製' }).click();

  await expect(page.getByRole('alert')).toHaveText('找不到可用的麥克風。請連接或允許麥克風後再試一次。');
  await expect(page.locator('.status-pill').getByText('需要處理', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  await expect.poll(() => page.liveTokenRequests.length).toBe(0);
  await expect(page.getByRole('alert')).toHaveText('找不到可用的麥克風。請連接或允許麥克風後再試一次。');
  await expect(page.locator('.status-pill').getByText('需要處理', { exact: true })).toBeVisible();
  await expect(page.locator('.live-error-message')).toHaveCSS('padding-top', '8px');
  await expect(page.locator('.live-error-message')).toHaveCSS('padding-bottom', '8px');

  await page.getByRole('link', { name: '返回會議管理' }).click();
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('missing Gemini API Key is shown before live recording starts', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  const startButton = page.locator('button.meeting-live-action-button').first();
  await expect(page.getByRole('status')).toContainText('錄音者必須輸入 Gemini API Key');
  await expect(page.getByLabel('Gemini API Key')).toBeVisible();
  await page.getByLabel('Gemini API Key').fill('test-api-key');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(startButton).toBeEnabled();
  await expect.poll(() => page.liveTokenRequests.length).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.length)).toBe(0);
});

test('meeting management errors use content height', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '會議清單暫時無法載入。' } })
    });
  });

  await page.goto('/#meetings');

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('無法載入會議或字典資料。');
  const box = await alert.boundingBox();
  expect(box?.height).toBeLessThan(120);
});

test('starts and stops a mocked Gemini Live translation session', async ({ page }) => {
  page.liveGlossaryEntries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }
  ];
  await gotoMockMeetingLive(page);

  await expect(page.locator('h1', { hasText: '即時字幕' })).toBeVisible();
  await expect(page.getByText('準備就緒')).toBeVisible();
  await expect(page.getByText('會議模式：尚未啟用', { exact: true })).toBeVisible();
  await expect(page.getByText('會議模式：尚未保存', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/尚無可下載/)).toHaveCount(0);

  await page.getByRole('button', { name: '開始' }).click();

  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__mockGoogleGenAI?.liveConnects.length || 0))
    .toBe(1);
  expect(page.liveTokenRequests[0]).toEqual({
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    echoTargetLanguage: true,
    sessionId: expect.any(String),
    meetingId: 'meeting-1'
  });

  const liveConnect = await page.evaluate(() => {
    const request = window.__mockGoogleGenAI.liveConnects[0];
    return {
      model: request.model,
      targetLanguageCode: request.config.generationConfig.translationConfig.targetLanguageCode,
      responseModalities: request.config.responseModalities
    };
  });
  expect(liveConnect).toEqual({
    model: 'gemini-live-e2e-model',
    targetLanguageCode: 'en',
    responseModalities: ['AUDIO']
  });
  await emitPartialTranscript(page, '麥克風', 'microphone and mic');
  await emitMicrophoneAudio(page);
  await emitOutputAudio(page);
  await expect(page.getByTestId('background-translation-notice')).toHaveCount(0);
  await expect(partialCueRows(page)).toHaveCount(1);
  await expectCueRow(partialCueRows(page).first(), {
    sourceText: '麥克風',
    translatedText: 'Alan speak and Alan speak'
  });

  await page.getByRole('button', { name: '結束本次工作階段' }).click();

  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect(page.getByText('未錄製講者原音。')).toHaveCount(0);
  await expect(page.getByText('翻譯語音：音檔已保存，請到翻譯紀錄下載。')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockMediaRecorders.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.every((track) => track.stopped))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].closed)).toBe(true);

});

test('ending a live recording returns to meeting management', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await mockSingleMeetingList(page);
  await page.goto('/#live?meetingId=meeting-1');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.getByRole('button', { name: '結束本次工作階段' }).click();

  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();
});

test('captures and drains first speech while provider connect is delayed', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);
  await page.evaluate(() => { window.__mockLiveConnectDelayMs = 8000; });
  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length), { timeout: 12000 }).toBe(1);
  expect(await page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(0);

  await emitMicrophoneAudio(page);
  await expect.poll(() => page.evaluate(() => window.__liveTranslateDebug.getSnapshot().preRollBufferedChunkCount)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length), { timeout: 12000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].sentInputs.length), { timeout: 12000 }).toBe(1);
  await expect(page.getByText('聆聽中')).toBeVisible();

  const snapshot = await page.evaluate(() => window.__liveTranslateDebug.getSnapshot());
  expect(snapshot.pcmGeneratedCount).toBe(1);
  expect(snapshot.pcmSendAttemptCount).toBe(1);
  expect(snapshot.preRollBufferedChunkCount).toBe(0);

  await emitFinalTranscript(page, 'delayed first source', 'delayed first translation');
  await expect(page.getByText('delayed first source')).toBeVisible();
  await expect(page.getByText('delayed first translation')).toBeVisible();
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
});

test('keeps capturing while a continuous turn emits many partial transcript updates', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.evaluate(() => {
    const liveSession = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (let index = 0; index < 250; index += 1) {
      liveSession.emitMessage({
        serverContent: {
          inputTranscription: { text: `連續說話原文 ${index}` },
          outputTranscription: { text: `continuous translation ${index}` }
        }
      });
    }
  });

  await page.waitForTimeout(50);
  await expectCueRow(partialCueRows(page).first(), {
    sourceText: '連續說話原文 249',
    translatedText: 'continuous translation 249'
  });
  await expect.poll(() => page.evaluate(() => window.__liveTranslateDebug.getSnapshot().pcmSendAttemptCount)).toBe(1);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
});

test('renders one row when the same live transcript is received by transcript and Cue pipelines', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: '你好，你好。' },
        turnComplete: true
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(page.getByTestId('cue-recovery-fallback')).toHaveCount(0);
  await expectCueRow(finalCueRows(page).first(), { sourceText: '你好，你好。' });
});

test('renders two separate Cues for two consecutive sentences', async ({ page }) => {
  const cueLogs = [];
  page.on('console', (message) => {
    if (message.type() === 'debug' && /Cue decision|Cue state transition/u.test(message.text())) cueLogs.push(message.text());
  });
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitFinalTranscript(page, '第一句測試。', 'First sentence.');
  await expect(finalCueRows(page)).toHaveCount(1);
  await emitFinalTranscript(page, '第二句測試。', 'Second sentence.');

  await expect(finalCueRows(page)).toHaveCount(2);
  await expectCueRow(finalCueRows(page).nth(0), { sourceText: '第一句測試。', translatedText: 'First sentence.' });
  await expectCueRow(finalCueRows(page).nth(1), { sourceText: '第二句測試。', translatedText: 'Second sentence.' });
  const cueIds = await finalCueRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-cue-id')));
  expect(cueIds).toHaveLength(2);
  expect(cueIds[0]).toMatch(/^cue:session-[^:]+:segment-1:1$/u);
  expect(cueIds[1]).toMatch(/^cue:session-[^:]+:segment-1:2$/u);
  expect(new Set(cueIds).size).toBe(2);
  expect(cueLogs.some((log) => log.includes('same-turn-final'))).toBe(false);
  expect(cueLogs.some((log) => log.includes('duplicate') || log.includes('already-finalized'))).toBe(false);
  console.log(`[two-cue-browser] ${JSON.stringify({ cueIds, cueLogs })}`);
});

test('keeps numeric tail fragments in the live subtitle', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const liveSession = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (const text of ['測試', '測試測試', '123', '3']) {
      liveSession.emitMessage({ serverContent: { inputTranscription: { text } } });
    }
  });

  await expectCueRow(partialCueRows(page).first(), { sourceText: '測試測試123' });
});

test('keeps page fixed while the live subtitle list scrolls independently', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const liveSession = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (let index = 0; index < 30; index += 1) {
      liveSession.emitMessage({
        serverContent: {
          turnIndex: index,
          inputTranscription: { text: `版面測試原文 ${index}` },
          outputTranscription: { text: `layout test translation ${index}` },
          turnComplete: true
        }
      });
    }
  });

  await expect.poll(() => page.evaluate(() => {
    const list = document.querySelector('[data-testid="cue-list"]');
    return {
      pageScrollable: document.scrollingElement.scrollHeight > window.innerHeight,
      listScrollable: list ? list.scrollHeight > list.clientHeight : false
    };
  })).toEqual({ pageScrollable: false, listScrollable: true });

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
});

test('pause and resume drains first speech from the replacement pre-roll', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.getByRole('button', { name: '暫停' }).click();
  await expect(page.locator('.status-pill').getByText('已暫停', { exact: true })).toBeVisible();

  await page.evaluate(() => { window.__mockLiveConnectDelayMs = 1000; });
  await page.getByRole('button', { name: '繼續' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(2);
  await emitMicrophoneAudio(page);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[1].sentInputs.length)).toBe(1);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitFinalTranscript(page, 'resume first source', 'resume first translation');
  await expect(page.getByText('resume first source')).toBeVisible();
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
});

test('pause preserves a pending subtitle received immediately before pause', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitPartialTranscript(page, 'pause pending source', 'pause pending translation');

  await page.getByRole('button', { name: '暫停' }).click();

  await expect(page.locator('.status-pill').getByText('已暫停', { exact: true })).toBeVisible();
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'pause pending source',
    translatedText: 'pause pending translation'
  });
});

test.skip('microphone recording error does not stop live translation', async ({ page }) => {
  await page.goto('/');

  await (await liveSetting(page, '錄下原始聲音')).check();
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.evaluate(() => {
    window.__mockMediaRecorders.at(-1).emitError('recording unavailable');
  });

  await expect(page.getByText('recording unavailable')).toBeVisible();
  await expect(page.locator('.status-pill').getByText('聆聽中', { exact: true })).toBeVisible();
  await emitFinalTranscript(page, 'recording failed source', 'recording failed translation');
  await expect(page.getByText('recording failed source')).toBeVisible();
});

test('live session creates a meeting checkpoint and flushes final chunks on Stop', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('會議模式：準備中')).toBeVisible();

  await emitPartialTranscript(page, 'checkpoint source', 'checkpoint translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();

  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '繼續錄製' })).toBeHidden();
  await expect.poll(() => checkpointRequests.length).toBe(1);
  expect(checkpointRequests[0].pendingPartial).toBeNull();
  expect(checkpointRequests[0].durableChunks.map(({ meetingId, segmentId, stream, sequence, text }) => ({
    meetingId,
    segmentId,
    stream,
    sequence,
    text
  }))).toEqual([
    { meetingId: 'meeting-1', segmentId: 'segment-1', stream: 'source', sequence: 1, text: 'checkpoint source' },
    { meetingId: 'meeting-1', segmentId: 'segment-1', stream: 'translation', sequence: 2, text: 'checkpoint translation' }
  ]);
  await expect(page.getByText('會議模式：已保存')).toBeVisible();
});

test('long meeting proactively switches through three segments and preserves confirmed transcript', async ({ page }) => {
  await page.addInitScript(() => {
    window.__liveTranslateSegmentSwitchIntervalMs = 700;
  });
  const checkpointRequests = await mockMeetingCheckpointApi(page);

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitFinalTranscript(page, 'segment one source', 'segment one translation', { waitMs: 100 });
  await expect.poll(() => checkpointRequests.rolloverRequests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(2);
  await expect(page.locator('.status-pill').getByText('下一段已開始', { exact: true })).toBeVisible();
  await expect(page.getByText('保存狀態：長會議已保存 1 段 · 目前段落 0 筆')).toBeVisible();

  await emitFinalTranscript(page, 'segment two source', 'segment two translation', { waitMs: 100 });
  await expect.poll(() => checkpointRequests.rolloverRequests.length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(3);
  await expect(page.getByText('保存狀態：長會議已保存 2 段 · 目前段落 0 筆')).toBeVisible();

  await emitFinalTranscript(page, 'segment three source', 'segment three translation', { waitMs: 100 });
  await expect(page.getByText('保存狀態：長會議已保存 2 段 · 目前段落 2 筆')).toBeVisible();
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(liveResourceDiagnostics)).toEqual({
    micTrackCount: 3,
    activeMicTrackCount: 0,
    audioContextCount: 3,
    openAudioContextCount: 0,
    liveSessionCount: 3,
    openLiveSessionCount: 0
  });
  await page.waitForTimeout(900);
  expect(checkpointRequests.rolloverRequests).toHaveLength(2);

  expect(checkpointRequests.rolloverRequests.map((request) => request.currentSegmentId)).toEqual(['segment-1', 'segment-2']);
  expect(checkpointRequests.rolloverRequests.map((request) => request.body.nextLiveSessionId)).toEqual([
    expect.stringMatching(/^live-session-/),
    expect.stringMatching(/^live-session-/)
  ]);
  expect(checkpointRequests.flatMap((request) => request.durableChunks.map(({ segmentId, text }) => ({ segmentId, text })))).toEqual([
    { segmentId: 'segment-1', text: 'segment one source' },
    { segmentId: 'segment-1', text: 'segment one translation' },
    { segmentId: 'segment-2', text: 'segment two source' },
    { segmentId: 'segment-2', text: 'segment two translation' },
    { segmentId: 'segment-3', text: 'segment three source' },
    { segmentId: 'segment-3', text: 'segment three translation' }
  ]);
  await expect(page.getByText('segment one source')).toBeVisible();
  await expect(page.getByText('segment two source')).toBeVisible();
  await expect(page.getByText('segment three source')).toBeVisible();
});

test('long meeting accelerated 130 minute schedule creates 13 segments without waiting', async ({ page }) => {
  await page.addInitScript(() => {
    window.__liveTranslateSegmentSwitchIntervalMs = 700;
  });
  const checkpointRequests = await mockMeetingCheckpointApi(page);

  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  for (let index = 0; index < 12; index += 1) {
    await emitFinalTranscript(page, `soak segment ${index + 1} source`, `soak segment ${index + 1} translation`, { waitMs: 250 });
    await expect.poll(() => checkpointRequests.rolloverRequests.length, { timeout: 7000 }).toBe(index + 1);
    await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(index + 2);
  }

  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(13);
  await emitFinalTranscript(page, 'soak segment 13 source', 'soak segment 13 translation', { waitMs: 100 });
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();

  await expect.poll(() => page.evaluate(liveResourceDiagnostics)).toEqual({
    micTrackCount: 13,
    activeMicTrackCount: 0,
    audioContextCount: 13,
    openAudioContextCount: 0,
    liveSessionCount: 13,
    openLiveSessionCount: 0
  });
  expect(checkpointRequests.rolloverRequests).toHaveLength(12);
  expect(checkpointRequests.rolloverRequests.map((request) => request.currentSegmentId)).toEqual(
    Array.from({ length: 12 }, (_, index) => `segment-${index + 1}`)
  );
  expect(new Set(checkpointRequests.rolloverRequests.map((request) => request.body.nextLiveSessionId)).size).toBe(12);
  expect(checkpointRequests.flatMap((request) => request.durableChunks.map(({ segmentId, text }) => ({ segmentId, text })))).toEqual(
    Array.from({ length: 13 }, (_, index) => [
      { segmentId: `segment-${index + 1}`, text: `soak segment ${index + 1} source` },
      { segmentId: `segment-${index + 1}`, text: `soak segment ${index + 1} translation` }
    ]).flat()
  );
});

test('checkpoint sync failure keeps the live session active and shows retryable status', async ({ page }) => {
  await mockMeetingCheckpointApi(page, { failCheckpoint: true });

  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'sync failure source', 'sync failure translation');

  await expect(page.getByText('會議模式：保存失敗，等待重試')).toBeVisible({ timeout: 6500 });
  await expect(page.locator('.status-pill').getByText('聆聽中', { exact: true })).toBeVisible();
  await expect(page.locator('.error-message')).toContainText('長會議同步暫時失敗');
});

test('stop error banner stays above the live workspace', async ({ page }) => {
  await mockMeetingCheckpointApi(page, { failCheckpoint: true });
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'stop error source', 'stop error translation');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.getByTestId('live-session-toolbar')).toBeVisible();
  const errorBanner = page.getByRole('alert').filter({ hasText: '長會議同步尚未完成' });
  await expect(errorBanner).toBeVisible();

  const errorBox = await errorBanner.boundingBox();
  const workspaceBox = await page.getByTestId('live-session-toolbar').boundingBox();
  expect(errorBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(workspaceBox.y);
  expect(workspaceBox.y - (errorBox.y + errorBox.height)).toBeLessThanOrEqual(16);
});

test('checkpoint sync retries a temporary failure and clears the error after success', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page, { failCheckpointAttempts: 1 });

  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'retry source', 'retry translation');

  await expect.poll(() => checkpointRequests.length, { timeout: 12000 }).toBe(2);
  await expect(page.getByText('會議模式：已保存')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '長會議同步' })).toBeHidden();
});

test('existing meeting subtitles render before checkpoint load', async ({ page }) => {
  const existingCue = {
    cueId: 'cue:session-existing:segment-1:1',
    sessionId: 'session-existing',
    segmentId: 'segment-1',
    sequence: 1,
    startTimeMs: 1000,
    endTimeMs: 2500,
    status: 'final',
    sourceText: '既有字幕原文',
    translatedText: 'Existing subtitle translation',
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en'
  };
  let releaseSegmentList;
  const segmentListReady = new Promise((resolve) => { releaseSegmentList = resolve; });
  const checkpointRequests = await mockMeetingCheckpointApi(page, {
    meetingDetailCues: [existingCue],
    waitForSegmentList: () => segmentListReady
  });

  await gotoMockMeetingLive(page);
  const row = cueRow(page, existingCue.cueId);
  await expect(row).toBeVisible({ timeout: 3000 });
  await expectCueRow(row, {
    sourceText: existingCue.sourceText,
    translatedText: existingCue.translatedText
  });
  expect(checkpointRequests).toHaveLength(0);

  releaseSegmentList();
  await expect(row).toBeVisible();
  await expectCueRow(row, {
    sourceText: existingCue.sourceText,
    translatedText: existingCue.translatedText
  });
  expect(checkpointRequests).toHaveLength(0);
});

test('reload with meeting id restores checkpoint and allows manual resume', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await page.route('**/api/sessions/*', async (route) => {
    if (['PATCH', 'PUT'].includes(route.request().method())) {
      const sessionId = new URL(route.request().url()).pathname.split('/').at(-1);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session: { id: sessionId, status: 'active' } })
      });
      return;
    }
    await route.fallback();
  });
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page).toHaveURL(/#live\?meetingId=meeting-1$/);

  await emitFinalTranscript(page, 'before reload source', 'before reload translation');
  await expect.poll(() => checkpointRequests.length, { timeout: 7000 }).toBe(1);

  await page.reload();
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'before reload source',
    translatedText: 'before reload translation'
  });
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '繼續錄製' })).toBeVisible();

  page.delayLiveTokenRequestMs = 1000;
  await page.getByRole('button', { name: '繼續錄製' }).click();
  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('manual_resume');
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await expect.poll(() => page.evaluate(() => ({
    sentInputCount: window.__mockGoogleGenAI.liveSessions.at(-1)?.sentInputs.length || 0,
    openAudioContextCount: (window.__mockAudioContexts || []).filter((context) => context.state !== 'closed').length,
    resumedAudioContextCount: (window.__mockAudioContexts || []).filter((context) => context.resumeCalls > 0).length
  }))).toEqual({ sentInputCount: 1, openAudioContextCount: 0, resumedAudioContextCount: 0 });

  await emitFinalTranscript(page, 'after resume source', 'after resume translation');
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'before reload source',
    translatedText: 'before reload translation'
  });
});

test('empty meeting resume draft shows start instead of continue recording', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.route('**/api/meetings/meeting-1/complete', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ meeting: { id: 'meeting-1', status: 'completed' } })
    });
  });

  await page.goto('/#live?meetingId=meeting-1');

  await expect(page.getByRole('button', { name: '繼續錄製' })).toBeHidden();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect(page.getByRole('button', { name: '結束會議' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const buttonMetrics = await page.evaluate(() => {
    const readButton = (button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      const parent = button.parentElement;
      const grandparent = parent?.parentElement;
      const readContainer = (element) => {
        if (!element) return null;
        const containerStyle = getComputedStyle(element);
        return {
          className: element.className,
          display: containerStyle.display,
          width: containerStyle.width,
          alignItems: containerStyle.alignItems,
          alignSelf: containerStyle.alignSelf,
          flex: containerStyle.flex,
          maxWidth: containerStyle.maxWidth
        };
      };
      return {
        text: button.textContent.trim(),
        className: button.className,
        outerHTML: button.outerHTML,
        computedWidth: style.width,
        display: style.display,
        alignSelf: style.alignSelf,
        flex: style.flex,
        maxWidth: style.maxWidth,
        inlineStyle: button.getAttribute('style'),
        boxSizing: style.boxSizing,
        rectWidth: rect.width,
        parentWidth: parent?.getBoundingClientRect().width ?? null,
        parent: readContainer(parent),
        grandparent: readContainer(grandparent)
      };
    };
    return {
      meetingControls: [...document.querySelectorAll('.meeting-live-action-button')].map(readButton),
      export: readButton(document.querySelector('.live-export-trigger'))
    };
  });
  console.log(`[live-settings-widths] ${JSON.stringify(buttonMetrics)}`);
  expect(buttonMetrics.meetingControls).toHaveLength(2);
  expect(buttonMetrics.meetingControls[0].computedWidth).toBe(buttonMetrics.meetingControls[1].computedWidth);
  expect(buttonMetrics.meetingControls[0].rectWidth).toBe(buttonMetrics.meetingControls[1].rectWidth);
  expect(buttonMetrics.meetingControls[0].computedWidth).toBe(buttonMetrics.export.computedWidth);
  expect(buttonMetrics.meetingControls[0].rectWidth).toBe(buttonMetrics.export.rectWidth);
  expect(buttonMetrics.meetingControls.every(({ boxSizing }) => boxSizing === 'border-box')).toBe(true);
  expect(buttonMetrics.meetingControls.every(({ parentWidth, rectWidth }) => parentWidth === rectWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/live-settings-controls-mobile.png', fullPage: true });

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '結束會議' }).click();
  await expect(page).toHaveURL(/#meeting$/);
});

test('active segment with a bound live session resumes without subtitles', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page, {
    initialSegmentStatus: 'active',
    initialLiveSessionId: 'live-session-interrupted'
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('live-translate:meeting-audio:meeting-1', JSON.stringify({
      inputDeviceId: '',
      outputDeviceId: '',
      inputDeviceLabel: '瀏覽器預設麥克風',
      outputDeviceLabel: '瀏覽器預設揚聲器',
      permissionStatus: 'confirmed',
      confirmedAt: new Date().toISOString()
    }));
  });

  await page.goto('/#live?meetingId=meeting-1');

  await expect(page.getByRole('button', { name: '繼續錄製' })).toBeVisible();
  await expect(finalCueRows(page)).toHaveCount(0);
  await page.getByRole('button', { name: '繼續錄製' }).click();

  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.outcome).toBe('interrupted');
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('manual_resume');
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('即時翻譯失敗')).toHaveCount(0);
});

test('clears the meeting actions when live translation has no selected meeting', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.goto('/#live?meetingId=meeting-1');

  await expect(page.getByRole('button', { name: '結束會議' })).toBeVisible();

  await page.goto('/#live');

  await expect(page.getByText('請先選擇一個已建立的會議。')).toBeVisible();
  await expect(page.getByRole('button', { name: '結束會議' })).toBeHidden();
  await expect(page.getByRole('button', { name: '開始' })).toBeHidden();
});

test('live glossary replacement is applied to final translation article text only', async ({ page }) => {
  page.liveGlossaryEntries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: [] }
  ];
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'microphone', 'microphone');

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'microphone',
    translatedText: 'Alan speak'
  });
});

test('glossary edits during an active session update later live translation article text', async ({ page }) => {
  let entries = [];

  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && url.pathname === '/api/glossary') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/glossary/entries') {
      const body = JSON.parse(request.postData() || '{}');
      const entry = { id: 'entry-active', ...body, createdAt: 1000, updatedAt: 1000 };
      entries = [entry];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ entry }) });
      return;
    }

    await route.fallback();
  });

  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => { window.location.hash = 'glossary'; });
  await expect(page).toHaveURL(/#glossary$/);
  await glossaryPanel(page).getByLabel('詞條').fill('microphone');
  await glossaryPanel(page).getByLabel('替換成').fill('Alan speak');
  await glossaryPanel(page).getByLabel('套用範圍').selectOption('live');
  await glossaryPanel(page).getByRole('button', { name: '新增詞條' }).click();
  await expect(glossaryPanel(page).getByText('字典詞條已新增。')).toBeVisible();
  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    if (session) session.liveGlossaryEntries = [{ source: 'microphone', target: 'Alan speak', replacementAliases: [] }];
  });

  await openLivePage(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'microphone', 'microphone');

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'microphone',
    translatedText: 'Alan speak'
  });
});

test('transcript polishing status and independent article output are visible', async ({ page }) => {
  let polishingOutput = null;
  await mockMeetingCheckpointApi(page);
  await mockSingleMeetingList(page);
  await page.route('**/api/sessions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && /^\/api\/sessions\/[^/]+\/translations$/.test(url.pathname) && polishingOutput) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-1');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId,
          translations: [],
          translationHistory: {
            outputs: [polishingOutput],
            executions: []
          }
        })
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '常會議', 'The regular meeting.');
  const cueId = await finalCueRows(page).first().getAttribute('data-cue-id');
  expect(cueId).toBeTruthy();
  await expect(liveCuePanel(page).getByTestId('transcript-polishing-status')).toHaveCount(0);
  await expect(finalCueRows(page).first()).not.toHaveClass(/cue-row-refining/);

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  polishingOutput = {
    id: 'polishing-output-1',
    executionId: 'polishing-execution-1',
    operation: 'transcript_polishing',
    version: 1,
    completedAt: '2026-08-07T00:00:10.000Z',
    translatedText: 'The long meeting.',
    polishedItems: [{
      cueId,
      sequence: 1,
      polishedText: 'The long meeting.'
    }]
  };

  const polishingStatus = liveCuePanel(page).getByTestId('transcript-polishing-status');
  await expect(polishingStatus.getByText('潤飾完成')).toBeVisible({ timeout: 5000 });
  await expect(polishingStatus).toHaveText(/潤飾完成.*v1/);
  await expect(page.locator('.live-page > [data-testid="transcript-polishing-status"]')).toHaveCount(0);
  await expect(page.getByTestId('polished-article').getByText('The long meeting.')).toBeVisible();
  await expect(translationCueList(page).getByText('The long meeting.')).toBeVisible();
  await expect(translationCueList(page).getByText('The regular meeting.')).toHaveCount(0);
  await expect(finalCueRows(page).first()).not.toHaveClass(/cue-row-refining/);
  await expect(finalCueRows(page).first()).toHaveClass(/cue-row-refined/);
  await expect(finalCueRows(page).first().getByTestId('cue-refined-indicator')).toHaveCount(1);
  await expect(finalCueRows(page).first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(finalCueRows(page).first().getByTestId('cue-source-text')).toHaveText('常會議');
  await expect(finalCueRows(page).first()).not.toContainText('修正中');
  await expect(finalCueRows(page).first()).not.toContainText('等待修正');
});

test('transcript polishing retry shows the new queued execution and failure reason inline', async ({ page }) => {
  let polishingPhase = 'failed';
  let retryCalls = 0;
  await page.route('**/api/sessions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && /^\/api\/sessions\/[^/]+\/translations$/.test(url.pathname)) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-1');
      const executions = polishingPhase === 'failed'
        ? [{
          id: 'polishing-execution-old',
          operation: 'transcript_polishing',
          status: 'failed',
          startedAt: '2026-08-07T00:00:01.000Z',
          completedAt: '2026-08-07T00:00:02.000Z',
          failureInfo: {
            reason: 'provider_execution_failed', code: 'bad_request', providerCode: 400, status: 400,
            providerStatus: 'INVALID_ARGUMENT', providerMessage: 'Invalid request for model gemini-3.5-flash-lite.',
            model: 'gemini-3.5-flash-lite', requestConfig: { fields: [] }
          }
        }]
        : [
          {
            id: 'polishing-execution-old',
            operation: 'transcript_polishing',
            status: 'failed',
            startedAt: '2026-08-07T00:00:01.000Z',
            completedAt: '2026-08-07T00:00:02.000Z',
            failureInfo: {
              reason: 'provider_execution_failed', code: 'bad_request', providerCode: 400, status: 400,
              providerStatus: 'INVALID_ARGUMENT', providerMessage: 'Invalid request for model gemini-3.5-flash-lite.',
              model: 'gemini-3.5-flash-lite', requestConfig: { fields: [] }
            }
          },
          {
            id: 'polishing-execution-retry',
            operation: 'transcript_polishing',
            status: 'queued',
            startedAt: '2026-08-07T00:00:03.000Z',
            completedAt: null,
            failureInfo: null
          }
        ];
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ sessionId, translations: [], translationHistory: { outputs: [], executions } })
      });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/translation-executions/*/retry', async (route) => {
    retryCalls += 1;
    polishingPhase = 'queued';
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'polishing retry source', 'polishing retry translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();

  const polishingStatus = liveCuePanel(page).getByTestId('transcript-polishing-status');
  await expect(polishingStatus).toContainText('潤飾失敗', { timeout: 5000 });
  await expect(polishingStatus).toContainText('Gemini 拒絕此翻譯請求');
  await polishingStatus.getByRole('button', { name: '重試' }).click();
  await expect.poll(() => retryCalls).toBe(1);
  await expect(polishingStatus).toContainText('等待潤飾');
  await expect(polishingStatus).not.toContainText('潤飾失敗');
});

test('final Cues stay paired and one partial Cue remains at the tail', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (const [sourceText, translationText] of [
      ['First sentence.', '第一句翻譯。'],
      ['Second sentence.', '第二句翻譯。'],
      ['Third sentence.', '第三句翻譯。']
    ]) {
      session.emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
      session.emitMessage({ serverContent: { turnComplete: true } });
    }
  });

  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: '第四句辨識中' },
        outputTranscription: { text: '第四句翻譯中' }
      }
    });
  });

  await expect(partialCueRows(page)).toHaveCount(1);
  await expectCueRow(partialCueRows(page).first(), {
    sourceText: '第四句辨識中',
    translatedText: '第四句翻譯中'
  });
  await expect(finalCueRows(page)).toHaveCount(2);
});

test('live subtitles prioritize translation and can collapse the source column', async ({ page }) => {
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'source sentence', 'translated sentence');

  const panel = liveCuePanel(page);
  const toggle = panel.getByTestId('source-visibility-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await panel.locator('.cue-panel-actions > *').evaluateAll((items) => items.findIndex((item) => item.matches('.live-inline-status')) < items.findIndex((item) => item.matches('[data-testid="source-visibility-toggle"]')))).toBe(true);
  await expect(panel.getByRole('region', { name: '即時字幕原文' })).toBeVisible();
  await expect(panel.getByTestId('cue-paired-list').getByText('translated sentence')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('live-subtitles-source-visible.png'), fullPage: true });

  const visibleLayout = await panel.getByTestId('cue-list').locator('.cue-reading-layout').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(visibleLayout.split(' ').length).toBe(2);
  const translationHeading = await panel.getByRole('heading', { name: '翻譯', exact: true }).boundingBox();
  const firstCueRow = await panel.getByTestId('cue-paired-list').locator('.cue-row').first().boundingBox();
  const description = await panel.locator('.meeting-settings-card-description').boundingBox();
  expect(translationHeading).not.toBeNull();
  expect(firstCueRow).not.toBeNull();
  expect(description).not.toBeNull();
  expect(translationHeading.y - (description.y + description.height)).toBeGreaterThanOrEqual(24);
  expect(translationHeading.y - (description.y + description.height)).toBeLessThanOrEqual(32);
  expect(firstCueRow.y - (translationHeading.y + translationHeading.height)).toBeLessThan(48);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.getByRole('region', { name: '即時字幕原文' })).toHaveCount(0);
  await expect(panel.getByTestId('cue-paired-list').getByText('translated sentence')).toBeVisible();
  await expect(panel.getByTestId('cue-source-text')).toHaveCount(0);
  await expect(panel.getByText('source sentence', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('live-subtitles-source-hidden.png'), fullPage: true });
  const hiddenLayout = await panel.getByTestId('cue-list').locator('.cue-reading-layout').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(hiddenLayout.split(' ').length).toBe(1);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('cue-paired-list').getByText('source sentence')).toBeVisible();
});

test('live recording reuses the meeting design system at desktop widths', async ({ page }) => {
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'visual source', 'visual translation');

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 }
  ]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: test.info().outputPath(`live-recording-${viewport.width}.png`) });

    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.live-recording-app-shell');
      const toolbar = document.querySelector('.live-session-toolbar');
      const panel = document.querySelector('[data-testid="live-cue-panel"]');
      const readingLayout = document.querySelector('.cue-reading-layout');
      const controlStatusRow = document.querySelector('.live-session-toolbar .control-status-row');
      const sessionButton = document.querySelector('.live-session-toolbar .session-actions button');
      const styles = toolbar ? getComputedStyle(toolbar) : null;
      const controlStyles = controlStatusRow ? getComputedStyle(controlStatusRow) : null;
      return {
        shellUsesMeetingManagement: shell?.classList.contains('meeting-management-shell') || false,
        toolbarBackground: styles?.backgroundColor,
        toolbarRadius: styles?.borderRadius,
        buttonHeight: sessionButton ? getComputedStyle(sessionButton).minHeight : '',
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        toolbarWidth: toolbar?.getBoundingClientRect().width || 0,
        toolbarHeight: toolbar?.getBoundingClientRect().height || 0,
        panelWidth: panel?.getBoundingClientRect().width || 0,
        controlDisplay: controlStyles?.display || '',
        controlColumns: controlStyles ? controlStyles.gridTemplateColumns.split(' ').length : 0,
        readingColumns: readingLayout ? getComputedStyle(readingLayout).gridTemplateColumns.split(' ').length : 0,
        dividerContent: readingLayout ? getComputedStyle(readingLayout, '::after').content : 'none'
      };
    });

    expect(layout.shellUsesMeetingManagement).toBe(true);
    expect(layout.toolbarBackground).toBe('rgb(255, 255, 255)');
    expect(layout.toolbarRadius).toBe('16px');
    expect(layout.buttonHeight).toBe('44px');
    expect(layout.hasHorizontalOverflow).toBe(false);
    expect(layout.toolbarWidth).toBeGreaterThan(0);
    expect(layout.toolbarHeight).toBeLessThanOrEqual(96);
    expect(layout.panelWidth).toBeGreaterThan(0);
    expect(layout.controlDisplay).toBe('grid');
    expect(layout.controlColumns).toBe(3);
    expect(layout.readingColumns).toBe(2);
    expect(layout.dividerContent).not.toBe('none');
  }

  await page.setViewportSize({ width: 640, height: 800 });
  const mobileLayout = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="cue-paired-list"] .cue-row');
    const styles = row ? getComputedStyle(row) : null;
    return {
      rowColumns: styles?.gridTemplateColumns.split(' ').length || 0,
      controlDisplay: getComputedStyle(document.querySelector('.live-session-toolbar .control-status-row')).display,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  expect(mobileLayout.rowColumns).toBe(1);
  expect(mobileLayout.controlDisplay).toBe('flex');
  expect(mobileLayout.hasHorizontalOverflow).toBe(false);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('live-session-toolbar').getByRole('button', { name: '詳細狀態' }).click();
  const typography = await page.evaluate(() => {
    const source = document.querySelector('[data-testid="cue-paired-list"] .cue-source');
    const translation = document.querySelector('[data-testid="cue-paired-list"] .cue-translation');
    const deviceSummary = document.querySelector('.live-device-summary span');
    const actionButton = document.querySelector('.live-session-toolbar .session-actions button');
    const sourceStyle = source ? getComputedStyle(source) : null;
    const translationStyle = translation ? getComputedStyle(translation) : null;
    const deviceSummaryStyle = deviceSummary ? getComputedStyle(deviceSummary) : null;
    const actionButtonStyle = actionButton ? getComputedStyle(actionButton) : null;
    return {
      sourceFontSize: sourceStyle?.fontSize || '',
      translationFontSize: translationStyle?.fontSize || '',
      deviceSummaryFontSize: deviceSummaryStyle?.fontSize || '',
      actionButtonFontSize: actionButtonStyle?.fontSize || '',
      sourceFontWeight: sourceStyle?.fontWeight || '',
      translationFontWeight: translationStyle?.fontWeight || '',
      firstRowBorder: document.querySelector('[data-testid="cue-paired-list"] .cue-row') ? getComputedStyle(document.querySelector('[data-testid="cue-paired-list"] .cue-row')).borderBottomWidth : ''
    };
  });
  expect(typography.translationFontSize).toBe(typography.sourceFontSize);
  expect(typography.deviceSummaryFontSize).toBe('16px');
  expect(typography.actionButtonFontSize).toBe(typography.deviceSummaryFontSize);
  expect(typography.translationFontWeight).toBe(typography.sourceFontWeight);
  expect(typography.firstRowBorder).toBe('0px');
});

test('live recording can expand secondary status and enter focus mode without hiding controls', async ({ page }) => {
  await gotoMockMeetingLive(page);
  await page.setViewportSize({ width: 1041, height: 750 });

  const toolbar = page.getByTestId('live-session-toolbar');
  const detailsButton = toolbar.getByRole('button', { name: '詳細狀態' });
  const focusButton = toolbar.getByRole('button', { name: '專注模式' });

  await expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#live-session-status-details')).toHaveCount(0);
  await detailsButton.click();
  await expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#live-session-status-details')).toBeVisible();
  await expect(page.getByLabel('已確認的音訊裝置')).toBeVisible();

  await focusButton.click();
  await expect(page.locator('.live-recording-app-shell')).toHaveClass(/is-live-focus-mode/u);
  await expect(page.locator('.live-recording-app-shell > .meeting-app-header')).toBeHidden();
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '退出專注' })).toHaveAttribute('aria-pressed', 'true');
  await expect(toolbar.getByRole('button', { name: /開始錄製|繼續錄製/u })).toBeVisible();

  await toolbar.getByRole('button', { name: '退出專注' }).click();
  await expect(page.locator('.live-recording-app-shell > .meeting-app-header')).toBeVisible();
});

test('final repeated number turn keeps its complete source and translation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    session.emitMessage({
      serverContent: {
        inputTranscription: { text: '123.' },
        outputTranscription: { text: '123.' },
        turnComplete: true
      }
    });
  });

  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: '456.' },
        outputTranscription: { text: '456.' },
        turnComplete: true
      }
    });
  });

  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: '123.456.789.' },
        outputTranscription: { text: '123.456.789.' },
        turnComplete: true
      }
    });
  });

  await page.waitForTimeout(800);
  await expect(finalCueRows(page)).toHaveCount(3);
  await expectCueRow(finalCueRows(page).nth(2), {
    sourceText: '123.456.789.',
    translatedText: '123.456.789.'
  });
});

test('late transcript after Turn completion does not remain in a partial row', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    session.emitMessage({ serverContent: { turnComplete: true } });
    session.emitMessage({ serverContent: { inputTranscription: { text: 'late source' } } });
    session.emitMessage({ serverContent: { outputTranscription: { text: 'late translation' } } });
  });
  await page.waitForTimeout(750);

  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'late source',
    translatedText: 'late translation'
  });
});

test('unpaired cumulative translation stays hidden until its source arrives', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    session.emitMessage({
      serverContent: {
        outputTranscription: { text: '這是' }
      }
    });
    session.emitMessage({
      serverContent: {
        outputTranscription: { text: '這是一個完整句末' }
      }
    });
  });

  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(0);

  await emitTurnComplete(page);

  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(0);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: '這是一個完整句末內容文字。' },
        outputTranscription: { text: '這是一個完整句末內容文字。' }
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page)).toHaveCount(0);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '這是一個完整句末內容文字。',
    translatedText: '這是一個完整句末內容文字。'
  });
});

test('cue list scroll stops follow-latest until the user returns to the latest subtitle', async ({ page }) => {
  await page.addInitScript(() => { window.__liveTranslateSegmentSwitchIntervalMs = 60000; });
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  for (let index = 0; index < 20; index += 1) {
    await emitFinalTranscript(page, `scroll source ${index}.`, `scroll translation ${index}.`, { waitMs: 100 });
  }

  await expect(cueList(page)).toHaveCSS('overflow-y', 'auto');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(await page.evaluate(() => window.innerHeight));
  await page.waitForTimeout(1000);
  await cueList(page).hover();
  await cueList(page).evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await cueList(page).evaluate((list) => {
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect.poll(() => cueList(page).evaluate((list) => list.scrollTop)).toBe(0);
  await expect(page.getByTestId('follow-latest-button')).toBeVisible();

  const scrollTopBeforeNewCue = await cueList(page).evaluate((list) => list.scrollTop);
  await emitFinalTranscript(page, 'scroll source newest.', 'scroll translation newest.', { waitMs: 300 });
  await expect(finalCueRows(page)).toHaveCount(21);
  await expect.poll(() => cueList(page).evaluate((list) => list.scrollTop)).toBe(scrollTopBeforeNewCue);

  await expect.poll(() => cueList(page).evaluate((list) => list.scrollTop)).toBe(scrollTopBeforeNewCue);
});

test('paired Cue auto-finalizes after idle when a provider boundary is absent', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitPartialTranscript(page, 'idle source finalizes', 'idle translation finalizes');

  await expect(partialCueRows(page)).toHaveCount(1);
  await expectCueRow(partialCueRows(page).first(), {
    sourceText: 'idle source finalizes',
    translatedText: 'idle translation finalizes'
  });

  await emitTurnComplete(page);

  await expect(partialCueRows(page)).toHaveCount(0, { timeout: 3500 });
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'idle source finalizes',
    translatedText: 'idle translation finalizes'
  });
});

test('source-only partial Cue is finalized after the turn boundary', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { inputTranscription: { text: '沒有翻譯的暫存句子' } }
    });
  });

  await expect(partialCueRows(page)).toHaveCount(1);
  await emitTurnComplete(page);
  await expect(partialCueRows(page)).toHaveCount(0, { timeout: 3500 });
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '沒有翻譯的暫存句子',
    translatedText: ''
  });
});

test('short paired Chinese Cue does not remain in recognition after turn completion', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitPartialTranscript(page, '測試,123', 'Microphone test,123');
  await expect(partialCueRows(page)).toHaveCount(1);
  await emitTurnComplete(page);

  await expect(partialCueRows(page)).toHaveCount(0, { timeout: 3500 });
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '測試,123',
    translatedText: 'Microphone test,123'
  });
});

test('late end-of-turn source transcription extends the existing Cue', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitPartialTranscript(page, '現在下午時間4', 'The time is now');
  await emitTurnComplete(page);
  await expect(partialCueRows(page)).toHaveCount(0, { timeout: 3500 });
  await expect(finalCueRows(page)).toHaveCount(1);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { inputTranscription: { text: '現在下午時間4點30分', turnComplete: true } }
    });
  });

  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '現在下午時間4',
    translatedText: 'The time is now'
  });
});

test('incremental word fragments render as one subtitle row after Turn completion', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    const emit = (inputTranscription, outputTranscription) => session.emitMessage({
      serverContent: {
        ...(inputTranscription ? { inputTranscription: { text: inputTranscription } } : {}),
        ...(outputTranscription ? { outputTranscription: { text: outputTranscription } } : {})
      }
    });
    emit("it's a voice");
    emit('input.');
    emit(null, '這是語音');
    emit(null, '輸入。');
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page)).toHaveCount(0);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { turnComplete: true }
    });
  });

  await page.waitForTimeout(750);
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: "it's a voice input.",
    translatedText: '這是語音輸入。'
  });
});

test('keeps non-cumulative numeric translation fragments in the same Cue', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    session.emitMessage({
      serverContent: { inputTranscription: { text: '測試測試123123' } }
    });
    session.emitMessage({
      serverContent: { outputTranscription: { text: 'test, test' } }
    });
    session.emitMessage({
      serverContent: { outputTranscription: { text: '123 123' } }
    });
    session.emitMessage({ serverContent: { turnComplete: true } });
  });

  await page.waitForTimeout(750);
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '測試測試123123',
    translatedText: 'test, test 123 123'
  });
});

test('adjacent short final Cues render as one natural sentence', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (const [sourceText, translationText] of [
      ['Actually,', '其實，'],
      ["it's very", '很'],
      ['right now.', '現在。']
    ]) {
      session.emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
    }
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: "Actually, it's very right now.",
    translatedText: '其實，很現在。'
  });
});

test('a long sentence remains one live Cue instead of being split by character limits', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  const sourceText = '這是一段很長的即時字幕內容，應該完整顯示成一句話，不要因為字數上限而被拆成多列。';
  const translationText = 'This is a long live subtitle sentence that should remain together instead of being split into several rows.';
  await emitFinalTranscript(page, sourceText, translationText);

  await expect(finalCueRows(page)).toHaveCount(1);
  const row = finalCueRows(page).first();
  const displayedSourceText = await row.getByTestId('cue-source-text').textContent();
  const displayedTranslationText = await translationCueList(page).getByTestId('cue-final-row').first().getByTestId('cue-translated-text').textContent();
  expect(displayedSourceText.replace(/\s+/gu, '').trim()).toBe(sourceText);
  expect(displayedTranslationText.replace(/\s+/gu, ' ').trim()).toBe(translationText);
});

test('unfinished prefix Cue joins the following sentence-ending Cue', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (const [sourceText, translationText] of [
      ['The microphone', '麥克風'],
      ['test is working.', '測試正常。']
    ]) {
      session.emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
    }
  });
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'The microphone test is working.',
    translatedText: '麥克風測試正常。'
  });
});

test.skip('downloads the active transcript through a browser download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'download source', 'download translation');
  await page.getByRole('button', { name: '匯出', exact: true }).click();

  const downloadPromise = page.waitForEvent('download');
  await activeExportPanel(page).getByRole('button', { name: '下載', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-transcript-.*\.txt$/);
});

test.skip('active source and translation SRT downloads use the same Cue timeline', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'first source', 'first translation');
  await emitFinalTranscript(page, 'second source', 'second translation');
  await page.getByRole('button', { name: '匯出', exact: true }).click();

  const exportPanel = activeExportPanel(page);
  await exportPanel.getByRole('combobox', { name: '匯出格式' }).selectOption('srt');

  const downloadStream = async (stream) => {
    await exportPanel.getByRole('combobox', { name: '匯出內容' }).selectOption(stream);
    const downloadPromise = page.waitForEvent('download');
    await exportPanel.getByRole('button', { name: '下載', exact: true }).click();
    const download = await downloadPromise;
    return readFile(await download.path(), 'utf8');
  };

  const source = await downloadStream('source');
  const translation = await downloadStream('translation');
  const timeline = (content) => [...content.matchAll(/^(\d+)\n([^\n]+) --> ([^\n]+)$/gmu)]
    .map((match) => match.slice(1));

  expect(timeline(source)).toEqual(timeline(translation));
});

test('source and translation remain paired in one Cue row without article aggregation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '汉语 软件 自行车', '汉语 软件 自行车');

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '汉语 软件 自行车',
    translatedText: '汉语 软件 自行车'
  });

  await emitFinalTranscript(page, 'new article source', 'new article translation', { waitMs: 1200 });
  await expect(finalCueRows(page)).toHaveCount(2);
  await expectCueRow(finalCueRows(page).nth(1), {
    sourceText: 'new article source',
    translatedText: 'new article translation'
  });
  await expect(page.getByText('內容已更新，請重新整理。')).toHaveCount(0);
});

test('copies only completed source transcript from live subtitles', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '第一段原文', '第一段翻譯', { waitMs: 1800 });
  await emitFinalTranscript(page, '第二段原文', '第二段翻譯', { waitMs: 1800 });

  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) => { window.__copiedText = value; };
  });
  await page.getByRole('button', { name: '複製原文' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText)).toBe('第一段原文\n第二段原文');
  await page.getByRole('button', { name: '複製翻譯' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText)).toBe('第一段翻譯\n第二段翻譯');
});

test('Stop finalizes visible partial transcripts without active export controls', async ({ page }) => {
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitPartialTranscript(page, 'partial source on stop', 'partial translation on stop');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'partial source on stop',
    translatedText: 'partial translation on stop'
  });
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '匯出', exact: true })).toHaveCount(0);
});

test('reconnects once after mocked unexpected close and preserves transcript', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page, { targetLanguageCode: 'ja' });

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'hello' },
        outputTranscription: { text: 'こんにちは' },
        turnComplete: true
      }
    });
  });
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('unexpected_close');
  expect(checkpointRequests.recoverRequests[0].body.outcome).toBe('interrupted');
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitMicrophoneAudio(page);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.at(-1)?.sentInputs.length || 0)).toBe(1);
  await emitFinalTranscript(page, 'reconnect first speech', 'reconnect first translation');
  await expect(page.getByText('reconnect first speech')).toBeVisible();
  await expect(page.getByText('reconnect first translation')).toBeVisible();
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);
});

test('offline pauses reconnect and online resumes one replacement session', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'before offline', 'after online');

  await page.context().setOffline(true);
  await expect(page.getByText('網路離線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);

  await page.context().setOffline(false);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('network_offline');
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('before offline')).toBeVisible();
  await expect(page.getByText('after online')).toBeVisible();
});

test.skip('selected microphone disconnect falls back on reconnect', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.enumerateDevices = async () => [{
      kind: 'audioinput',
      deviceId: 'mic-1',
      groupId: 'group-1',
      label: 'Desk Mic'
    }];
  });
  await page.goto('/');

  await (await liveSetting(page, '麥克風')).selectOption('mic-1');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => window.__mockMicTracks[0].emit('ended'));

  await expect(page.getByText('所選麥克風已中斷，重新連線時會改用瀏覽器預設麥克風。')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('selected_device_missing');
  await expect(page.getByText('聆聽中')).toBeVisible();
});

test('token expired recovers with a fresh token and preserves transcript', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'before token expiration' },
        outputTranscription: { text: 'still visible after expiration' },
        turnComplete: true
      }
    });
  });
  await expect(page.getByText('before token expiration')).toBeVisible();
  await expect(page.getByText('still visible after expiration')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('token_expired');
  expect(checkpointRequests.recoverRequests[0].body.failureCategory).toBe('token');
  expect(checkpointRequests.recoverRequests[0].body.outcome).toBe('interrupted');
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByRole('button', { name: '結束本次工作階段' })).toBeVisible();
  await expect(page.getByText('before token expiration')).toBeVisible();
  await expect(page.getByText('still visible after expiration')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);
});

test('browser suspended recovery preserves checkpointed transcript after wake', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitFinalTranscript(page, 'before browser sleep', 'visible after browser wake');
  await expect(page.getByText('before browser sleep')).toBeVisible();
  await expect(page.getByText('visible after browser wake')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitError({
      code: 'browser_suspended',
      message: 'page resumed after background sleep'
    });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('browser_suspended');
  expect(checkpointRequests.recoverRequests[0].body.failureCategory).toBe('browser_runtime');
  expect(checkpointRequests.recoverRequests[0].body.outcome).toBe('interrupted');
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('before browser sleep')).toBeVisible();
  await expect(page.getByText('visible after browser wake')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);
});

test('auth failed shows friendly message without reconnect', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'before auth failure' },
        outputTranscription: { text: 'auth failure transcript' },
        turnComplete: true
      }
    });
  });

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitError({
      error: { status: 403, code: 'auth_failed' },
      message: 'raw auth failure token abc123 at Provider.stack'
    });
  });

  await expect(page.getByText('存取失敗', { exact: true })).toBeVisible();
  await expect(page.getByText('存取失敗。請檢查存取權杖或設定。（HTTP 403）')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '結束本次工作階段' })).toBeHidden();
  await expect(page.getByText('before auth failure')).toBeVisible();
  await expect(page.getByText('auth failure transcript')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('rate limited shows friendly message without reconnect', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'before rate limit' },
        outputTranscription: { text: 'rate limit transcript' },
        turnComplete: true
      }
    });
  });

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitError({
      code: 'rate_limited',
      message: 'raw rate limit failure token abc123 at Provider.stack'
    });
  });

  await expect(page.getByText('請求受限', { exact: true })).toBeVisible();
  await expect(page.getByText('請求過於頻繁。請稍候再試。')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '結束本次工作階段' })).toBeHidden();
  await expect(page.getByText('before rate limit')).toBeVisible();
  await expect(page.getByText('rate limit transcript')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('stop during reconnect cancels pending replacement session', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });
  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await page.waitForTimeout(900);

  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('duplicate unexpected close does not create duplicate replacement sessions', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions[0];
    session.emitClose({ reason: 'unexpected provider close', code: 1011 });
    session.emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
});

test('reconnect failure preserves transcript and allows manual restart', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'hello before failure' },
        outputTranscription: { text: 'translated before failure' },
        turnComplete: true
      }
    });
  });
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect(page.getByText('無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);

  page.failLiveTokenRequestAt = null;
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect.poll(() => page.liveTokenRequests.length).toBe(3);
});

test('retry exhaustion shows explicit error and preserves transcript', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'still exportable' },
        outputTranscription: { text: 'after exhaustion' },
        turnComplete: true
      }
    });
  });

  for (let index = 0; index < 3; index += 1) {
    await page.evaluate((sessionIndex) => {
      window.__mockGoogleGenAI.liveSessions[sessionIndex].emitClose({ reason: 'unexpected provider close', code: 1011 });
    }, index);
    await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(index + 2);
    await expect(page.getByText('聆聽中')).toBeVisible();
  }

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[3].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('即時翻譯多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect(page.getByText('still exportable')).toBeVisible();
  await expect(page.getByText('after exhaustion')).toBeVisible();
  await expectActiveExportDownloadEnabled(page);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(4);
});

test('meeting management uses the live workspace layout and preserves create flow', async ({ page }) => {
  await page.unroute('**/api/meetings');
  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'meeting-existing',
          name: '既有產品會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en',
          createdAt: 1700000000000
        }])
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meetings/meeting-existing') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: 'meeting-existing',
            name: '既有產品會議',
            status: 'created',
            sourceLanguageCode: 'zh-Hant',
            targetLanguageCode: 'en',
            glossaryEntries: []
          }
        })
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meetings/meeting-created') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: 'meeting-created',
            name: '產品會議',
            status: 'created',
            sourceLanguageCode: 'zh-Hant',
            targetLanguageCode: 'en',
            glossaryEntries: []
          }
        })
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: {
            id: 'meeting-created',
            name: '產品會議',
            sourceLanguageCode: 'zh-Hant',
            targetLanguageCode: 'en',
            status: 'created',
            glossaryEntries: []
          }
        })
      });
      return;
    }

    if (request.method() === 'DELETE' && url.pathname === '/api/meetings/meeting-created') {
      await route.fulfill({ status: 204 });
      return;
    }

    await route.fallback();
  });
  let glossaryListRequestCount = 0;
  let releaseGlossaryDrawerLoad;
  await page.route('**/api/glossary**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/glossary/entries') {
      const payload = request.postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          entry: {
            id: 'glossary-new',
            source: payload.source,
            scope: payload.scope,
            translations: payload.translations,
            replacementAliases: { en: [] }
          }
        })
      });
      return;
    }
    glossaryListRequestCount += 1;
    if (glossaryListRequestCount === 2) {
      await new Promise((resolve) => { releaseGlossaryDrawerLoad = resolve; });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [{
          id: 'glossary-product',
          source: '產品名稱',
          scope: 'live',
          translations: { en: 'Product Name' },
          replacementAliases: { en: [] }
        }]
      })
    });
  });

  await page.goto('/#meeting');

  await expect(page.locator('.meeting-app-shell')).toBeVisible();
  await expect(page.locator('.meeting-app-header')).toBeVisible();
  await expect(page.locator('.live-sidebar')).toHaveCount(0);
  await expect(page.getByText('MEETING SETUP')).toBeHidden();
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立會議', exact: true }).last()).toBeVisible();
  await expect(page.locator('.meeting-management-page > .history-panel')).toBeVisible();

  await expect(page.locator('.meeting-card-grid .meeting-card')).toHaveCount(1);
  await expect(page.locator('.meeting-management-page ul.history-list')).toHaveCount(0);
  await expect(page.locator('.meeting-card').filter({ hasText: '既有產品會議' }).getByRole('button', { name: '編輯並開始會議', exact: true })).toBeVisible();

  const meetingCardLayout = await page.locator('.meeting-card-grid').evaluate((element) => {
    const gridRect = element.getBoundingClientRect();
    const panelRect = element.closest('.history-panel').getBoundingClientRect();
    return {
      gridFitsPanel: gridRect.left >= panelRect.left && gridRect.right <= panelRect.right,
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      columnCount: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      gridRect: { top: gridRect.top, bottom: gridRect.bottom, height: gridRect.height },
      panelRect: { top: panelRect.top, bottom: panelRect.bottom, height: panelRect.height }
    };
  });
  expect(meetingCardLayout.gridFitsPanel).toBe(true);
  expect(meetingCardLayout.pageHasHorizontalOverflow).toBe(false);
  expect(meetingCardLayout.columnCount).toBe(3);

  await page.setViewportSize({ width: 1023, height: 600 });
  const laptopMeetingLayout = await page.locator('.meeting-card-grid').evaluate((element) => {
    return {
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      columnCount: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      cardFitsViewport: [...element.querySelectorAll('.meeting-card')].every((card) => card.getBoundingClientRect().right <= window.innerWidth)
    };
  });
  expect(laptopMeetingLayout.pageHasHorizontalOverflow).toBe(false);
  expect(laptopMeetingLayout.columnCount).toBe(1);
  expect(laptopMeetingLayout.cardFitsViewport).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator('.meeting-card').filter({ hasText: '既有產品會議' }).getByRole('button', { name: '編輯並開始會議' }).click();
  await expect(page.getByRole('heading', { name: '編輯會議設定' })).toBeVisible();
  await expect(page.getByLabel('會議名稱')).toHaveValue('既有產品會議');
  await page.getByRole('button', { name: '返回會議清單' }).click();
  await expect(page.getByRole('button', { name: '建立會議', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: '編輯會議設定' })).toHaveCount(0);

  await page.getByRole('button', { name: '建立會議', exact: true }).last().click();
  await expect(page.getByText('MEETING SETUP')).toBeVisible();
  await expect(page.getByRole('heading', { name: '建立會議' })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回會議清單' })).toBeVisible();

  const managementCards = page.locator('.meeting-management-grid > .control-panel');
  await expect(managementCards).toHaveCount(1);

  await page.getByRole('button', { name: /會議字典/ }).click();
  const glossaryDrawer = page.locator('.meeting-management-page .glossary-drawer');
  await expect(glossaryDrawer).toBeVisible();
  await expect.poll(() => glossaryListRequestCount).toBe(2);
  await glossaryDrawer.locator('.glossary-choice input').check();
  await expect(page.getByRole('button', { name: /會議字典/ })).toContainText('1');

  await glossaryDrawer.getByLabel('原文').fill('新產品名稱');
  await glossaryDrawer.getByLabel('翻譯（英文）').fill('New Product Name');
  await glossaryDrawer.getByRole('button', { name: '新增並套用' }).click();
  await expect(glossaryDrawer.getByRole('status')).toHaveText('詞條已新增並套用。');
  releaseGlossaryDrawerLoad?.();
  await expect(glossaryDrawer.locator('.glossary-choice')).toHaveCount(2);
  await expect(glossaryDrawer.locator('.glossary-choice').first()).toContainText('新產品名稱');
  await expect(glossaryDrawer.locator('.glossary-choice').first().locator('input')).toBeChecked();
  await expect(page.getByRole('button', { name: /會議字典/ })).toContainText('2');
  await page.keyboard.press('Escape');
  await expect(glossaryDrawer).toBeHidden();

  await page.setViewportSize({ width: 1024, height: 720 });
  await page.getByRole('button', { name: /會議字典/ }).click();
  await expect(glossaryDrawer).toBeVisible();
  const laptopDrawerLayout = await glossaryDrawer.evaluate((element) => {
    const styles = getComputedStyle(element.querySelector('.glossary-drawer-header'));
    return {
      width: element.getBoundingClientRect().width,
      borderBoxFits: element.scrollWidth <= element.clientWidth + 1,
      headerPadding: styles.paddingInline
    };
  });
  expect(laptopDrawerLayout.width).toBeCloseTo(340, 0);
  expect(laptopDrawerLayout.borderBoxFits).toBe(true);
  expect(laptopDrawerLayout.headerPadding).toBe('18px');
  await glossaryDrawer.getByRole('button', { name: '關閉字典' }).click();
  await expect(glossaryDrawer).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /會議字典/ }).click();
  await expect(glossaryDrawer).toBeVisible();
  const mobileDrawerLayout = await glossaryDrawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      width: rect.width,
      height: rect.height,
      borderTopWidth: styles.borderTopWidth,
      borderLeftWidth: styles.borderLeftWidth
    };
  });
  expect(mobileDrawerLayout.width).toBeLessThanOrEqual(390);
  expect(mobileDrawerLayout.height).toBeLessThanOrEqual(760);
  expect(mobileDrawerLayout.borderTopWidth).toBe('1px');
  expect(mobileDrawerLayout.borderLeftWidth).toBe('0px');
  await expect(glossaryDrawer.getByRole('button', { name: '前往完整字典管理' })).toBeVisible();
  await glossaryDrawer.getByRole('button', { name: '關閉字典' }).click();
  await expect(glossaryDrawer).toBeHidden();

  await page.getByLabel('會議名稱').fill('產品會議');
  await page.getByLabel('會議設定').getByRole('button', { name: '建立會議', exact: true }).click();

  await expect(page.getByRole('status')).toHaveText('會議已建立。');
  await expect(page.getByRole('button', { name: '儲存變更', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回會議清單', exact: true })).toBeVisible();
  await expect(page.locator('.meeting-management-grid > .control-panel')).toHaveCount(2);
  const cardWidths = await page.locator('.meeting-management-grid > .control-panel').evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().width)));
  expect(cardWidths[0]).toBe(cardWidths[1]);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '返回會議清單' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  const createdMeetingCard = page.locator('.meeting-card').filter({ has: page.getByText('產品會議', { exact: true }) });
  await createdMeetingCard.click({ position: { x: 12, y: 12 } });
  await expect(page.getByRole('heading', { name: '編輯會議設定' })).toBeVisible();
  await page.getByRole('button', { name: '刪除會議' }).click();
  await expect(createdMeetingCard).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('會議已刪除。');
});

test('opening a meeting live workspace clears the previous live preview', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.route('**/api/meetings/meeting-1/segments/segment-1/start', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: { id: 'meeting-1', name: '測試會議', status: 'active' },
        segment: { id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'active', liveSessionId: 'live-session-1' }
      })
    });
  });
  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '上一場原文', 'Previous translation');
  await expect(finalCueRows(page)).toHaveCount(1);
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(finalCueRows(page)).toHaveCount(1);

  await page.route('**/api/meetings**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'meeting-2', name: '新測試會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }])
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/api/meetings/meeting-2') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ meeting: { id: 'meeting-2', name: '新測試會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', glossaryEntries: [] } })
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/api/meetings/meeting-2/segments') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ meetingId: 'meeting-2', segments: [] }) });
      return;
    }
    await route.fallback();
  });
  await page.goto('/#meeting');
  await page.locator('.meeting-card').filter({ hasText: '新測試會議' }).getByRole('button', { name: '編輯並開始會議' }).click();
  await page.getByRole('button', { name: '前往即時字幕' }).click();

  await expect(page).toHaveURL(/#live\?meetingId=meeting-2$/);
  await expect(page.getByTestId('cue-empty-state')).toBeVisible();
  await expect(finalCueRows(page)).toHaveCount(0);
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(page.getByText('上一場原文')).toHaveCount(0);
  await expect(page.getByText('Previous translation')).toHaveCount(0);
  await expect(page.getByTestId('polished-article')).toHaveCount(0);
  await expect(page.getByTestId('transcript-polishing-status')).toHaveCount(0);
});

test('switching meetings before recording clears subtitles from the previous meeting', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'meeting-1',
        name: '已有記錄的會議',
        status: 'created',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en'
      }, {
        id: 'meeting-2',
        name: '尚未錄製的會議',
        status: 'created',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en'
      }])
    });
  });
  await page.route('**/api/meetings/meeting-1/segments/segment-1/start', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: { id: 'meeting-1', name: '已有記錄的會議', status: 'active' },
        segment: { id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'active', liveSessionId: 'live-session-1' }
      })
    });
  });
  await page.route('**/api/meetings/meeting-2', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: { id: 'meeting-2', name: '尚未錄製的會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', glossaryEntries: [] }
      })
    });
  });
  await page.route('**/api/meetings/meeting-2/segments', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ meetingId: 'meeting-2', segments: [] })
    });
  });

  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '上一場原文', 'Previous translation');
  await expect(finalCueRows(page)).toHaveCount(1);
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(finalCueRows(page)).toHaveCount(1);

  const mode = page.getByRole('combobox', { name: '選擇會議' });
  await mode.fill('尚未錄製');
  await mode.press('ArrowDown');
  await mode.press('Enter');

  await expect(page).toHaveURL(/#live\?meetingId=meeting-2$/);
  await expect(page.getByTestId('cue-empty-state')).toBeVisible();
  await expect(finalCueRows(page)).toHaveCount(0);
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(page.getByText('上一場原文')).toHaveCount(0);
  await expect(page.getByText('Previous translation')).toHaveCount(0);
});

test.skip('live translation offers resumable meetings and loads selected settings', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'meeting-live',
        name: '產品評審會議',
        status: 'created',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'ja',
        createdAt: 1700000000000
      }, {
        id: 'meeting-active',
        name: '進行中的會議',
        status: 'active',
        createdAt: 1700000001000
      }])
    });
  });
  await page.route('**/api/meetings/meeting-live', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: {
          id: 'meeting-live',
          name: '產品評審會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'ja',
          glossaryEntries: []
        }
      })
    });
  });
  await page.route('**/api/meetings/meeting-live/shares', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([])
    });
  });

  await page.goto('/#live');

  const mode = page.getByRole('combobox', { name: '選擇會議' });
  await expect(mode).toHaveValue('');
  await expect(page.getByRole('button', { name: '開始' })).toHaveCount(0);
  await mode.click();
  await expect(page.getByRole('option', { name: '產品評審會議' })).toBeVisible();
  await expect(page.getByRole('option', { name: '進行中的會議' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  await mode.fill('產品評審');
  await expect(page.getByRole('option', { name: '產品評審會議' })).toBeVisible();

  await mode.press('ArrowDown');
  await mode.press('Enter');
  await expect(page).toHaveURL(/#live\?meetingId=meeting-live$/);
  const settingsPanel = await openLiveSettings(page);
  await expect(settingsPanel.getByLabel('目標語言')).toHaveValue('ja');
  await expect(settingsPanel.getByLabel('我主要說的語言')).toBeDisabled();
  await expect(settingsPanel.getByLabel('目標語言')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option', { name: '產品評審會議' })).toBeHidden();
  await mode.fill('不存在的會議');
  await expect(page.getByText('找不到符合的會議。')).toBeVisible();
  await mode.fill('產品評審會議');
  await expect(page.getByRole('link', { name: '回會議管理修改' })).toHaveAttribute('href', '#meeting?meetingId=meeting-live');
  await page.getByRole('link', { name: '回會議管理修改' }).click();
  await expect(page).toHaveURL(/#meeting\?meetingId=meeting-live$/);
  await expect(page.getByRole('heading', { name: '編輯會議設定' })).toBeVisible();
  await expect(page.getByLabel('會議名稱')).toHaveValue('產品評審會議');

  await page.goto('/#live?meetingId=meeting-live');
  await expect(page.getByRole('button', { name: /^字典/ })).toBeVisible();

  await page.getByRole('button', { name: /^字典/ }).click();
  const meetingGlossaryDrawer = page.getByRole('complementary', { name: '本次翻譯字典' });
  await expect(meetingGlossaryDrawer.getByText('這些詞條來自會議建立設定；如需修改，請回會議管理。')).toBeVisible();
  await expect(meetingGlossaryDrawer.locator('.glossary-quick-add')).toHaveCount(0);
  await expect(meetingGlossaryDrawer.getByRole('button', { name: '回會議管理修改' })).toBeVisible();
  await meetingGlossaryDrawer.getByRole('button', { name: '回會議管理修改' }).click();
  await expect(page).toHaveURL(/#meeting\?meetingId=meeting-live$/);
  await expect(page.getByRole('heading', { name: '編輯會議設定' })).toBeVisible();
});

test('live route redirects when the meeting is terminal', async ({ page }) => {
  await page.unroute('**/api/meetings');
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'meeting-failed', name: '已失敗的會議', status: 'failed' }])
    });
  });

  await page.goto('/#live?meetingId=meeting-failed');

  await expect(page).toHaveURL(/#meeting$/);
  await expect(page.getByRole('alert')).toHaveText('會議連結不存在或已失效，請重新選擇已建立的會議。');
});

test('Meeting home searches by name and filters by status', async ({ page }) => {
  await page.unroute('**/api/meetings');
  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'meeting-active', name: '產品評審', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', startedAt: 1699999000000, updatedAt: 1700000000000 },
        { id: 'meeting-paused', name: '客戶訪談', status: 'interrupted', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', startedAt: 1699999001000, updatedAt: 1700000001000 },
        { id: 'meeting-completed', name: '已完成簡報', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', startedAt: 1699999002000, updatedAt: 1700000002000 }
      ])
    });
  });

  await page.goto('/#meetings');
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();
  await expect(page.locator('.meeting-app-header .brand-block p')).toHaveText('先建立會議並完成設定，再分享給參與者錄音。');
  await expect(page.locator('.meeting-management-page > .history-header')).toHaveCount(0);
  const desktopMeetingLayout = await page.locator('.meeting-management-shell').evaluate((shell) => {
    const header = shell.querySelector('.meeting-app-header')?.getBoundingClientRect();
    const panel = shell.querySelector('.meeting-management-page > .history-panel')?.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      shellWidth: shellRect.width,
      headerLeft: header?.left ?? 0,
      headerRight: header?.right ?? 0,
      headerToPanelGap: panel && header ? panel.top - header.bottom : Infinity
    };
  });
  expect(desktopMeetingLayout.shellWidth).toBeGreaterThanOrEqual(1279);
  expect(desktopMeetingLayout.headerLeft).toBeLessThanOrEqual(1);
  expect(desktopMeetingLayout.headerRight).toBeGreaterThanOrEqual(1279);
  expect(desktopMeetingLayout.headerToPanelGap).toBeLessThan(40);
  await expect(page.locator('.meeting-card-grid .meeting-card')).toHaveCount(3);
  const activeCard = page.locator('.meeting-card').filter({ hasText: '產品評審' });
  await expect(activeCard).toContainText('繁體中文 → 日文');
  await expect(activeCard).toContainText('開始時間：');
  await expect(activeCard).toContainText('最後更新：');
  await expect(activeCard.getByTestId('meeting-card-started-at')).toHaveCount(1);
  await expect(activeCard.getByTestId('meeting-card-updated-at')).toHaveCount(1);

  await page.setViewportSize({ width: 768, height: 800 });
  const narrowMeetingLayout = await page.locator('.meeting-management-page').evaluate((pageElement) => {
    const toolbar = pageElement.querySelector('.meeting-table-toolbar');
    const search = pageElement.querySelector('.meeting-search-field');
    const dictionaryButton = pageElement.querySelector('.meeting-table-toolbar > .button');
    const cards = pageElement.querySelector('.meeting-card-grid');
    const actionButton = pageElement.querySelector('.meeting-card-action');
    return {
      toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : '',
      toolbarWraps: search && dictionaryButton ? dictionaryButton.getBoundingClientRect().top > search.getBoundingClientRect().bottom : false,
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      cardColumnCount: cards ? getComputedStyle(cards).gridTemplateColumns.split(' ').length : 0,
      actionHeight: actionButton?.getBoundingClientRect().height || 0
    };
  });
  expect(narrowMeetingLayout.toolbarDisplay).toBe('grid');
  expect(narrowMeetingLayout.toolbarWraps).toBe(true);
  expect(narrowMeetingLayout.pageHasHorizontalOverflow).toBe(false);
  expect(narrowMeetingLayout.cardColumnCount).toBe(1);
  expect(narrowMeetingLayout.actionHeight).toBeGreaterThanOrEqual(44);

  await page.getByLabel('搜尋會議').fill('產品');
  await expect(page.locator('.meeting-card-grid .meeting-card')).toHaveCount(1);
  await expect(activeCard).toContainText('進行中');

  await page.getByLabel('搜尋會議').fill('');
  await page.getByLabel('篩選狀態').selectOption('interrupted');
  const interruptedCard = page.locator('.meeting-card').filter({ hasText: '客戶訪談' });
  await expect(page.locator('.meeting-card-grid .meeting-card')).toHaveCount(1);
  await expect(interruptedCard).toContainText('可續錄');
  await expect(interruptedCard.getByRole('button', { name: '繼續即時字幕' })).toBeVisible();
});

test('Meeting home card layout captures desktop viewport references', async ({ page }) => {
  await page.unroute('**/api/meetings');
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'meeting-active', name: '董事會策略會議', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', updatedAt: Date.now() - 120000 },
        { id: 'meeting-ready', name: '產品發布簡報', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', updatedAt: Date.now() - 1080000 },
        { id: 'meeting-paused', name: '客戶訪談', status: 'interrupted', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', updatedAt: Date.now() - 3600000 },
        { id: 'meeting-completed', name: '每週團隊同步', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', updatedAt: Date.now() - 86400000 }
      ])
    });
  });

  await page.goto('/#meetings');
  await page.locator('.meeting-card').first().waitFor();

  for (const [width, height, name, expectedColumns] of [
    [1920, 900, 'wide-desktop', 4],
    [1440, 900, 'desktop', 3],
    [1280, 800, '13-inch', 3],
    [1279, 768, 'compact-desktop', 2]
  ]) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.locator('.meeting-card-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(expectedColumns);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const footerLayout = await page.locator('.meeting-card').first().evaluate((card) => {
    const description = card.querySelector('.meeting-card-footer p').getBoundingClientRect();
    const actions = card.querySelector('.meeting-card-actions').getBoundingClientRect();
    return { descriptionBottom: description.bottom, descriptionWidth: description.width, actionsTop: actions.top, cardWidth: card.getBoundingClientRect().width };
  });
  expect(footerLayout.actionsTop).toBeGreaterThan(footerLayout.descriptionBottom);
  expect(footerLayout.descriptionWidth).toBeGreaterThan(footerLayout.cardWidth * 0.8);
  await page.screenshot({ path: `/private/tmp/live-translate-meeting-management-${name}.png`, fullPage: true });
}
});
