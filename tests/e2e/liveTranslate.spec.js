import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const resetResponse = await page.request.delete('/api/test/sessions');
  expect(resetResponse.status()).toBe(204);
  page.liveTokenRequests = [];
  page.failLiveTokenRequestAt = null;
  page.liveGlossaryEntries = [];

  await page.addInitScript(() => {
    window.__mockMicTracks = [];
    window.__mockAudioContexts = [];
    window.__mockAudioProcessors = [];
    window.__mockMediaRecorders = [];

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const track = {
            kind: 'audio',
            stopped: false,
            stop() {
              this.stopped = true;
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
        window.__mockAudioContexts.push(this);
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

  await page.route('**/api/meetings', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([])
    });
  });
});

function historyPanel(page) {
  return page.locator('.history-page > .history-panel:not(.meeting-panel)');
}

function historyItems(page) {
  return historyPanel(page).locator('.history-item');
}

function meetingsPanel(page) {
  return historyPanel(page);
}

function meetingItems(page) {
  return meetingsPanel(page).locator('.meeting-item');
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
  return page.locator('.export-panel');
}

function glossaryPanel(page) {
  return page.locator('.glossary-panel');
}

function retranslationPage(page) {
  return page.locator('.retranslation-workflow');
}

async function mockMeetingCheckpointApi(page, { failCheckpoint = false, waitForSegmentList = null } = {}) {
  const checkpointRequests = [];
  const rolloverRequests = [];
  const recoverRequests = [];
  const checkpoints = new Map();
  let latestSegmentNumber = 1;

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

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

    const segmentMatch = url.pathname.match(/^\/api\/meetings\/meeting-1\/segments\/(segment-\d+)\/checkpoint$/);
    if (method === 'PUT' && segmentMatch) {
      const body = JSON.parse(request.postData() || '{}');
      checkpointRequests.push(body);

      if (failCheckpoint) {
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

async function openHistoryPage(page) {
  await page.getByRole('link', { name: '翻譯紀錄', exact: true }).click();
  await expect(page).toHaveURL(/#history$/);
}

async function openMeetingsPage(page) {
  await openHistoryPage(page);
}

async function openGlossaryPage(page) {
  await page.getByRole('link', { name: '翻譯字典' }).click();
  await expect(page).toHaveURL(/#glossary$/);
}

async function openLivePage(page) {
  await page.getByRole('link', { name: '即時翻譯' }).click();
  await expect(page).toHaveURL(/#live$/);
}

async function emitFinalTranscript(page, sourceText = 'history source', translationText = 'history translation') {
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
  await expect(historyPanel(page).getByText('尚無翻譯紀錄。')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
});

test('meeting history detail shows timeline, article views, and export controls', async ({ page }) => {
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

  const detail = meetingItems(page).first().locator('.meeting-detail');
  const timeline = detail.getByLabel('會議段落時間軸');
  await expect(timeline.getByText('段落 1')).toBeVisible();
  await expect(timeline.getByText('段落 2')).toBeVisible();
  await expect(timeline.getByText('段落 3')).toBeVisible();
  await expect(timeline.getByText('已中斷')).toBeVisible();
  await expect(timeline.locator('.history-status-failed').getByText('失敗', { exact: true })).toBeVisible();
  await expect(detail.getByLabel('段落 2 原文').getByText('第二段原文')).toBeVisible();
  await expect(detail.getByLabel('段落 2 翻譯').getByText('第二段翻譯')).toBeVisible();
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
  await openGlossaryPage(page);

  await expect(glossaryPanel(page).getByRole('heading', { name: '翻譯字典' })).toBeVisible();
  await glossaryPanel(page).getByLabel('詞條').fill('microphone');
  await glossaryPanel(page).getByLabel('目標語言').selectOption('ja');
  await glossaryPanel(page).getByLabel('替換成').fill('Alan speak');
  await expect(glossaryPanel(page).getByLabel('字幕替換詞')).toHaveCount(0);
  await glossaryPanel(page).getByLabel('套用範圍').selectOption('live');
  await glossaryPanel(page).getByRole('button', { name: '新增詞條' }).click();

  await expect(glossaryPanel(page).getByText('microphone → Alan speak')).toBeVisible();
  await expect(glossaryPanel(page).getByText('套用範圍：即時翻譯')).toBeVisible();

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

test('active session is not shown while listening', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await openHistoryPage(page);

  await expect(historyPanel(page).getByText('尚無翻譯紀錄。')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
  await expect(historyPanel(page).getByRole('button', { name: '查看詳細資料' })).toHaveCount(0);
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

  await expect(page.getByRole('alert')).toHaveText('找不到可用的麥克風。請連接或允許麥克風後再試一次。');
  await expect(page.locator('.status-pill').getByText('需要處理', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  await expect.poll(() => page.liveTokenRequests.length).toBe(0);
  resolveSegmentList();
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
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '即時翻譯' })).toBeVisible();
  await expect(page.getByText('準備就緒')).toBeVisible();

  const sourceLanguage = page.getByRole('combobox', { name: '主要輸入語言' });
  const targetLanguage = page.getByRole('combobox', { name: '目標語言' });

  await expect(sourceLanguage).toHaveValue('zh-Hant');
  await expect(targetLanguage).toHaveValue('en');
  await sourceLanguage.selectOption('en');
  await targetLanguage.selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();

  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__mockGoogleGenAI?.liveConnects.length || 0))
    .toBe(1);
  await expect(sourceLanguage).toBeDisabled();
  await expect(targetLanguage).toBeDisabled();
  expect(page.liveTokenRequests[0]).toEqual({
    targetLanguageCode: 'ja',
    sourceLanguageCode: 'en',
    echoTargetLanguage: true
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
    targetLanguageCode: 'ja',
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
  await expect(page.getByText('未錄製講者原音。')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載原始語音' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下載翻譯語音' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__mockMediaRecorders.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.every((track) => track.stopped))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].closed)).toBe(true);

  const translatedDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載翻譯語音' }).click();
  const translatedDownload = await translatedDownloadPromise;
  expect(translatedDownload.suggestedFilename()).toMatch(/^live-translate-translated-audio-session-[a-z0-9-]+-\d{8}-\d{6}\.wav$/);

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await translatedAudioUploadStarted;
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page).getByRole('heading', { name: '語音紀錄下載' })).toBeVisible();
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

test('pause keeps the session content and end exposes microphone recording download', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('錄製講者原音').check();
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'before pause source', 'before pause translation');

  await page.getByRole('button', { name: '暫停' }).click();
  await expect(page.locator('.status-pill').getByText('已暫停', { exact: true })).toBeVisible();
  await expect(page.getByText('before pause source')).toBeVisible();
  await expect(page.getByText('before pause translation')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載原始語音' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下載翻譯語音' })).toBeDisabled();
  await openHistoryPage(page);
  await expect(historyPanel(page).getByText('尚無翻譯紀錄。')).toBeVisible();

  await openLivePage(page);
  await page.getByRole('button', { name: '繼續' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('before pause source')).toBeVisible();
  await emitMicrophoneAudio(page);
  await emitFinalTranscript(page, 'after continue source', 'after continue translation');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByText('after continue source')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載原始語音' })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載原始語音' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-input-audio-session-[a-z0-9-]+-\d{8}-\d{6}\.wav$/);

  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  const savedInputDownloadPromise = page.waitForEvent('download');
  await sessionDetail(page).getByRole('link', { name: '下載原始語音紀錄' }).click();
  const savedInputDownload = await savedInputDownloadPromise;
  expect(savedInputDownload.suggestedFilename()).toMatch(/^live-translate-input-audio-session-[a-z0-9-]+-\d{8}-\d{6}\.wav$/);
});

test('microphone recording error does not stop live translation', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('錄製講者原音').check();
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
  await expect(page.getByText('長會議同步：準備同步')).toBeVisible();

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
  await expect(page.getByText('長會議同步：已同步')).toBeVisible();
});

test('long meeting proactively switches through three segments and preserves confirmed transcript', async ({ page }) => {
  await page.addInitScript(() => {
    window.__liveTranslateSegmentSwitchIntervalMs = 700;
  });
  const checkpointRequests = await mockMeetingCheckpointApi(page);

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitFinalTranscript(page, 'segment one source', 'segment one translation');
  await expect.poll(() => checkpointRequests.rolloverRequests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(2);
  await expect(page.locator('.status-pill').getByText('下一段已開始', { exact: true })).toBeVisible();
  await expect(page.getByText('長會議段落：已封存 1 段 · 已載入 1 段 · 目前段落 0 筆')).toBeVisible();

  await emitFinalTranscript(page, 'segment two source', 'segment two translation');
  await expect.poll(() => checkpointRequests.rolloverRequests.length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(3);
  await expect(page.getByText('長會議段落：已封存 2 段 · 已載入 2 段 · 目前段落 0 筆')).toBeVisible();

  await emitFinalTranscript(page, 'segment three source', 'segment three translation');
  await expect(page.getByText('長會議段落：已封存 2 段 · 已載入 2 段 · 目前段落 2 筆')).toBeVisible();
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

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  for (let index = 0; index < 12; index += 1) {
    await emitFinalTranscript(page, `soak segment ${index + 1} source`, `soak segment ${index + 1} translation`);
    await expect.poll(() => checkpointRequests.rolloverRequests.length, { timeout: 7000 }).toBe(index + 1);
  }

  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBe(13);
  await emitFinalTranscript(page, 'soak segment 13 source', 'soak segment 13 translation');
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

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'sync failure source', 'sync failure translation');

  await expect(page.getByText('長會議同步：同步失敗，等待重試')).toBeVisible({ timeout: 6500 });
  await expect(page.locator('.status-pill').getByText('聆聽中', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('長會議同步暫時失敗');
});

test('reload with meeting id restores checkpoint and allows manual resume', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
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

  await page.getByRole('button', { name: '繼續錄製' }).click();
  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => checkpointRequests.recoverRequests.length).toBe(1);
  expect(checkpointRequests.recoverRequests[0].body.failureReason).toBe('manual_resume');
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitFinalTranscript(page, 'after resume source', 'after resume translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByTestId('legacy-transcript-fallback')).toBeVisible();
  await expect(detail.getByText('before reload translation after resume translation')).toBeVisible();
  await detail.getByRole('tab', { name: '原始逐字稿' }).click();
  await expect(detail.getByText('before reload source after resume source')).toBeVisible();
});

test('empty meeting resume draft does not show continue recording action', async ({ page }) => {
  await mockMeetingCheckpointApi(page);

  await page.goto('/#live?meetingId=meeting-1');

  await expect(page.getByText('長會議同步：已同步')).toBeVisible();
  await expect(page.getByRole('button', { name: '繼續錄製' })).toBeHidden();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
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

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await openGlossaryPage(page);
  await glossaryPanel(page).getByLabel('詞條').fill('microphone');
  await glossaryPanel(page).getByLabel('替換成').fill('Alan speak');
  await glossaryPanel(page).getByLabel('套用範圍').selectOption('live');
  await glossaryPanel(page).getByRole('button', { name: '新增詞條' }).click();
  await expect(glossaryPanel(page).getByText('字典詞條已新增。')).toBeVisible();

  await openLivePage(page);
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

  await openHistoryPage(page);
  await expect(historyPanel(page).getByText('尚無翻譯紀錄。')).toBeVisible();

  await openLivePage(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(liveCuePanel(page)).toBeVisible();
  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(page.getByText('keep this source')).toBeVisible();
  await expect(page.getByText('keep this translation')).toBeVisible();
  await expect(page.getByTestId('cue-empty-state')).toHaveCount(0);
  await expect(page.getByText('逐字稿 / 文章版')).toBeHidden();
});

test('final Cues stay paired and one partial Cue remains at the tail', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    for (const [sourceText, translationText] of [
      ['第一句', '第一句翻譯'],
      ['第二句', '第二句翻譯'],
      ['第三句', '第三句翻譯']
    ]) {
      session.emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
    }
    session.emitMessage({
      serverContent: {
        inputTranscription: { text: '第四句辨識中' },
        outputTranscription: { text: '第四句翻譯中' }
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(3);
  await expect(partialCueRows(page)).toHaveCount(1);
  await expectCueRow(partialCueRows(page).first(), {
    sourceText: '第四句辨識中',
    translatedText: '第四句翻譯中'
  });
});

test('repeated speech merges into one live Cue with cumulative translation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    session.emitMessage({
      serverContent: {
        inputTranscription: { text: '123' },
        outputTranscription: { text: '1, 2, 3' },
        turnComplete: true
      }
    });
    session.emitMessage({
      serverContent: {
        inputTranscription: { text: '123' },
        outputTranscription: { text: '1, 2, 3, 1, 2' }
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '123 123',
    translatedText: '1, 2, 3, 1, 2'
  });
});

test('cumulative speech updates the preceding final Cue without leaving a partial row', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions.at(-1);
    session.emitMessage({
      serverContent: {
        inputTranscription: { text: '你好' },
        outputTranscription: { text: 'Hello' },
        turnComplete: true
      }
    });
    session.emitMessage({
      serverContent: {
        inputTranscription: { text: '你好,你好。' },
        outputTranscription: { text: 'Hello, hello.' }
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page)).toHaveCount(0);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '你好,你好。',
    translatedText: 'Hello, hello.'
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
        inputTranscription: { text: '這是一個完整句末。' }
      }
    });
  });

  await expect(finalCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page)).toHaveCount(0);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '這是一個完整句末。',
    translatedText: '這是一個完整句末'
  });
});

test('page scroll stops follow-latest until the user returns to the latest subtitle', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  for (let index = 0; index < 5; index += 1) {
    await emitFinalTranscript(page, `scroll source ${index}`, `scroll translation ${index}`);
  }

  await expect(cueList(page)).toHaveCSS('overflow-y', 'visible');
  await expect(cueList(page)).toHaveCSS('max-height', 'none');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect(page.getByTestId('follow-latest-button')).toBeVisible();

  const scrollTopBeforeNewCue = await page.evaluate(() => window.scrollY);
  await emitFinalTranscript(page, 'scroll source newest', 'scroll translation newest');
  await expect(finalCueRows(page)).toHaveCount(6);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollTopBeforeNewCue);

  await page.getByTestId('follow-latest-button').click();
  await expect(page.getByTestId('follow-latest-button')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollTopBeforeNewCue);
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

  await expect(partialCueRows(page)).toHaveCount(0, { timeout: 3500 });
  await expect(partialCueRows(page)).toHaveCount(0);
  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: 'idle source finalizes',
    translatedText: 'idle translation finalizes'
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

  await expect(partialCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page).first()).toHaveText(/it's a voice input\./);

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { turnComplete: true }
    });
  });

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

  await emitFinalTranscript(page, '其實，', 'Actually,');
  await emitFinalTranscript(page, '很', "it's very");
  await emitFinalTranscript(page, '現在，', 'Right now,');

  await expect(finalCueRows(page)).toHaveCount(1);
  await expectCueRow(finalCueRows(page).first(), {
    sourceText: '其實，很現在，',
    translatedText: "Actually, it's very Right now,"
  });
});

test('replaced pending Cue text remains one partial preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: 'pending sour' }
      }
    });
  });
  await expect(partialCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page).first().getByTestId('cue-source-text')).toHaveText('pending sour');

  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: 'pending source' }
      }
    });
  });
  await expect(partialCueRows(page).first().getByTestId('cue-source-text')).toHaveText('pending source');

  await page.waitForTimeout(2600);
  await expect(partialCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page).first().getByTestId('cue-source-text')).toHaveText('pending source');

  await expect(partialCueRows(page)).toHaveCount(1, { timeout: 1500 });
  await expect(finalCueRows(page)).toHaveCount(0);
});

test('downloads the active transcript through a browser download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'download source', 'download translation');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-transcript-.*\.txt$/);
});

test('active source and translation SRT downloads use the same Cue timeline', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'first source', 'first translation');
  await emitFinalTranscript(page, 'second source', 'second translation');

  const exportPanel = page.locator('.export-panel');
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

  await emitFinalTranscript(page, 'new article source', 'new article translation');
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
  await emitFinalTranscript(page, '第一段原文', '第一段翻譯');
  await emitFinalTranscript(page, '第二段原文', '第二段翻譯');

  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) => { window.__copiedText = value; };
  });
  await page.getByRole('button', { name: '複製原文' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText)).toBe('第一段原文\n第二段原文');
  await page.getByRole('button', { name: '複製翻譯' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText)).toBe('第一段翻譯\n第二段翻譯');
});

test('Stop finalizes visible partial transcripts for export and history', async ({ page }) => {
  await page.goto('/');
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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page).getByTestId('session-cue-list')).toBeVisible();
  await expect(sessionDetail(page).getByTestId('session-cue-list').getByTestId('cue-final-row')).toHaveCount(1);
  await expect(sessionDetail(page).getByTestId('session-cue-list').getByTestId('cue-partial-row')).toHaveCount(0);
  await expect(sessionDetail(page).getByTestId('session-cue-list').getByTestId('cue-source-text')).toHaveText('partial source on stop');
  await expect(sessionDetail(page).getByTestId('session-cue-list').getByTestId('cue-translated-text')).toHaveText('partial translation on stop');
});

test('interim input transcription keeps source visible before formal input finalizes it', async ({ page }) => {
  await page.goto('/');
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
    sourceText: 'interim source before final',
    translatedText: 'translation already available'
  });
  await expect(partialCueRows(page)).toHaveCount(1);
  await expect(partialCueRows(page).first().getByTestId('cue-source-text')).toHaveText('formal source after interim');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page).getByTestId('session-cue-list').getByTestId('cue-final-row')).toHaveCount(1);
  await expectCueRow(sessionDetail(page).getByTestId('session-cue-list').getByTestId('cue-final-row').first(), {
    sourceText: 'interim source before final',
    translatedText: 'translation already available'
  });
});

test('stopped session appears in history with language, status, and transcript summary', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'hello history', '履歴');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByRole('heading', { name: '日文' })).toBeVisible();
  await expect(item.getByText('已停止', { exact: true })).toBeVisible();
  await expect(item.getByText('原文完成：1 · 翻譯完成：1')).toBeVisible();
});

test('stopped session can be deleted from history', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'delete source', 'delete translation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);

  await expect(historyItems(page)).toHaveCount(1);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page)).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await historyItems(page).first().getByRole('button', { name: '刪除' }).click();

  await expect(sessionDetail(page)).toBeHidden();
  await expect(historyItems(page)).toHaveCount(0);
  await expect(historyPanel(page).getByText('尚無翻譯紀錄。')).toBeVisible();
});

test('stopped session can open and close inline detail with metadata and final transcripts', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: { inputTranscription: { text: 'partial should not save' } }
    });
  });
  await emitFinalTranscript(page, 'saved source detail', 'saved translation detail');

  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByRole('heading', { name: '日文詳細資料' })).toBeVisible();
  await expect(detail.getByText('目標語言', { exact: true })).toBeVisible();
  await expect(detail.getByText('日文', { exact: true })).toBeVisible();
  await expect(detail.getByText('狀態')).toBeVisible();
  await expect(detail.getByText('已停止', { exact: true })).toBeVisible();
  await expect(detail.getByText('開始時間')).toBeVisible();
  await expect(detail.getByText('結束時間')).toBeVisible();
  await expect(detail.getByText('持續時間')).toBeVisible();
  await expect(detail.getByText(/原文完成：\d+ · 翻譯完成：\d+/)).toBeVisible();
  await expect(detail.getByTestId('session-cue-list')).toBeVisible();
  await expect(detail.getByTestId('history-cue-columns')).toContainText('原文');
  await expect(detail.getByTestId('history-cue-columns')).toContainText('翻譯');
  await expect(detail.getByTestId('cue-final-row').locator('.cue-text-toggle')).toHaveCSS(
    'grid-template-columns',
    /\S+\s+\S+/
  );
  await expect(detail.getByTestId('session-cue-list').getByTestId('cue-final-row')).toHaveCount(1);
  await expect(detail.getByTestId('session-cue-list').getByTestId('cue-partial-row')).toHaveCount(0);
  await expect(detail.getByTestId('session-cue-list').getByTestId('cue-source-text')).toHaveText('saved source detail');
  await expect(detail.getByTestId('session-cue-list').getByTestId('cue-translated-text')).toHaveText('saved translation detail');
  await expect(savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出格式' })).toHaveValue('txt');
  await expect(savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出內容' })).toHaveValue('translation');
  await expect(savedExportPanel(page).getByRole('button', { name: '下載已儲存的逐字稿' })).toBeEnabled();

  await historyItems(page).first().getByRole('button', { name: '關閉詳細資料' }).click();
  await expect(sessionDetail(page)).toBeHidden();
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

  await page.goto('/');
  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'Hello retranslation', 'live output');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByRole('heading', { name: '文章版翻譯' })).toBeVisible();
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

  await page.goto('/');
  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
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
  await expect(originalDetail.getByRole('heading', { name: '文章版翻譯' })).toBeVisible();
  await expect(originalDetail.getByLabel('文章版翻譯').getByText('live output')).toBeVisible();
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

  await page.goto('/');
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
  await emitFinalTranscript(page, 'saved download source', 'saved download translation');
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

  await expect(sessionDetail(page).getByRole('heading', { name: '文章版翻譯' })).toBeVisible();
  await expect(sessionDetail(page).getByText('尚無文章版翻譯。')).toBeVisible();
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
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();

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
  await page.goto('/');

  await activeExportPanel(page).getByRole('combobox', { name: '匯出格式' }).selectOption('vtt');
  await activeExportPanel(page).getByRole('combobox', { name: '匯出內容' }).selectOption('source');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'source export separation', 'translation export separation');
  await page.getByRole('button', { name: '結束本次工作階段' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  await savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出格式' }).selectOption('srt');
  await savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出內容' }).selectOption('translation');

  await openLivePage(page);
  await expect(activeExportPanel(page).getByRole('combobox', { name: '匯出格式' })).toHaveValue('vtt');
  await expect(activeExportPanel(page).getByRole('combobox', { name: '匯出內容' })).toHaveValue('source');
});

test('failed session appears in history with normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

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
  await expect(item.getByText('原因：unexpected_close')).toBeVisible();
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
  await expect(detail.getByText('provider')).toBeVisible();
});

test('token expiration reconnect does not finalize history until user stops', async ({ page }) => {
  await page.goto('/');

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
  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('已停止', { exact: true })).toBeVisible();
});

test('manual Start after a finalized session does not clear previous history', async ({ page }) => {
  await page.goto('/');

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
  await page.goto('/');

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
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('已停止', { exact: true })).toBeVisible();
});

test('reconnects once after mocked unexpected close and preserves transcript', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await page.goto('/');

  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();

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
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
});

test('token expired recovers with a fresh token and preserves transcript', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await page.goto('/');

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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();

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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
});

test('browser suspended recovery preserves checkpointed transcript after wake', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);
  await page.goto('/');

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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
});

test('auth failed shows friendly message without reconnect', async ({ page }) => {
  await page.goto('/');

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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('rate limited shows friendly message without reconnect', async ({ page }) => {
  await page.goto('/');

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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
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
  await page.goto('/');

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
  await page.goto('/');

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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect(page.getByText('無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();

  page.failLiveTokenRequestAt = null;
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect.poll(() => page.liveTokenRequests.length).toBe(3);
});

test('retry exhaustion shows explicit error and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
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
  await expect(page.getByRole('button', { name: '下載', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(4);
});
