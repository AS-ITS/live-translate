import { expect, test } from '@playwright/test';

const LOCALIZED_UI_TEXT = {
  'Access failed': '存取失敗',
  'Access failed. Please check your access token or configuration.': '存取失敗。請檢查存取權杖或設定。',
  'Close details': '關閉詳細資料',
  'Detected source languages: en, ja': '偵測到的原文語言：en, ja',
  'Download': '下載',
  'Download saved': '下載已儲存的逐字稿',
  'Duration': '持續時間',
  'Ended': '結束時間',
  'Expired': '已過期',
  'Export format': '匯出格式',
  'Export stream': '匯出內容',
  'Failed': '失敗',
  'Failure category': '失敗類別',
  'Failure reason': '失敗原因',
  'Filter output language': '篩選輸出語言',
  'Japanese': '日文',
  'Japanese details': '日文詳細資料',
  'Listening': '聆聽中',
  'Live Translate': '即時翻譯',
  'Live transcripts': '即時逐字稿',
  'Live translation': '即時翻譯',
  'Live translation could not reconnect after repeated attempts. You can start a new session when ready.': '即時翻譯多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。',
  'No saved transcript.': '沒有已儲存的逐字稿。',
  'No session history yet.': '尚無工作階段紀錄。',
  'Rate limited': '請求受限',
  'Ready': '準備就緒',
  'Reason: token_expired': '原因：token_expired',
  'Reason: unexpected_close': '原因：unexpected_close',
  'Reconnecting': '正在重新連線',
  'SRT and VTT export one stream at a time.': 'SRT 與 VTT 一次只能匯出一個內容。',
  'Saved export format': '已儲存逐字稿匯出格式',
  'Saved export stream': '已儲存逐字稿匯出內容',
  'Saved subtitle timing uses the original session observation timestamps.': '已儲存字幕的時間碼採用原始工作階段觀察時間。',
  'Saved transcript export': '已儲存逐字稿匯出',
  'Session expired': '工作階段已過期',
  'Session expired. Please start a new session.': '工作階段已過期。請開始新的工作階段。',
  'Source final: 1 · Translation final: 1': '原文完成：1 · 翻譯完成：1',
  'Source transcript': '原文逐字稿',
  'Start': '開始',
  'Started': '開始時間',
  'Status': '狀態',
  'Stop': '停止',
  'Stopped': '已停止',
  'Target language': '目標語言',
  'Too many requests. Please wait and try again.': '請求過於頻繁。請稍候再試。',
  'Translation history': '翻譯紀錄',
  'Translation transcript': '翻譯逐字稿',
  'Unable to reconnect live translation. You can start a new session when ready.': '無法重新連線即時翻譯。準備就緒後可以開始新的工作階段。',
  'View details': '查看詳細資料'
};

function localizeUiSelector(value) {
  return typeof value === 'string' ? (LOCALIZED_UI_TEXT[value] || value) : value;
}

function localizeSelectorMethods(target) {
  for (const method of ['getByText', 'getByLabel']) {
    const original = target[method].bind(target);
    target[method] = (text, options) => original(localizeUiSelector(text), options);
  }

  const getByRole = target.getByRole.bind(target);
  target.getByRole = (role, options = {}) => getByRole(role, {
    ...options,
    ...(Object.hasOwn(options, 'name') ? { name: localizeUiSelector(options.name) } : {})
  });
}

function localizeLocatorPrototype(locatorPrototype) {
  for (const method of ['getByText', 'getByLabel']) {
    const original = locatorPrototype[method];
    locatorPrototype[method] = function localizedSelector(text, options) {
      return original.call(this, localizeUiSelector(text), options);
    };
  }

  const getByRole = locatorPrototype.getByRole;
  locatorPrototype.getByRole = function localizedRoleSelector(role, options = {}) {
    return getByRole.call(this, role, {
      ...options,
      ...(Object.hasOwn(options, 'name') ? { name: localizeUiSelector(options.name) } : {})
    });
  };
}

test.beforeEach(async ({ page }) => {
  localizeSelectorMethods(page);
  const locatorPrototype = Object.getPrototypeOf(page.locator('body'));
  if (!locatorPrototype.__localizedUiSelectors) {
    localizeLocatorPrototype(locatorPrototype);
    Object.defineProperty(locatorPrototype, '__localizedUiSelectors', { value: true });
  }

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
  return sessionDetail(page).getByLabel('Saved transcript export');
}

function activeExportPanel(page) {
  return page.locator('.export-panel');
}

async function openHistoryPage(page) {
  await page.getByRole('link', { name: 'Translation history' }).click();
  await expect(page).toHaveURL(/#history$/);
}

async function openLivePage(page) {
  await page.getByRole('link', { name: 'Live translation' }).click();
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

test('initial history shows empty state', async ({ page }) => {
  await page.goto('/');
  await openHistoryPage(page);

  await expect(historyPanel(page).getByRole('heading', { name: 'Translation history' })).toBeVisible();
  await expect(historyPanel(page).getByText('No session history yet.')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
});

test('active session is not shown while listening', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await openHistoryPage(page);

  await expect(historyPanel(page).getByText('No session history yet.')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
  await expect(historyPanel(page).getByRole('button', { name: 'View details' })).toHaveCount(0);
});

test('starts and stops a mocked Gemini Live translation session', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Live Translate' })).toBeVisible();
  await expect(page.getByText('Ready')).toBeVisible();

  const targetLanguage = page.getByRole('combobox', { name: 'Target language' });

  await targetLanguage.selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.getByText('Listening')).toBeVisible();
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

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.locator('.status-pill').getByText('Stopped', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.every((track) => track.stopped))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].closed)).toBe(true);
});

test('navigation keeps an active translation session and its transcript state', async ({ page }) => {
  await page.goto('/');
  await expect(historyPanel(page)).toBeHidden();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'keep this source', 'keep this translation');

  await openHistoryPage(page);
  await expect(historyPanel(page).getByText('No session history yet.')).toBeVisible();

  await openLivePage(page);
  await expect(page.getByText('Listening')).toBeVisible();
  await expect(page.getByText('keep this source')).toBeVisible();
  await expect(page.getByText('keep this translation')).toBeVisible();
  await expect(page.getByLabel('Live transcripts').locator('.transcript-panel')).toHaveCount(2);
});

test('downloads the active transcript through a browser download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'download source', 'download translation');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-transcript-.*\.txt$/);
});

test('Stop finalizes visible partial transcripts for export and history', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitPartialTranscript(page, 'partial source on stop', 'partial translation on stop');

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();
  await expect(sessionDetail(page).getByText('partial source on stop')).toBeVisible();
  await expect(sessionDetail(page).getByLabel('Translation transcript').getByText('partial translation on stop')).toBeVisible();
});

test('stopped session appears in history with language, status, and transcript summary', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'hello history', '履歴');

  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByRole('heading', { name: 'Japanese' })).toBeVisible();
  await expect(item.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(item.getByText('Source final: 1 · Translation final: 1')).toBeVisible();
});

test('stopped session can open and close inline detail with metadata and final transcripts', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitPartialTranscript(page, 'partial should not save', 'partial translation should not save');
  await emitFinalTranscript(page, 'saved source detail', 'saved translation detail');

  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByRole('heading', { name: 'Japanese details' })).toBeVisible();
  await expect(detail.getByText('Target language')).toBeVisible();
  await expect(detail.getByText('Japanese', { exact: true })).toBeVisible();
  await expect(detail.getByText('Status')).toBeVisible();
  await expect(detail.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(detail.getByText('Started')).toBeVisible();
  await expect(detail.getByText('Ended')).toBeVisible();
  await expect(detail.getByText('Duration')).toBeVisible();
  await expect(detail.getByText('Source final: 1 · Translation final: 1')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Source transcript' })).toBeVisible();
  await expect(detail.getByText('saved source detail')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Translation transcript' })).toBeVisible();
  await expect(detail.getByLabel('Translation transcript').getByText('saved translation detail')).toBeVisible();
  await expect(detail.getByText('partial should not save')).toBeHidden();
  await expect(detail.getByText('partial translation should not save')).toBeHidden();
  await expect(savedExportPanel(page).getByRole('combobox', { name: 'Saved export format' })).toHaveValue('txt');
  await expect(savedExportPanel(page).getByRole('combobox', { name: 'Saved export stream' })).toHaveValue('translation');
  await expect(savedExportPanel(page).getByRole('button', { name: 'Download saved' })).toBeEnabled();

  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(sessionDetail(page)).toBeHidden();
  await expect(historyItems(page)).toHaveCount(1);
});

test('session detail renders filtered translation history with mixed-language detection', async ({ page }) => {
  await page.route('**/api/sessions/**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/translations')) {
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
  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'Hello こんにちは', 'live output');
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  const history = detail.getByLabel('Translation history');
  await expect(history.getByText('こんにちは', { exact: true })).toBeVisible();
  await expect(history.getByText('世界')).toBeVisible();
  await expect(history.getByText('Bonjour')).toBeVisible();
  await expect(history.getByText('Detected source languages: en, ja')).toHaveCount(3);

  await history.getByRole('combobox', { name: 'Filter output language' }).selectOption('ja');
  await expect(history.getByText('こんにちは', { exact: true })).toBeVisible();
  await expect(history.getByText('世界')).toBeVisible();
  await expect(history.getByText('Bonjour')).toBeHidden();
});

test('translation execution controls cancel queued work and retry failed work without replacing the source', async ({ page }) => {
  const executions = [
    { id: 'execution-queued', requestId: 'request-queued', targetLanguageCode: 'ja', status: 'queued' },
    { id: 'execution-failed', requestId: 'request-failed', targetLanguageCode: 'fr', status: 'failed' },
    { id: 'execution-running', requestId: 'request-running', targetLanguageCode: 'en', status: 'running' },
    { id: 'execution-completed', requestId: 'request-completed', targetLanguageCode: 'de', status: 'completed' },
    { id: 'execution-cancelled', requestId: 'request-cancelled', targetLanguageCode: 'ko', status: 'cancelled' }
  ];
  await page.route('**/api/sessions/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/translations')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        sessionId: 'controlled-session',
        translations: [],
        translationHistory: { outputs: [], executions }
      }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      session: { id: 'controlled-session', status: 'completed', startedAt: 1, endedAt: 2, durationMs: 1, failureReason: null, failureCategory: null, transcriptSummary: { totalItems: 0, sourceFinalCount: 0, translationFinalCount: 0, sourcePartialCount: 0, translationPartialCount: 0, hasTranscript: false } },
      sourceTranscript: { id: 'source:controlled-session', sessionId: 'controlled-session', revisionId: 'source:final', status: 'finalized', items: [], createdAt: 1, finalizedAt: 2 },
      translationOutputs: [], selectedTranslationOutput: null, legacy: false
    }) });
  });
  await page.route('**/api/translation-executions/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'POST') return route.continue();
    if (url.pathname.endsWith('/execution-queued/cancel')) {
      executions[0] = { ...executions[0], status: 'cancelled', completedAt: '2026-07-21T00:00:00.000Z' };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(executions[0]) });
      return;
    }
    if (url.pathname.endsWith('/execution-failed/retry')) {
      executions.push({ id: 'execution-retry', requestId: 'request-failed', targetLanguageCode: 'fr', status: 'queued' });
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(executions.at(-1)) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const history = sessionDetail(page).getByLabel('Translation history');
  await expect(history.getByRole('button', { name: '取消' })).toHaveCount(1);
  await expect(history.getByRole('button', { name: '重新嘗試' })).toHaveCount(1);
  await expect(history.getByText('en · 執行中')).toBeVisible();
  await expect(history.getByText('de · 已完成')).toBeVisible();
  await expect(history.getByText('ko · 已取消')).toBeVisible();

  await history.getByRole('button', { name: '取消' }).click();
  await expect(history.getByText('ja · 已取消')).toBeVisible();
  await expect(history.getByRole('button', { name: '取消' })).toHaveCount(0);

  await history.getByRole('button', { name: '重新嘗試' }).click();
  await expect(history.getByText('fr · 失敗')).toBeVisible();
  await expect(history.getByText('fr · 已排隊')).toBeVisible();
  await expect(history.getByRole('button', { name: '重新嘗試' })).toHaveCount(1);
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

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'timed source', 'timed translation');
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const panel = savedExportPanel(page);
  await panel.getByRole('combobox', { name: 'Saved export stream' }).selectOption('source');
  await panel.getByRole('combobox', { name: 'Saved export format' }).selectOption('srt');
  await expect(panel.getByRole('button', { name: 'Download saved' })).toBeEnabled();

  await panel.getByRole('combobox', { name: 'Saved export format' }).selectOption('vtt');
  await expect(panel.getByRole('button', { name: 'Download saved' })).toBeEnabled();
  await expect(panel.getByText('Saved subtitle timing uses the original session observation timestamps.')).toBeVisible();
});

test('downloads a saved transcript through a browser download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'saved download source', 'saved download translation');
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const downloadPromise = page.waitForEvent('download');
  await savedExportPanel(page).getByRole('button', { name: 'Download saved' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^live-translate-session-.*\.txt$/);
});

test('both stream is unavailable for saved SRT and VTT export', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'source subtitle', 'translation subtitle');
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const panel = savedExportPanel(page);
  await panel.getByRole('combobox', { name: 'Saved export format' }).selectOption('srt');
  await panel.getByRole('combobox', { name: 'Saved export stream' }).selectOption('both');

  await expect(panel.getByRole('button', { name: 'Download saved' })).toBeDisabled();
  await expect(panel.getByText('SRT and VTT export one stream at a time.')).toBeVisible();

  await panel.getByRole('combobox', { name: 'Saved export format' }).selectOption('vtt');
  await expect(panel.getByRole('button', { name: 'Download saved' })).toBeDisabled();
});

test('no transcript detail shows empty state', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);

  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  await expect(sessionDetail(page).getByText('No saved transcript.')).toBeVisible();
  await expect(savedExportPanel(page).getByRole('button', { name: 'Download saved' })).toBeDisabled();
});

test('switching saved session resets saved export controls', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'first source', 'first translation');
  await page.getByRole('button', { name: 'Stop' }).click();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'second source', 'second translation');
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(2);

  await historyItems(page).nth(1).getByRole('button', { name: 'View details' }).click();
  await savedExportPanel(page).getByRole('combobox', { name: 'Saved export format' }).selectOption('vtt');
  await savedExportPanel(page).getByRole('combobox', { name: 'Saved export stream' }).selectOption('source');

  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  await expect(savedExportPanel(page).getByRole('combobox', { name: 'Saved export format' })).toHaveValue('txt');
  await expect(savedExportPanel(page).getByRole('combobox', { name: 'Saved export stream' })).toHaveValue('translation');
});

test('saved export controls do not alter active export controls', async ({ page }) => {
  await page.goto('/');

  await activeExportPanel(page).getByRole('combobox', { name: 'Export format' }).selectOption('vtt');
  await activeExportPanel(page).getByRole('combobox', { name: 'Export stream' }).selectOption('source');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'source export separation', 'translation export separation');
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  await savedExportPanel(page).getByRole('combobox', { name: 'Saved export format' }).selectOption('srt');
  await savedExportPanel(page).getByRole('combobox', { name: 'Saved export stream' }).selectOption('translation');

  await openLivePage(page);
  await expect(activeExportPanel(page).getByRole('combobox', { name: 'Export format' })).toHaveValue('vtt');
  await expect(activeExportPanel(page).getByRole('combobox', { name: 'Export stream' })).toHaveValue('source');
});

test('failed session appears in history with normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Unable to reconnect live translation. You can start a new session when ready.')).toBeVisible();
  await openHistoryPage(page);

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('Failed', { exact: true })).toBeVisible();
  await expect(item.getByText('Reason: unexpected_close')).toBeVisible();
});

test('failed session detail shows normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Unable to reconnect live translation. You can start a new session when ready.')).toBeVisible();
  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByText('Failure reason')).toBeVisible();
  await expect(detail.getByText('unexpected_close')).toBeVisible();
  await expect(detail.getByText('Failure category')).toBeVisible();
  await expect(detail.getByText('provider')).toBeVisible();
});

test('expired session appears in history with expired status', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await openHistoryPage(page);
  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('Expired', { exact: true })).toBeVisible();
  await expect(item.getByText('Reason: token_expired')).toBeVisible();
});

test('expired session detail shows normalized failure reason', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await openHistoryPage(page);
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByText('Failure reason')).toBeVisible();
  await expect(detail.getByText('token_expired')).toBeVisible();
  await expect(detail.getByText('Failure category')).toBeVisible();
  await expect(detail.getByText('token', { exact: true })).toBeVisible();
});

test('manual Start after a finalized session does not clear previous history', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);

  await openLivePage(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('Stopped', { exact: true })).toBeVisible();
});

test('reconnect does not create duplicate history record', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'before reconnect', 'after reconnect');

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect(page.getByText('Listening')).toBeVisible();
  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(0);

  await openLivePage(page);
  await page.getByRole('button', { name: 'Stop' }).click();

  await openHistoryPage(page);
  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('Stopped', { exact: true })).toBeVisible();
});

test('reconnects once after mocked unexpected close and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

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

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('Listening')).toBeVisible();
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();
});

test('token expired shows friendly message without reconnect and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

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

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await expect(page.getByText('Session expired', { exact: true })).toBeVisible();
  await expect(page.getByText('Session expired. Please start a new session.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(page.getByText('before token expiration')).toBeVisible();
  await expect(page.getByText('still visible after expiration')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await expect(page.getByText('before token expiration')).toBeHidden();
  await expect(page.getByText('still visible after expiration')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
});

test('auth failed shows friendly message without reconnect', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

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

  await expect(page.getByText('Access failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Access failed. Please check your access token or configuration.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(page.getByText('before auth failure')).toBeVisible();
  await expect(page.getByText('auth failure transcript')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('rate limited shows friendly message without reconnect', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

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

  await expect(page.getByText('Rate limited', { exact: true })).toBeVisible();
  await expect(page.getByText('Too many requests. Please wait and try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(page.getByText('before rate limit')).toBeVisible();
  await expect(page.getByText('rate limit transcript')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('stop during reconnect cancels pending replacement session', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });
  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.status-pill').getByText('Stopped', { exact: true })).toBeVisible();
  await page.waitForTimeout(900);

  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('duplicate unexpected close does not create duplicate replacement sessions', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions[0];
    session.emitClose({ reason: 'unexpected provider close', code: 1011 });
    session.emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
});

test('reconnect failure preserves transcript and allows manual restart', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

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

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect(page.getByText('Unable to reconnect live translation. You can start a new session when ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();

  page.failLiveTokenRequestAt = null;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await expect.poll(() => page.liveTokenRequests.length).toBe(3);
});

test('retry exhaustion shows explicit error and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

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
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(index + 2);
    await expect(page.getByText('Listening')).toBeVisible();
  }

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[3].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Live translation could not reconnect after repeated attempts. You can start a new session when ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByText('still exportable')).toBeVisible();
  await expect(page.getByText('after exhaustion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(4);
});
