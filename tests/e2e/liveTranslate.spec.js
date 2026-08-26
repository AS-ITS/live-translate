import { expect, test } from '@playwright/test';
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
    window.localStorage.clear();
    window.__mockMicTracks = [];
    window.__mockAudioContexts = [];
    window.__mockAudioProcessors = [];
    window.__mockMediaRecorders = [];
    window.__mockLiveConnectDelayMs = 0;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const track = {
            kind: 'audio',
            stopped: false,
            listeners: new Map(),
            stop() {
              this.stopped = true;
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
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/meetings') {
      await route.fallback();
      return;
    }
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
  });

  await page.route('**/api/meetings/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
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

});

function historyPanel(page) {
  return page.locator('.history-page > .history-panel:not(.meeting-panel)');
}

function historyItems(page) {
  return historyPanel(page).locator('.history-data-grid .ag-row');
}

function meetingsPanel(page) {
  return historyPanel(page);
}

function meetingItems(page) {
  return meetingsPanel(page).locator('.history-data-grid .ag-row');
}

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
  return liveCuePanel(page).getByTestId('cue-translation-list');
}

function finalCueRows(page) {
  return liveCuePanel(page).getByTestId('cue-source-list').getByTestId('cue-final-row');
}

function partialCueRows(page) {
  return liveCuePanel(page).getByTestId('cue-source-list').getByTestId('cue-partial-row');
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
    } else {
      const rowIndex = await row.evaluate((element) => Array.from(element.parentElement.children).indexOf(element));
      const panel = row.locator('xpath=ancestor::*[@data-testid="live-cue-panel"]');
      await expect(panel.getByTestId('cue-translation-list').locator('.cue-row').nth(rowIndex).getByTestId('cue-translated-text')).toHaveText(translatedText);
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

function retranslationPage(page) {
  return page.locator('.retranslation-workflow');
}

async function mockMeetingCheckpointApi(page, {
  failCheckpoint = false,
  failCheckpointAttempts = 0,
  waitForSegmentList = null,
  sourceLanguageCode = 'zh-Hant',
  targetLanguageCode = 'en'
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
          }
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
            status: index + 1 === latestSegmentNumber ? 'active' : 'completed'
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

async function openHistoryPage(page) {
  if (page.useMeetingRootForGoto && page.url().includes('#live?meetingId=meeting-1')) {
    page.useMockMeetings = false;
    page.useMeetingRootForGoto = false;
    page.sessionHistoryMode = true;
    await page.goto('/#history');
    await expect(page).toHaveURL(/#meetings\?status=completed$/);
    return;
  }
  await page.goto('/#history');
  await expect(page).toHaveURL(/#meetings\?status=completed$/);
}

async function openSessionHistoryPage(page) {
  page.useMockMeetings = false;
  page.useMeetingRootForGoto = false;
  await page.goto('/#history');
  await expect(page).toHaveURL(/#meetings\?status=completed$/);
}

async function openMeetingsPage(page) {
  await openHistoryPage(page);
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
    await expect(page).toHaveURL(/#meeting-workspace\?meetingId=meeting-1&tab=live$/);
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
  await expect(page.getByRole('combobox', { name: '選擇會議' })).toHaveValue('測試會議');
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
}

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

test('initial history shows empty state', async ({ page }) => {
  await page.goto('/');
  await openHistoryPage(page);

  await expect(page.getByRole('heading', { name: '翻譯紀錄' })).toBeVisible();
  await expect(historyPanel(page).getByText('尚無會議紀錄。')).toHaveCount(0);
  await expect(historyPanel(page).getByText('完成一次即時翻譯後，會議摘要會出現在這裡。')).toHaveCount(0);
  await expect(historyPanel(page).locator('.history-data-grid')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
});

test('legacy feature routes converge on Meeting Management and Workspace', async ({ page }) => {
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'navigation-meeting', name: '導覽測試會議', status: 'created', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }])
    });
  });

  await page.goto('/#live');
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.locator('.meetings-page')).toBeVisible();

  await page.goto('/#meeting');
  await expect(page.locator('.meeting-management-page:not(.history-page)')).toBeVisible();

  await openHistoryPage(page);
  await expect(page).toHaveURL(/#meetings\?status=completed$/);
  await expect(page.locator('.meetings-page')).toBeVisible();
});

test('Meeting shell keeps only the brand and create action in the header', async ({ page }) => {
  for (const hash of ['#history', '#retranslate', '#glossary', '#meetings', '#dead-letter-queue']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('.live-sidebar, .feature-navigation')).toHaveCount(0);
    await expect(page.locator('.meeting-app-header')).toBeVisible();
    await expect(page.getByRole('button', { name: '建立會議' }).first()).toBeVisible();
  }
});

test('history grid uses native pagination and page size controls', async ({ page }) => {
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.from({ length: 13 }, (_, index) => historyRecord({
        id: `session-pagination-${index + 1}`,
        startedAt: index + 1,
        endedAt: index + 2
      })))
    });
  });

  await page.goto('/');
  await openHistoryPage(page);

  const grid = historyPanel(page).locator('.history-data-grid');
  await expect(grid.locator('.ag-row')).toHaveCount(12);
  await expect(grid.locator('.ag-paging-page-size')).toBeVisible();
  await expect(grid.getByRole('button', { name: '下一頁' })).toBeEnabled();

  const layout = await grid.evaluate((element) => {
    const gridRect = element.getBoundingClientRect();
    const panelRect = element.parentElement.getBoundingClientRect();
    const paginationPanel = element.querySelector('.ag-paging-panel')?.getBoundingClientRect() || null;
    return {
      gridFitsPanel: gridRect.left >= panelRect.left && gridRect.right <= panelRect.right,
      paginationFitsGrid: paginationPanel ? paginationPanel.bottom <= gridRect.bottom + 1 : false,
      paginationPanel
    };
  });
  expect(layout.gridFitsPanel).toBe(true);
  expect(layout.paginationFitsGrid).toBe(true);
  expect(layout.paginationPanel).not.toBeNull();

  const nextPageButton = await grid.getByRole('button', { name: '下一頁' }).boundingBox();
  const pageSizeSelector = await grid.locator('.ag-paging-page-size').boundingBox();
  expect(nextPageButton).not.toBeNull();
  expect(pageSizeSelector).not.toBeNull();
  expect(Math.abs(nextPageButton.y + nextPageButton.height / 2 - (pageSizeSelector.y + pageSizeSelector.height / 2))).toBeLessThanOrEqual(2);

  await grid.getByRole('button', { name: '下一頁' }).click();
  await expect(grid.locator('.ag-row')).toHaveCount(1);

  await grid.locator('.ag-paging-page-size .ag-picker-field-display').click();
  await expect(page.getByRole('option', { name: '24' })).toBeVisible();
  await page.getByRole('option', { name: '24' }).click();
  await expect(grid.locator('.ag-row')).toHaveCount(13);
});

test('history grid uses compact columns on laptop viewports', async ({ page }) => {
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        historyRecord({ id: 'session-compact-1', targetLanguageLabel: '英文' }),
        historyRecord({ id: 'session-compact-2', targetLanguageLabel: '日文' }),
        historyRecord({ id: 'session-compact-3', targetLanguageLabel: '韓文' })
      ])
    });
  });

  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto('/#history');

  const grid = historyPanel(page).locator('.history-data-grid');
  await expect(grid.locator('.ag-row')).toHaveCount(3);
  await expect(grid.getByText('會議', { exact: true })).toBeVisible();
  await expect(grid.getByText('開始時間', { exact: true })).toBeVisible();
  await expect(grid.getByText('會議摘要', { exact: true })).toBeVisible();
  await expect(grid.getByText('操作', { exact: true })).toBeVisible();
  await expect(grid.getByText('結束時間', { exact: true })).toHaveCount(0);

  const layout = await grid.evaluate((element) => {
    const horizontalScroll = element.querySelector('.ag-body-horizontal-scroll-viewport');
    return {
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      gridHasHorizontalOverflow: Boolean(horizontalScroll && horizontalScroll.scrollWidth > horizontalScroll.clientWidth + 1)
    };
  });
  expect(layout.pageHasHorizontalOverflow).toBe(false);
  expect(layout.gridHasHorizontalOverflow).toBe(false);
});

test('history workspace keeps page scrolling inside the table', async ({ page }) => {
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.from({ length: 48 }, (_, index) => historyRecord({
        id: `session-scroll-${index + 1}`,
        startedAt: index + 1,
        endedAt: index + 2,
        targetLanguageLabel: `語言 ${index + 1}`
      })))
    });
  });

  await page.goto('/');
  await openHistoryPage(page);
  await expect(historyPanel(page).locator('.history-data-grid')).toBeVisible();
  await expect(historyItems(page)).not.toHaveCount(0);

  const layout = await page.evaluate(() => {
    const grid = document.querySelector('.history-data-grid');
    const tableScroll = document.querySelector('.history-table-scroll');
    const pageScroll = document.scrollingElement;
    const body = document.body;
    const gridBody = grid?.querySelector('.ag-body-viewport');
    const rect = grid?.getBoundingClientRect();
    const panelRect = document.querySelector('.history-page > .history-panel')?.getBoundingClientRect();
    return {
      bodyCanScroll: body.scrollHeight > body.clientHeight,
      pageCanScroll: pageScroll.scrollHeight > pageScroll.clientHeight,
      tableScrollEnabled: Boolean(tableScroll && ['auto', 'scroll'].includes(getComputedStyle(tableScroll).overflowY)),
      gridBodyScrollEnabled: Boolean(gridBody && ['auto', 'scroll'].includes(getComputedStyle(gridBody).overflowY)),
      gridFitsPanel: Boolean(rect && panelRect && rect.top >= panelRect.top && rect.bottom <= panelRect.bottom + 1),
      domLayout: grid?.querySelector('.ag-root')?.getAttribute('class') || ''
    };
  });
  expect(layout.bodyCanScroll).toBe(false);
  expect(layout.pageCanScroll).toBe(false);
  expect(layout.tableScrollEnabled || layout.gridBodyScrollEnabled).toBe(true);
  expect(layout.gridFitsPanel).toBe(true);
  expect(layout.domLayout).not.toContain('ag-layout-auto-height');
});

test('retranslation picker uses compact columns on laptop viewports', async ({ page }) => {
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        historyRecord({ id: 'session-retranslation-compact-1', name: '紀錄一' }),
        historyRecord({ id: 'session-retranslation-compact-2', name: '紀錄二' }),
        historyRecord({ id: 'session-retranslation-compact-3', name: '紀錄三' })
      ])
    });
  });

  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto('/#retranslate');

  const grid = page.locator('.retranslation-session-data-grid');
  await expect(grid.locator('.ag-row')).toHaveCount(3);
  await expect(grid.getByText('名稱', { exact: true })).toBeVisible();
  await expect(grid.getByText('開始時間', { exact: true })).toBeVisible();
  await expect(grid.getByText('逐字稿', { exact: true })).toBeVisible();
  await expect(grid.getByRole('button', { name: '選擇' }).first()).toBeVisible();
  await expect(grid.getByText('結束時間', { exact: true })).toHaveCount(0);

  const layout = await grid.evaluate((element) => {
    const horizontalScroll = element.querySelector('.ag-body-horizontal-scroll-viewport');
    return {
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      gridHasHorizontalOverflow: Boolean(horizontalScroll && horizontalScroll.scrollWidth > horizontalScroll.clientWidth + 1)
    };
  });
  expect(layout.pageHasHorizontalOverflow).toBe(false);
  expect(layout.gridHasHorizontalOverflow).toBe(false);
});

test('meeting history detail uses an independent page with timeline, article views, and export controls', async ({ page }) => {
  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([meetingHistoryRecord()])
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meetings/meeting-1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(meetingDetailResponse())
      });
      return;
    }

    await route.fallback();
  });

  await page.goto('/');
  await openMeetingsPage(page);

  await expect(page.getByRole('heading', { name: '翻譯紀錄' })).toBeVisible();
  await expect(meetingItems(page)).toHaveCount(1);
  await expect(meetingItems(page).first().getByText('3 段（完成 1、中斷 1、失敗 1）')).toBeVisible();
  await meetingItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  await expect(page).toHaveURL(/#meeting-detail\?meetingId=meeting-1&from=history$/);
  await expect(page.locator('.history-page')).toHaveCount(0);
  await expect(page.locator('.meeting-detail-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: '會議詳細資料' })).toBeVisible();
  const detail = page.locator('.meeting-detail-page .meeting-detail');
  const detailLayout = await page.evaluate(() => {
    const detailPage = document.querySelector('.meeting-detail-page');
    const detailScroll = document.querySelector('.meeting-detail-page-scroll');
    const pageScroll = document.scrollingElement;
    return {
      pageCanScroll: pageScroll.scrollHeight > pageScroll.clientHeight,
      detailPageVisible: Boolean(detailPage),
      detailScrollEnabled: Boolean(detailScroll && ['auto', 'scroll'].includes(getComputedStyle(detailScroll).overflowY))
    };
  });
  expect(detailLayout.pageCanScroll).toBe(false);
  expect(detailLayout.detailPageVisible).toBe(true);
  expect(detailLayout.detailScrollEnabled).toBe(true);
  const audioDownloads = detail.locator('.audio-artifact-downloads');
  const audioLayout = await audioDownloads.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    columns: getComputedStyle(element).gridTemplateColumns,
    pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
  }));
  expect(audioLayout.height).toBeLessThanOrEqual(120);
  expect(audioLayout.columns.split(' ').length).toBe(2);
  expect(audioLayout.pageHasHorizontalOverflow).toBe(false);
  await expect(detail.getByLabel('會議段落時間軸')).toHaveCount(0);
  await expect(detail.getByText('段落內容', { exact: true })).toHaveCount(0);
  await expect(detail.getByText('第一段翻譯 第二段翻譯 第三段翻譯')).toBeVisible();

  await detail.getByRole('tab', { name: '原始逐字稿' }).click();
  await expect(detail.getByText('第一段原文 第二段原文 第三段原文')).toBeVisible();

  const exportPanel = detail.getByLabel('整場會議逐字稿匯出');
  await expect(exportPanel.getByRole('button', { name: '下載整場逐字稿' })).toBeEnabled();
  await exportPanel.getByRole('combobox', { name: '整場匯出格式' }).selectOption('srt');

  const downloadPromise = page.waitForEvent('download');
  await exportPanel.getByRole('button', { name: '下載整場逐字稿' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const content = await readFile(downloadPath, 'utf8');

  expect(download.suggestedFilename()).toMatch(/^live-translate-meeting-meeting-1-.*-translation\.srt$/);
  expect(content).toContain('00:00:09,000 --> 00:00:10,000\n第一段翻譯');
  expect(content).toContain('00:01:09,000 --> 00:01:10,000\n第二段翻譯');
  expect(content).toContain('00:02:09,000 --> 00:02:10,000\n第三段翻譯');
  expect(content.indexOf('第一段翻譯')).toBeLessThan(content.indexOf('第二段翻譯'));
  expect(content.indexOf('第二段翻譯')).toBeLessThan(content.indexOf('第三段翻譯'));

  await page.getByRole('button', { name: '返回翻譯紀錄' }).click();
  await expect(page).toHaveURL(/#history$/);
  await expect(page.locator('.meeting-detail-page')).toHaveCount(0);

  await page.goto('/#meetings');
  await expect(page.locator('.meetings-page')).toBeVisible();
  await page.locator('.meetings-page .meeting-item').first().getByRole('button', { name: '查看會議詳細資料' }).click();
  await expect(page).toHaveURL(/#meeting-detail\?meetingId=meeting-1&from=meetings$/);
  await expect(page.locator('.meeting-detail-page')).toBeVisible();
  await page.getByRole('button', { name: '返回會議列表' }).click();
  await expect(page).toHaveURL(/#meetings$/);

  await page.goto('/#meeting-detail?meetingId=meeting-1&from=history');
  await expect(page.locator('.meeting-detail-page')).toBeVisible();
  await expect(page.getByText('第一段翻譯 第二段翻譯 第三段翻譯')).toBeVisible();
});

test('completed meeting opens translation history from meeting management without a blank page', async ({ page }) => {
  const detail = meetingDetailResponse();
  detail.meeting = { ...detail.meeting, status: 'completed' };

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([meetingHistoryRecord({ status: 'completed' })])
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meetings/meeting-1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(detail)
      });
      return;
    }

    await route.fallback();
  });

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/#meeting');

  const row = page.locator('.meeting-management-page .meeting-management-data-grid .ag-row').first();
  await expect(row).toContainText('已完成');
  await row.getByRole('button', { name: '查看翻譯紀錄' }).click();

  await expect(page).toHaveURL(/#meeting-workspace\?meetingId=meeting-1&tab=history$/);
  await expect(page.locator('.meeting-workspace-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: '翻譯紀錄' })).toBeVisible();
  await expect(page.getByText('第一段翻譯 第二段翻譯 第三段翻譯')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Meeting Workspace exposes status-specific tabs', async ({ page }) => {
  const baseDetail = meetingDetailResponse();
  const meetings = [
    { id: 'workspace-created', name: '草稿會議', status: 'created' },
    { id: 'workspace-active', name: '進行中會議', status: 'active' },
    { id: 'workspace-interrupted', name: '中斷會議', status: 'interrupted' },
    { id: 'workspace-completed', name: '完成會議', status: 'completed' }
  ];

  await page.unroute('**/api/meetings');
  await page.unroute('**/api/meetings/**');
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(meetings) });
  });
  await page.route('**/api/meetings/**', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const meeting = meetings.find((item) => item.id === id);
    if (!meeting || route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== `/api/meetings/${id}`) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...baseDetail, meeting: { ...baseDetail.meeting, ...meeting } })
    });
  });

  await page.goto('/#meeting-workspace?meetingId=workspace-created&tab=live');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('即時字幕');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('會議字典');
  await expect(page.locator('.meeting-workspace-tabs')).not.toContainText('分享觀看');

  await page.goto('/#meeting-workspace?meetingId=workspace-active&tab=live');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('分享觀看');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('匯出');

  await page.goto('/#meeting-workspace?meetingId=workspace-interrupted&tab=export');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('匯出');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('分享觀看');

  await page.goto('/#meeting-workspace?meetingId=workspace-completed&tab=history');
  await expect(page.locator('.meeting-workspace-tabs')).toContainText('翻譯紀錄');
  await expect(page.locator('.meeting-workspace-tabs')).not.toContainText('即時字幕');
});

test('glossary page creates, edits, and deletes scoped entries', async ({ page }) => {
  const requests = [];
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

  await page.goto('/');
  await page.evaluate(() => { window.location.hash = 'glossary'; });
  await expect(page).toHaveURL(/#meetings\?panel=global-glossary$/);

  await expect(page.getByRole('heading', { name: '全域字典' })).toBeVisible();
  await expect(page.locator('.global-glossary-modal')).toBeVisible();
  await glossaryPanel(page).getByLabel('詞條').fill('microphone');
  await glossaryPanel(page).getByLabel('目標語言').selectOption('ja');
  await glossaryPanel(page).getByLabel('替換成').fill('Alan speak');
  await expect(glossaryPanel(page).getByLabel('字幕替換詞')).toHaveCount(0);
  await glossaryPanel(page).getByLabel('套用範圍').selectOption('live');
  await glossaryPanel(page).getByRole('button', { name: '新增詞條' }).click();

  const glossaryRow = glossaryPanel(page).locator('.glossary-data-grid .ag-row').first();
  await expect(glossaryRow.getByText('microphone', { exact: true })).toBeVisible();
  await expect(glossaryRow.getByText('Alan speak')).toBeVisible();
  await expect(glossaryPanel(page).getByText('套用範圍：即時字幕')).toBeVisible();

  await glossaryPanel(page).getByRole('button', { name: '編輯' }).click();
  await glossaryPanel(page).getByLabel('套用範圍').selectOption('both');
  await glossaryPanel(page).getByRole('button', { name: '更新詞條' }).click();
  await expect(glossaryPanel(page).getByText('套用範圍：兩者')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await glossaryPanel(page).getByRole('button', { name: '刪除' }).click();
  await expect(glossaryPanel(page).getByText('尚無字典詞條。')).toBeVisible();

  expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'DELETE']);
  expect(requests[0].body.scope).toBe('live');
  expect(requests[0].body).toEqual({ source: 'microphone', translations: { ja: 'Alan speak' }, scope: 'live' });
  expect(requests[1].body.scope).toBe('both');
});

test('live translation meeting glossary is read-only', async ({ page }) => {
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
  await expect(page).toHaveURL(/#meeting-workspace\?meetingId=meeting-1&tab=live$/);
  await expect(page.locator('.history-page')).toHaveCount(0);
  await expect(page.locator('.live-sidebar, .feature-navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立會議' })).toBeDisabled();
});

test('missing microphone keeps a retryable error visible', async ({ page }) => {
  let resolveSegmentList;
  const segmentListLoaded = new Promise((resolve) => {
    resolveSegmentList = resolve;
  });
  await mockMeetingCheckpointApi(page, { waitForSegmentList: () => segmentListLoaded });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('No microphone device found', 'NotFoundError');
    };
  });

  await page.goto('/#live?meetingId=meeting-1');
  await page.getByRole('button', { name: '開始' }).click();

  resolveSegmentList();

  await expect(page.getByRole('alert')).toHaveText('找不到可用的麥克風。請連接或允許麥克風後再試一次。');
  await expect(page.locator('.status-pill').getByText('需要處理', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  await expect.poll(() => page.liveTokenRequests.length).toBe(0);
  await expect(page.getByRole('alert')).toHaveText('找不到可用的麥克風。請連接或允許麥克風後再試一次。');
  await expect(page.locator('.status-pill').getByText('需要處理', { exact: true })).toBeVisible();
});

test('starts and stops a mocked Gemini Live translation session', async ({ page }) => {
  page.liveGlossaryEntries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }
  ];
  let releaseTranslatedAudioUpload;
  let markTranslatedAudioUploadStarted;
  const translatedAudioUploadStarted = new Promise((resolve) => {
    markTranslatedAudioUploadStarted = resolve;
  });
  await page.route('**/api/sessions/**/audio/translation/segments/**', async (route) => {
    if (route.request().method() === 'POST') {
      markTranslatedAudioUploadStarted();
      await new Promise((uploadResolve) => {
        releaseTranslatedAudioUpload = uploadResolve;
      });
    }
    await route.fallback();
  });
  await gotoMockMeetingLive(page);

  await expect(page.getByRole('heading', { name: '即時翻譯' })).toBeVisible();
  await expect(page.getByText('準備就緒')).toBeVisible();
  await expect(page.getByText('會議模式：尚未啟用', { exact: true })).toBeVisible();
  await expect(page.getByText('會議模式：尚未保存', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/尚無可下載/)).toHaveCount(0);

  const settingsPanel = await openLiveSettings(page);
  const sourceLanguage = settingsPanel.getByRole('combobox', { name: '我主要說的語言' });
  const targetLanguage = settingsPanel.getByRole('combobox', { name: '目標語言' });

  await expect(sourceLanguage).toHaveValue('zh-Hant');
  await expect(targetLanguage).toHaveValue('en');
  await expect(sourceLanguage).toBeDisabled();
  await expect(targetLanguage).toBeDisabled();
  await page.keyboard.press('Escape');
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

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await translatedAudioUploadStarted;
  await historyItems(page).first().getByRole('button', { name: /查看(詳細資料|內容)/ }).click();
  await expect(sessionDetail(page).locator('.audio-artifact-downloads').getByRole('heading', { name: '語音紀錄下載' })).toBeVisible();
  await expect(sessionDetail(page).getByRole('link', { name: '下載原始語音紀錄' })).toHaveAttribute('aria-disabled', 'true');
  await expect(sessionDetail(page).getByRole('link', { name: '下載翻譯語音紀錄' })).toHaveAttribute('aria-disabled', 'true');

  releaseTranslatedAudioUpload();
  await expect(sessionDetail(page).getByRole('link', { name: '下載翻譯語音紀錄' })).toHaveAttribute(
    'href',
    /\/api\/sessions\/.+\/audio\/translation/
  );
  const savedTranslatedDownloadPromise = page.waitForEvent('download');
  await sessionDetail(page).getByRole('link', { name: '下載翻譯語音紀錄' }).click();
  const savedTranslatedDownload = await savedTranslatedDownloadPromise;
  expect(savedTranslatedDownload.suggestedFilename()).toMatch(/^live-translate-translated-audio-session-[a-z0-9-]+-\d{8}-\d{6}\.wav$/);
});

test('captures and drains first speech while provider connect is delayed', async ({ page }) => {
  await mockMeetingCheckpointApi(page);
  await mockSingleMeetingList(page);
  await page.goto('/');
  await page.evaluate(() => { window.__mockLiveConnectDelayMs = 1000; });
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('正在連線，已暫存音訊')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);

  await emitMicrophoneAudio(page);
  await expect.poll(() => page.evaluate(() => window.__liveTranslateDebug.getSnapshot().preRollBufferedChunkCount)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].sentInputs.length)).toBe(1);
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

test('audio segment upload retries a temporary failure and preserves the saved artifact', async ({ page }) => {
  let uploadAttempts = 0;
  await page.route('**/api/sessions/**/audio/translation/segments/**', async (route) => {
    if (route.request().method() === 'POST' && uploadAttempts++ === 0) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'session_audio_unavailable' } })
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitOutputAudio(page);
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();

  await expect(page.getByText('語音紀錄暫時無法同步，未上傳片段已保留並會在背景持續重試。')).toBeVisible();
  await expect.poll(() => uploadAttempts, { timeout: 12000 }).toBe(2);
  await expect(page.getByRole('alert').filter({ hasText: '長會議同步' })).toBeHidden();
});

test('pause keeps the session content and end exposes microphone recording download', async ({ page }) => {
  await page.goto('/');

  await (await liveSetting(page, '錄下原始聲音')).check();
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'before pause source', 'before pause translation');

  await page.getByRole('button', { name: '暫停' }).click();
  await expect(page.locator('.status-pill').getByText('已暫停', { exact: true })).toBeVisible();
  await expect(page.getByText('before pause source')).toBeVisible();
  await expect(page.getByText('before pause translation')).toBeVisible();
  await expect(page.getByText('原始語音：錄音已暫停，已保留目前片段。')).toBeVisible();
  const pausedLiveUrl = page.url();
  await page.getByRole('link', { name: '翻譯紀錄', exact: true }).click({ force: true });
  await expect(page).toHaveURL(pausedLiveUrl);
  await expect(page.getByRole('alert')).toContainText('錄音進行中');

  await page.getByRole('button', { name: '繼續' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('before pause source')).toBeVisible();
  await emitMicrophoneAudio(page);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.at(-1)?.sentInputs.length || 0)).toBe(1);
  await emitFinalTranscript(page, 'after continue source', 'after continue translation');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByText('after continue source')).toBeVisible();
  await expect(page.getByText('原始語音：音檔已保存，請到翻譯紀錄下載。')).toBeVisible();

  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  const savedInputDownloadPromise = page.waitForEvent('download');
  await sessionDetail(page).getByRole('link', { name: '下載原始語音紀錄' }).click();
  const savedInputDownload = await savedInputDownloadPromise;
  expect(savedInputDownload.suggestedFilename()).toMatch(/^live-translate-input-audio-session-[a-z0-9-]+-\d{8}-\d{6}\.wav$/);
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

test('microphone recording error does not stop live translation', async ({ page }) => {
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
  await expect(page.getByRole('region', { name: '即時翻譯工作區' })).toBeVisible();
  const errorBanner = page.getByRole('alert').filter({ hasText: '長會議同步尚未完成' });
  await expect(errorBanner).toBeVisible();

  const errorBox = await errorBanner.boundingBox();
  const workspaceBox = await page.getByRole('region', { name: '即時翻譯工作區' }).boundingBox();
  expect(errorBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(workspaceBox.y);
});

test('checkpoint sync retries a temporary failure and clears the error after success', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page, { failCheckpointAttempts: 1 });

  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'retry source', 'retry translation');

  await expect.poll(() => checkpointRequests.length, { timeout: 12000 }).toBe(2);
  await expect(page.getByText('會議模式：已保存')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '長會議同步' })).toBeHidden();
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
  await page.getByRole('combobox', { name: '選擇會議' }).click();
  await page.getByRole('option', { name: '測試會議' }).click();
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

test('navigation keeps an active translation session and its article reading state', async ({ page }) => {
  await page.goto('/');
  await expect(historyPanel(page)).toBeHidden();

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'keep this source', 'keep this translation');

  const listeningLiveUrl = page.url();
  await page.getByRole('link', { name: '翻譯紀錄', exact: true }).click({ force: true });
  await expect(page).toHaveURL(listeningLiveUrl);
  await expect(page.getByRole('alert')).toContainText('錄音進行中');
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(liveCuePanel(page)).toBeVisible();
  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(page.getByText('keep this source')).toBeVisible();
  await expect(page.getByText('keep this translation')).toBeVisible();
  await expect(page.getByTestId('cue-empty-state')).toHaveCount(0);
  await expect(page.getByText('逐字稿 / 文章版')).toBeHidden();
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

  await page.goto('/');
  await page.getByRole('combobox', { name: '選擇會議' }).click();
  await page.getByRole('option', { name: '測試會議' }).click();
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '常會議', 'The regular meeting.');
  const cueId = await finalCueRows(page).first().getAttribute('data-cue-id');
  expect(cueId).toBeTruthy();

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
  await expect(translationCueList(page).getByText('The regular meeting.')).toBeVisible();
  await expect(finalCueRows(page).first().getByTestId('cue-source-text')).toHaveText('常會議');
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

test('downloads the active transcript through a browser download', async ({ page }) => {
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

test('active source and translation SRT downloads use the same Cue timeline', async ({ page }) => {
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

test('Stop finalizes visible partial transcripts for export and history', async ({ page }) => {
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
  await page.getByRole('button', { name: '匯出', exact: true }).click();
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '關閉匯出' }).click();
  await openSessionHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
});

test('interim input transcription stays in the same pending pair as formal input', async ({ page }) => {
  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitInterimInputWithOutput(page, 'interim source before final', 'translation already available');

  await expect(partialCueRows(page)).toHaveCount(1);
  await expectCueRow(partialCueRows(page).first(), {
    sourceText: 'interim source before final',
    translatedText: 'translation already available'
  });

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: 'formal source after interim' },
        turnComplete: true
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'interim source before final formal source after interim',
    translatedText: 'translation already available'
  });

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openSessionHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
});

test('stopped session appears in history with language, status, and transcript summary', async ({ page }) => {
  await gotoMockMeetingLive(page, { targetLanguageCode: 'ja' });

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'hello history', '履歴');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openSessionHistoryPage(page);

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item).toBeVisible();
});

test('stopped session can be deleted from history', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'delete source', 'delete translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openSessionHistoryPage(page);

  await expect(historyItems(page)).toHaveCount(1);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page)).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await historyItems(page).first().getByRole('button', { name: '刪除' }).click();

  await expect(historyItems(page)).toHaveCount(1);
});

test('recording and playback settings appear before export fields without overflow', async ({ page }) => {
  await page.unroute('**/api/meetings');
  await page.route('**/api/meetings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'meeting-layout', name: '版面測試會議', status: 'created' }])
    });
  });
  await page.route('**/api/meetings/meeting-layout', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meeting: {
          id: 'meeting-layout',
          name: '版面測試會議',
          status: 'created',
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en',
          glossaryEntries: []
        }
      })
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  page.useMeetingRootForGoto = false;
  await page.goto('/');

  const settingsTrigger = page.getByRole('button', { name: '設定', exact: true });
  await expect(settingsTrigger).toBeVisible();
  await settingsTrigger.click();
  const settingsPanel = page.getByRole('complementary', { name: '即時翻譯設定' });
  await expect(settingsPanel).toBeVisible();
  await expect(settingsPanel.getByLabel('我主要說的語言')).toBeEnabled();
  await expect(settingsPanel.getByLabel('目標語言')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(settingsPanel).toBeHidden();

  const meetingPicker = page.getByRole('combobox', { name: '選擇會議' });
  await meetingPicker.click();
  await page.getByRole('option', { name: '版面測試會議' }).click();

  await expect(settingsTrigger).toBeVisible();
  await settingsTrigger.click();
  await expect(settingsPanel).toBeVisible();
  const playback = page.getByLabel('播放翻譯聲音');
  const recording = page.getByLabel('錄下原始聲音');
  const exportTrigger = page.getByRole('button', { name: '匯出', exact: true });
  await expect(exportTrigger).toBeVisible();
  await expect(settingsPanel.getByLabel('我主要說的語言')).toBeVisible();
  await expect(settingsPanel.getByLabel('目標語言')).toBeVisible();
  await expect(settingsPanel.getByLabel('麥克風')).toBeVisible();
  await expect(playback).toBeVisible();
  await expect(recording).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsPanel).toBeHidden();
  await exportTrigger.click();
  const exportPanel = activeExportPanel(page);
  await expect(exportPanel.getByRole('combobox', { name: '匯出格式' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  await settingsTrigger.click();
  await expect(playback).toBeVisible();
  await expect(recording).toBeVisible();
  const exportButton = page.getByRole('button', { name: '匯出', exact: true });
  await expect(exportButton).toBeVisible();
  const layout = await page.evaluate(() => {
    const card = document.querySelector('.live-settings-card');
    const startButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('開始'));
    const cardRect = card?.getBoundingClientRect();
    const startRect = startButton?.getBoundingClientRect();
    return {
      cardContainsStartButton: Boolean(cardRect && startRect && startRect.bottom <= cardRect.bottom + 1),
      pageCanScrollVertically: document.documentElement.scrollHeight >= window.innerHeight,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  expect(layout.cardContainsStartButton).toBe(true);
  expect(layout.pageCanScrollVertically).toBe(true);
  expect(layout.hasHorizontalOverflow).toBe(false);

  await page.setViewportSize({ width: 1024, height: 600 });
  await page.reload();

  const laptopCard = page.locator('.live-settings-card');
  const laptopStartButton = page.getByRole('button', { name: '開始', exact: true });
  await expect(laptopStartButton).toHaveCount(1);
  const laptopLayoutBeforeScroll = await laptopCard.evaluate((card, startButton) => {
    const cardRect = card.getBoundingClientRect();
    const startRect = startButton.getBoundingClientRect();
    const controls = card.querySelector('.live-settings-controls');
    const statusMessages = card.querySelector('.control-status-messages');
    const actions = card.querySelector('.control-actions');
    const controlsRect = controls?.getBoundingClientRect();
    const statusRect = statusMessages?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    return {
      cardOverflowY: getComputedStyle(card).overflowY,
      controlsOverflowY: getComputedStyle(controls).overflowY,
      cardContentFits: card.scrollHeight <= card.clientHeight + 1,
      pageCanScroll: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight,
      controlsDoNotOverlapStatus: controlsRect.bottom <= statusRect.top + 1,
      statusDoesNotOverlapActions: statusRect.bottom <= actionsRect.top + 1,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  }, await laptopStartButton.elementHandle());
  expect(laptopLayoutBeforeScroll.cardOverflowY).toBe('visible');
  expect(laptopLayoutBeforeScroll.controlsOverflowY).toBe('visible');
  expect(laptopLayoutBeforeScroll.cardContentFits).toBe(true);
  expect(laptopLayoutBeforeScroll.pageCanScroll).toBe(true);
  expect(laptopLayoutBeforeScroll.controlsDoNotOverlapStatus).toBe(true);
  expect(laptopLayoutBeforeScroll.statusDoesNotOverlapActions).toBe(true);
  expect(laptopLayoutBeforeScroll.hasHorizontalOverflow).toBe(false);

  await laptopCard.evaluate((card) => card.scrollIntoView({ block: 'start' }));
  await expect(laptopStartButton).toBeInViewport();
  await expect(laptopCard.getByRole('button', { name: '開始', exact: true })).toBeVisible();
  await expect(laptopCard.getByText(/會議模式：/)).toBeInViewport();

  const laptopTextLayout = await laptopCard.evaluate((card) => {
    const textElements = [...card.querySelectorAll('h2, p, label > span, button')];
    return {
      textWrapEnabled: textElements.every((element) => getComputedStyle(element).overflowWrap === 'anywhere' || getComputedStyle(element).whiteSpace !== 'nowrap'),
      clippedText: textElements.some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow === 'hidden')
    };
  });
  expect(laptopTextLayout.textWrapEnabled).toBe(true);
  expect(laptopTextLayout.clippedText).toBe(false);

  await page.setViewportSize({ width: 1280, height: 550 });
  await page.reload();
  const desktopShortLayout = await page.locator('.live-settings-card').evaluate((card) => {
    const cardRect = card.getBoundingClientRect();
    const controls = [...card.querySelectorAll('.live-settings-controls button, .live-settings-controls a.button, .control-actions button, .control-actions a.button')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({ text: element.textContent.trim(), rect: element.getBoundingClientRect() }));
    const overlaps = controls.some((current, index) => controls.slice(index + 1).some((other) => (
      current.rect.left < other.rect.right && current.rect.right > other.rect.left
      && current.rect.top < other.rect.bottom && current.rect.bottom > other.rect.top
    )));
    return {
      cardHeight: cardRect.height,
      cardContentFits: card.scrollHeight <= card.clientHeight + 1,
      pageCanScroll: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight,
      overflowY: getComputedStyle(card).overflowY,
      controlsOverflowY: getComputedStyle(card.querySelector('.live-settings-controls')).overflowY,
      controlsOverlap: overlaps,
      controlsRemainInCardFlow: controls.every(({ rect }) => rect.top >= cardRect.top && rect.left >= cardRect.left && rect.right <= cardRect.right + 1)
    };
  });
  expect(desktopShortLayout.cardContentFits).toBe(true);
  expect(desktopShortLayout.pageCanScroll).toBe(true);
  expect(desktopShortLayout.overflowY).toBe('visible');
  expect(desktopShortLayout.controlsOverflowY).toBe('visible');
  expect(desktopShortLayout.controlsOverlap).toBe(false);
  expect(desktopShortLayout.controlsRemainInCardFlow).toBe(true);
});

test('live settings actions keep the same width without a long-meeting checkpoint note', async ({ page }) => {
  await mockLiveLayoutMeeting(page, { archivedSegmentCount: 0 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#live?meetingId=4444');

  const card = page.locator('.live-settings-card');
  await expect(card.getByText('會議模式：已保存')).toBeVisible();
  const widths = await card.evaluate((element) => {
    const widthOf = (button) => button.getBoundingClientRect().width;
    return {
      start: widthOf([...element.querySelectorAll('button')].find((button) => button.textContent.includes('開始'))),
      end: widthOf([...element.querySelectorAll('button')].find((button) => button.textContent.includes('結束會議'))),
      export: widthOf(element.querySelector('.live-export-trigger'))
    };
  });

  expect(Math.abs(widths.start - widths.end)).toBeLessThanOrEqual(1);
  expect(Math.abs(widths.start - widths.export)).toBeLessThanOrEqual(1);
});

test('live settings actions keep the same width with a long-meeting checkpoint note', async ({ page }) => {
  await mockLiveLayoutMeeting(page, { archivedSegmentCount: 30 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#live?meetingId=4444');

  const card = page.locator('.live-settings-card');
  await expect(card.getByText('會議模式：已保存')).toBeVisible();
  await expect(card.getByText('保存狀態：長會議已保存 30 段 · 目前段落 0 筆')).toBeVisible();
  const widths = await card.evaluate((element) => {
    const widthOf = (button) => button.getBoundingClientRect().width;
    return {
      start: widthOf([...element.querySelectorAll('button')].find((button) => button.textContent.includes('開始'))),
      end: widthOf([...element.querySelectorAll('button')].find((button) => button.textContent.includes('結束會議'))),
      export: widthOf(element.querySelector('.live-export-trigger'))
    };
  });

  expect(Math.abs(widths.start - widths.end)).toBeLessThanOrEqual(1);
  expect(Math.abs(widths.start - widths.export)).toBeLessThanOrEqual(1);
});

test('stopped session can open and close inline detail with metadata and final transcripts', async ({ page }) => {
  await gotoMockMeetingLive(page, { targetLanguageCode: 'ja' });

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { inputTranscription: { text: 'partial should not save' } }
    });
  });
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { turnComplete: true }
    });
  });
  await emitFinalTranscript(page, 'saved source detail', 'saved translation detail');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openSessionHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
});

test('session detail queues retranslation and displays pending status', async ({ page }) => {
  await page.route('**/api/translation-providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [{ key: 'gemini', label: 'Gemini', model: 'test model' }] })
    });
  });

  await page.route('**/api/sessions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isSessionDetail = request.method() === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname);
    const isRetranslationSubmit = request.method() === 'POST' && url.pathname.endsWith('/retranslations');

    if (isRetranslationSubmit) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-retranslation');
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          request: { id: 'request-fr-1', sessionId, targetLanguageCode: 'fr' },
          execution: { id: 'execution-fr-1', requestId: 'request-fr-1', targetLanguageCode: 'fr', status: 'queued' }
        })
      });
      return;
    }

    if (!isSessionDetail) {
      await route.continue();
      return;
    }

    const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-retranslation');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(sessionDetailResponse({
        sessionId,
        sourceText: 'Hello retranslation',
        translationHistory: {
          outputs: [{
            id: 'legacy-output-fr-1',
            targetLanguageCode: 'fr',
            version: 1,
            source: 'legacy',
            translatedText: 'live output'
          }],
          executions: []
        }
      }))
    });
  });

  await gotoMockMeetingLive(page, { targetLanguageCode: 'ja' });
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'Hello retranslation', 'live output');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByRole('heading', { name: '翻譯內容' })).toBeVisible();
  await detail.getByRole('tab', { name: '原始逐字稿' }).click();
  await expect(detail.getByRole('heading', { name: '原始逐字稿' })).toBeVisible();
  await expect(detail.getByLabel('重新翻譯進度')).toHaveCount(0);
  const retranslation = detail.getByLabel('重新翻譯');

  await retranslation.getByRole('button', { name: '以此原文重新翻譯' }).click();
  await expect(page).toHaveURL(/#retranslate\?sessionId=/);
  const workflow = retranslationPage(page);
  await expect(workflow.getByRole('link', { name: '返回 Session 清單' })).toBeVisible();
  await workflow.getByRole('link', { name: '返回 Session 清單' }).click();
  await expect(page).toHaveURL(/#retranslate$/);
  await expect(workflow.getByLabel('選擇歷史紀錄')).toBeVisible();
  await workflow.getByLabel('選擇歷史紀錄').getByRole('button', { name: '選擇' }).click();
  await expect(page).toHaveURL(/#retranslate\?sessionId=/);
  await expect(workflow.getByRole('heading', { name: '原始逐字稿' })).toBeVisible();
  await expect(workflow.getByText('Hello retranslation')).toBeVisible();
  await expect(workflow.getByLabel('重新翻譯結果').getByText('重新翻譯結果（0）')).toBeVisible();
  await expect(workflow.getByLabel('重新翻譯結果').getByText('尚無重新翻譯結果。')).toBeVisible();
  await workflow.getByRole('combobox', { name: '目標語言' }).selectOption('fr');
  await expect(workflow.getByLabel('使用模型').locator('strong')).toHaveText('test model');
  await workflow.getByRole('button', { name: '開始重新翻譯' }).click();

  await expect(workflow.getByRole('status')).toHaveText('已將法文重新翻譯加入佇列。');
  await expect(workflow.getByLabel('重新翻譯進度').getByText('法文')).toBeVisible();
  await expect(workflow.getByLabel('重新翻譯進度').getByText('已排隊')).toBeVisible();
  await expect(workflow.getByLabel('重新翻譯進度').getByText('live output')).toHaveCount(0);

  await openHistoryPage(page);
  await page.getByRole('link', { name: '重新翻譯' }).click();
  await expect(page).toHaveURL(/#retranslate$/);
  await expect(workflow.getByLabel('選擇歷史紀錄')).toBeVisible();
  await expect(workflow.getByRole('button', { name: '開始重新翻譯' })).toHaveCount(0);
  await workflow.getByLabel('選擇歷史紀錄').getByRole('button', { name: '選擇' }).click();
  await expect(page).toHaveURL(/#retranslate\?sessionId=/);
  await expect(workflow.getByText('Hello retranslation')).toBeVisible();
});

test('completed retranslation stays out of translation history records', async ({ page }) => {
  let submitted = false;
  let postSubmitDetailReads = 0;
  let completed = false;
  let deletedOutput = false;
  const originalSessionId = 'session-complete-retranslation';

  await page.route('**/api/translation-providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [{ key: 'gemini', label: 'Gemini', model: 'test model' }] })
    });
  });

  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        historyRecord({ id: originalSessionId, targetLanguageCode: 'ja', targetLanguageLabel: '日文' })
      ])
    });
  });

  await page.route('**/api/sessions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isTranslationHistory = request.method() === 'GET' && /^\/api\/sessions\/[^/]+\/translations$/.test(url.pathname);
    const isTranslationOutputDelete = request.method() === 'DELETE' && /^\/api\/sessions\/[^/]+\/translations\/[^/]+$/.test(url.pathname);
    const isSessionDetail = request.method() === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname);
    const isRetranslationSubmit = request.method() === 'POST' && url.pathname.endsWith('/retranslations');
    const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-retranslation');

    if (isTranslationOutputDelete) {
      deletedOutput = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: true, sessionId, outputId: 'output-fr-1' })
      });
      return;
    }

    if (isTranslationHistory) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId,
          translations: [],
          translationHistory: !submitted
            ? { outputs: [], executions: [] }
            : completed && !deletedOutput
              ? {
                  outputs: [{
                    id: 'output-fr-1',
                    executionId: 'execution-fr-1',
                    requestId: 'request-fr-1',
                    targetLanguageCode: 'fr',
                    translatedText: 'Bonjour terminé\nDeuxième phrase',
                    version: 1,
                    source: 'formal',
                    completedAt: '2026-07-21T00:00:10.000Z'
                  }],
                  executions: [{
                    id: 'execution-fr-1',
                    requestId: 'request-fr-1',
                    targetLanguageCode: 'fr',
                    status: 'running',
                    providerAttemptStatus: 'in_flight',
                    providerAttemptedAt: new Date(Date.now() - 2000).toISOString()
                  }]
                }
              : {
                  outputs: [],
                  executions: [{
                    id: 'execution-fr-1',
                    requestId: 'request-fr-1',
                    targetLanguageCode: 'fr',
                    status: 'running',
                    providerAttemptStatus: 'in_flight',
                    providerAttemptedAt: new Date(Date.now() - 2000).toISOString()
                  }]
                }
        })
      });
      return;
    }

    if (isRetranslationSubmit) {
      submitted = true;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          request: { id: 'request-fr-1', sessionId, targetLanguageCode: 'fr' },
          execution: { id: 'execution-fr-1', requestId: 'request-fr-1', status: 'queued' }
        })
      });
      return;
    }

    if (isSessionDetail) {
      if (submitted) {
        postSubmitDetailReads += 1;
      }

      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(sessionDetailResponse({
          sessionId: originalSessionId,
          translationHistory: !submitted
            ? { outputs: [], executions: [] }
            : postSubmitDetailReads === 1
              ? { outputs: [], executions: [{ id: 'execution-fr-1', requestId: 'request-fr-1', targetLanguageCode: 'fr', status: 'running', providerAttemptStatus: 'in_flight', providerAttemptedAt: new Date(Date.now() - 2000).toISOString() }] }
              : { outputs: [], executions: [] }
        }))
      });
      return;
    }

    await route.continue();
  });

  await gotoMockMeetingLive(page, { targetLanguageCode: 'ja' });
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'Hello complete retranslation', 'live output');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  const retranslation = detail.getByLabel('重新翻譯');
  await retranslation.getByRole('button', { name: '以此原文重新翻譯' }).click();
  const workflow = retranslationPage(page);
  await workflow.getByRole('combobox', { name: '目標語言' }).selectOption('fr');
  await expect(workflow.getByLabel('使用模型').locator('strong')).toHaveText('test model');
  await workflow.getByRole('button', { name: '開始重新翻譯' }).click();

  await expect(workflow.getByLabel('重新翻譯進度').getByText('正在送往 Gemini')).toBeVisible();
  await expect(workflow.getByLabel('重新翻譯進度').getByText(/已等待 \d+ 秒/)).toBeVisible();
  completed = true;
  const resultWorkspace = workflow.getByLabel('重新翻譯結果與內容');
  const outputList = resultWorkspace.getByLabel('重新翻譯結果');
  const selectionPrompt = resultWorkspace.getByLabel('重新翻譯內容選取');
  await expect(selectionPrompt.getByText('選取一筆重新翻譯結果後查看原文與翻譯文。')).toBeVisible();
  await expect(resultWorkspace.locator('.retranslation-output-list-panel')).toHaveCount(1);
  await expect(resultWorkspace.locator('.retranslation-selection-panel')).toHaveCount(1);
  await expect(outputList.getByText('法文重新翻譯')).toBeVisible();
  await expect(outputList.getByText('已完成')).toBeVisible();
  await expect(workflow.getByLabel('重新翻譯進度').getByText(/已等待 \d+ 秒/)).toHaveCount(0);
  await expect(workflow.getByText('Bonjour terminé')).toHaveCount(0);
  await expect(workflow.getByText('Hello complete retranslation')).toHaveCount(0);
  await expect(workflow.getByText(/v1/)).toHaveCount(0);
  await outputList.getByRole('button', { name: '查看內容' }).click();
  await expect(selectionPrompt).toHaveCount(0);
  await expect(resultWorkspace.getByRole('heading', { name: '重翻逐字稿' })).toBeVisible();
  const retranslationExport = workflow.getByLabel('重新翻譯匯出');
  const sourceArticle = resultWorkspace.getByLabel('原始逐字稿');
  const outputArticle = resultWorkspace.getByLabel('重翻逐字稿');
  await expect(sourceArticle.getByRole('button', { name: '複製' })).toBeEnabled();
  await expect(sourceArticle.getByRole('button', { name: '匯出 TXT' })).toBeEnabled();
  await expect(outputArticle.getByRole('button', { name: '複製' })).toBeEnabled();
  await expect(outputArticle.getByRole('button', { name: '匯出 TXT' })).toBeEnabled();
  await expect(retranslationExport.getByRole('combobox', { name: '匯出格式' })).toHaveValue('txt');
  await expect(retranslationExport.getByRole('combobox', { name: '匯出內容' })).toHaveValue('translation');
  await expect(retranslationExport.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await retranslationExport.getByRole('combobox', { name: '匯出格式' }).selectOption('srt');
  await expect(retranslationExport.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await retranslationExport.getByRole('combobox', { name: '匯出格式' }).selectOption('vtt');
  await expect(retranslationExport.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await retranslationExport.getByRole('combobox', { name: '匯出內容' }).selectOption('both');
  await expect(retranslationExport.getByRole('button', { name: '下載', exact: true })).toBeDisabled();
  await expect(retranslationExport.getByText('SRT 與 VTT 一次只能匯出一個內容。')).toBeVisible();
  await retranslationExport.getByRole('combobox', { name: '匯出內容' }).selectOption('source');
  await expect(retranslationExport.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await expect(resultWorkspace.getByLabel('重新翻譯閱讀區').getByText('Hello complete retranslation')).toBeVisible();
  const retranslatedContent = resultWorkspace.getByLabel('重翻逐字稿內容');
  await expect(retranslatedContent.getByText('Bonjour terminé Deuxième phrase')).toBeVisible();
  await expect(retranslatedContent.locator('p')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await outputList.getByRole('button', { name: '刪除' }).click();
  await expect(outputList.getByText('尚無重新翻譯結果。')).toBeVisible();
  await expect(workflow.getByText('重新翻譯結果已刪除。')).toBeVisible();
  await expect(resultWorkspace.getByText('Bonjour terminé')).toHaveCount(0);
  await expect(retranslationExport).toHaveCount(0);

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('由')).toHaveCount(0);
  if (await sessionDetail(page).count() === 0) {
    await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  }

  const originalDetail = sessionDetail(page);
  await expect(originalDetail.getByRole('heading', { name: '翻譯內容' })).toBeVisible();
  await expect(originalDetail.getByLabel('翻譯內容').getByText('live output')).toBeVisible();
  await expect(originalDetail.getByText('Bonjour terminé')).toHaveCount(0);
});

test('session detail displays failed retranslation reason', async ({ page }) => {
  await page.route('**/api/translation-providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [{ key: 'gemini', label: 'Gemini', model: 'test model' }] })
    });
  });

  const failedTranslationHistory = {
    outputs: [],
    executions: [{
      id: 'execution-fr-failed',
      requestId: 'request-fr-failed',
      targetLanguageCode: 'fr',
      status: 'failed',
      failureInfo: {
        reason: 'provider_execution_failed',
        code: 'unauthorized',
        status: 401,
        message: 'Gemini HTTP request failed: unauthorized (401).'
      }
    }, {
      id: 'execution-de-timeout',
      requestId: 'request-de-timeout',
      targetLanguageCode: 'de',
      status: 'failed',
      providerAttemptStatus: 'failed',
      providerAttemptedAt: '2026-07-21T00:00:00.000Z',
      providerCompletedAt: '2026-07-21T00:00:30.000Z',
      failureInfo: {
        reason: 'provider_execution_failed',
        code: 'provider_timeout',
        status: 504,
        message: 'Gemini saved transcript translation timed out after 30000ms.'
      }
    }, {
      id: 'execution-ja-failed',
      requestId: 'request-ja-failed',
      targetLanguageCode: 'ja',
      status: 'failed',
      failureInfo: {
        reason: 'provider_execution_failed',
        code: 'rate_limited',
        status: 429,
        providerStatus: 'RESOURCE_EXHAUSTED',
        providerMessage: 'Quota exceeded for GenerateRequestsPerMinutePerProject.',
        message: 'Gemini HTTP request failed: rate_limited (429).'
      }
    }]
  };

  await page.route('**/api/sessions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isTranslationHistory = request.method() === 'GET' && /^\/api\/sessions\/[^/]+\/translations$/.test(url.pathname);
    const isSessionDetail = request.method() === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname);

    if (isTranslationHistory) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-retranslation');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ sessionId, translations: [], translationHistory: failedTranslationHistory })
      });
      return;
    }

    if (!isSessionDetail) {
      await route.continue();
      return;
    }

    const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-retranslation');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(sessionDetailResponse({
        sessionId,
        translationHistory: failedTranslationHistory
      }))
    });
  });

  await gotoMockMeetingLive(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'Hello failed retranslation', 'live output');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await sessionDetail(page).getByLabel('重新翻譯').getByRole('button', { name: '以此原文重新翻譯' }).click();

  const progress = retranslationPage(page).getByLabel('重新翻譯進度');
  await expect(progress.getByText('法文')).toBeVisible();
  await expect(progress.getByText('德文')).toBeVisible();
  await expect(progress.getByText('日文')).toBeVisible();
  await expect(progress.locator('.history-status-failed')).toHaveCount(3);
  await expect(progress.getByText('已逾時')).toBeVisible();
  await expect(progress.getByText('失敗原因：Gemini API 金鑰未授權，請確認後端 GEMINI_API_KEY。')).toBeVisible();
  await expect(progress.getByText('失敗原因：Gemini 回應逾時，請稍後重試。')).toBeVisible();
  await expect(progress.getByText('失敗原因：Gemini 暫時限制此請求，可能是短時間速率、Token、模型容量或滾動用量限制；不一定代表每日用量已達上限，請稍後重試。')).toBeVisible();
});

function historyRecord(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    status: overrides.status || 'stopped',
    startedAt: overrides.startedAt ?? 1,
    endedAt: overrides.endedAt ?? 2,
    durationMs: overrides.durationMs ?? 1,
    targetLanguageCode: overrides.targetLanguageCode || 'ja',
    targetLanguageLabel: overrides.targetLanguageLabel || '日文',
    failureReason: overrides.failureReason ?? null,
    failureCategory: overrides.failureCategory ?? null,
    transcriptSummary: overrides.transcriptSummary || {
      totalItems: 2,
      sourceFinalCount: 1,
      translationFinalCount: 1,
      sourcePartialCount: 0,
      translationPartialCount: 0,
      hasTranscript: true
    },
    recordKind: overrides.recordKind || 'session',
    retranslatedFrom: overrides.retranslatedFrom || null
  };
}

function meetingHistoryRecord(overrides = {}) {
  return {
    id: overrides.id || 'meeting-1',
    status: overrides.status || 'active',
    startedAt: overrides.startedAt ?? 1000,
    endedAt: overrides.endedAt ?? 190000,
    durationMs: overrides.durationMs ?? 189000,
    segmentSummary: overrides.segmentSummary || {
      totalSegments: 3,
      countsByStatus: { completed: 1, interrupted: 1, failed: 1 },
      hasInterruptedSegments: true,
      hasFailedSegments: true
    },
    transcriptSummary: overrides.transcriptSummary || {
      totalItems: 6,
      sourceFinalCount: 3,
      translationFinalCount: 3,
      hasTranscript: true
    },
    failureInfo: null,
    recordKind: 'meeting'
  };
}

function meetingDetailResponse() {
  const meeting = meetingHistoryRecord();
  const timeline = [
    { id: 'segment-1', sequence: 0, status: 'completed', startedAt: 1000, endedAt: 60000, durationMs: 59000, liveSessionId: 'live-1', errorInfo: null },
    { id: 'segment-2', sequence: 1, status: 'interrupted', startedAt: 61000, endedAt: 120000, durationMs: 59000, liveSessionId: 'live-2', errorInfo: { reason: 'token_expired', category: 'token' } },
    { id: 'segment-3', sequence: 2, status: 'failed', startedAt: 121000, endedAt: 190000, durationMs: 69000, liveSessionId: 'live-3', errorInfo: { reason: 'provider_error', category: 'provider' } }
  ];
  const transcriptItems = [
    meetingTranscriptItem({ id: 'source-1', segmentId: 'segment-1', segmentSequence: 0, segmentStatus: 'completed', stream: 'source', sequence: 1, text: '第一段原文', startedAt: 10000 }),
    meetingTranscriptItem({ id: 'translation-1', segmentId: 'segment-1', segmentSequence: 0, segmentStatus: 'completed', stream: 'translation', sequence: 2, text: '第一段翻譯', startedAt: 11000 }),
    meetingTranscriptItem({ id: 'source-2', segmentId: 'segment-2', segmentSequence: 1, segmentStatus: 'interrupted', stream: 'source', sequence: 3, text: '第二段原文', startedAt: 70000 }),
    meetingTranscriptItem({ id: 'translation-2', segmentId: 'segment-2', segmentSequence: 1, segmentStatus: 'interrupted', stream: 'translation', sequence: 4, text: '第二段翻譯', startedAt: 71000 }),
    meetingTranscriptItem({ id: 'source-3', segmentId: 'segment-3', segmentSequence: 2, segmentStatus: 'failed', stream: 'source', sequence: 5, text: '第三段原文', startedAt: 130000 }),
    meetingTranscriptItem({ id: 'translation-3', segmentId: 'segment-3', segmentSequence: 2, segmentStatus: 'failed', stream: 'translation', sequence: 6, text: '第三段翻譯', startedAt: 131000 })
  ];

  return {
    meeting,
    segments: timeline.map((segment) => ({
      ...segment,
      meetingId: 'meeting-1',
      checkpointUpdatedAt: segment.endedAt,
      transcriptSummary: { totalItems: 2, sourceFinalCount: 1, translationFinalCount: 1, hasTranscript: true }
    })),
    timeline,
    transcriptItems,
    readingContent: {
      sourceTranscript: {
        kind: 'sourceTranscript',
        status: 'available',
        text: '第一段原文 第二段原文 第三段原文',
        paragraphs: ['第一段原文 第二段原文 第三段原文'],
        createdAt: 1000,
        finalizedAt: 190000
      },
      translationArticle: {
        kind: 'translationArticle',
        status: 'available',
        text: '第一段翻譯 第二段翻譯 第三段翻譯',
        paragraphs: ['第一段翻譯 第二段翻譯 第三段翻譯'],
        createdAt: 1000,
        completedAt: 190000
      }
    },
    recordKind: 'meeting'
  };
}

function meetingTranscriptItem(overrides = {}) {
  return {
    meetingId: 'meeting-1',
    status: 'final',
    finalizedAt: overrides.startedAt + 1000,
    liveSessionId: `live-${overrides.segmentSequence + 1}`,
    ...overrides
  };
}

function sessionDetailResponse({ sessionId, sourceText = 'Hello complete retranslation', translationHistory, recordKind = 'session', retranslatedFrom = null, selectedTranslationOutput, readingContent }) {
  return {
    session: { id: sessionId, status: 'stopped', startedAt: 1, endedAt: 2, durationMs: 1, failureReason: null, failureCategory: null, transcriptSummary: { totalItems: 2, sourceFinalCount: 1, translationFinalCount: 1, sourcePartialCount: 0, translationPartialCount: 0, hasTranscript: true }, recordKind, retranslatedFrom },
    sourceTranscript: { id: `source:${sessionId}`, sessionId, revisionId: 'source:final', status: 'finalized', items: [{ id: 'source-1', stream: 'source', status: 'final', text: sourceText, sequence: 0, startedAt: 1, finalizedAt: 2 }], createdAt: 1, finalizedAt: 2 },
    translationOutputs: [],
    selectedTranslationOutput: selectedTranslationOutput || { id: `legacy-output:${sessionId}:ja`, targetLanguageCode: 'ja', items: [{ id: 'translation-1', stream: 'translation', status: 'final', text: 'live output' }] },
    readingContent,
    translationHistory,
    legacy: false
  };
}

test('saved SRT and VTT export are enabled when timing exists', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'timed source', 'timed translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const panel = savedExportPanel(page);
  await panel.getByRole('combobox', { name: '已儲存逐字稿匯出內容' }).selectOption('source');
  await panel.getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('srt');
  await expect(panel.getByRole('button', { name: '下載已儲存的逐字稿' })).toBeEnabled();

  await panel.getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('vtt');
  await expect(panel.getByRole('button', { name: '下載已儲存的逐字稿' })).toBeEnabled();
  await expect(panel.getByText('已儲存字幕的時間碼採用原始工作階段觀察時間。')).toBeVisible();
});

test('downloads saved Cue TXT, SRT, and VTT through browser downloads', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'saved download source', 'saved download translation', { waitMs: 1800 });
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const panel = savedExportPanel(page);
  const downloadSaved = async (format) => {
    await panel.getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption(format);
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下載已儲存的逐字稿' }).click();
    const download = await downloadPromise;
    return {
      download,
      content: await readFile(await download.path(), 'utf8')
    };
  };

  const txt = await downloadSaved('txt');
  expect(txt.download.suggestedFilename()).toMatch(/^live-translate-session-.*\.txt$/);
  expect(txt.content).toContain('saved download translation');

  const srt = await downloadSaved('srt');
  expect(srt.download.suggestedFilename()).toMatch(/^live-translate-session-.*\.srt$/);
  expect(srt.content).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\nsaved download translation\n/);

  const vtt = await downloadSaved('vtt');
  expect(vtt.download.suggestedFilename()).toMatch(/^live-translate-session-.*\.vtt$/);
  expect(vtt.content).toMatch(/^WEBVTT\n\n\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\nsaved download translation\n/);
});

test('both stream is unavailable for saved SRT and VTT export', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'source subtitle', 'translation subtitle');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const panel = savedExportPanel(page);
  await panel.getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('srt');
  await panel.getByRole('combobox', { name: '已儲存逐字稿匯出內容' }).selectOption('both');

  await expect(panel.getByRole('button', { name: '下載已儲存的逐字稿' })).toBeDisabled();
  await expect(panel.getByText('SRT 與 VTT 一次只能匯出一個內容。')).toBeVisible();

  await panel.getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('vtt');
  await expect(panel.getByRole('button', { name: '下載已儲存的逐字稿' })).toBeDisabled();
});

test('no transcript detail shows empty state', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);

  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  await expect(sessionDetail(page).getByRole('heading', { name: '翻譯內容' })).toBeVisible();
  await expect(sessionDetail(page).getByText('尚無翻譯內容。')).toBeVisible();
  await sessionDetail(page).getByRole('tab', { name: '原始逐字稿' }).click();
  await expect(sessionDetail(page).getByText('尚無原始逐字稿。')).toBeVisible();
  await expect(savedExportPanel(page).getByRole('button', { name: '下載已儲存的逐字稿' })).toBeDisabled();
});

test('switching saved session resets saved export controls', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'first source', 'first translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.getByLabel('即時翻譯工作區').getByText('已停止', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'second source', 'second translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(2);

  await historyItems(page).nth(1).getByRole('button', { name: '查看詳細資料' }).click();
  await savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('vtt');
  await savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出內容' }).selectOption('source');

  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  await expect(savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出格式' })).toHaveValue('txt');
  await expect(savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出內容' })).toHaveValue('translation');
});

test('saved export controls do not alter active export controls', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '匯出', exact: true }).click();
  await activeExportPanel(page).getByRole('combobox', { name: '匯出格式' }).selectOption('vtt');
  await activeExportPanel(page).getByRole('combobox', { name: '匯出內容' }).selectOption('source');
  await activeExportPanel(page).getByRole('button', { name: '關閉匯出' }).click();
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'source export separation', 'translation export separation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  await savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('srt');
  await savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出內容' }).selectOption('translation');

  await openLivePage(page);
  await page.getByRole('button', { name: '匯出', exact: true }).click();
  await expect(activeExportPanel(page).getByRole('combobox', { name: '匯出格式' })).toHaveValue('vtt');
  await expect(activeExportPanel(page).getByRole('combobox', { name: '匯出內容' })).toHaveValue('source');
});

test('failed session appears in history with normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。')).toBeVisible();
  await openHistoryPage(page);

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('失敗', { exact: true })).toBeVisible();
});

test('failed session detail shows normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。')).toBeVisible();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByText('失敗原因')).toBeVisible();
  await expect(detail.getByText('unexpected_close')).toBeVisible();
  await expect(detail.getByText('失敗類別')).toBeVisible();
  await expect(detail.getByText('翻譯服務暫時失敗')).toBeVisible();
});

test('token expiration reconnect does not finalize history until user stops', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(0);

  await openLivePage(page);
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  const item = historyItems(page).last();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('已停止', { exact: true })).toBeVisible();
});

test('manual Start after a finalized session does not clear previous history', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);

  await openLivePage(page);
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('已停止', { exact: true })).toBeVisible();
});

test('reconnect does not create duplicate history record', async ({ page }) => {
  await gotoMockMeetingLive(page);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'before reconnect', 'after reconnect');

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(0);

  await openLivePage(page);
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.getByLabel('即時翻譯工作區').getByText('已停止', { exact: true })).toBeVisible();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('已停止', { exact: true })).toBeVisible();
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

test('selected microphone disconnect falls back on reconnect', async ({ page }) => {
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
      code: 'auth_failed',
      message: 'raw auth failure token abc123 at Provider.stack'
    });
  });

  await expect(page.getByText('存取失敗', { exact: true })).toBeVisible();
  await expect(page.getByText('存取失敗。請檢查存取權杖或設定。')).toBeVisible();
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
  await mockSingleMeetingList(page);
  await page.goto('/');

  await page.getByRole('combobox', { name: '選擇會議' }).click();
  await page.getByRole('option', { name: '測試會議' }).click();
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

  await expect(page.locator('.live-app-shell')).toBeVisible();
  await expect(page.getByRole('link', { name: '會議管理' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.getByText('MEETING SETUP')).toBeHidden();
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立會議', exact: true }).last()).toBeVisible();
  await expect(page.locator('.meeting-management-page > .history-panel')).toBeVisible();

  await expect(page.locator('.meeting-management-data-grid .ag-row')).toHaveCount(1);
  await expect(page.locator('.meeting-management-page ul.history-list')).toHaveCount(0);
  await expect(page.getByRole('row', { name: /既有產品會議/ })).toBeVisible();

  const meetingGridLayout = await page.locator('.meeting-management-data-grid').evaluate((element) => {
    const gridRect = element.getBoundingClientRect();
    const scrollRect = element.parentElement.getBoundingClientRect();
    const panelRect = element.closest('.history-panel').getBoundingClientRect();
    const root = element.querySelector('.ag-root-wrapper');
    const scroll = element.parentElement;
    const cell = element.querySelector('.ag-cell');
    return {
      gridFitsPanel: gridRect.bottom <= panelRect.bottom + 1,
      pageFitsViewport: document.scrollingElement.scrollHeight <= document.scrollingElement.clientHeight,
      layout: root?.className || '',
      overflowY: getComputedStyle(scroll).overflowY,
      overflowX: getComputedStyle(scroll).overflowX,
      cellAlignItems: cell ? getComputedStyle(cell).alignItems : '',
      rootHeight: root?.getBoundingClientRect().height || 0,
      gridRect: { top: gridRect.top, bottom: gridRect.bottom, height: gridRect.height },
      scrollRect: { top: scrollRect.top, bottom: scrollRect.bottom, height: scrollRect.height },
      panelRect: { top: panelRect.top, bottom: panelRect.bottom, height: panelRect.height }
    };
  });
  expect(meetingGridLayout.gridFitsPanel).toBe(true);
  expect(meetingGridLayout.pageFitsViewport).toBe(true);
  expect(meetingGridLayout.layout).toContain('ag-layout-normal');
  expect(meetingGridLayout.overflowY).toBe('auto');
  expect(meetingGridLayout.overflowX).toBe('auto');
  expect(meetingGridLayout.cellAlignItems).toBe('center');
  expect(meetingGridLayout.rootHeight).toBeLessThanOrEqual(meetingGridLayout.scrollRect.height);
  expect(meetingGridLayout.scrollRect.height).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1024, height: 600 });
  const laptopMeetingLayout = await page.locator('.meeting-management-data-grid').evaluate((element) => {
    const mainText = [...element.querySelectorAll('.meeting-name-cell')];
    return {
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      mainTextCanWrap: mainText.every((cell) => getComputedStyle(cell).overflowWrap === 'anywhere'),
      clippedMainText: mainText.some((cell) => cell.scrollWidth > cell.clientWidth + 1 && getComputedStyle(cell).overflow === 'hidden')
    };
  });
  expect(laptopMeetingLayout.pageHasHorizontalOverflow).toBe(false);
  expect(laptopMeetingLayout.mainTextCanWrap).toBe(true);
  expect(laptopMeetingLayout.clippedMainText).toBe(false);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole('row', { name: /既有產品會議/ }).getByRole('button', { name: '編輯' }).click();
  await expect(page.getByRole('heading', { name: '編輯會議設定' })).toBeVisible();
  await expect(page.getByLabel('會議名稱')).toHaveValue('既有產品會議');
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toBeVisible();
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
  await page.getByRole('button', { name: '建立會議', exact: true }).click();

  await expect(page.getByRole('status')).toHaveText('會議已建立。');
  await expect(page.getByRole('button', { name: '儲存變更', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回會議清單', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立錄音分享連結' })).toBeEnabled();
  await expect(page.locator('.meeting-management-grid > .control-panel')).toHaveCount(2);
  const cardWidths = await page.locator('.meeting-management-grid > .control-panel').evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().width)));
  expect(cardWidths[0]).toBe(cardWidths[1]);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '返回會議清單' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  const createdMeetingRow = page.getByRole('row').filter({ has: page.getByText('產品會議', { exact: true }) });
  await createdMeetingRow.getByRole('button', { name: '刪除' }).click();
  await expect(createdMeetingRow).toHaveCount(0);
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
  await page.getByRole('row', { name: /新測試會議/ }).getByRole('button', { name: '編輯' }).click();
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

test('live translation offers resumable meetings and loads selected settings', async ({ page }) => {
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

test('live route redirects when the meeting does not exist', async ({ page }) => {
  await page.goto('/#live?meetingId=missing-meeting');

  await expect(page).toHaveURL(/#meeting$/);
  await expect(page.getByRole('alert')).toHaveText('會議連結不存在或已失效，請重新選擇已建立的會議。');

  await openHistoryPage(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
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
        { id: 'meeting-active', name: '產品評審', status: 'active', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', updatedAt: 1700000000000 },
        { id: 'meeting-paused', name: '客戶訪談', status: 'interrupted', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', updatedAt: 1700000001000 },
        { id: 'meeting-completed', name: '已完成簡報', status: 'completed', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', updatedAt: 1700000002000 }
      ])
    });
  });

  await page.goto('/#meetings');
  await expect(page).toHaveURL(/#meetings$/);
  await expect(page.getByRole('heading', { name: '會議管理' })).toBeVisible();
  await expect(page.locator('.meeting-management-data-grid .ag-row')).toHaveCount(3);
  await expect(page.getByRole('row', { name: /產品評審/ })).toContainText('繁體中文 → 日文');
  await expect(page.getByRole('row', { name: /產品評審/ })).toContainText(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/);
  await expect(page.locator('.meeting-management-data-grid .ag-paging-panel')).toBeHidden();

  await page.setViewportSize({ width: 768, height: 800 });
  const narrowMeetingLayout = await page.locator('.meeting-management-page').evaluate((pageElement) => {
    const toolbar = pageElement.querySelector('.meeting-table-toolbar');
    const search = pageElement.querySelector('.meeting-search-field');
    const dictionaryButton = pageElement.querySelector('.meeting-table-toolbar > .button');
    const tableScroll = pageElement.querySelector('.meeting-table-scroll');
    const actionButton = pageElement.querySelector('.meeting-actions .button');
    return {
      toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : '',
      toolbarWraps: search && dictionaryButton ? dictionaryButton.getBoundingClientRect().top > search.getBoundingClientRect().bottom : false,
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      tableCanScrollHorizontally: tableScroll ? tableScroll.scrollWidth > tableScroll.clientWidth : false,
      actionHeight: actionButton?.getBoundingClientRect().height || 0
    };
  });
  expect(narrowMeetingLayout.toolbarDisplay).toBe('grid');
  expect(narrowMeetingLayout.toolbarWraps).toBe(true);
  expect(narrowMeetingLayout.pageHasHorizontalOverflow).toBe(false);
  expect(narrowMeetingLayout.tableCanScrollHorizontally).toBe(true);
  expect(narrowMeetingLayout.actionHeight).toBeGreaterThanOrEqual(44);

  await page.getByLabel('搜尋會議').fill('產品');
  await expect(page.locator('.meeting-management-data-grid .ag-row')).toHaveCount(1);
  await expect(page.getByRole('row', { name: /產品評審/ })).toContainText('進行中');

  await page.getByLabel('搜尋會議').fill('');
  await page.getByLabel('篩選狀態').selectOption('interrupted');
  await expect(page.locator('.meeting-management-data-grid .ag-row')).toHaveCount(1);
  await expect(page.getByRole('row', { name: /客戶訪談/ })).toContainText('已暫停／可繼續');
  await expect(page.getByRole('row', { name: /客戶訪談/ }).getByRole('button', { name: '繼續即時字幕' })).toBeVisible();
});
