import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const resetResponse = await page.request.delete('/api/test/sessions');
  expect(resetResponse.status()).toBe(204);
  page.liveTokenRequests = [];
  page.failLiveTokenRequestAt = null;

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
        expiresAt: '2026-07-07T00:30:00.000Z'
      })
    });
  });
});

function historyPanel(page) {
  return page.locator('.history-panel');
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

async function openHistoryPage(page) {
  await page.getByRole('link', { name: '翻譯紀錄' }).click();
  await expect(page).toHaveURL(/#history$/);
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
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '即時翻譯' })).toBeVisible();
  await expect(page.getByText('準備就緒')).toBeVisible();

  const targetLanguage = page.getByRole('combobox', { name: '目標語言' });

  await expect(targetLanguage).toHaveValue('en');
  await targetLanguage.selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();

  await expect(page.getByText('聆聽中')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__mockGoogleGenAI?.liveConnects.length || 0))
    .toBe(1);
  await expect(targetLanguage).toBeDisabled();

  const liveConnect = await page.evaluate(() => {
    const request = window.__mockGoogleGenAI.liveConnects[0];
    return {
      model: request.model,
      targetLanguageCode: request.config.generationConfig.translationConfig.targetLanguageCode,
      responseModalities: request.config.responseModalities
    };
  });
  expect(liveConnect).toEqual({
    model: 'gemini-3.5-live-translate-preview',
    targetLanguageCode: 'ja',
    responseModalities: ['AUDIO']
  });

  await page.getByRole('button', { name: '停止' }).click();

  await expect(page.locator('.status-pill').getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.every((track) => track.stopped))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].closed)).toBe(true);
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
  await expect(sourcePanel.locator('.article-content')).toContainText('第一句 第二句 第三句');
  await expect(translationPanel.locator('.article-content')).toContainText('第一句翻譯 第二句翻譯 第三句翻譯');
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
  await expect(sourcePanel.locator('.article-content')).toContainText('漢語 軟體 腳踏車');
  await expect(translationPanel.locator('.article-content')).toContainText('汉语 软件 自行车');
  await expect(sourcePanel.getByRole('button', { name: /整理成文章/ })).toHaveCount(0);
  await expect(translationPanel.getByRole('button', { name: /整理成文章/ })).toHaveCount(0);

  await emitFinalTranscript(page, 'new article source', 'new article translation');
  await expect(sourcePanel.locator('.article-content')).toContainText('漢語 軟體 腳踏車 new article source');
  await expect(translationPanel.locator('.article-content')).toContainText('汉语 软件 自行车 new article translation');
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
  await expect(sessionDetail(page).getByText('partial source on stop')).toBeVisible();
  await expect(sessionDetail(page).getByLabel('翻譯逐字稿').getByText('partial translation on stop')).toBeVisible();
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
  await expect(detail.getByText('目標語言')).toBeVisible();
  await expect(detail.getByText('日文', { exact: true })).toBeVisible();
  await expect(detail.getByText('狀態')).toBeVisible();
  await expect(detail.getByText('已停止', { exact: true })).toBeVisible();
  await expect(detail.getByText('開始時間')).toBeVisible();
  await expect(detail.getByText('結束時間')).toBeVisible();
  await expect(detail.getByText('持續時間')).toBeVisible();
  await expect(detail.getByText(/原文完成：\d+ · 翻譯完成：\d+/)).toBeVisible();
  await expect(detail.getByRole('heading', { name: '原文逐字稿' })).toBeVisible();
  await expect(detail.getByText('saved source detail')).toBeVisible();
  await expect(detail.getByRole('heading', { name: '翻譯逐字稿' })).toBeVisible();
  await expect(detail.getByLabel('翻譯逐字稿').getByText('saved translation detail')).toBeVisible();
  await expect(detail.getByLabel('原文逐字稿').locator('.session-transcript-article')).toContainText('saved source detail');
  await expect(detail.getByLabel('翻譯逐字稿').locator('.session-transcript-article')).toContainText('saved translation detail');
  await expect(detail.getByLabel('原文逐字稿').locator('.session-transcript-list')).toHaveCount(0);
  await expect(detail.getByLabel('翻譯逐字稿').locator('.session-transcript-list')).toHaveCount(0);
  await expect(savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出格式' })).toHaveValue('txt');
  await expect(savedExportPanel(page).getByRole('combobox', { name: '已儲存逐字稿匯出內容' })).toHaveValue('translation');
  await expect(savedExportPanel(page).getByRole('button', { name: '下載已儲存的逐字稿' })).toBeEnabled();

  await detail.getByRole('button', { name: '關閉詳細資料' }).click();
  await expect(sessionDetail(page)).toBeHidden();
  await expect(historyItems(page)).toHaveCount(1);
});

test('session detail omits the extra translation history section', async ({ page }) => {
  let translationHistoryRequests = 0;

  await page.route('**/api/sessions/**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/translations')) {
      translationHistoryRequests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'session-history',
          translations: [
            historyTranslation({ id: 'request-ja-1', targetLanguageCode: 'ja', translatedText: 'こんにちは' }),
            historyTranslation({ id: 'request-ja-2', targetLanguageCode: 'ja', translatedText: '世界' }),
            historyTranslation({ id: 'request-fr-1', targetLanguageCode: 'fr', translatedText: 'Bonjour' })
          ]
        })
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        session: { id: 'session-history', status: 'completed', startedAt: 1, endedAt: 2, durationMs: 1, failureReason: null, failureCategory: null, transcriptSummary: { totalItems: 1, sourceFinalCount: 1, translationFinalCount: 0, sourcePartialCount: 0, translationPartialCount: 0, hasTranscript: true } },
        sourceTranscript: { id: 'source:session-history', sessionId: 'session-history', revisionId: 'source:final', status: 'finalized', items: [{ id: 'source-1', stream: 'source', status: 'final', text: 'Hello こんにちは' }], createdAt: 1, finalizedAt: 2 },
        translationOutputs: [], selectedTranslationOutput: null, legacy: false
      })
    });
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: '目標語言' }).selectOption('ja');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  await emitFinalTranscript(page, 'Hello こんにちは', 'live output');
  await page.getByRole('button', { name: '停止' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: '查看詳細資料' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByRole('heading', { name: '原文逐字稿' })).toBeVisible();
  await expect(detail.getByRole('heading', { name: '翻譯逐字稿' })).toBeVisible();
  await expect(detail.getByLabel('翻譯紀錄')).toHaveCount(0);
  await expect(detail.getByText('Bonjour')).toHaveCount(0);
  expect(translationHistoryRequests).toBe(0);
});

function historyTranslation({ id, targetLanguageCode, translatedText }) {
  return {
    request: { id, sourceText: 'Hello こんにちは', targetLanguageCode, createdAt: '2026-07-21T00:00:00.000Z' },
    execution: { id: `execution-${id}`, translationRequestId: id, status: 'completed', startedAt: '2026-07-21T00:00:01.000Z', completedAt: '2026-07-21T00:00:02.000Z', failureInfo: null },
    output: { id: `output-${id}`, executionId: `execution-${id}`, translatedText, targetLanguageCode, createdAt: '2026-07-21T00:00:02.000Z' },
    sourceLanguageDetections: [{ transcriptItemId: 'source-1', detectedLanguageCodes: ['en', 'ja'], coverage: 'partial' }]
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

  await expect(sessionDetail(page).getByText('沒有已儲存的逐字稿。')).toBeVisible();
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
