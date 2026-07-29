import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const resetResponse = await page.request.delete('/api/test/sessions');
  expect(resetResponse.status()).toBe(204);
  page.liveTokenRequests = [];
  page.failLiveTokenRequestAt = null;
  page.liveGlossaryEntries = [];

  await page.addInitScript(() => {
    window.__mockMicTracks = [];

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
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createScriptProcessor() {
        return { connect() {}, disconnect() {}, onaudioprocess: null };
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
});

function historyPanel(page) {
  return page.locator('.history-page > .history-panel');
}

function historyItems(page) {
  return historyPanel(page).locator('.history-item');
}

function sessionDetail(page) {
  return page.locator('.session-detail');
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

async function mockMeetingCheckpointApi(page, { failCheckpoint = false } = {}) {
  const checkpointRequests = [];

  await page.route('**/api/meetings**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'POST' && url.pathname === '/api/meetings') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          meeting: { id: 'meeting-1', status: 'active' },
          segment: { id: 'segment-1', meetingId: 'meeting-1', sequence: 0, status: 'active' }
        })
      });
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/meetings/meeting-1/segments/segment-1/checkpoint') {
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

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meetingId: 'meeting-1',
          segmentId: 'segment-1',
          checkpoint: {
            idempotencyKey: body.idempotencyKey,
            durableChunks: body.durableChunks,
            pendingPartial: null,
            updatedAt: 1000
          }
        })
      });
      return;
    }

    await route.fallback();
  });

  return checkpointRequests;
}

async function openHistoryPage(page) {
  await page.getByRole('link', { name: '翻譯紀錄' }).click();
  await expect(page).toHaveURL(/#history$/);
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

async function emitTurnComplete(page) {
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({ serverContent: { turnComplete: true } });
  });
}

test('initial history shows empty state', async ({ page }) => {
  await page.goto('/');
  await openHistoryPage(page);

  await expect(historyPanel(page).getByRole('heading', { name: '翻譯紀錄' })).toBeVisible();
  await expect(historyPanel(page).getByText('尚無工作階段紀錄。')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
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

  await expect(historyPanel(page).getByText('尚無工作階段紀錄。')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
  await expect(historyPanel(page).getByRole('button', { name: '查看詳細資料' })).toHaveCount(0);
});

test('starts and stops a mocked Gemini Live translation session', async ({ page }) => {
  page.liveGlossaryEntries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }
  ];
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
  await expect(page.locator('.transcript-panel').nth(0).locator('.transcript-current')).toContainText('麥克風');
  await expect(page.locator('.transcript-panel').nth(1).locator('.transcript-current')).toContainText('Alan speak and Alan speak');
  await expect(page.locator('.transcript-panel').nth(1).locator('.transcript-current')).not.toContainText('microphone and mic');

  await page.getByRole('button', { name: '停止' }).click();

  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.every((track) => track.stopped))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].closed)).toBe(true);
});

test('live session creates a meeting checkpoint and flushes final chunks on Stop', async ({ page }) => {
  const checkpointRequests = await mockMeetingCheckpointApi(page);

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('長會議同步：準備同步')).toBeVisible();

  await emitPartialTranscript(page, 'checkpoint source', 'checkpoint translation');
  await page.getByRole('button', { name: '停止' }).click();

  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
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

test('live glossary replacement is applied to final translation article text only', async ({ page }) => {
  page.liveGlossaryEntries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: [] }
  ];
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'microphone', 'microphone');

  const sourcePanel = page.locator('.transcript-panel').nth(0);
  const translationPanel = page.locator('.transcript-panel').nth(1);
  await expect(sourcePanel.locator('.article-content')).toContainText('microphone');
  await expect(translationPanel.locator('.article-content')).toContainText('Alan speak');
  await expect(translationPanel.locator('.article-content')).not.toContainText('microphone');
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

  const sourcePanel = page.locator('.transcript-panel').nth(0);
  const translationPanel = page.locator('.transcript-panel').nth(1);
  await expect(sourcePanel.locator('.article-content')).toContainText('microphone');
  await expect(translationPanel.locator('.article-content')).toContainText('Alan speak');
  await expect(translationPanel.locator('.article-content')).not.toContainText('microphone');
});

test('navigation keeps an active translation session and its article reading state', async ({ page }) => {
  await page.goto('/');
  await expect(historyPanel(page)).toBeHidden();

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'keep this source', 'keep this translation');

  await openHistoryPage(page);
  await expect(historyPanel(page).getByText('尚無工作階段紀錄。')).toBeVisible();

  await openLivePage(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByRole('heading', { name: '原文文章' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '翻譯文章' })).toBeVisible();
  await expect(page.getByText('keep this source')).toBeVisible();
  await expect(page.getByText('keep this translation')).toBeVisible();
  await expect(page.getByLabel('文章版閱讀區').locator('.transcript-panel')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /整理成文章/ })).toHaveCount(0);
  await expect(page.getByText('逐字稿 / 文章版')).toBeHidden();
});

test('live article panels show completed paragraphs and keep pending text as status', async ({ page }) => {
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

  const sourcePanel = page.locator('.transcript-panel').nth(0);
  const translationPanel = page.locator('.transcript-panel').nth(1);
  await expect(sourcePanel.locator('.transcript-history-item')).toHaveCount(0);
  await expect(translationPanel.locator('.transcript-history-item')).toHaveCount(0);
  await expect(sourcePanel.locator('.article-content')).toContainText('第一句第二句第三句');
  await expect(translationPanel.locator('.article-content')).toContainText('第一句翻譯第二句翻譯第三句翻譯');
  await expect(sourcePanel.locator('.transcript-current')).toHaveText('辨識中…第四句辨識中');
  await expect(translationPanel.locator('.transcript-current')).toHaveText('翻譯中…第四句翻譯中');
});

test('cumulative sentence translation keeps the ending in the current panel and article', async ({ page }) => {
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

  const translationPanel = page.locator('.transcript-panel').nth(1);
  await expect(translationPanel.locator('.transcript-current')).toHaveText('翻譯中…這是一個完整句末');
  await expect(translationPanel.locator('.article-content')).toHaveCount(0);

  await emitTurnComplete(page);

  await expect(translationPanel.locator('.transcript-current')).toHaveCount(0);
  await expect(translationPanel.locator('.article-content')).toContainText('這是一個完整句末');
});

test('idle pending transcripts are promoted into article paragraphs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await emitPartialTranscript(page, 'idle source finalizes', 'idle translation finalizes');

  const sourcePanel = page.locator('.transcript-panel').nth(0);
  const translationPanel = page.locator('.transcript-panel').nth(1);
  await expect(sourcePanel.locator('.transcript-current')).toHaveText('辨識中…idle source finalizes');
  await expect(translationPanel.locator('.transcript-current')).toHaveText('翻譯中…idle translation finalizes');

  await expect(sourcePanel.locator('.transcript-current')).toHaveCount(0, { timeout: 4500 });
  await expect(translationPanel.locator('.transcript-current')).toHaveCount(0);
  await expect(sourcePanel.locator('.article-content')).toContainText('idle source finalizes');
  await expect(translationPanel.locator('.article-content')).toContainText('idle translation finalizes');
  await expect(sourcePanel.getByRole('button', { name: '複製' })).toBeEnabled();
  await expect(translationPanel.getByRole('button', { name: '匯出 TXT' })).toBeEnabled();
});

test('idle finalization ignores replaced pending transcript text', async ({ page }) => {
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
  const sourcePanel = page.locator('.transcript-panel').nth(0);
  await expect(sourcePanel.locator('.transcript-current')).toHaveText('辨識中…pending sour');

  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
      serverContent: {
        inputTranscription: { text: 'pending source' }
      }
    });
  });
  await expect(sourcePanel.locator('.transcript-current')).toHaveText('辨識中…pending source');

  await page.waitForTimeout(2600);
  await expect(sourcePanel.locator('.transcript-current')).toHaveText('辨識中…pending source');
  await expect(sourcePanel.locator('.article-content')).toHaveCount(0);

  await expect(sourcePanel.locator('.transcript-current')).toHaveCount(0, { timeout: 1500 });
  await expect(sourcePanel.locator('.article-content')).toContainText('pending source');
});

test('downloads the active transcript through a browser download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'download source', 'download translation');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-transcript-.*\.txt$/);
});

test('source and translation article panels render local final text separately without organize controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, '汉语 软件 自行车', '汉语 软件 自行车');

  const sourcePanel = page.locator('.transcript-panel').nth(0);
  const translationPanel = page.locator('.transcript-panel').nth(1);
  await expect(sourcePanel.locator('.article-content')).toContainText('漢語軟體腳踏車');
  await expect(translationPanel.locator('.article-content')).toContainText('汉语软件自行车');
  await expect(sourcePanel.getByRole('button', { name: /整理成文章/ })).toHaveCount(0);
  await expect(translationPanel.getByRole('button', { name: /整理成文章/ })).toHaveCount(0);

  await emitFinalTranscript(page, 'new article source', 'new article translation');
  await expect(sourcePanel.locator('.article-content')).toContainText('漢語軟體腳踏車 new article source');
  await expect(translationPanel.locator('.article-content')).toContainText('汉语软件自行车 new article translation');
  await expect(page.getByText('內容已更新，請重新整理。')).toHaveCount(0);
});

test('Stop finalizes visible partial transcripts for export and history', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitPartialTranscript(page, 'partial source on stop', 'partial translation on stop');

  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.locator('.transcript-panel').nth(0).locator('.transcript-history-item')).toHaveCount(0);
  await expect(page.locator('.transcript-panel').nth(1).locator('.transcript-history-item')).toHaveCount(0);
  await expect(page.locator('.transcript-current')).toHaveCount(0);
  await expect(page.locator('.transcript-panel').nth(0).locator('.article-content')).toContainText('partial source on stop');
  await expect(page.locator('.transcript-panel').nth(1).locator('.article-content')).toContainText('partial translation on stop');
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page).getByLabel('文章版翻譯').getByText('partial translation on stop')).toBeVisible();
  await sessionDetail(page).getByRole('tab', { name: '原始逐字稿' }).click();
  await expect(sessionDetail(page).getByLabel('原始逐字稿').getByText('partial source on stop')).toBeVisible();
});

test('stopped session appears in history with language, status, and transcript summary', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'hello history', '履歴');

  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();
  await openHistoryPage(page);

  await expect(historyItems(page)).toHaveCount(1);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();
  await expect(sessionDetail(page)).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await historyItems(page).first().getByRole('button', { name: '刪除' }).click();

  await expect(sessionDetail(page)).toBeHidden();
  await expect(historyItems(page)).toHaveCount(0);
  await expect(historyPanel(page).getByText('尚無工作階段紀錄。')).toBeVisible();
});

test('stopped session can open and close inline detail with metadata and final transcripts', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitPartialTranscript(page, 'partial should not save', 'partial translation should not save');
  await emitFinalTranscript(page, 'saved source detail', 'saved translation detail');

  await page.getByRole('button', { name: '停止' }).click();
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
  await expect(detail.getByRole('tab', { name: '文章版翻譯' })).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('heading', { name: '文章版翻譯' })).toBeVisible();
  await expect(detail.getByLabel('文章版翻譯').locator('.session-transcript-article')).toContainText('saved translation detail');
  await expect(detail.getByText('saved source detail')).toHaveCount(0);
  await expect(detail.locator('.session-transcript-list')).toHaveCount(0);
  await detail.getByRole('tab', { name: '原始逐字稿' }).click();
  await expect(detail.getByRole('tab', { name: '原始逐字稿' })).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('heading', { name: '原始逐字稿' })).toBeVisible();
  await expect(detail.getByLabel('原始逐字稿').locator('.session-transcript-article')).toContainText('saved source detail');
  await expect(detail.getByText('saved translation detail')).toHaveCount(0);
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
  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();
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
  await expect(retranslationExport.getByRole('button', { name: '下載' })).toBeEnabled();
  await retranslationExport.getByRole('combobox', { name: '匯出格式' }).selectOption('srt');
  await expect(retranslationExport.getByRole('button', { name: '下載' })).toBeEnabled();
  await retranslationExport.getByRole('combobox', { name: '匯出格式' }).selectOption('vtt');
  await expect(retranslationExport.getByRole('button', { name: '下載' })).toBeEnabled();
  await retranslationExport.getByRole('combobox', { name: '匯出內容' }).selectOption('both');
  await expect(retranslationExport.getByRole('button', { name: '下載' })).toBeDisabled();
  await expect(retranslationExport.getByText('SRT 與 VTT 一次只能匯出一個內容。')).toBeVisible();
  await retranslationExport.getByRole('combobox', { name: '匯出內容' }).selectOption('source');
  await expect(retranslationExport.getByRole('button', { name: '下載' })).toBeEnabled();
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

  await page.route('**/api/sessions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isSessionDetail = request.method() === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname);

    if (!isSessionDetail) {
      await route.continue();
      return;
    }

    const sessionId = decodeURIComponent(url.pathname.split('/')[3] || 'session-retranslation');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(sessionDetailResponse({
        sessionId,
        translationHistory: {
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
        }
      }))
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'Hello failed retranslation', 'live output');
  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();
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

test('downloads a saved transcript through a browser download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'saved download source', 'saved download translation');
  await page.getByRole('button', { name: '停止' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const downloadPromise = page.waitForEvent('download');
  await savedExportPanel(page).getByRole('button', { name: '下載已儲存的逐字稿' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-session-.*\.txt$/);
});

test('both stream is unavailable for saved SRT and VTT export', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'source subtitle', 'translation subtitle');
  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'second source', 'second translation');
  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();
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

test('expired session appears in history with expired status', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await openHistoryPage(page);
  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('已過期', { exact: true })).toBeVisible();
  await expect(item.getByText('原因：token_expired')).toBeVisible();
});

test('expired session detail shows normalized failure reason', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByText('失敗原因')).toBeVisible();
  await expect(detail.getByText('token_expired')).toBeVisible();
  await expect(detail.getByText('失敗類別')).toBeVisible();
  await expect(detail.getByText('token', { exact: true })).toBeVisible();
});

test('manual Start after a finalized session does not clear previous history', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await page.getByRole('button', { name: '停止' }).click();
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
  await page.getByRole('button', { name: '停止' }).click();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('已停止', { exact: true })).toBeVisible();
});

test('reconnects once after mocked unexpected close and preserves transcript', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();
});

test('token expired shows friendly message without reconnect and preserves transcript', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await expect(page.getByText('工作階段已過期', { exact: true })).toBeVisible();
  await expect(page.getByText('工作階段已過期。請開始新的工作階段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止' })).toBeHidden();
  await expect(page.getByText('before token expiration')).toBeVisible();
  await expect(page.getByText('still visible after expiration')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);

  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect(page.getByText('before token expiration')).toBeHidden();
  await expect(page.getByText('still visible after expiration')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
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
  await expect(page.getByRole('button', { name: '停止' })).toBeHidden();
  await expect(page.getByText('before auth failure')).toBeVisible();
  await expect(page.getByText('auth failure transcript')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();
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
  await expect(page.getByRole('button', { name: '停止' })).toBeHidden();
  await expect(page.getByText('before rate limit')).toBeVisible();
  await expect(page.getByText('rate limit transcript')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();
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

  await page.getByRole('button', { name: '停止' }).click();
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
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('正在重新連線', { exact: true })).toBeVisible();
  await expect(page.getByText('無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();

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
  await expect(page.getByRole('button', { name: '下載' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(4);
});
